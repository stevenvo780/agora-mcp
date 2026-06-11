# Conectar el MCP a distintos clientes

`agora-mcp` es un servidor MCP **stdio** estándar: cualquier cliente que hable Model
Context Protocol lo puede usar. El comando siempre es `node /ruta/a/agora-mcp/server.mjs`,
con la config en `config.json` (al lado del `server.mjs`) o por variables de entorno.

## Claude Desktop

`~/Library/Application Support/Claude/claude_desktop_config.json` (macOS) o el equivalente
en tu sistema:

```json
{
  "mcpServers": {
    "agora": {
      "command": "node",
      "args": ["/ruta/absoluta/a/agora-mcp/server.mjs"]
    }
  }
}
```

## Claude Code (CLI)

```bash
claude mcp add agora -- node /ruta/absoluta/a/agora-mcp/server.mjs
```

O en `.mcp.json` del proyecto:

```json
{
  "mcpServers": {
    "agora": { "command": "node", "args": ["/ruta/absoluta/a/agora-mcp/server.mjs"] }
  }
}
```

## OpenClaw

```bash
openclaw mcp set agora '{"command":"node","args":["/ruta/absoluta/a/agora-mcp/server.mjs"]}'
```

## Cursor / Windsurf / cualquier cliente MCP

Misma idea — un servidor stdio:

```json
{
  "mcpServers": {
    "agora": { "command": "node", "args": ["/ruta/absoluta/a/agora-mcp/server.mjs"] }
  }
}
```

## Pasar las credenciales por entorno (en vez de config.json)

Útil para contenedores / CI / "pegarlo a otras cosas". Cualquier cliente que permita `env`:

```json
{
  "mcpServers": {
    "agora": {
      "command": "node",
      "args": ["/ruta/a/agora-mcp/server.mjs"],
      "env": {
        "AGORA_BASE": "https://agora.example.com",
        "AGORA_INTERNAL_SECRET": "...",
        "AGORA_WEB_API_KEY": "AIza...",
        "AGORA_UID": "...",
        "AGORA_SA_FILE": "/ruta/a/service-account.json",
        "AGORA_DEFAULT_WORKSPACE": "personal"
      }
    }
  }
}
```

## Probarlo sin cliente (stdio a mano)

```bash
printf '%s\n' \
  '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{}}}' \
  '{"jsonrpc":"2.0","id":2,"method":"tools/list"}' \
  '{"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"agora_call","arguments":{"tool":"list_workspaces"}}}' \
  | node server.mjs
```
