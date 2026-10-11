import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { createBroker, validateBrokerRequest, readRootJSON } from '../lib/broker.mjs';
import { BrokerClient, MAX_REQUEST_BYTES, MAX_RESPONSE_BYTES } from '../lib/broker-client.mjs';

const id = '0123456789abcdef';
const input = { name: 'Phone', guestRamMiB: 2560, hostMemoryMiB: 3584, diskGiB: 8 };
const capabilities = () => ({ supported: true, checks: { networkIsolation: { ok: true }, streamingIsolation: { ok: true } } });
function mock() {
  const calls = [];
  const manager = { capabilities: async () => capabilities() };
  for (const op of ['list', 'usage', 'create', 'start', 'stop', 'delete', 'metrics', 'revealKey', 'verifyKey']) {
    manager[op] = async (...args) => { calls.push([op, ...args]); return { operation: op, args }; };
  }
  return { manager, calls };
}
async function fixture(t, options = {}) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'cp-broker-'));
  const socketPath = path.join(dir, 'broker.sock');
  const state = mock();
  const server = createBroker({ manager: state.manager, ...options });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(socketPath, resolve); });
  t.after(async () => { await server.closeBroker(); await fs.rm(dir, { recursive: true, force: true }); });
  return { ...state, server, socketPath, client: new BrokerClient({ socketPath, timeoutMs: 2000 }) };
}
async function raw(socketPath, body, { end = true } = {}) {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection({ path: socketPath });
    const chunks = [];
    const timer = setTimeout(() => { socket.destroy(); reject(new Error('Test socket timeout')); }, 2000);
    socket.on('connect', () => end ? socket.end(body) : body && socket.write(body));
    socket.on('data', chunk => chunks.push(chunk));
    socket.on('error', error => { if (error.code !== 'ECONNRESET') reject(error); });
    socket.on('close', () => { clearTimeout(timer); resolve(Buffer.concat(chunks).toString()); });
  });
}

test('client forwards only public manager methods; usage adds read-only SDK accounting', async t => {
  const f = await fixture(t, { sharedSdkBytes: async () => 12345, verifyCredentials: async (u, p) => u === 'admin' && p === 'correct' });
  assert.deepEqual(await f.client.list(), { operation: 'list', args: [] });
  assert.deepEqual(await f.client.create(input), { operation: 'create', args: [input] });
  for (const op of ['start', 'stop', 'delete', 'metrics', 'revealKey']) {
    assert.deepEqual(await f.client[op](id), { operation: op, args: [id] });
  }
  assert.deepEqual(await f.client.verifyKey(id, 'random_key'), { operation: 'verifyKey', args: [id, 'random_key'] });
  assert.equal((await f.client.usage()).sharedSdkBytes, 12345);
  assert.equal((await f.client.capabilities()).supported, true);
  assert.equal(await f.client.verifyCredentials('admin', 'correct'), true);
  assert.equal(await f.client.verifyCredentials('admin', 'wrong'), false);
});

test('rejects unknown operations, paths, config injection and invalid resource boundaries', async t => {
  const f = await fixture(t);
  const bad = [null, [], {}, { op: 'list' }, { op: 'list', args: [], config: {} },
    { op: 'constructor', args: [] }, { op: '__proto__', args: [] }, { op: 'command', args: ['/bin/sh'] },
    { op: 'list', args: ['extra'] }, { op: 'start', args: ['../../etc/passwd'] },
    { op: 'metrics', args: [id.toUpperCase()] }, { op: 'delete', args: [123] },
    { op: 'create', args: [{ ...input, stateDir: '/tmp' }] },
    { op: 'create', args: [{ ...input, config: { mode: 'standalone' } }] },
    ...[{ guestRamMiB: 2559 }, { guestRamMiB: 65537 }, { hostMemoryMiB: 3583 },
      { hostMemoryMiB: 131073 }, { diskGiB: 7 }, { diskGiB: 1025 }, { diskGiB: 8.5 },
      { name: 'Phone\ncommand' }].map(change => ({ op: 'create', args: [{ ...input, ...change }] })),
    { op: 'verifyKey', args: [id, 'x'.repeat(257)] }, { op: 'verifyCredentials', args: ['admin', 'x'.repeat(1025)] },
    { op: 'verifyCredentials', args: ['../admin', 'password'] }];
  for (const request of bad) {
    const reply = JSON.parse(await raw(f.socketPath, JSON.stringify(request)));
    assert.equal(reply.ok, false, JSON.stringify(request));
    assert.equal(reply.error.code, 'INVALID_REQUEST');
  }
  assert.deepEqual(f.calls, []);
  assert.deepEqual(validateBrokerRequest({ op: 'create', args: [{ ...input, guestRamMiB: 65536, hostMemoryMiB: 131072, diskGiB: 1024 }] }).args[0],
    { ...input, guestRamMiB: 65536, hostMemoryMiB: 131072, diskGiB: 1024 });
});

test('malformed JSON, concatenated frames and invalid UTF-8 never dispatch', async t => {
  const f = await fixture(t);
  for (const body of ['', '{', '{"op":"list","args":[]}{"op":"list","args":[]}', Buffer.from([0xff])]) {
    assert.equal(JSON.parse(await raw(f.socketPath, body)).error.code, 'INVALID_REQUEST');
  }
  assert.deepEqual(f.calls, []);
});

test('capability enforcement fails closed but cleanup remains available', async t => {
  const f = await fixture(t);
  for (const c of [{ supported: true }, { supported: true, checks: {} },
    { supported: true, checks: { networkIsolation: { ok: true } } },
    { supported: true, checks: { networkIsolation: { ok: true }, streamingIsolation: { ok: false } } },
    { ...capabilities(), supported: false }, { ...capabilities(), checks: { ...capabilities().checks, mounts: { ok: false } } }]) {
    f.manager.capabilities = async () => c;
    assert.equal((await f.client.capabilities()).supported, false);
    await assert.rejects(f.client.create(input), { code: 'ENFORCEMENT_UNAVAILABLE' });
    await assert.rejects(f.client.start(id), { code: 'ENFORCEMENT_UNAVAILABLE' });
  }
  await f.client.stop(id); await f.client.delete(id);
  assert.deepEqual(f.calls.map(call => call[0]), ['stop', 'delete']);
});

test('mutations serialize across clients and queue recovers from backend failure', async t => {
  const f = await fixture(t);
  let active = 0, maximum = 0, count = 0;
  f.manager.stop = async () => {
    active++; maximum = Math.max(active, maximum); const n = ++count;
    await delay(20); active--;
    if (n === 1) throw new Error('/root/secret password');
    return n;
  };
  const results = await Promise.allSettled([f.client.stop(id), f.client.stop(id), f.client.stop(id)]);
  assert.equal(maximum, 1);
  assert.equal(results[0].reason.message, 'Broker operation failed');
  assert.equal(results[0].reason.code, 'BACKEND_ERROR');
  assert.deepEqual(results.slice(1).map(r => r.value), [2, 3]);
});

test('timed-out running mutation retains serialization lock', async t => {
  const f = await fixture(t);
  let release, started;
  const entered = new Promise(resolve => { started = resolve; });
  const gate = new Promise(resolve => { release = resolve; });
  let active = false;
  f.manager.stop = async () => { active = true; started(); await gate; active = false; return true; };
  f.manager.delete = async () => { assert.equal(active, false); return true; };
  const client = new BrokerClient({ socketPath: f.socketPath, timeoutMs: 30 });
  const first = assert.rejects(client.stop(id), { code: 'TIMEOUT' });
  await entered; await first;
  const second = f.client.delete(id);
  await delay(10); release();
  assert.equal(await second, true);
});

test('bounded mutation queue rejects excess work', async t => {
  const f = await fixture(t, { maxMutations: 1 });
  let release, started;
  const entered = new Promise(resolve => { started = resolve; });
  const gate = new Promise(resolve => { release = resolve; });
  f.manager.stop = async () => { started(); await gate; return true; };
  const first = f.client.stop(id); await entered;
  await assert.rejects(f.client.delete(id), { code: 'BUSY' });
  release(); await first;
});

test('authentication global rate and concurrency limits are bounded', async t => {
  let time = 0, calls = 0;
  const f = await fixture(t, { now: () => time, maxAuthAttempts: 2,
    verifyCredentials: async () => { calls++; return true; } });
  assert.equal(await f.client.verifyCredentials('admin', 'password'), true);
  await f.client.verifyKey(id, 'key');
  await assert.rejects(f.client.verifyCredentials('admin', 'password'), { code: 'RATE_LIMITED', status: 429 });
  assert.equal(calls, 1);
  time = 60000;
  assert.equal(await f.client.verifyCredentials('admin', 'password'), true);
});

test('authentication verifier truthy non-booleans do not authenticate', async t => {
  const f = await fixture(t, { verifyCredentials: async () => ({ authenticated: true }) });
  assert.equal(await f.client.verifyCredentials('admin', 'password'), false);
});

test('missing key/metrics operations fail explicitly, backend secrets never escape', async t => {
  const f = await fixture(t);
  delete f.manager.metrics; delete f.manager.verifyKey; delete f.manager.revealKey;
  for (const request of [f.client.metrics(id), f.client.verifyKey(id, 'key'), f.client.revealKey(id)]) {
    await assert.rejects(request, { code: 'UNAVAILABLE' });
  }
  f.manager.list = async () => { throw new Error('password=secret /root/private'); };
  await assert.rejects(f.client.list(), error => error.code === 'BACKEND_ERROR' && !/secret|private/.test(error.message));
});

test('oversized requests, read deadline, operation deadline and reply size are bounded', async t => {
  const f = await fixture(t, { readTimeoutMs: 30, operationTimeoutMs: 80 });
  assert.equal(await raw(f.socketPath, ' '.repeat(MAX_REQUEST_BYTES + 1)), '');
  assert.equal(await raw(f.socketPath, '{', { end: false }), '');
  assert.deepEqual(f.calls, []);
  f.manager.list = async () => 'x'.repeat(MAX_RESPONSE_BYTES);
  await assert.rejects(f.client.list(), { code: 'RESPONSE_LIMIT' });
  f.manager.list = async () => { await delay(120); return []; };
  await assert.rejects(f.client.list(), /closed without a reply|Unexpected end/);
  await delay(50);
});

test('client refuses oversized requests and invalid transport settings', async () => {
  assert.throws(() => new BrokerClient({ socketPath: '127.0.0.1:1234' }), /Invalid/);
  assert.throws(() => new BrokerClient({ timeoutMs: 0 }), /Invalid/);
  await assert.rejects(new BrokerClient().request('create', ['x'.repeat(MAX_REQUEST_BYTES)]), /too large/);
});

test('root configuration rejects writable ancestors and request-style paths', async t => {
  await assert.rejects(readRootJSON('../config.json'), /Invalid trusted path/);
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'cp-config-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const config = path.join(dir, 'config.json');
  await fs.writeFile(config, '{}', { mode: 0o600 });
  await assert.rejects(readRootJSON(config), /Unsafe root directory/);
});

test('concurrent verifications have a hard two-worker limit', async t => {
  let release, bothStarted, active = 0;
  const gate = new Promise(resolve => { release = resolve; });
  const entered = new Promise(resolve => { bothStarted = resolve; });
  const f = await fixture(t, { verifyCredentials: async () => {
    if (++active === 2) bothStarted();
    await gate; active--; return true;
  } });
  const first = f.client.verifyCredentials('admin', 'password');
  const second = f.client.verifyCredentials('admin', 'password');
  await entered;
  await assert.rejects(f.client.verifyCredentials('admin', 'password'), { code: 'RATE_LIMITED' });
  assert.equal(active, 2);
  release(); assert.deepEqual(await Promise.all([first, second]), [true, true]);
});

test('idle connections cannot exceed configured socket limit', async t => {
  const f = await fixture(t, { maxConnections: 1 });
  const idle = net.createConnection({ path: f.socketPath });
  idle.on('error', () => {});
  t.after(() => idle.destroy());
  await new Promise(resolve => idle.once('connect', resolve));
  await assert.rejects(f.client.list());
  assert.deepEqual(f.calls, []);
  idle.destroy();
});

test('disconnected in-flight read operations retain admission slots until settled', async t => {
  const f = await fixture(t, { maxConnections: 1, operationTimeoutMs: 50 });
  let release, started;
  const entered = new Promise(resolve => { started = resolve; });
  const gate = new Promise(resolve => { release = resolve; });
  f.manager.list = async () => { started(); await gate; return []; };
  const first = assert.rejects(f.client.list());
  await entered; await first;
  await assert.rejects(f.client.usage(), { code: 'BUSY' });
  release(); await delay(10);
  assert.equal((await f.client.usage()).operation, 'usage');
});

test('broker credential forwarding uses existing scrypt schema without exposing verifier', async t => {
  const { scryptSync } = await import('node:crypto');
  const { createAuth, SCRYPT } = await import('../lib/auth.mjs');
  const salt = 'ab'.repeat(32);
  const auth = createAuth({ credentials: { schemaVersion: 1, username: 'admin', salt,
    passwordHash: scryptSync('test password', Buffer.from(salt, 'hex'), 64, SCRYPT).toString('hex') } });
  const f = await fixture(t, { verifyCredentials: (username, password) => auth.verify({ username, password }) });
  assert.equal(await f.client.verifyCredentials('admin', 'test password'), true);
  assert.equal(await f.client.verifyCredentials('other', 'test password'), false);
  assert.equal(await f.client.verifyCredentials('admin', 'incorrect'), false);
});

test('phone key validation permits URL-safe tokens and rejects control characters', () => {
  assert.equal(validateBrokerRequest({ op: 'verifyKey', args: [id, 'abc-DEF_123'] }).args[1], 'abc-DEF_123');
  for (const key of ['bad key', 'bad\nkey', 'bad\0key', 'bad\x7fkey']) {
    assert.throws(() => validateBrokerRequest({ op: 'verifyKey', args: [id, key] }), /Invalid broker request/);
  }
});

// Stream tests use only temporary Unix sockets and a fake worker. No ADB/host commands.
const { default: http } = await import('node:http');
const { once } = await import('node:events');
const { WebSocket, WebSocketServer } = await import('ws');
const { createStreamBroker } = await import('../lib/broker.mjs');
const { STREAM_BUFFER_BYTES, STREAM_CONTROL_BYTES, sendStreamBounded, unixStreamURL } = await import('../lib/broker-client.mjs');
async function eventually(check) {
  for (let i = 0; i < 150; i++) { if (check()) return; await delay(5); }
  assert.ok(check(), 'stream condition did not settle');
}
async function streamFixture(t, options = {}) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'cp-stream-'));
  const workerPath = path.join(dir, 'worker.sock'), streamPath = path.join(dir, 'stream.sock');
  const worker = http.createServer();
  const workerWSS = new WebSocketServer({ server: worker, maxPayload: STREAM_CONTROL_BYTES, perMessageDeflate: false });
  const workerSockets = new Set(), controls = [], resolved = [];
  const packet = Buffer.from([2, 0, 0, 0, 0, 0, 0, 0, 7, 0, 0, 0, 1, 0x65]);
  let activeWorker;
  worker.on('connection', socket => { workerSockets.add(socket); socket.on('close', () => workerSockets.delete(socket)); });
  workerWSS.on('connection', (ws, req) => {
    activeWorker = ws;
    assert.equal(req.url, '/stream');
    ws.on('error', () => {});
    ws.on('message', (data, binary) => {
      assert.equal(binary, false);
      const m = JSON.parse(data); controls.push(m);
      if (m.type === 'start' && !options.silent) {
        ws.send(JSON.stringify({ type: 'metadata', width: 720, height: 1520, codec: 0x68323634, audio: false }));
        ws.send(packet);
      }
    });
  });
  await new Promise(resolve => worker.listen(workerPath, resolve));
  const phone = { id, name: 'Phone', status: 'running', adbPort: 15000, consolePort: 5556, serial: 'emulator-5556' };
  const manager = { capabilities: async () => capabilities(), list: async () => [phone],
    streamSocket: async requested => { resolved.push(requested); return workerPath; }, ...options.manager };
  const proxy = createStreamBroker({ manager, ...options.proxy });
  await new Promise(resolve => proxy.listen(streamPath, resolve));
  t.after(async () => {
    await proxy.closeBroker();
    for (const ws of workerWSS.clients) ws.terminate();
    for (const socket of workerSockets) socket.destroy();
    await new Promise(resolve => workerWSS.close(resolve));
    await new Promise(resolve => worker.close(resolve));
    await fs.rm(dir, { recursive: true, force: true });
  });
  return { dir, workerPath, streamPath, manager, proxy, controls, resolved, phone, packet,
    get workerWS() { return activeWorker; }, client: new BrokerClient({ streamSocketPath: streamPath }) };
}
async function streamConnect(t, socketPath, suffix = `/stream?id=${id}&quality=balanced`, headers = {}) {
  const ws = new WebSocket(unixStreamURL(socketPath, suffix), { headers, perMessageDeflate: false, maxPayload: STREAM_BUFFER_BYTES });
  const messages = [];
  ws.on('error', () => {});
  ws.on('message', (data, binary) => messages.push(binary ? Buffer.from(data) : JSON.parse(data)));
  t.after(() => ws.terminate());
  await once(ws, 'open');
  return { ws, messages };
}
async function rejectStream(socketPath, suffix, status) {
  await new Promise((resolve, reject) => {
    const ws = new WebSocket(unixStreamURL(socketPath, suffix));
    ws.on('error', () => {});
    ws.on('unexpected-response', (_req, res) => {
      res.resume(); ws.terminate();
      try { assert.equal(res.statusCode, status); resolve(); } catch (error) { reject(error); }
    });
    ws.on('open', () => { ws.terminate(); reject(new Error('Unexpected stream upgrade')); });
  });
}

test('real HTTP frontend integrates broker adapter and Unix worker without ADB', async t => {
  const f = await streamFixture(t);
  const { createApplication } = await import('../server.mjs');
  const { scryptSync } = await import('node:crypto');
  const salt = 'ab'.repeat(32), password = 'stream-test-password';
  const credentials = { schemaVersion: 1, username: 'admin', salt,
    passwordHash: scryptSync(password, Buffer.from(salt, 'hex'), 64).toString('hex') };
  // RPC list fixture isolates this test from backend commands; stream adapter is real.
  f.client.list = f.manager.list;
  const app = await createApplication({ credentials, manager: f.client, secureCookies: false, publicOrigin: 'http://localhost' });
  const frontendPath = path.join(f.dir, 'web.sock');
  await new Promise(resolve => app.server.listen(frontendPath, resolve));
  t.after(() => app.close());
  const login = await new Promise((resolve, reject) => {
    const req = http.request({ socketPath: frontendPath, path: '/api/login', method: 'POST',
      headers: { Host: 'localhost', Origin: 'http://localhost', 'Content-Type': 'application/json' } }, res => {
      res.resume(); res.on('end', () => resolve(res));
    });
    req.on('error', reject); req.end(JSON.stringify({ username: 'admin', password }));
  });
  assert.equal(login.statusCode, 200);
  const { ws, messages } = await streamConnect(t, frontendPath, `/stream?id=${id}&quality=sharp`, {
    Origin: 'http://localhost', Cookie: login.headers['set-cookie'][0].split(';')[0],
  });
  await eventually(() => messages.some(Buffer.isBuffer));
  assert.deepEqual(messages.find(Buffer.isBuffer), f.packet);
  assert.deepEqual(f.resolved, [id]);
  assert.deepEqual(f.controls[0], { type: 'start', quality: 'sharp' });
  for (const m of [
    { type: 'key', action: 0, keyCode: 3, repeat: 0, metaState: 0 },
    { type: 'text', text: 'A' }, { type: 'text', text: '你好 🌎' },
    { type: 'touch', id: 9, action: 0, x: 20, y: 30, width: 720, height: 1520, pressure: 0.5 },
    { type: 'scroll', x: 20, y: 30, width: 720, height: 1520, dx: 0.2, dy: -0.5 },
  ]) ws.send(JSON.stringify(m));
  await eventually(() => f.controls.length === 6);
  assert.deepEqual(f.controls.slice(1).map(m => m.type), ['key', 'text', 'text', 'touch', 'scroll']);
  assert.equal(f.controls[3].text, '你好 🌎');
  assert.equal(f.controls[4].id, 9);
  f.workerWS.send(JSON.stringify({ type: 'size', width: 360, height: 760 }));
  await eventually(() => messages.some(m => m.type === 'size'));
  ws.send(JSON.stringify({ type: 'scroll', x: 1, y: 2, width: 360, height: 760, dx: 0, dy: 1 }));
  await eventually(() => f.controls.length === 7);
  assert.equal(f.controls[6].width, 360);
  ws.terminate();
  await eventually(() => f.workerWS.readyState === WebSocket.CLOSED);
});

test('stream proxy rejects invalid queries, paths and absent enforcement before worker access', async t => {
  const f = await streamFixture(t);
  for (const suffix of ['/other', '/stream', `/stream?id=${id}&quality=constructor`,
    '/stream?id=../../etc/passwd&quality=balanced', `/stream?id=${id}&quality=balanced&path=/tmp/x`,
    `/stream?id=${id}&id=${id}&quality=balanced`, `/stream?id=${id}&quality=balanced&quality=sharp`]) {
    await rejectStream(f.streamPath, suffix, 400);
  }
  assert.deepEqual(f.resolved, []);
  f.manager.capabilities = async () => ({ supported: true, checks: {} });
  await rejectStream(f.streamPath, `/stream?id=${id}&quality=balanced`, 503);
  f.manager.capabilities = async () => capabilities(); f.phone.status = 'stopped';
  await rejectStream(f.streamPath, `/stream?id=${id}&quality=balanced`, 409);
  f.phone.status = 'running'; f.manager.streamSocket = async () => '/tmp/worker.sock:/other';
  await rejectStream(f.streamPath, `/stream?id=${id}&quality=balanced`, 503);
  delete f.manager.streamSocket;
  await rejectStream(f.streamPath, `/stream?id=${id}&quality=balanced`, 503);
});

test('proxy denies duplicate phone controllers and disconnects both ends on invalid controls', async t => {
  const f = await streamFixture(t);
  const { ws, messages } = await streamConnect(t, f.streamPath);
  await eventually(() => messages.length >= 2);
  await rejectStream(f.streamPath, `/stream?id=${id}&quality=balanced`, 409);
  ws.send(JSON.stringify({ type: 'shell', command: 'id' }));
  await eventually(() => ws.readyState === WebSocket.CLOSED && f.workerWS.readyState === WebSocket.CLOSED);
  assert.deepEqual(f.controls.map(m => m.type), ['start']);
});

test('oversized and binary controls terminate proxy without dispatch', async t => {
  for (const data of [Buffer.from([1, 2]), 'x'.repeat(STREAM_CONTROL_BYTES + 1)]) {
    const f = await streamFixture(t);
    const { ws, messages } = await streamConnect(t, f.streamPath);
    await eventually(() => messages.length >= 2);
    ws.send(data);
    await eventually(() => ws.readyState === WebSocket.CLOSED && f.workerWS.readyState === WebSocket.CLOSED);
    assert.equal(f.controls.length, 1);
  }
});

test('worker close propagates to frontend adapter and metadata dimensions are validated', async t => {
  const f = await streamFixture(t);
  const frontend = http.createServer();
  const wss = new WebSocketServer({ server: frontend });
  const frontendPath = path.join(f.dir, 'adapter.sock');
  let state, startTask;
  wss.on('connection', ws => {
    state = { phone: f.phone, quality: 'balanced', ws, stopped: false };
    startTask = f.client.startStream(state, m => ws.send(JSON.stringify(m)));
    startTask.catch(() => {});
  });
  await new Promise(resolve => frontend.listen(frontendPath, resolve));
  t.after(async () => {
    for (const ws of wss.clients) ws.terminate();
    await new Promise(resolve => wss.close(resolve));
    await new Promise(resolve => frontend.close(resolve));
  });
  const { ws, messages } = await streamConnect(t, frontendPath, '/stream');
  await eventually(() => messages.some(Buffer.isBuffer)); await startTask;
  assert.equal(state.ready, true); assert.deepEqual(state.video, { width: 720, height: 1520 });
  assert.equal(state.adb, undefined);
  f.workerWS.send(JSON.stringify({ type: 'size', width: -1, height: 500 }));
  await eventually(() => ws.readyState === WebSocket.CLOSED && f.workerWS.readyState === WebSocket.CLOSED);
  assert.equal(state.ready, false);
});

test('stream queue budget terminates rather than dropping a frame', () => {
  const sent = []; let terminated = false;
  const ws = { readyState: WebSocket.OPEN, bufferedAmount: 0,
    send: (...args) => sent.push(args), terminate: () => { terminated = true; } };
  assert.equal(sendStreamBounded(ws, Buffer.alloc(16), true, 16), true);
  ws.bufferedAmount = 1;
  assert.equal(sendStreamBounded(ws, Buffer.alloc(16), true, 16), false);
  assert.equal(sent.length, 1); assert.equal(terminated, true);
  for (const p of ['relative', '/tmp/x:/stream', '/tmp/a?x', '/tmp/../x', '/tmp/x#fragment']) assert.throws(() => unixStreamURL(p, '/stream'));
});

test('worker oversized frames or malformed binary terminate both proxy legs', async t => {
  for (const data of [Buffer.alloc(STREAM_BUFFER_BYTES + 1), Buffer.from([1, 2, 3]), 'x'.repeat(STREAM_CONTROL_BYTES + 1)]) {
    const f = await streamFixture(t);
    const { ws, messages } = await streamConnect(t, f.streamPath);
    await eventually(() => messages.length >= 2);
    f.workerWS.send(data);
    await eventually(() => ws.readyState === WebSocket.CLOSED && f.workerWS.readyState === WebSocket.CLOSED);
  }
});

test('frontend disconnect before metadata rejects adapter startup and closes worker', async t => {
  const f = await streamFixture(t, { silent: true });
  const frontend = http.createServer();
  const wss = new WebSocketServer({ server: frontend });
  const frontendPath = path.join(f.dir, 'cancel.sock');
  let startTask, state;
  wss.on('connection', ws => {
    state = { phone: f.phone, quality: 'balanced', ws, stopped: false };
    startTask = f.client.startStream(state, m => ws.send(JSON.stringify(m)));
    startTask.catch(() => {});
  });
  await new Promise(resolve => frontend.listen(frontendPath, resolve));
  t.after(async () => {
    for (const ws of wss.clients) ws.terminate();
    await new Promise(resolve => wss.close(resolve));
    await new Promise(resolve => frontend.close(resolve));
  });
  const { ws } = await streamConnect(t, frontendPath, '/stream');
  await eventually(() => f.controls.length === 1);
  ws.terminate();
  await assert.rejects(startTask, /stream closed/);
  await eventually(() => f.workerWS.readyState === WebSocket.CLOSED);
  assert.equal(state.ready, false);
});

test('timed-out backend upgrade check retains bounded admission slot and never opens worker', async t => {
  let release, entered;
  const gate = new Promise(resolve => { release = resolve; });
  const started = new Promise(resolve => { entered = resolve; });
  const f = await streamFixture(t, { proxy: { maxConnections: 1, handshakeTimeoutMs: 50 },
    manager: { capabilities: async () => { entered(); await gate; return capabilities(); } } });
  const ws = new WebSocket(unixStreamURL(f.streamPath, `/stream?id=${id}&quality=balanced`));
  ws.on('error', () => {});
  const closed = new Promise(resolve => ws.once('close', resolve));
  await started; await closed;
  await rejectStream(f.streamPath, '/stream?id=fedcba9876543210&quality=balanced', 429);
  release();
  await delay(20);
  assert.equal(f.workerWS, undefined);
});

test('gaming encoded scale and bounded audio pass through real Unix broker transport', async t => {
  const f = await streamFixture(t);
  const { ws, messages } = await streamConnect(t, f.streamPath, `/stream?id=${id}&quality=gaming&scale=0.5`);
  await eventually(() => f.controls.length === 1);
  assert.deepEqual(f.controls[0], { type: 'start', quality: 'gaming', scale: 0.5 });
  f.workerWS.send(JSON.stringify({ type: 'audio', supported: true, codec: 'opus', sampleRate: 48000, channels: 2 }));
  const audio = Buffer.from([3, 0, 0, 0, 0, 0, 1, 0, 0, 0xF8, 0xFF, 0xFE]);
  f.workerWS.send(audio);
  await eventually(() => messages.some(m => m.type === 'audio') && messages.some(m => Buffer.isBuffer(m) && m[0] === 3));
  assert.deepEqual(messages.find(m => Buffer.isBuffer(m) && m[0] === 3), audio);
  ws.terminate();
});

test('encoded scale rejects unsafe, ambiguous or unbounded query values', async t => {
  const f = await streamFixture(t);
  for (const value of ['0', '-1', '2', 'NaN', '0.50', '', '1&scale=0.5']) {
    await rejectStream(f.streamPath, `/stream?id=${id}&quality=gaming&scale=${value}`, 400);
  }
  assert.deepEqual(f.resolved, []);
});

test('media schema restricts audio formats and encoded geometry independently', async () => {
  const { streamScale, audioMetadata, validMediaPacket } = await import('../lib/media-protocol.mjs');
  assert.equal(streamScale(undefined), 1);
  for (const value of [0.5, 0.75, 1]) assert.equal(streamScale(String(value)), value);
  for (const value of [false, [], {}, 0, Infinity, '1e0', '01']) assert.throws(() => streamScale(value));
  const format = { type: 'audio', supported: true, codec: 'pcm', sampleRate: 48000, channels: 2 };
  assert.deepEqual(audioMetadata({ ...format, secret: 'discard' }), format);
  for (const bad of [{ codec: 'aac' }, { sampleRate: 999999 }, { channels: 100 }, { supported: 'true' }]) assert.throws(() => audioMetadata({ ...format, ...bad }));
  assert.deepEqual(audioMetadata({ supported: false, reason: '/private/path' }), { type: 'audio', supported: false, reason: 'unavailable' });
  for (const data of [Buffer.alloc(8), Buffer.alloc(1024*1024+1), Buffer.from([5,0,0,0,0,0,0,0,0])]) assert.equal(validMediaPacket(data), false);
});

test('Unix proxy authenticates the actual descriptor supplied to websocket', async t => {
  const { socketCredentials } = await import('../lib/stream-peer.mjs');
  let observed;
  const f = await streamFixture(t, { proxy: { verifyPeer: async (id, socket) => { observed = await socketCredentials(socket); } } });
  const { messages } = await streamConnect(t, f.streamPath);
  await eventually(() => messages.some(Buffer.isBuffer));
  assert.equal(observed.pid, process.pid); assert.equal(observed.uid, process.getuid());
});

test('failed connected peer authentication prevents websocket upgrade and start', async t => {
  const f = await streamFixture(t, { proxy: { verifyPeer: async () => { throw new Error('wrong peer'); } } });
  await rejectStream(f.streamPath, `/stream?id=${id}&quality=balanced`, 503);
  assert.deepEqual(f.controls, []);
});
