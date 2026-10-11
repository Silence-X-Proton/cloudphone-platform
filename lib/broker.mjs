import net from 'node:net';
import http from 'node:http';
import { WebSocket, WebSocketServer } from 'ws';
import fs from 'node:fs/promises';
import { constants as F } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { PhoneManager, defaultRunner } from './isolation.mjs';
import { createAuth } from './auth.mjs';
import { validateRequest } from './resources.mjs';
import { BROKER_SOCKET, MAX_REQUEST_BYTES, MAX_RESPONSE_BYTES, BROKER_TIMEOUT_MS, STREAM_SOCKET, STREAM_BUFFER_BYTES, STREAM_CONTROL_BYTES, STREAM_QUALITIES, unixStreamURL, sendStreamBounded, validStreamControl } from './broker-client.mjs';

const ID = /^[a-f0-9]{16}$/;
const MUTATIONS = new Set(['create', 'start', 'stop', 'delete']);
const COUNTS = Object.freeze({ list: 0, usage: 0, capabilities: 0, create: 1, start: 1, stop: 1,
  delete: 1, metrics: 1, revealKey: 1, verifyKey: 2, verifyCredentials: 2 });
class BrokerError extends Error {
  constructor(code, message, status) { super(message); this.code = code; this.status = status; }
}
const invalid = () => { throw new BrokerError('INVALID_REQUEST', 'Invalid broker request', 400); };
export function validateBrokerRequest(request) {
  if (!request || typeof request !== 'object' || Array.isArray(request) ||
      Object.keys(request).length !== 2 || !Object.hasOwn(request, 'op') || !Object.hasOwn(request, 'args') ||
      typeof request.op !== 'string' || !Object.hasOwn(COUNTS, request.op) ||
      !Array.isArray(request.args) || request.args.length !== COUNTS[request.op]) invalid();
  const { op, args } = request;
  if (['start', 'stop', 'delete', 'metrics', 'revealKey', 'verifyKey'].includes(op) &&
      (typeof args[0] !== 'string' || !ID.test(args[0]))) invalid();
  if (op === 'create') {
    try {
      if (typeof args[0]?.name !== 'string' || /[\x00-\x1f\x7f]/.test(args[0].name)) invalid();
      return { op, args: [validateRequest(args[0])] };
    } catch { invalid(); }
  }
  if (op === 'verifyKey' && (typeof args[1] !== 'string' || args[1].length < 1 ||
      Buffer.byteLength(args[1]) > 256 || /[\x00-\x20\x7f]/.test(args[1]))) invalid();
  if (op === 'verifyCredentials' && (typeof args[0] !== 'string' || !/^[A-Za-z0-9_.@-]{1,64}$/.test(args[0]) ||
      typeof args[1] !== 'string' || !args[1].length || Buffer.byteLength(args[1]) > 1024)) invalid();
  return { op, args };
}

function enforced(c) {
  return c?.supported === true && c.checks && Object.keys(c.checks).length > 0 &&
    Object.values(c.checks).every(check => check?.ok === true) &&
    c.checks.networkIsolation?.ok === true && c.checks.streamingIsolation?.ok === true;
}
function publicCapabilities(c) {
  return { ...c, supported: !!enforced(c), checks: { ...c?.checks,
    brokerEnforcement: { ok: !!enforced(c), ...(!enforced(c) ? { reason: 'Validated network and streaming isolation required' } : {}) } } };
}

/** Injectable transport for mocked tests. Production must use startBroker(), not bare listen(). */
export function createBroker({ manager, verifyCredentials = async () => false, sharedSdkBytes = async () => null,
  readTimeoutMs = 5000, operationTimeoutMs = BROKER_TIMEOUT_MS, maxConnections = 32,
  maxMutations = 16, maxAuthAttempts = 20, now = Date.now } = {}) {
  if (!manager) throw new Error('Manager required');
  for (const n of [readTimeoutMs, operationTimeoutMs, maxConnections, maxMutations, maxAuthAttempts]) {
    if (!Number.isSafeInteger(n) || n < 1) throw new Error('Invalid broker limit');
  }
  const sockets = new Set(); let inFlight = 0, mutationCount = 0, authCount = 0;
  let authUntil = 0, authAttempts = 0, queue = Promise.resolve();
  const dispatch = async ({ op, args }, socket) => {
    if (typeof manager[op] !== 'function' && op !== 'verifyCredentials') throw new BrokerError('UNAVAILABLE', 'Broker operation unavailable', 503);
    if (op === 'verifyCredentials' || op === 'verifyKey') {
      if (now() >= authUntil) { authUntil = now() + 60_000; authAttempts = 0; }
      if (++authAttempts > maxAuthAttempts || authCount >= 2) throw new BrokerError('RATE_LIMITED', 'Authentication rate limit', 429);
      authCount++;
      try { return op === 'verifyCredentials' ? (await verifyCredentials(...args)) === true : await manager.verifyKey(...args); }
      finally { authCount--; }
    }
    if (op === 'usage') return { ...await manager.usage(), sharedSdkBytes: await sharedSdkBytes() };
    if (op === 'capabilities') return publicCapabilities(await manager.capabilities());
    if (!MUTATIONS.has(op)) return manager[op](...args);
    if (mutationCount >= maxMutations) throw new BrokerError('BUSY', 'Mutation queue full', 503);
    mutationCount++;
    const task = queue.catch(() => {}).then(async () => {
      // A queued request abandoned before execution must not start new work.
      if (socket.destroyed) throw new BrokerError('CANCELLED', 'Connection closed', 503);
      if (['create', 'start'].includes(op) && !enforced(await manager.capabilities())) {
        throw new BrokerError('ENFORCEMENT_UNAVAILABLE', 'Strict isolation enforcement unavailable', 503);
      }
      return manager[op](...args);
    });
    queue = task;
    try { return await task; } finally { mutationCount--; }
  };
  const server = net.createServer({ allowHalfOpen: true }, socket => {
    if (sockets.size >= maxConnections) { socket.destroy(); return; }
    sockets.add(socket);
    const chunks = []; let size = 0, replied = false;
    const send = reply => {
      if (replied || socket.destroyed) return;
      replied = true; clearTimeout(readTimer);
      let body;
      try { body = JSON.stringify(reply); } catch { body = ''; }
      if (!body || Buffer.byteLength(body) > MAX_RESPONSE_BYTES) {
        body = JSON.stringify({ ok: false, error: { code: 'RESPONSE_LIMIT', message: 'Broker response unavailable', status: 503 } });
      }
      socket.end(body);
    };
    const fail = error => send({ ok: false, error: error instanceof BrokerError ?
      { code: error.code, message: error.message, status: error.status } :
      { code: 'BACKEND_ERROR', message: 'Broker operation failed', status: 503 } });
    const readTimer = setTimeout(() => socket.destroy(), readTimeoutMs);
    const deadline = setTimeout(() => socket.destroy(), operationTimeoutMs);
    socket.on('error', () => {});
    socket.on('close', () => { clearTimeout(readTimer); clearTimeout(deadline); sockets.delete(socket); });
    socket.on('data', chunk => {
      if (replied) return;
      size += chunk.length;
      if (size > MAX_REQUEST_BYTES) { socket.destroy(); return; }
      chunks.push(chunk);
    });
    socket.on('end', async () => {
      clearTimeout(readTimer);
      if (socket.destroyed || replied) return;
      let request;
      try { request = validateBrokerRequest(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks)))); }
      catch { fail(new BrokerError('INVALID_REQUEST', 'Invalid broker request', 400)); return; }
      if (inFlight >= maxConnections) { fail(new BrokerError('BUSY', 'Broker busy', 503)); return; }
      inFlight++;
      try { send({ ok: true, result: (await dispatch(request, socket)) ?? null }); }
      catch (error) { fail(error); }
      finally { inFlight--; }
    });
  });
  server.closeBroker = async () => {
    for (const socket of sockets) socket.destroy();
    await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    await queue.catch(() => {});
  };
  return server;
}

function trustedPath(value) {
  if (typeof value !== 'string' || !/^\/[A-Za-z0-9_./-]+$/.test(value) || value === '/' || path.normalize(value) !== value) throw new Error('Invalid trusted path');
  return value;
}
async function trustedDirectory(dir) {
  trustedPath(dir);
  for (let current = dir; current !== '/'; current = path.dirname(current)) {
    const st = await fs.lstat(current);
    if (!st.isDirectory() || st.isSymbolicLink() || st.uid !== 0 || st.mode & 0o022) throw new Error('Unsafe root directory');
  }
  if (await fs.realpath(dir) !== dir) throw new Error('Noncanonical root directory');
}
export async function readRootJSON(filename) {
  trustedPath(filename); await trustedDirectory(path.dirname(filename));
  const handle = await fs.open(filename, F.O_RDONLY | F.O_NOFOLLOW | F.O_NONBLOCK);
  try {
    const st = await handle.stat();
    if (!st.isFile() || st.uid !== 0 || (st.mode & 0o777) !== 0o600 || st.nlink !== 1 || st.size > 65536) throw new Error('Unsafe root JSON file');
    const buffer = Buffer.alloc(65537);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    if (bytesRead > 65536) throw new Error('Root JSON too large');
    return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(buffer.subarray(0, bytesRead)));
  } finally { await handle.close(); }
}
function sdkMeter(sdkDir) {
  let expires = 0, cached = null, pending;
  return async () => {
    if (Date.now() < expires) return cached;
    if (!pending) pending = (async () => {
      try {
        const result = await defaultRunner('/usr/bin/du', ['-s', '-B1', '-x', '--', sdkDir], { timeout: 15000, maxBuffer: 4096 });
        const match = /^(\d+)\s/.exec(result.stdout);
        const bytes = match ? Number(match[1]) : NaN;
        cached = result.code === 0 && Number.isSafeInteger(bytes) && bytes >= 0 ? bytes : null;
      } catch { cached = null; }
      finally { expires = Date.now() + 60000; pending = undefined; }
      return cached;
    })();
    return pending;
  };
}

/** Root-only production entry point. No request may affect these options. */
export async function startBroker({ configFile = process.env.CONFIG_FILE } = {}) {
  if (process.getuid?.() !== 0) throw new Error('Broker must run as root');
  const config = await readRootJSON(configFile);
  if (config?.schemaVersion !== 1 || !['dashboard', 'standalone'].includes(config.mode)) throw new Error('Invalid root configuration');
  for (const key of ['stateDir', 'sdkDir', 'credentialsFile']) trustedPath(config[key]);
  await trustedDirectory(config.stateDir); await trustedDirectory(config.sdkDir);
  const auth = createAuth({ credentials: await readRootJSON(config.credentialsFile) });
  const manager = new PhoneManager({ stateDir: config.stateDir, sdkDir: config.sdkDir, config });
  const groups = (await fs.readFile('/etc/group', 'utf8')).split('\n').filter(line => line.startsWith('cloudphone-web:'));
  if (groups.length !== 1 || !/^\d+$/.test(groups[0].split(':')[2])) throw new Error('cloudphone-web group required');
  const gid = Number(groups[0].split(':')[2]);
  if (!Number.isSafeInteger(gid) || gid < 1 || gid > 2147483647) throw new Error('Unsafe broker group');
  const dir = path.dirname(BROKER_SOCKET);
  await trustedDirectory(path.dirname(dir));
  try { await fs.mkdir(dir, { mode: 0o750 }); } catch (error) { if (error.code !== 'EEXIST') throw error; }
  await trustedDirectory(dir);
  await fs.chown(dir, 0, gid); await fs.chmod(dir, 0o750);
  for (const socketPath of [BROKER_SOCKET, STREAM_SOCKET]) {
    try { await fs.lstat(socketPath); throw new Error('Broker socket already exists; offline cleanup required'); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
  const server = createBroker({ manager, verifyCredentials: (username, password) => auth.verify({ username, password }), sharedSdkBytes: sdkMeter(config.sdkDir) });
  const streams = createStreamBroker({ manager });
  const closeRPC = server.closeBroker;
  server.closeBroker = async () => { await streams.closeBroker(); await closeRPC(); };
  // No group access until final chmod; no permissive socket creation window.
  const oldMask = process.umask(0o077);
  try {
    for (const [listener, socketPath] of [[server, BROKER_SOCKET], [streams, STREAM_SOCKET]]) {
      await new Promise((resolve, reject) => { listener.once('error', reject); listener.listen(socketPath, resolve); });
      await fs.chown(socketPath, 0, gid); await fs.chmod(socketPath, 0o660);
      const st = await fs.lstat(socketPath);
      if (!st.isSocket() || st.uid !== 0 || st.gid !== gid || (st.mode & 0o777) !== 0o660) throw new Error('Unsafe broker socket');
    }
  } catch (error) { if (server.listening) await server.closeBroker(); throw error; }
  finally { process.umask(oldMask); }
  return server;
}
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try {
    const server = await startBroker();
    let stopping = false;
    for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => {
      if (stopping) return; stopping = true;
      void server.closeBroker().catch(() => { process.exitCode = 1; });
    });
  } catch (error) { console.error('Broker startup failed:', error.message); process.exitCode = 1; }
}

/** Unix-only in production; injectable manager/listen path for mock-worker tests. */
export function createStreamBroker({ manager, maxConnections = 32, handshakeTimeoutMs = 10000 } = {}) {
  if (!manager || !Number.isSafeInteger(maxConnections) || maxConnections < 1 ||
      !Number.isSafeInteger(handshakeTimeoutMs) || handshakeTimeoutMs < 1) throw new Error('Invalid stream broker settings');
  const wss = new WebSocketServer({ noServer: true, maxPayload: STREAM_CONTROL_BYTES, perMessageDeflate: false });
  const sockets = new Set(), sessions = new Set(), ids = new Set();
  let pending = 0, closing = false, closeTask;
  const server = http.createServer({ maxHeaderSize: 4096 }, (_req, res) => {
    res.writeHead(404, { Connection: 'close', 'Content-Length': 0 }); res.end();
  });
  server.maxConnections = maxConnections;
  server.headersTimeout = handshakeTimeoutMs; server.requestTimeout = handshakeTimeoutMs;
  server.on('clientError', (_error, socket) => socket.destroy());
  server.on('connection', socket => {
    if (closing || sockets.size >= maxConnections) { socket.destroy(); return; }
    sockets.add(socket);
    const timer = setTimeout(() => socket.destroy(), handshakeTimeoutMs);
    socket.once('close', () => { clearTimeout(timer); sockets.delete(socket); });
    socket.once('streamUpgraded', () => clearTimeout(timer));
    socket.on('error', () => {});
  });
  server.on('upgrade', async (req, socket, head) => {
    let id, ownsId = false, admitted = false, transferred = false;
    const reject = status => { if (!socket.destroyed) socket.end(`HTTP/1.1 ${status} Rejected\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`); };
    try {
      if (closing || req.method !== 'GET' || !req.url?.startsWith('/stream?') || head.length > STREAM_CONTROL_BYTES) return reject(400);
      const url = new URL(req.url, 'http://localhost');
      id = url.searchParams.get('id'); const quality = url.searchParams.get('quality');
      if (url.pathname !== '/stream' || url.hash || !ID.test(id ?? '') || !STREAM_QUALITIES.includes(quality) ||
          [...url.searchParams.keys()].length !== 2 || url.searchParams.getAll('id').length !== 1 || url.searchParams.getAll('quality').length !== 1) return reject(400);
      if (pending + sessions.size >= maxConnections) return reject(429);
      if (ids.has(id)) return reject(409);
      pending++; admitted = true; ids.add(id); ownsId = true;
      if (typeof manager.streamSocket !== 'function' || !enforced(await manager.capabilities())) return reject(503);
      const phones = await manager.list();
      if (!phones.some(phone => phone.id === id && phone.status === 'running')) return reject(409);
      // streamSocket must verify identity, mounts, namespaces and live unit limits.
      // Root-configured backend is the ONLY source of paths. Never return this path to HTTP.
      const target = unixStreamURL(await manager.streamSocket(id), '/stream');
      if (socket.destroyed || closing) return;
      wss.handleUpgrade(req, socket, head, downstream => {
        transferred = true;
        socket.emit('streamUpgraded'); socket.setTimeout(0);
        const session = { downstream, upstream: null, alive: true, closed: false };
        sessions.add(session);
        let tokens = 360, refill = performance.now();
        const finish = () => {
          if (session.closed) return;
          session.closed = true; sessions.delete(session); ids.delete(id);
          downstream.terminate(); session.upstream?.terminate();
        };
        session.close = finish;
        downstream.on('error', finish); downstream.once('close', finish);
        downstream.on('pong', () => { session.alive = true; });
        const upstream = new WebSocket(target, { maxPayload: STREAM_BUFFER_BYTES, perMessageDeflate: false, handshakeTimeout: handshakeTimeoutMs });
        session.upstream = upstream;
        upstream.on('error', finish); upstream.once('close', finish);
        upstream.once('open', () => {
          if (session.closed || !sendStreamBounded(upstream, JSON.stringify({ type: 'start', quality }), false, STREAM_CONTROL_BYTES)) finish();
        });
        downstream.on('message', (data, binary) => {
          const now = performance.now(); tokens = Math.min(360, tokens + (now - refill) * 0.24); refill = now;
          try {
            if (session.closed || binary || data.length > STREAM_CONTROL_BYTES || --tokens < 0 ||
                !validStreamControl(JSON.parse(data.toString())) || !sendStreamBounded(upstream, data, false, STREAM_CONTROL_BYTES)) finish();
          } catch { finish(); }
        });
        upstream.on('message', (data, binary) => {
          if (session.closed || (!binary && data.length > STREAM_CONTROL_BYTES) ||
              (binary && (data.length < 9 || ![0, 1, 2].includes(data[0]))) || !sendStreamBounded(downstream, data, binary)) finish();
        });
      });
    } catch { reject(503); }
    finally { if (admitted) pending--; if (ownsId && !transferred) ids.delete(id); }
  });
  const heartbeat = setInterval(() => {
    for (const session of sessions) {
      if (!session.alive) { session.close(); continue; }
      session.alive = false;
      if (session.downstream.readyState === WebSocket.OPEN) session.downstream.ping();
    }
  }, 15000);
  heartbeat.unref();
  server.closeBroker = () => closeTask ??= (async () => {
    closing = true; clearInterval(heartbeat);
    for (const session of sessions) session.close();
    for (const socket of sockets) socket.destroy();
    await new Promise(resolve => wss.close(resolve));
    if (server.listening) await new Promise(resolve => server.close(resolve));
  })();
  return server;
}
