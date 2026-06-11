#!/usr/bin/env node
// Regenera agora-tools.json desde el código fuente de tu AgoraBack.
// Parsea AGORA_AGENT_TOOLS de toolDefinitions.ts (parser con tracking de profundidad de
// llaves + string-aware, así ignora los name:/description: anidados de los params).
//
// Uso:
//   node tools/extract-catalog.cjs /ruta/a/AgoraBack/src/lib/agora-ai/toolDefinitions.ts
//   (sin argumento usa $AGORA_TOOLDEFS o el path por defecto)
const fs = require('fs');
const path = require('path');

const T = process.argv[2] || process.env.AGORA_TOOLDEFS ||
  '../AgoraBack/src/lib/agora-ai/toolDefinitions.ts';
// el set autoritativo de destructivas vive en toolRegistry.ts (DESTRUCTIVE_TOOL_NAMES)
const DESTRUCTIVE = new Set(['delete_document', 'delete_file', 'delete_folder', 'overwrite_document',
  'rollback_action', 'rollback_last', 'run_worker_command', 'update_document', 'write_worker_file']);

const src = fs.readFileSync(T, 'utf8');
const decl = src.indexOf('AGORA_AGENT_TOOLS');
if (decl < 0) { console.error('No encontré AGORA_AGENT_TOOLS en', T); process.exit(1); }
const start = src.indexOf('[', src.indexOf('=', decl)); // el array tras el '=', no el [] del tipo

function run(src, start) {
  let i = start, depth = 0, tools = [], cur = null;
  while (i < src.length) {
    const c = src[i];
    if (c === '"' || c === "'" || c === '`') { const q = c; i++; while (i < src.length) { if (src[i] === '\\') { i += 2; continue; } if (src[i] === q) break; i++; } i++; continue; }
    if (c === '/' && src[i + 1] === '/') { while (i < src.length && src[i] !== '\n') i++; continue; }
    if (c === '/' && src[i + 1] === '*') { i += 2; while (i < src.length && !(src[i] === '*' && src[i + 1] === '/')) i++; i += 2; continue; }
    if (c === '{' || c === '[') { depth++; if (depth === 2) cur = { name: '', description: '' }; i++; continue; }
    if (c === '}' || c === ']') { if (depth === 2 && cur) { if (cur.name) tools.push(cur); cur = null; } depth--; if (depth === 0) break; i++; continue; }
    if (depth === 2 && cur) {
      for (const key of ['name', 'description']) {
        if (src.startsWith(key + ':', i) && !cur[key]) {
          let j = i + key.length + 1; while (/\s/.test(src[j])) j++;
          if (src[j] === '"' || src[j] === "'" || src[j] === '`') {
            const q = src[j]; j++; let buf = '';
            while (j < src.length) { if (src[j] === '\\') { buf += src[j + 1]; j += 2; continue; } if (src[j] === q) break; buf += src[j]; j++; }
            cur[key] = buf.replace(/\s+/g, ' ').trim(); i = j + 1;
          }
          break;
        }
      }
    }
    i++;
  }
  return tools;
}

const tools = run(src, start).map(t => ({
  name: t.name,
  description: t.description.slice(0, 240),
  destructive: DESTRUCTIVE.has(t.name) || t.name.startsWith('delete_')
}));
const out = path.join(__dirname, '..', 'agora-tools.json');
fs.writeFileSync(out, JSON.stringify(tools, null, 0));
console.log(`${tools.length} tools -> ${out} (${tools.filter(t => t.destructive).length} destructivas)`);
