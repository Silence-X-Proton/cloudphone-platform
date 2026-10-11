import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import { Readable } from 'node:stream';
import { randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { WebSocketServer, WebSocket } from 'ws';
import { AdbServerClient } from '@yume-chan/adb';
import { AdbServerNodeTcpConnector } from '@yume-chan/adb-server-node-tcp';
import { AdbScrcpyClient, AdbScrcpyOptions3_3_1 } from '@yume-chan/adb-scrcpy';

import { createAuth, originAllowed } from './lib/auth.mjs';
import { validateRequest } from './lib/resources.mjs';
import { streamScale, streamAudio } from './lib/media-protocol.mjs';
export { originAllowed };
const ROOT = path.dirname(fileURLToPath(import.meta.url));
const int = (n, min, max) => Number.isInteger(n) && n >= min && n <= max;
const finite = (n, min, max) => Number.isFinite(n) && n >= min && n <= max;
const keyCodes = new Set([3, 4, 19, 20, 21, 22, 23, 24, 25, 61, 62, 66, 67, 92, 93, 111, 112, 122, 123, 124, 187, ...Array.from({length: 26}, (_, i) => 29 + i), ...Array.from({length: 10}, (_, i) => 7 + i)]);

// No client-supplied shell, app names, paths, or ADB service names are accepted.
export function validateControl(m) {
  if (m?.type === 'keyframe') return Object.keys(m).length === 1;
  if (!m || typeof m !== 'object' || Array.isArray(m)) return false;
  const fields = { key: ['type', 'keyCode', 'action', 'repeat', 'metaState'], text: ['type', 'text'],
    touch: ['type', 'id', 'action', 'x', 'y', 'width', 'height', 'pressure'], scroll: ['type', 'x', 'y', 'width', 'height', 'dx', 'dy'] };
  if (!Object.hasOwn(fields, m.type) || Object.keys(m).some(k => !fields[m.type].includes(k))) return false;
  if (m.type === 'key') return keyCodes.has(m.keyCode) && int(m.action, 0, 1) && int(m.repeat ?? 0, 0, 30) && int(m.metaState ?? 0, 0, 0x7fffffff);
  if (m.type === 'text') return typeof m.text === 'string' && m.text.length > 0 && Buffer.byteLength(m.text) <= 4096 && !m.text.includes('\0');
  if (m.type === 'touch' || m.type === 'scroll') {
    if (!int(m.width, 1, 8192) || !int(m.height, 1, 8192) || !int(m.x, 0, m.width - 1) || !int(m.y, 0, m.height - 1)) return false;
    if (m.type === 'touch') return int(m.id, 0, 2147483647) && [0, 1, 2, 3].includes(m.action) && finite(m.pressure, 0, 1);
    return finite(m.dx, -1, 1) && finite(m.dy, -1, 1);
  }
  return false;
}

// One WS binary message: flags u8 (1=config, 2=key), PTS microseconds u64 BE,
// then an intact Annex-B H.264 packet. No conversion to milliseconds.
export function encodePacket(packet) {
  const header = Buffer.alloc(9);
  header[0] = packet.type === 'configuration' ? 1 : packet.keyframe ? 2 : 0;
  header.writeBigUInt64BE(packet.type === 'data' ? (packet.pts ?? 0n) : 0n, 1);
  return Buffer.concat([header, packet.data]);
}

export const QUALITY = Object.freeze({
  gaming: Object.freeze({ videoBitRate: 1800000, maxSize: 900, maxFps: 60 }),
  economy: Object.freeze({ videoBitRate: 1500000, maxSize: 720, maxFps: 24 }),
  balanced: Object.freeze({ videoBitRate: 4000000, maxSize: 1140, maxFps: 30 }),
  sharp: Object.freeze({ videoBitRate: 6000000, maxSize: 1600, maxFps: 30 }),
});
const ID_RE = /^[a-f0-9]{16}$/;
export function validatePhoneIdentity(phone) {
  if (!phone || !ID_RE.test(phone.id) || !int(phone.adbPort, 15000, 15030) ||
      !int(phone.consolePort, 5556, 5616) || phone.consolePort % 2 || phone.serial !== `emulator-${phone.consolePort}`) throw new Error('Invalid managed phone identity');
}
export function sendPacket(ws, packet, limit = 4 * 1024 * 1024) {
  if (ws.readyState !== WebSocket.OPEN) return false;
  // Close rather than drop any delta/config packet: a reconnect creates a new decoder sequence.
  if (ws.bufferedAmount + packet.data.byteLength + 9 > limit) {
    ws.close(1013, 'Slow connection; reconnect for a fresh keyframe'); return false;
  }
  ws.send(encodePacket(packet)); return true;
}

export async function startDevice(state, send) {
  validatePhoneIdentity(state.phone);
  if (!QUALITY[state.quality] || !path.isAbsolute(state.scrcpyServer)) throw new Error('Invalid streaming configuration');
  const adbServer = new AdbServerClient(new AdbServerNodeTcpConnector({host: '127.0.0.1', port: state.phone.adbPort}));
  state.adb = await adbServer.createAdb({serial: state.phone.serial});
  if (state.stopped) return;
  // Dedicated filename and socket ID prevent collisions with unrelated scrcpy users.
  const devicePath = '/data/local/tmp/cloudphone-scrcpy-server.jar';
  await AdbScrcpyClient.pushServer(state.adb, Readable.toWeb(createReadStream(state.scrcpyServer)), devicePath);
  if (state.stopped) return;
  state.client = await AdbScrcpyClient.start(state.adb, devicePath, new AdbScrcpyOptions3_3_1({
    scid: randomBytes(4).readUInt32BE().toString(16).slice(0, 7),
    videoCodec: 'h264', ...QUALITY[state.quality],
    audio: false, control: true, tunnelForward: true, clipboardAutosync: true,
    sendFrameMeta: true, sendCodecMeta: true, sendDeviceMeta: true,
    cleanup: false,
  }, {version: '3.3.3'}));
  // Drain output and device clipboard even when UI does not consume them.
  const drain = async (stream, log = false) => {
    if (!stream) return;
    const reader = stream.getReader();
    try { while (true) { const {done, value} = await reader.read(); if (done) break; if (log) console.log('[scrcpy]', value); } }
    catch (error) { if (!state.stopped) console.warn('[scrcpy stream]', error.message); }
    finally { reader.releaseLock(); }
  };
  void drain(state.client.output, true);
  void drain(state.client.clipboard);
  if (state.stopped) return;
  const video = await state.client.videoStream;
  state.video = video;
  send({type: 'metadata', ...video.metadata, audio: false, android: 'Android 16 · Google image'});
  video.sizeChanged(size => send({type: 'size', ...size}));
  state.ready = true;
  state.reader = video.stream.getReader();
  state.pump = (async () => {
    try {
      while (!state.stopped) {
        const {done, value} = await state.reader.read();
        if (done) break;
        if (state.ws.readyState !== WebSocket.OPEN) break;
        // Never discard arbitrary deltas: reconnect launches a fresh config + IDR.
        if (!sendPacket(state.ws, value)) break;
      }
    } catch (error) { if (!state.stopped) console.warn('[video]', error.message); }
    finally { if (!state.stopped) state.ws.close(1011, 'Video ended'); }
  })();
}

class HttpError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}
const fail = (status, message) => { throw new HttpError(status, message); };
async function readBody(req, limit, required = false) {
  if (Number(req.headers['content-length']) > limit) { req.resume(); fail(413, 'Body too large'); }
  const parts = []; let size = 0;
  for await (const chunk of req.iterator({ destroyOnReturn: false })) {
    size += chunk.length;
    if (size > limit) { req.resume(); fail(413, 'Body too large'); }
    parts.push(chunk);
  }
  if (!size && !required) return undefined;
  if (!/^application\/json(?:\s*;.*)?$/i.test(req.headers['content-type'] ?? '')) fail(415, 'JSON required');
  let value;
  try { value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(parts))); } catch { fail(400, 'Invalid JSON'); }
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail(400, 'JSON object required');
  return value;
}
function onlyQuery(url, allowed) {
  for (const key of url.searchParams.keys()) if (!allowed.includes(key) || url.searchParams.getAll(key).length !== 1) fail(400, 'Invalid query');
}
function publicPhone(phone, metrics = {}) {
  const out = {};
  metrics = { ...metrics, memoryBytes: metrics?.memoryCurrentBytes ?? metrics?.memoryBytes };
  for (const key of ['id', 'name', 'guestRamMiB', 'hostMemoryMiB', 'diskGiB', 'status']) out[key] = phone[key];
  for (const key of ['memoryBytes', 'diskUsedBytes']) out[key] = Number.isSafeInteger(metrics?.[key]) && metrics[key] >= 0 ? metrics[key] : null;
  return out;
}
export function mapResources(usage, capabilities) {
  const host = {};
  for (const key of ['memoryTotalBytes', 'memoryAvailableBytes', 'memoryAllocatableBytes', 'memoryReserveBytes', 'diskTotalBytes', 'diskAvailableBytes', 'diskAllocatableBytes', 'diskReserveBytes']) host[key] = usage[key] ?? null;
  return { host, reserved: { memoryBytes: usage.memoryReservedBytes ?? null, diskBytes: usage.diskCommittedBytes ?? null },
    sharedSdkBytes: usage.sharedSdkBytes ?? null,
    capabilities: { ...capabilities, ok: capabilities.supported === true,
      reasons: Object.entries(capabilities.checks ?? {}).filter(([, v]) => v?.ok !== true).map(([key, value]) => `${key}: ${value?.reason ?? 'unavailable'}`) } };
}

export async function createApplication({ credentials, manager, mode = 'dashboard', deviceStarter,
  scrcpyServer = '/opt/cloudphone-sdk/api36-v1/scrcpy-server.jar', secureCookies = true, publicOrigin,
  bodyLimit = 8192, maxConnections = 128, startupTimeoutMs = 25000, ...authOptions } = {}) {
  if (!['dashboard', 'standalone'].includes(mode)) throw new Error('Invalid mode');
  if (!manager || typeof manager.list !== 'function') throw new Error('Phone manager required');
  if (!int(bodyLimit, 256, 65536) || !int(maxConnections, 1, 1024) || !int(startupTimeoutMs, 1, 120000)) throw new Error('Invalid server limits');
  const auth = createAuth({ ...authOptions, credentials, secureCookies, publicOrigin });
  // A manager-owned worker must place streaming inside the phone memory cgroup.
  // There is deliberately no in-process production fallback.
  deviceStarter ??= async (state, send) => {
    if (typeof manager.startStream !== 'function') throw new Error('Isolated streaming worker unavailable');
    await manager.startStream(state, send);
  };
  const inventory = async () => {
    const phones = await manager.list();
    if (!Array.isArray(phones)) throw new Error('Invalid inventory');
    if (mode === 'standalone' && phones.length > 1) fail(409, 'Standalone permits at most one phone');
    return phones;
  };
  await inventory();
  const findPhone = async id => {
    if (!ID_RE.test(id ?? '')) fail(400, 'Invalid phone ID');
    const phone = (await inventory()).find(p => p.id === id);
    if (!phone) fail(404, 'Phone not found');
    return phone;
  };
  const slots = new Map(); let shuttingDown = false;
  const slotFor = id => {
    let slot = slots.get(id);
    if (!slot) { slot = { active: null, queue: Promise.resolve(), pending: 0 }; slots.set(id, slot); }
    return slot;
  };
  const enqueue = (id, fn) => {
    const slot = slotFor(id); slot.pending++;
    const job = slot.queue.catch(() => {}).then(() => fn(slot));
    slot.queue = job.catch(() => {}).finally(() => {
      slot.pending--;
      if (!slot.pending && !slot.active && slots.get(id) === slot) slots.delete(id);
    });
    return job;
  };
  const stop = async state => {
    if (!state) return;
    state.stopped = true; state.ready = false; clearTimeout(state.startTimer);
    state.cancelStart?.(); state.cancelStart = null;
    if (state.ws.readyState === WebSocket.OPEN) state.ws.close(1000, 'Controller closed');
    // A late startup may assign resources after an earlier stop. Capture and clear
    // each handle rather than marking the entire state permanently cleaned.
    const reader = state.reader, client = state.client, adb = state.adb;
    state.reader = null; state.client = null; state.adb = null;
    await Promise.allSettled([reader?.cancel(), client?.close(), adb?.close()]);
  };
  const expireControllers = () => {
    for (const slot of slots.values()) if (slot.active && !auth.sessions.has(slot.active.sessionId)) slot.active.ws.close(4001, 'Session expired');
  };
  const json = (res, status, data, headers = {}) => {
    res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', ...headers }); res.end(JSON.stringify(data));
  };
  const sessionData = session => ({ username: session.role === 'phone' ? 'Phone access' : auth.username, csrf: session.csrf, mode, role: session.role, ...(session.phoneId ? { phoneId: session.phoneId } : {}) });
  const authorizePhone = (session, id) => { if (session.role === 'phone' && session.phoneId !== id) fail(403, 'Phone access denied'); };
  let keyVerifications = 0;
  const server = http.createServer(async (req, res) => {
    for (const [key, value] of Object.entries({ 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff',
      'Referrer-Policy': 'no-referrer', 'X-Frame-Options': 'DENY',
      'Content-Security-Policy': "default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self' data:; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'" })) res.setHeader(key, value);
    try {
      if (shuttingDown) fail(503, 'Server stopping');
      const url = new URL(req.url, 'http://localhost');
      const mutating = !['GET', 'HEAD', 'OPTIONS'].includes(req.method);
      if (mutating && !auth.allowed(req)) fail(403, 'Origin rejected');
      if (url.pathname === '/api/login' && req.method === 'POST') {
        onlyQuery(url, []);
        if (!auth.attempt(req.socket.remoteAddress)) fail(429, 'Too many attempts');
        const body = await readBody(req, bodyLimit, true);
        let scope = {};
        if (Object.hasOwn(body, 'phoneId') || Object.hasOwn(body, 'key')) {
          if (Object.keys(body).some(k => !['phoneId', 'key'].includes(k)) || !ID_RE.test(body.phoneId ?? '') ||
              typeof body.key !== 'string' || !body.key.length || Buffer.byteLength(body.key) > 256) fail(401, 'Invalid phone credentials');
          if (keyVerifications >= 2) fail(429, 'Authentication busy');
          keyVerifications++;
          let valid = false;
          try { valid = (await manager.verifyKey?.(body.phoneId, body.key)) === true; } finally { keyVerifications--; }
          if (!valid) fail(401, 'Invalid phone credentials');
          await findPhone(body.phoneId);
          scope = { phoneId: body.phoneId };
        } else if (!await auth.verify(body)) fail(401, 'Invalid username or password');
        const session = auth.issue(auth.session(req), scope); expireControllers();
        return json(res, 200, sessionData(session), { 'Set-Cookie': auth.cookie(session.id) });
      }
      if (url.pathname.startsWith('/api/')) {
        const session = auth.session(req);
        if (!session) fail(401, 'Sign in required');
        if (mutating) {
          if (!auth.csrf(req, session)) fail(403, 'CSRF token rejected');
          const stored = auth.sessions.get(session.id), time = Date.now();
          if (!stored.rate || stored.rate.until <= time) stored.rate = { count: 0, until: time + 60_000 };
          if (++stored.rate.count > 60) fail(429, 'Mutation rate exceeded');
        }
        onlyQuery(url, url.pathname === '/api/health' ? ['id'] : []);
        if (url.pathname === '/api/session' && req.method === 'GET') return json(res, 200, sessionData(session));
        if (url.pathname === '/api/logout' && req.method === 'POST') {
          const body = await readBody(req, bodyLimit);
          if (body && Object.keys(body).length) fail(400, 'Unexpected fields');
          auth.revoke(session.id); expireControllers();
          return json(res, 200, { ok: true }, { 'Set-Cookie': auth.cookie() });
        }
        if (session.role === 'phone' && (mutating || !['/api/session', '/api/phones', '/api/health'].includes(url.pathname))) fail(403, 'Administrator required');
        if (url.pathname === '/api/resources' && req.method === 'GET') {
          await inventory();
          const [usage, capabilities] = await Promise.all([manager.usage(), manager.capabilities()]);
          return json(res, 200, mapResources(usage, capabilities));
        }
        if (url.pathname === '/api/phones' && req.method === 'GET') {
          const phones = (await inventory()).filter(p => session.role !== 'phone' || p.id === session.phoneId);
          return json(res, 200, { phones: await Promise.all(phones.map(async p => publicPhone(p, await manager.metrics?.(p.id)))) });
        }
        if (url.pathname === '/api/health' && req.method === 'GET') {
          authorizePhone(session, url.searchParams.get('id'));
          const phone = await findPhone(url.searchParams.get('id'));
          return json(res, 200, { ok: true, id: phone.id, status: phone.status, serial: phone.serial,
            streaming: !!slots.get(phone.id)?.active?.ready, android: 'Android 16 (API 36), Google image', audio: slots.get(phone.id)?.active?.audio ?? { supported: false, reason: 'unavailable' } });
        }
        if (url.pathname === '/api/phones' && req.method === 'POST') {
          if (mode === 'standalone') fail(403, 'Standalone provisioning is installer-only');
          let input;
          try { input = validateRequest(await readBody(req, bodyLimit, true)); }
          catch (e) { if (e.status) throw e; fail(400, 'Invalid phone resource request'); }
          if (!(await manager.capabilities()).supported) fail(503, 'Strict isolation unavailable');
          const phone = await manager.create(input);
          return json(res, 201, { phone: publicPhone(phone), id: phone.id });
        }
        const reveal = /^\/api\/phones\/([a-f0-9]{16})\/key$/.exec(url.pathname);
        if (reveal && req.method === 'POST') {
          const body = await readBody(req, bodyLimit);
          if (body && Object.keys(body).length) fail(400, 'Unexpected fields');
          await findPhone(reveal[1]);
          if (typeof manager.revealKey !== 'function') fail(503, 'Key access unavailable');
          return json(res, 200, { id: reveal[1], key: await manager.revealKey(reveal[1]) });
        }
        const route = /^\/api\/phones\/([a-f0-9]{16})(?:\/(start|stop))?$/.exec(url.pathname);
        if (route && (req.method === 'DELETE' && !route[2] || req.method === 'POST' && route[2])) {
          if (mode === 'standalone' && req.method === 'DELETE') fail(403, 'Standalone phone cannot be deleted');
          const body = await readBody(req, bodyLimit);
          if (body && Object.keys(body).length) fail(400, 'Unexpected fields');
          await findPhone(route[1]);
          const result = await enqueue(route[1], async slot => {
            await findPhone(route[1]);
            if (route[2] !== 'start') { const state = slot.active; slot.active = null; await stop(state); }
            if (route[2] === 'start' && !(await manager.capabilities()).supported) fail(503, 'Strict isolation unavailable');
            return manager[route[2] ?? 'delete'](route[1]);
          });
          return json(res, 200, { ok: true, ...(result ? { phone: publicPhone(result) } : {}) });
        }
        fail(404, 'Not found');
      }
      const files = { '/': [mode === 'standalone' ? 'phone.html' : 'index.html', 'text/html'],
        '/phone': ['phone.html', 'text/html'], '/phone.html': ['phone.html', 'text/html'],
        '/style.css': ['style.css', 'text/css'], '/client.js': ['client.js', 'text/javascript'],
        ...(mode === 'dashboard' ? { '/index.html': ['index.html', 'text/html'], '/app.js': ['app.js', 'text/javascript'] } : {}) };
      const file = files[url.pathname];
      if (!file || !['GET', 'HEAD'].includes(req.method)) fail(404, 'Not found');
      const content = await readFile(path.join(ROOT, 'public', file[0]));
      res.writeHead(200, { 'Content-Type': `${file[1]}; charset=utf-8`, 'Content-Length': content.length });
      res.end(req.method === 'HEAD' ? undefined : content);
    } catch (error) {
      if (!res.headersSent && !res.destroyed) json(res, error.status ?? 500, { error: error.status ? error.message : 'Request failed' }, error.status === 429 ? { 'Retry-After': '60' } : {});
      else res.end();
    }
  });
  server.requestTimeout = 15000; server.headersTimeout = 10000; server.keepAliveTimeout = 5000;
  server.maxConnections = 256; server.maxRequestsPerSocket = 1000;
  const wss = new WebSocketServer({ noServer: true, maxPayload: bodyLimit, perMessageDeflate: false });
  let pendingUpgrades = 0;
  server.on('upgrade', async (req, socket, head) => {
    socket.on('error', () => {});
    const reject = status => { socket.end(`HTTP/1.1 ${status} Rejected\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`); };
    if (pendingUpgrades + wss.clients.size >= maxConnections) return reject(429);
    pendingUpgrades++;
    const timer = setTimeout(() => socket.destroy(), 10000); timer.unref();
    try {
      const session = auth.session(req);
      if (!session) fail(401, 'Sign in required');
      if (!auth.allowed(req)) fail(403, 'Origin rejected');
      const url = new URL(req.url, 'http://localhost');
      if (url.pathname !== '/stream' || shuttingDown) fail(404, 'Not found');
      onlyQuery(url, ['id', 'quality', 'scale', 'audio']);
      let scale, audio;
      try { scale = streamScale(url.searchParams.get('scale')); audio = streamAudio(url.searchParams.get('audio')); } catch { fail(400, 'Invalid stream settings'); }
      const quality = url.searchParams.get('quality') ?? 'balanced';
      if (!Object.hasOwn(QUALITY, quality)) fail(400, 'Invalid quality');
      authorizePhone(session, url.searchParams.get('id'));
      const phone = await findPhone(url.searchParams.get('id'));
      if (phone.status !== 'running') fail(409, 'Phone is not running');
      validatePhoneIdentity(phone);
      if (!auth.session(req) || socket.destroyed || shuttingDown) fail(401, 'Session expired');
      wss.handleUpgrade(req, socket, head, ws => wss.emit('connection', ws, session, phone, quality, scale, audio));
    } catch (error) { if (!socket.destroyed) reject(error.status ?? 503); }
    finally { pendingUpgrades--; clearTimeout(timer); }
  });
  wss.on('connection', (ws, session, phone, quality, scale, audio) => {
    const state = { ws, phone, quality, scale, audioMode: audio, scrcpyServer, sessionId: session.id, stopped: false, ready: false,
      alive: true, pointers: new Set(), tokens: 360, refill: Date.now(), pending: 0, controls: Promise.resolve() };
    const slot = slotFor(phone.id);
    const send = value => { if (!state.stopped && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(value)); };
    ws.on('error', () => {});
    ws.on('pong', () => { state.alive = true; });
    ws.on('close', () => {
      state.stopped = true; state.ready = false; state.cancelStart?.();
      void enqueue(phone.id, async current => { await stop(state); if (current.active === state) current.active = null; });
    });
    ws.on('message', (data, binary) => {
      auth.prune();
      if (!auth.sessions.has(state.sessionId)) return ws.close(4001, 'Session expired');
      const now = Date.now();
      state.tokens = Math.min(360, state.tokens + (now - state.refill) * 0.24); state.refill = now;
      if (--state.tokens < 0 || state.pending >= 32) return ws.close(1008, 'Control rate exceeded');
      let m; try { m = binary ? null : JSON.parse(data.toString()); } catch {}
      if (!validateControl(m)) return ws.close(1008, 'Invalid control');
      if (!state.ready || state.stopped) return;
      if ((m.type === 'touch' || m.type === 'scroll') && (m.width !== state.video.width || m.height !== state.video.height)) return;
      if (m.type === 'touch') {
        if (m.action === 0) { if (state.pointers.size >= 10 || state.pointers.has(m.id)) return; state.pointers.add(m.id); }
        else if (!state.pointers.has(m.id)) return;
        if (m.action === 1 || m.action === 3) state.pointers.delete(m.id);
      }
      const queuedAt = performance.now();
      state.pending++;
      state.controls = state.controls.then(async () => {
        if (state.stopped || ws.readyState !== WebSocket.OPEN) return;
        if (performance.now() - queuedAt > 150 && m.type === 'touch' && m.action === 2) return;
        const c = state.client.controller;
        if (m.type === 'keyframe') { await c.resetVideo?.(); return; }
        if (m.type === 'key') await c.injectKeyCode({action: m.action, keyCode: m.keyCode, repeat: m.repeat ?? 0, metaState: m.metaState ?? 0});
        // Clipboard paste preserves Unicode and works with Android's active IME.
        if (m.type === 'text') { if (m.text.length === 1 && m.text.charCodeAt(0) < 128) await c.injectText(m.text); else await c.setClipboard({sequence: 0n, content: m.text, paste: 1}); }
        if (m.type === 'touch') await c.injectTouch({action: m.action === 3 ? 1 : m.action, pointerId: BigInt(m.id), pointerX: m.x, pointerY: m.y, videoWidth: m.width, videoHeight: m.height, pressure: m.action === 1 || m.action === 3 ? 0 : m.pressure, actionButton: 0, buttons: 0});
        if (m.type === 'scroll') await c.injectScroll({pointerX: m.x, pointerY: m.y, videoWidth: m.width, videoHeight: m.height, scrollX: m.dx, scrollY: m.dy, buttons: 0});
      }).catch(error => { console.warn('[control]', error.message); ws.close(1011, 'Control channel failed'); }).finally(() => { state.pending--; });
    });
    if (slot.active) { slot.active.stopped = true; slot.active.cancelStart?.(); slot.active.ws.close(4000, 'Another controller connected'); }
    const previous = slot.active;
    slot.active = state;
    void enqueue(phone.id, async current => {
      await stop(previous);
      if (state.stopped || shuttingDown || current.active !== state) return;
      send({ type: 'status', message: 'Connecting to Android…' });
      let timedOut = false;
      try {
        const fresh = await findPhone(phone.id);
        if (fresh.status !== 'running' || state.stopped || shuttingDown) throw new Error('Phone stopped');
        const work = Promise.resolve().then(() => deviceStarter(state, send));
        work.finally(() => { if (state.stopped) return stop(state); }).catch(() => {});
        await Promise.race([work, new Promise((_, reject) => {
          state.cancelStart = () => reject(new Error('Startup cancelled'));
          state.startTimer = setTimeout(() => { timedOut = true; state.stopped = true; reject(new Error('Startup timed out')); }, startupTimeoutMs);
        })]);
      } catch {
        send({ type: 'error', message: 'Could not start isolated Android streaming. Please reconnect.' });
        ws.close(1011, timedOut ? 'Android startup timed out' : 'Android unavailable');
        await stop(state);
      } finally {
        clearTimeout(state.startTimer); state.cancelStart = null;
        if (state.stopped || ws.readyState !== WebSocket.OPEN) await stop(state);
      }
    }).catch(() => { ws.close(1011, 'Lifecycle failed'); });
  });
  const heartbeat = setInterval(() => {
    auth.prune(); expireControllers();
    for (const slot of slots.values()) {
      const state = slot.active;
      if (!state) continue;
      if (!state.alive) { state.ws.terminate(); continue; }
      state.alive = false;
      if (state.ws.readyState === WebSocket.OPEN) state.ws.ping();
    }
  }, 15000);
  heartbeat.unref();
  let closePromise;
  const close = () => closePromise ??= (async () => {
    shuttingDown = true; clearInterval(heartbeat);
    for (const ws of wss.clients) ws.terminate();
    await Promise.all([...slots.values()].map(slot => stop(slot.active)));
    await Promise.all([...slots.values()].map(slot => slot.queue));
    await new Promise(resolve => wss.close(resolve));
    if (server.listening) {
      const closed = new Promise(resolve => server.close(resolve));
      server.closeAllConnections(); await closed;
    }
  })();
  return { server, close };
}

export async function loadRuntimeConfig(env = process.env) {
  let config = {};
  if (env.CONFIG_FILE) {
    if (!path.isAbsolute(env.CONFIG_FILE)) throw new Error('CONFIG_FILE must be absolute');
    config = JSON.parse(await readFile(env.CONFIG_FILE, 'utf8'));
    if (config.schemaVersion !== 1) throw new Error('Unsupported configuration schema');
  }
  const stateDir = env.STATE_DIR ?? config.stateDir ?? '/var/lib/cloudphone-platform';
  const sdkDir = env.SDK_DIR ?? config.sdkDir ?? '/opt/cloudphone-sdk/api36-v1';
  const mode = env.CLOUDPHONE_MODE ?? config.mode ?? 'dashboard';
  const portValue = env.PORT ?? config.port ?? 8790;
  const host = env.HOST ?? config.host ?? '127.0.0.1';
  if (!['dashboard', 'standalone'].includes(mode) || !/^\d+$/.test(String(portValue)) || !int(Number(portValue), 1024, 65535) || Number(portValue) === 8787) throw new Error('Invalid mode or web port (8787 reserved)');
  if (!['127.0.0.1', '::1', 'localhost'].includes(host)) throw new Error('Web service must bind loopback');
  const scrcpyServer = env.SCRCPY_SERVER ?? config.scrcpyServer ?? path.join(sdkDir, 'scrcpy-server.jar');
  const credentialsFile = config.credentialsFile ?? path.join(stateDir, 'credentials.json');
  for (const p of [stateDir, sdkDir, scrcpyServer, credentialsFile]) if (typeof p !== 'string' || !path.isAbsolute(p)) throw new Error('Runtime paths must be absolute');
  const publicOrigin = env.PUBLIC_ORIGIN ?? config.publicOrigin;
  return { ...config, stateDir, sdkDir, mode, port: Number(portValue), host, scrcpyServer, credentialsFile,
    publicOrigin, secureCookies: publicOrigin ? new URL(publicOrigin).protocol === 'https:' : true };
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const config = await loadRuntimeConfig();
  if (process.getuid?.() === 0) throw new Error('HTTP must run as unprivileged cloudphone-web; use the root broker');
  const { BrokerClient } = await import('./lib/broker-client.mjs');
  const manager = new BrokerClient({ socketPath: config.brokerSocket });
  const app = await createApplication({ ...config, manager, verifyCredentials: (username, password) => manager.verifyCredentials(username, password) });
  app.server.listen(config.port, config.host, () => console.log(`Cloudphone listening on ${config.host}:${config.port}`));
  let exiting = false;
  for (const signal of ['SIGTERM', 'SIGINT']) process.on(signal, async () => {
    if (exiting) return; exiting = true;
    const deadline = setTimeout(() => process.exit(1), 8000); deadline.unref();
    await app.close(); process.exit(0);
  });
}
