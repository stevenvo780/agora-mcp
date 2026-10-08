import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';

const server = fileURLToPath(new URL('./server.mjs', import.meta.url));
const networkGuard = String.raw`
const blocked = name => () => {
  process.stderr.write('[stdio-test] blocked network: ' + name + '\n');
  throw new Error('Network blocked by stdio test: ' + name);
};
globalThis.fetch = blocked('fetch');
for (const name of ['http', 'https']) {
  const module = require('node:' + name);
  for (const method of ['get', 'request']) module[method] = blocked(name + '.' + method);
  module.Agent.prototype.createConnection = blocked(name + '.Agent.createConnection');
}
const net = require('node:net');
for (const method of ['connect', 'createConnection']) net[method] = blocked('net.' + method);
net.Socket.prototype.connect = blocked('net.Socket.connect');
net.Server.prototype.listen = blocked('net.Server.listen');
require('node:tls').connect = blocked('tls.connect');
const dns = require('node:dns');
for (const module of [dns, dns.promises, dns.Resolver.prototype, dns.promises.Resolver.prototype]) {
  for (const method of Object.getOwnPropertyNames(module)) {
    if (/^(lookup|resolve|reverse)/.test(method) && typeof module[method] === 'function') {
      module[method] = blocked('dns.' + method);
    }
  }
}
require('node:module').syncBuiltinESMExports();
`;

async function runServer(t, chunks, { slowOutput = false } = {}) {
  const directory = await mkdtemp(path.join(tmpdir(), 'agora-mcp-stdio-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const config = path.join(directory, 'config.json');
  const preload = path.join(directory, 'block-network.cjs');
  await writeFile(config, JSON.stringify({
    base: 'https://agora.invalid',
    internalSecret: 'synthetic-test-secret',
    webApiKey: 'synthetic-test-api-key',
    uid: 'synthetic-test-user',
    serviceAccount: { client_email: 'synthetic@example.invalid', private_key: 'not-a-private-key' }
  }));
  await writeFile(preload, networkGuard);
  // Explicit allowlist: never inherit credentials, HOME, NODE_OPTIONS or Agora overrides.
  const env = { AGORA_MCP_CONFIG: config };
  if (process.platform === 'win32' && process.env.SystemRoot) env.SystemRoot = process.env.SystemRoot;
  const child = spawn(process.execPath, ['--require', preload, server], {
    cwd: directory, env, stdio: ['pipe', 'pipe', 'pipe']
  });
  t.after(() => { if (child.exitCode === null) child.kill(); });
  let stdout = '', stderr = '', expired = false;
  let signalStarted;
  const started = new Promise(resolve => { signalStarted = resolve; });
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stdout.on('data', data => { stdout += data; });
  if (slowOutput) child.stdout.pause();
  child.stderr.on('data', data => {
    stderr += data;
    if (stderr.includes('[agora-mcp] listo')) signalStarted();
  });
  child.stdin.on('error', () => {}); // The exit assertion below reports premature termination.
  const closed = new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('close', (code, signal) => { signalStarted(); resolve({ code, signal }); });
  });
  const timeout = setTimeout(() => { expired = true; child.kill('SIGKILL'); }, 5000);
  let exit, resumeOutput;
  try {
    await started;
    for (const [index, chunk] of chunks.entries()) {
      if (index) await delay(10);
      child.stdin.write(chunk);
    }
    child.stdin.end();
    // Force pipe backpressure, then let the reader catch up while the server drains.
    if (slowOutput) resumeOutput = setTimeout(() => child.stdout.resume(), 100);
    exit = await closed;
  } finally {
    clearTimeout(timeout);
    clearTimeout(resumeOutput);
  }
  assert.equal(expired, false, `server timed out\n${stderr}`);
  assert.equal(exit.code, 0, `server exited with ${exit.code}/${exit.signal}\n${stderr}`);
  assert.match(stderr, /\[agora-mcp\] listo · base=https:\/\/agora\.invalid · uid=synthetic-test-user/);
  assert.doesNotMatch(stderr, /\[stdio-test\] blocked network/);
  assert.ok(stdout === '' || stdout.endsWith('\n'), 'stdout ends with a complete protocol line');
  const responses = stdout === '' ? [] : stdout.slice(0, -1).split('\n').map(line => {
    const response = JSON.parse(line); // Any diagnostic or malformed output fails here.
    assert.equal(response.jsonrpc, '2.0');
    assert.ok(Object.hasOwn(response, 'id'), 'every response includes an id');
    assert.notEqual(Object.hasOwn(response, 'result'), Object.hasOwn(response, 'error'));
    return response;
  });
  return { responses, stderr };
}

function request(method, id, params) {
  return JSON.stringify({ jsonrpc: '2.0', method, id, ...(params === undefined ? {} : { params }) }) + '\n';
}

function assertRpcError(response, id, code) {
  assert.deepEqual(Object.keys(response).sort(), ['error', 'id', 'jsonrpc']);
  assert.equal(response.id, id);
  assert.equal(response.error.code, code);
  assert.equal(typeof response.error.message, 'string');
}

test('malformed JSON returns -32700 with null id and preserves the next message', async t => {
  const { responses } = await runServer(t, ['{"jsonrpc":\n' + request('ping', 'after-parse')]);
  assert.equal(responses.length, 2);
  assertRpcError(responses[0], null, -32700);
  assert.deepEqual(responses[1], { jsonrpc: '2.0', id: 'after-parse', result: {} });
});

const invalidEnvelopes = [
  ['null', null, null],
  ['boolean', true, null],
  ['number', 42, null],
  ['string', 'ping', null],
  ['empty array', [], null],
  ['batch array', [{ jsonrpc: '2.0', method: 'ping', id: 'batch' }], null],
  ['empty object', {}, null],
  ['missing version', { method: 'ping', id: 'missing-version' }, 'missing-version'],
  ['wrong version', { jsonrpc: '1.0', method: 'ping', id: 0 }, 0],
  ['numeric version', { jsonrpc: 2, method: 'ping', id: null }, null],
  ['missing method', { jsonrpc: '2.0', id: 'missing-method' }, 'missing-method'],
  ['null method', { jsonrpc: '2.0', method: null, id: 'null-method' }, 'null-method'],
  ['numeric method', { jsonrpc: '2.0', method: 1, id: 1 }, 1],
  ['array method', { jsonrpc: '2.0', method: [], id: 'array-method' }, 'array-method'],
  ['object method', { jsonrpc: '2.0', method: {}, id: 'object-method' }, 'object-method'],
  ['null params', { jsonrpc: '2.0', method: 'ping', params: null, id: 'null-params' }, 'null-params'],
  ['boolean params', { jsonrpc: '2.0', method: 'ping', params: false, id: 'boolean-params' }, 'boolean-params'],
  ['numeric params', { jsonrpc: '2.0', method: 'ping', params: 1, id: 'numeric-params' }, 'numeric-params'],
  ['string params', { jsonrpc: '2.0', method: 'ping', params: 'x', id: 'string-params' }, 'string-params'],
  ['object id', { jsonrpc: '2.0', method: 'ping', id: {} }, null],
  ['array id', { jsonrpc: '2.0', method: 'ping', id: [] }, null],
  ['boolean id', { jsonrpc: '2.0', method: 'ping', id: false }, null],
  ['invalid notification', { jsonrpc: '2.0', method: 'ping', params: null }, null]
];
for (const [name, envelope, id] of invalidEnvelopes) {
  test(`invalid envelope: ${name} returns -32600 and preserves the next message`, async t => {
    const { responses } = await runServer(t, [JSON.stringify(envelope) + '\n' + request('ping', 'after-invalid')]);
    assert.equal(responses.length, 2);
    assertRpcError(responses[0], id, -32600);
    assert.deepEqual(responses[1], { jsonrpc: '2.0', id: 'after-invalid', result: {} });
  });
}

test('a numeric id outside the finite range returns -32600 with null id', async t => {
  const { responses } = await runServer(t, ['{"jsonrpc":"2.0","method":"ping","id":1e400}\n']);
  assert.equal(responses.length, 1);
  assertRpcError(responses[0], null, -32600);
});

const notifications = [
  ['initialize', { protocolVersion: '2024-11-05' }],
  ['ping'],
  ['tools/list'],
  ['tools/call', { name: 'agora_tools', arguments: { query: 'document' } }],
  ['tools/call', { name: 'agora_tools', arguments: { query: 1 } }],
  ['tools/call', { name: 'unknown_local_tool' }],
  ['unknown/method'],
  ['notifications/initialized']
];
for (const [index, [method, params]] of notifications.entries()) {
  test(`valid notification ${index + 1}: ${method} produces no response`, async t => {
    const { responses } = await runServer(t, [request(method, undefined, params) + request('ping', 'after-notification')]);
    assert.deepEqual(responses, [{ jsonrpc: '2.0', id: 'after-notification', result: {} }]);
  });
}

test('notification method names carrying an id are requests and return -32601', async t => {
  const { responses } = await runServer(t, [request('notifications/initialized', 'notification-request')]);
  assert.equal(responses.length, 1);
  assertRpcError(responses[0], 'notification-request', -32601);
});

for (const id of [0, 'request-id', 7, 2.5, null]) {
  test(`preserves ${JSON.stringify(id)} in successful and unknown-method responses`, async t => {
    const { responses } = await runServer(t, [request('ping', id) + request('unknown/method', id)]);
    assert.equal(responses.length, 2);
    assert.deepEqual(responses[0], { jsonrpc: '2.0', id, result: {} });
    assertRpcError(responses[1], id, -32601);
  });
}

test('object and array params are valid structured JSON-RPC params', async t => {
  const { responses } = await runServer(t, [request('ping', 'object', {}) + request('ping', 'array', [])]);
  assert.deepEqual(responses, [
    { jsonrpc: '2.0', id: 'object', result: {} },
    { jsonrpc: '2.0', id: 'array', result: {} }
  ]);
});

test('an empty string method is a valid unknown method', async t => {
  const { responses } = await runServer(t, [request('', 'empty-method')]);
  assert.equal(responses.length, 1);
  assertRpcError(responses[0], 'empty-method', -32601);
});

test('chunked input preserves message framing and protocol output', async t => {
  const line = request('initialize', 'chunked', { protocolVersion: '2024-11-05' });
  const { responses } = await runServer(t, [line.slice(0, 8), line.slice(8, -1), '\n' + request('tools/list', 0)]);
  assert.equal(responses.length, 2);
  assert.equal(responses[0].id, 'chunked');
  assert.equal(responses[0].result.protocolVersion, '2024-11-05');
  assert.equal(responses[0].result.serverInfo.name, 'agora');
  assert.equal(responses[1].id, 0);
  assert.deepEqual(responses[1].result.tools.map(tool => tool.name), ['agora_tools', 'agora_call']);
});

test('EOF preserves successful and failing asynchronous local tools/call responses', async t => {
  const { responses, stderr } = await runServer(t, [
    request('tools/call', 0, { name: 'agora_tools', arguments: { query: 'document' } }) +
    request('tools/call', 'handler-error', { name: 'agora_tools', arguments: { query: 1 } }) +
    request('tools/call', null, { name: 'unknown_local_tool' })
  ]);
  assert.equal(responses.length, 3);
  const success = responses.find(response => response.id === 0);
  assert.equal(success.result.isError, false);
  assert.equal(success.result.content[0].type, 'text');
  assert.match(success.result.content[0].text, /coinciden con "document"/);
  const failure = responses.find(response => response.id === 'handler-error');
  assert.equal(failure.result.isError, true);
  assert.match(failure.result.content[0].text, /^Error: /);
  assert.match(stderr, /\[agora-mcp\] call error:/);
  const unknown = responses.find(response => response.id === null);
  assert.equal(unknown.result.isError, true);
  assert.equal(unknown.result.content[0].type, 'text');
});

test('EOF drains a burst of responses when the stdout reader is slow', async t => {
  const count = 256;
  const input = Array.from({ length: count }, (_, id) => request('tools/list', id) + '{malformed\n').join('');
  const { responses } = await runServer(t, [input], { slowOutput: true });
  assert.equal(responses.length, count * 2);
  const lists = responses.filter(response => Object.hasOwn(response, 'result'));
  assert.deepEqual(lists.map(response => response.id), Array.from({ length: count }, (_, id) => id));
  for (const response of lists) assert.equal(response.result.tools.length, 2);
  const errors = responses.filter(response => Object.hasOwn(response, 'error'));
  assert.equal(errors.length, count);
  for (const response of errors) assertRpcError(response, null, -32700);
});
