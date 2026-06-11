# agora-mcp

> An [MCP](https://modelcontextprotocol.io) server that exposes **Agora's agent toolset** — documents, tasks, kanban boards, concepts, snippets, workspaces, members, email and a code worker — to **any** MCP client (Claude Desktop, Claude Code, OpenClaw, Cursor, your own agent…).

**Zero dependencies.** Pure Node (`>=18`). It signs a Firebase custom token with the
native `crypto` module, exchanges it for an ID token, and calls Agora's internal
`execute-tool` endpoint. Drop it into any LLM agent and it can now *operate a real Agora
workspace* on your behalf.

```
┌────────────┐   stdio (MCP)   ┌──────────────┐   HTTPS    ┌─────────────────────┐
│ MCP client │◄───────────────►│  agora-mcp   │───────────►│  Agora backend      │
│ (Claude,   │  agora_tools    │  server.mjs  │  execute-  │  /api/agora-ai/     │
│  OpenClaw, │  agora_call     │              │   tool     │  internal/          │
│  Cursor…)  │                 │              │            │  execute-tool       │
└────────────┘                 └──────┬───────┘            └─────────────────────┘
                                      │ mints
                                      ▼
                          Firebase custom token (RS256)
                          → ID token (Identity Toolkit)
```

---

## Why it's useful

Agora ships ~150 internal tools that its own AI agent uses. This server makes that **same
surface** available to *any* agent you control. Point Claude (or any MCP-speaking model) at
it and ask in natural language:

- *"How many documents are in my **Logica** workspace? List the first three."*
- *"Create a card in the **Platon** board under the To-Do column."*
- *"Search my concepts for 'epistemología' and summarize them."*

The model discovers the right tool via `agora_tools`, then runs it via `agora_call`.

## The two tools

### `agora_tools` — discover
Lists/searches the tool catalog. Use `query` to filter by keyword; returns name,
description and whether the tool is destructive. **Call this first** when you don't know
the exact tool name.

```jsonc
{ "query": "board" }   // → get_board, create_board_card, move_board_card, …
```

### `agora_call` — execute
Runs a tool by name against real data.

```jsonc
{
  "tool": "list_documents",
  "args": { "limit": 3 },
  "workspace": "Logica",     // by NAME (auto-resolved to id) or by id; default: configured
  "confirm": false,          // required true to actually run a destructive tool
  "dryRun": false            // force a no-op preview for any tool
}
```

**Safety built in:**
- **Destructive tools** (`delete_*`, `overwrite_document`, `update_document`,
  `run_worker_command`, `rollback_*`, `write_worker_file`) **never run without
  `confirm: true`.** Without it you get a `dryRun` preview describing what *would* happen —
  nothing is touched. This mirrors Agora's own authoritative destructive set.
- **Workspace by name:** pass `"Platon"` and the server resolves it to the workspace id
  (cached). Pass an id directly if you prefer. Defaults to your configured workspace.
- Reads (`list_*`, `read_*`, `get_*`, `search_*`) run directly.

## Tool catalog

`agora-tools.json` ships the full catalog (name + short description + `destructive` flag).
Categories include: documents & folders, tasks, kanban boards/cards, concepts & relations
(knowledge graph), snippets, workspaces & members, calendar/email, search, and a sandboxed
code worker. Run `agora_tools` (no query) to print every name, or with a `query` to filter.

Regenerate it from your own Agora source whenever the toolset changes:

```bash
node tools/extract-catalog.cjs /path/to/AgoraBack/src/lib/agora-ai/toolDefinitions.ts
```

---

## Requirements

- Node.js **18+** (uses built-in `fetch` and `crypto`).
- A reachable Agora backend that exposes `POST /api/agora-ai/internal/execute-tool`.
- Five pieces of configuration (below). No npm install needed.

## Setup

### 1. Get the credentials

| Field | What it is | Where to find it |
|---|---|---|
| `base` | Agora backend base URL | e.g. `https://agora.example.com` |
| `internalSecret` | shared secret the endpoint checks | `HUB_INTERNAL_SECRET` (or `BACKEND_INTERNAL_SECRET`) in your Agora deploy's env |
| `secretHeader` | which header carries it | `x-hub-internal-secret` (default) or `x-backend-internal-secret` |
| `webApiKey` | Firebase Web API key | `NEXT_PUBLIC_FIREBASE_API_KEY` (starts with `AIza…`) — from your Firebase web app config |
| `uid` | Firebase uid the MCP acts as | the user whose workspaces you want to operate |
| `serviceAccount` | Firebase Admin service account | a service-account JSON for the same Firebase project (Project Settings → Service accounts) — used **only** to mint a custom token for `uid` |

> The MCP **acts as that `uid`** — it can do anything that user can. Consider a dedicated
> bot user rather than your personal account for shared/production setups.

### 2. Configure

Copy the example and fill it in:

```bash
cp config.example.json config.json
# edit config.json   (it's gitignored — never commit it)
```

Or pass everything via environment variables (great for containers / CI):
`AGORA_BASE`, `AGORA_INTERNAL_SECRET`, `AGORA_SECRET_HEADER`, `AGORA_WEB_API_KEY`,
`AGORA_UID`, `AGORA_DEFAULT_WORKSPACE`, and the service account via `AGORA_SA_FILE`
(path) / `AGORA_SA_JSON` (inline) / `GOOGLE_APPLICATION_CREDENTIALS`. Point at a config
file elsewhere with `AGORA_MCP_CONFIG=/path/to/config.json`.

### 3. Connect it to your MCP client

See [`examples/mcp-clients.md`](examples/mcp-clients.md) for Claude Desktop, Claude Code,
OpenClaw, Cursor and a raw-stdio smoke test. The short version:

```bash
# OpenClaw
openclaw mcp set agora '{"command":"node","args":["/abs/path/agora-mcp/server.mjs"]}'

# Claude Code
claude mcp add agora -- node /abs/path/agora-mcp/server.mjs
```

### 4. Smoke test (no client needed)

```bash
printf '%s\n' \
  '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{}}}' \
  '{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"agora_call","arguments":{"tool":"list_workspaces"}}}' \
  | node server.mjs
```

You should see your workspaces in the second response.

---

## How auth works (the clever bit)

Agora's `execute-tool` endpoint requires **both** a shared internal secret **and** a valid
Firebase ID token (so it knows *which user* is acting, and enforces workspace membership).
This server obtains the ID token with no SDK:

1. Build a Firebase **custom token** — a JWT signed `RS256` with the service-account
   private key, `aud` = the Identity Toolkit audience, `uid` = your user.
2. Exchange it via `identitytoolkit.googleapis.com/v1/accounts:signInWithCustomToken`
   (using the Web API key) for a short-lived **ID token**.
3. Cache the ID token until it nears expiry, then re-mint.
4. Call `execute-tool` with `<secretHeader>: <internalSecret>` and
   `Authorization: Bearer <idToken>`, body `{ call: { name, id, args }, ctx: { workspaceId, dryRun } }`.

All of this is ~40 lines in `server.mjs` using only `crypto` + `fetch`.

## Security notes

- **Never commit `config.json`** — it's in `.gitignore`. It holds the internal secret and a
  service-account private key (which can mint tokens for *any* uid in the project). Treat it
  like a root credential. Keep it `chmod 600`.
- TLS verification is on by default. Only set `insecureTLS: true` (or `AGORA_INSECURE_TLS=1`)
  for a backend with a self-signed cert you trust — it disables cert checks for *all* fetches.
- This repo documents *how* to talk to Agora's internal endpoint, but possessing it grants
  nothing without the secret + a service account. Rotate the secret if it ever leaks.

## License

[MIT](LICENSE) © 2026 Steven Vallejo ([stevenvo780](https://github.com/stevenvo780))

---

<sub>Built as the Agora bridge for a self-hosted AI assistant. Not affiliated with the
Model Context Protocol project; "MCP" refers to the open protocol.</sub>
