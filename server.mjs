#!/usr/bin/env node
// Agora MCP — expone las herramientas del agente de Agora a cualquier cliente MCP.
// Sin dependencias: firma el Firebase custom token con `crypto` nativo, lo intercambia
// por un ID token y llama POST /api/agora-ai/internal/execute-tool.
// 2 herramientas: agora_tools (catálogo) + agora_call (ejecuta; destructivas piden confirm).
//
// Licencia MIT. https://github.com/stevenvo780/agora-mcp
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const DIR = path.dirname(fileURLToPath(import.meta.url));
const log = (...a) => process.stderr.write('[agora-mcp] ' + a.join(' ') + '\n');

// ---- config: archivo (config.json / $AGORA_MCP_CONFIG) con override por env ----
function loadConfig() {
  const explicit = process.env.AGORA_MCP_CONFIG;
  const local = path.join(DIR, 'config.json');
  const p = explicit || (fs.existsSync(local) ? local : null);
  const cfg = p ? JSON.parse(fs.readFileSync(p, 'utf8')) : {};

  cfg.base = (process.env.AGORA_BASE || cfg.base || '').replace(/\/$/, '');
  cfg.internalSecret = process.env.AGORA_INTERNAL_SECRET || cfg.internalSecret || cfg.hubSecret;
  cfg.secretHeader = process.env.AGORA_SECRET_HEADER || cfg.secretHeader || 'x-hub-internal-secret';
  cfg.webApiKey = process.env.AGORA_WEB_API_KEY || cfg.webApiKey;
  cfg.uid = process.env.AGORA_UID || cfg.uid;
  cfg.defaultWorkspace = process.env.AGORA_DEFAULT_WORKSPACE || cfg.defaultWorkspace || 'personal';
  if (process.env.AGORA_INSECURE_TLS) cfg.insecureTLS = process.env.AGORA_INSECURE_TLS === '1';

  // service account: inline {client_email, private_key} o archivo JSON
  if (!cfg.serviceAccount?.private_key) {
    const saFile = process.env.AGORA_SA_FILE || process.env.GOOGLE_APPLICATION_CREDENTIALS || cfg.serviceAccountFile;
    let sa = null;
    if (process.env.AGORA_SA_JSON) sa = JSON.parse(process.env.AGORA_SA_JSON);
    else if (saFile && fs.existsSync(saFile)) sa = JSON.parse(fs.readFileSync(saFile, 'utf8'));
    if (sa) cfg.serviceAccount = { client_email: sa.client_email, private_key: sa.private_key };
  }

  const missing = ['base', 'internalSecret', 'webApiKey', 'uid'].filter(k => !cfg[k]);
  if (!cfg.serviceAccount?.private_key) missing.push('serviceAccount');
  if (missing.length) { log('config incompleta — faltan: ' + missing.join(', ') + '. Ver config.example.json y el README.'); process.exit(1); }
  return cfg;
}
const cfg = loadConfig();
if (cfg.insecureTLS) process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';

const CATALOG = JSON.parse(fs.readFileSync(path.join(DIR, 'agora-tools.json'), 'utf8'));
const CAT_BY_NAME = new Map(CATALOG.map(t => [t.name, t]));

// destructivas: marca del catálogo + set autoritativo de Agora (toolRegistry + toolExecutor)
const DESTRUCTIVE = new Set(['delete_document', 'delete_file', 'delete_folder', 'overwrite_document',
  'rollback_action', 'rollback_last', 'run_worker_command', 'update_document', 'write_worker_file']);
const isDestructive = (name) => CAT_BY_NAME.get(name)?.destructive === true || DESTRUCTIVE.has(name) || name.startsWith('delete_');

// ---- Firebase custom token (RS256) -> ID token, con cache ----
const b64url = (b) => Buffer.from(b).toString('base64url');
function customToken(uid) {
  const now = Math.floor(Date.now() / 1000);
  const header = { alg: 'RS256', typ: 'JWT' };
  const payload = { iss: cfg.serviceAccount.client_email, sub: cfg.serviceAccount.client_email,
    aud: 'https://identitytoolkit.googleapis.com/google.identity.identitytoolkit.v1.IdentityToolkit',
    iat: now, exp: now + 3600, uid };
  const input = b64url(JSON.stringify(header)) + '.' + b64url(JSON.stringify(payload));
  const sig = crypto.sign('RSA-SHA256', Buffer.from(input), cfg.serviceAccount.private_key);
  return input + '.' + b64url(sig);
}
let tok = { id: null, exp: 0 };
async function idToken() {
  if (tok.id && Date.now() < tok.exp - 60000) return tok.id;
  const r = await fetch(`https://identitytoolkit.googleapis.com/v1/accounts:signInWithCustomToken?key=${cfg.webApiKey}`,
    { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ token: customToken(cfg.uid), returnSecureToken: true }) });
  const j = await r.json();
  if (!j.idToken) throw new Error('token exchange falló: ' + (j.error?.message || JSON.stringify(j)));
  tok = { id: j.idToken, exp: Date.now() + (parseInt(j.expiresIn || '3600', 10) * 1000) };
  return tok.id;
}

let seq = 0;
async function execTool(name, args, workspaceId, dryRun) {
  const r = await fetch(`${cfg.base}/api/agora-ai/internal/execute-tool`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', [cfg.secretHeader]: cfg.internalSecret, 'authorization': 'Bearer ' + (await idToken()) },
    body: JSON.stringify({ call: { name, id: `mcp-${name}-${Date.now()}-${seq++}`, args: args || {} },
      ctx: { workspaceId: workspaceId || cfg.defaultWorkspace, dryRun: !!dryRun } })
  });
  const txt = await r.text();
  let j; try { j = JSON.parse(txt); } catch { j = { raw: txt.slice(0, 2000) }; }
  return { status: r.status, result: j };
}

// ---- resolución de workspace por nombre ----
let wsCache = null;
async function resolveWorkspace(ws) {
  if (!ws || ws === cfg.defaultWorkspace || ws === 'personal') return ws || cfg.defaultWorkspace;
  if (/^[A-Za-z0-9_-]{18,28}$/.test(ws) && !/\s/.test(ws)) return ws; // parece un id
  if (!wsCache) { const r = await execTool('list_workspaces', {}, cfg.defaultWorkspace, false); wsCache = r.result?.data?.workspaces || []; }
  const hit = wsCache.find(w => (w.name || '').toLowerCase() === ws.toLowerCase());
  if (hit) return hit.id;
  const names = wsCache.map(w => w.name).filter(Boolean).join(', ');
  throw new Error(`workspace "${ws}" no encontrado. Disponibles: ${names || '(ninguno)'} — o usá un id, o "${cfg.defaultWorkspace}".`);
}

// ---- herramientas MCP ----
const MCP_TOOLS = [
  { name: 'agora_tools',
    description: `Lista/busca las ${CATALOG.length} herramientas de Agora (documentos, tareas, boards/kanban, conceptos, snippets, workspaces, miembros, correos, worker de código…). Usá query para filtrar por palabra. Devuelve nombre, descripción y si es destructiva. Llamá esto primero para descubrir qué herramienta usar.`,
    inputSchema: { type: 'object', properties: {
      query: { type: 'string', description: 'filtro por nombre/descripción, ej: "document", "task", "board", "member"' },
      all: { type: 'boolean', description: 'devolver el catálogo completo' } } } },
  { name: 'agora_call',
    description: 'Ejecuta una herramienta de Agora por nombre con sus argumentos, sobre datos reales. Las destructivas (borrar/sobrescribir/worker) requieren confirm:true; sin él devuelven un PREVIEW dryRun sin tocar nada. Workspace por nombre (ej "Platon") o id; default: el configurado.',
    inputSchema: { type: 'object', required: ['tool'], properties: {
      tool: { type: 'string', description: 'nombre EXACTO de la herramienta (descubrilas con agora_tools)' },
      args: { type: 'object', description: 'argumentos de esa herramienta' },
      workspace: { type: 'string', description: 'nombre o id del workspace; default el configurado' },
      confirm: { type: 'boolean', description: 'true para ejecutar de verdad una herramienta destructiva' },
      dryRun: { type: 'boolean', description: 'forzar preview sin ejecutar (cualquier herramienta)' } } } }
];

async function handleToolCall(name, a) {
  a = a || {};
  if (name === 'agora_tools') {
    const q = (a.query || '').toLowerCase();
    let list = CATALOG;
    if (q) list = CATALOG.filter(t => t.name.toLowerCase().includes(q) || (t.description || '').toLowerCase().includes(q));
    const body = (q || a.all)
      ? list.map(t => `${t.destructive ? '⚠️ ' : ''}${t.name} — ${t.description}`).join('\n')
      : `${CATALOG.length} herramientas. Pasá query para filtrar (ej "document", "task", "board"). Nombres:\n` + CATALOG.map(t => t.name).join(', ');
    return { text: (q ? `${list.length} coinciden con "${a.query}":\n` : '') + body };
  }
  if (name === 'agora_call') {
    if (!a.tool) return { text: 'Falta "tool".', isError: true };
    if (!CAT_BY_NAME.has(a.tool) && !DESTRUCTIVE.has(a.tool)) {
      const near = CATALOG.filter(t => t.name.includes(a.tool) || a.tool.includes(t.name)).slice(0, 6).map(t => t.name);
      return { text: `Herramienta "${a.tool}" no existe. ${near.length ? 'Quizá: ' + near.join(', ') : 'Usá agora_tools para ver el catálogo.'}`, isError: true };
    }
    const wsId = await resolveWorkspace(a.workspace);
    const destructive = isDestructive(a.tool);
    const dry = a.dryRun === true || (destructive && a.confirm !== true);
    const { status, result } = await execTool(a.tool, a.args, wsId, dry);
    let note = '';
    if (destructive && a.confirm !== true && a.dryRun !== true)
      note = `\n\n⚠️ DESTRUCTIVA: esto fue un PREVIEW (dryRun). Para ejecutarla de verdad, repetí con confirm:true.`;
    const head = `tool=${a.tool} workspace=${wsId} ${dry ? '(dryRun)' : '(ejecutado)'} http=${status}`;
    return { text: head + '\n' + JSON.stringify(result, null, 2).slice(0, 6000) + note, isError: status >= 400 || result?.ok === false };
  }
  return { text: 'método desconocido', isError: true };
}

// ---- MCP stdio (JSON-RPC 2.0, newline-delimited) ----
function send(msg) { process.stdout.write(JSON.stringify(msg) + '\n'); }
function reply(id, result) { send({ jsonrpc: '2.0', id, result }); }
function rerror(id, code, message) { send({ jsonrpc: '2.0', id, error: { code, message } }); }

async function handle(msg) {
  const { id, method, params } = msg;
  if (method === 'initialize')
    return reply(id, { protocolVersion: params?.protocolVersion || '2024-11-05', capabilities: { tools: {} }, serverInfo: { name: 'agora', version: '1.0.0' } });
  if (method === 'tools/list') return reply(id, { tools: MCP_TOOLS });
  if (method === 'ping') return reply(id, {});
  if (method === 'tools/call') {
    try {
      const out = await handleToolCall(params?.name, params?.arguments);
      return reply(id, { content: [{ type: 'text', text: out.text }], isError: !!out.isError });
    } catch (e) { log('call error:', e.message); return reply(id, { content: [{ type: 'text', text: 'Error: ' + e.message }], isError: true }); }
  }
  if (method && method.startsWith('notifications/')) return; // sin respuesta
  if (id !== undefined) rerror(id, -32601, 'method not found: ' + method);
}

let buf = '', inflight = 0, ended = false;
const maybeExit = () => { if (ended && inflight === 0) process.exit(0); };
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => {
  buf += chunk;
  let nl;
  while ((nl = buf.indexOf('\n')) >= 0) {
    const line = buf.slice(0, nl).trim();
    buf = buf.slice(nl + 1);
    if (!line) continue;
    let msg; try { msg = JSON.parse(line); } catch { log('json inválido:', line.slice(0, 120)); continue; }
    inflight++;
    Promise.resolve(handle(msg)).catch(e => log('handle error:', e.message)).finally(() => { inflight--; maybeExit(); });
  }
});
process.stdin.on('end', () => { ended = true; maybeExit(); });
log('listo · base=' + cfg.base + ' · uid=' + cfg.uid + ' · ' + CATALOG.length + ' tools');
