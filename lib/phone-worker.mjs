import http from 'node:http';
import fs from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import { Readable } from 'node:stream';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomBytes } from 'node:crypto';
import { WebSocketServer, WebSocket } from 'ws';
import { AdbServerClient } from '@yume-chan/adb';
import { AdbServerNodeTcpConnector } from '@yume-chan/adb-server-node-tcp';
import { AdbScrcpyClient, AdbScrcpyOptions3_3_1 } from '@yume-chan/adb-scrcpy';

// This module must run in the phone unit, not the HTTP service. No server import:
// the frontend knows only the bounded Unix WS protocol, never an ADB transport.
export const MAX_INBOUND = 8192;
export const MAX_BUFFERED = 4 * 1024 * 1024;
export const QUALITY = Object.freeze({
  economy: Object.freeze({ videoBitRate: 1500000, maxSize: 720, maxFps: 24 }),
  balanced: Object.freeze({ videoBitRate: 4000000, maxSize: 1140, maxFps: 30 }),
  sharp: Object.freeze({ videoBitRate: 6000000, maxSize: 1600, maxFps: 30 }),
});
const int = (n, min, max) => Number.isInteger(n) && n >= min && n <= max;
const finite = (n, min, max) => Number.isFinite(n) && n >= min && n <= max;
const record = m => m !== null && typeof m === 'object' && !Array.isArray(m);
const only = (m, keys) => record(m) && Object.keys(m).every(k => keys.includes(k));
const keyCodes = new Set([3, 4, 19, 20, 21, 22, 23, 24, 25, 61, 62, 66, 67, 92, 93, 111, 112, 122, 123, 124, 187,
  ...Array.from({ length: 26 }, (_, i) => 29 + i), ...Array.from({ length: 10 }, (_, i) => 7 + i)]);
export function validateControl(m) {
  if (!record(m)) return false;
  if (m.type === 'key') return only(m, ['type', 'keyCode', 'action', 'repeat', 'metaState']) && keyCodes.has(m.keyCode) && int(m.action, 0, 1) && int(m.repeat ?? 0, 0, 30) && int(m.metaState ?? 0, 0, 0x7fffffff);
  if (m.type === 'text') return only(m, ['type', 'text']) && typeof m.text === 'string' && m.text.length > 0 && Buffer.byteLength(m.text) <= 4096 && !m.text.includes('\0');
  if (m.type === 'touch' || m.type === 'scroll') {
    if (!int(m.width, 1, 8192) || !int(m.height, 1, 8192) || !int(m.x, 0, m.width - 1) || !int(m.y, 0, m.height - 1)) return false;
    const base = ['type', 'width', 'height', 'x', 'y'];
    if (m.type === 'touch') return only(m, [...base, 'id', 'action', 'pressure']) && int(m.id, 0, 2147483647) && int(m.action, 0, 3) && finite(m.pressure, 0, 1);
    return only(m, [...base, 'dx', 'dy']) && finite(m.dx, -1, 1) && finite(m.dy, -1, 1);
  }
  return false;
}
const validStart = m => only(m, ['type', 'quality']) && m.type === 'start' && Object.hasOwn(QUALITY, m.quality);

export function encodePacket(packet) {
  if (!packet || !['configuration', 'data'].includes(packet.type) || !(packet.data instanceof Uint8Array) || packet.data.byteLength + 9 > MAX_BUFFERED) throw new Error('Invalid video packet');
  const header = Buffer.alloc(9);
  header[0] = packet.type === 'configuration' ? 1 : packet.keyframe ? 2 : 0;
  header.writeBigUInt64BE(packet.type === 'data' ? (packet.pts ?? 0n) : 0n, 1);
  return Buffer.concat([header, packet.data]);
}
function sendBounded(ws, data) {
  if (ws.readyState !== WebSocket.OPEN) return false;
  if (ws.bufferedAmount + Buffer.byteLength(data) > MAX_BUFFERED) {
    ws.close(1013, 'Slow connection; reconnect for a fresh keyframe');
    return false;
  }
  ws.send(data);
  return true;
}
export function sendPacket(ws, packet) {
  if (ws.readyState !== WebSocket.OPEN) return false;
  if (!packet?.data || packet.data.byteLength + 9 + ws.bufferedAmount > MAX_BUFFERED) {
    ws.close(1013, 'Video buffer limit'); return false;
  }
  return sendBounded(ws, encodePacket(packet));
}

function validateOptions(options) {
  const { phone, scrcpyServer, socketPath, webGid, networkMode } = options;
  if (!record(phone) || !/^[a-f0-9]{16}$/.test(phone.id) || !int(phone.adbPort, 15000, 15030) || !int(phone.consolePort, 5556, 5616) || phone.consolePort % 2 || phone.serial !== `emulator-${phone.consolePort}`) throw new Error('Invalid phone identity');
  for (const p of [scrcpyServer, socketPath]) if (typeof p !== 'string' || !path.isAbsolute(p) || path.normalize(p) !== p || p.includes('\0')) throw new Error('Invalid worker path');
  if (Buffer.byteLength(socketPath) > 100 || !int(webGid, 1, 2147483647)) throw new Error('Invalid socket configuration');
  if (networkMode !== 'private') throw new Error('Only isolated private networking is supported; egress helper unavailable');
}

/** A local fail-closed check, not a substitute for broker unit/membership verification.
 * hostNetNamespace must originate in the trusted host broker, never from a browser.
 */
export async function assertWorkerIsolation(options, { io = fs, uid = process.getuid?.() } = {}) {
  validateOptions(options);
  if (!int(uid, 1, 2147483647)) throw new Error('Worker must run as the unprivileged phone UID');
  if (uid !== 200000 + options.phone.adbPort - 15000) throw new Error('Worker UID does not match phone');
  const group = `/system.slice/cloudphone-${options.phone.id}.service`;
  if ((await io.readFile('/proc/self/cgroup', 'utf8')).trim() !== `0::${group}`) throw new Error('Worker is outside phone cgroup');
  const memory = (await io.readFile(`/sys/fs/cgroup${group}/memory.max`, 'utf8')).trim();
  const swap = (await io.readFile(`/sys/fs/cgroup${group}/memory.swap.max`, 'utf8')).trim();
  if (!/^[1-9][0-9]*$/.test(memory) || swap !== '0') throw new Error('Phone memory boundary is not enforced');
  if (!/^net:\[[0-9]+\]$/.test(options.hostNetNamespace ?? '') || await io.readlink('/proc/self/ns/net') === options.hostNetNamespace) throw new Error('Private network namespace is not established');
}

async function drain(stream) {
  if (!stream) return;
  const reader = stream.getReader();
  try { while (!(await reader.read()).done) { /* Discard bounded source chunks; never buffer logs/clipboard. */ } }
  catch { /* Transport cleanup also interrupts drains. */ }
  finally { reader.releaseLock(); }
}

// Protocol adapted from the original cloudphone/server.mjs; launch inputs are
// trusted and fixed for this process. Clients cannot select devices or paths.
export async function startDevice(state, send) {
  const adbServer = new AdbServerClient(new AdbServerNodeTcpConnector({ host: '127.0.0.1', port: state.phone.adbPort }));
  state.adb = await adbServer.createAdb({ serial: state.phone.serial });
  if (state.stopped) return;
  const devicePath = '/data/local/tmp/cloudphone-scrcpy-server.jar';
  await AdbScrcpyClient.pushServer(state.adb, Readable.toWeb(createReadStream(state.scrcpyServer)), devicePath);
  if (state.stopped) return;
  state.client = await AdbScrcpyClient.start(state.adb, devicePath, new AdbScrcpyOptions3_3_1({
    scid: randomBytes(4).readUInt32BE().toString(16).slice(0, 7),
    videoCodec: 'h264', ...QUALITY[state.quality], audio: false, control: true,
    tunnelForward: true, clipboardAutosync: true, sendFrameMeta: true,
    sendCodecMeta: true, sendDeviceMeta: true, cleanup: false,
  }, { version: '3.3.3' }));
  void drain(state.client.output); void drain(state.client.clipboard);
  if (state.stopped) return;
  const video = await state.client.videoStream;
  if (state.stopped || !video) return;
  state.video = video;
  send({ type: 'metadata', ...video.metadata, audio: false, android: 'Android 16 · Google image' });
  state.removeSizeListener = video.sizeChanged(size => send({ type: 'size', ...size }));
  state.ready = true;
  state.reader = video.stream.getReader();
  state.pump = (async () => {
    try {
      while (!state.stopped) {
        const { done, value } = await state.reader.read();
        if (done || !sendPacket(state.ws, value)) break;
      }
    } catch { /* Close with a generic reason; transport internals stay private. */ }
    finally { if (!state.stopped) state.ws.close(1011, 'Video ended'); }
  })();
}

async function inject(state, m) {
  if (state.stopped || state.ws.readyState !== WebSocket.OPEN) return;
  const c = state.client.controller;
  if (m.type === 'key') await c.injectKeyCode({ action: m.action, keyCode: m.keyCode, repeat: m.repeat ?? 0, metaState: m.metaState ?? 0 });
  if (m.type === 'text') {
    if (m.text.length === 1 && m.text.charCodeAt(0) < 128) await c.injectText(m.text);
    else await c.setClipboard({ sequence: 0n, content: m.text, paste: 1 });
  }
  if (m.type === 'touch') await c.injectTouch({ action: m.action === 3 ? 1 : m.action, pointerId: BigInt(m.id), pointerX: m.x, pointerY: m.y, videoWidth: m.width, videoHeight: m.height, pressure: m.action === 1 || m.action === 3 ? 0 : m.pressure, actionButton: 0, buttons: 0 });
  if (m.type === 'scroll') await c.injectScroll({ pointerX: m.x, pointerY: m.y, videoWidth: m.width, videoHeight: m.height, scrollX: m.dx, scrollY: m.dy, buttons: 0 });
}

/** Trusted construction only. Tests may inject transport and isolation checks. */
export async function createPhoneWorker({
  phone, scrcpyServer, socketPath = '/srv/cloudphone/run/stream.sock', webGid,
  hostNetNamespace, networkMode = 'private', deviceStarter = startDevice,
  isolationProbe = assertWorkerIsolation,
} = {}) {
  const options = { phone: phone && Object.freeze({ ...phone }), scrcpyServer, socketPath, webGid, hostNetNamespace, networkMode };
  validateOptions(options);
  let active, closing = false, published, staging, closeTask, listenStarted = false;
  const sockets = new Set();
  const wss = new WebSocketServer({ noServer: true, maxPayload: MAX_INBOUND, perMessageDeflate: false });
  const server = http.createServer({ maxHeaderSize: 4096 }, (_req, res) => {
    res.writeHead(404, { Connection: 'close', 'Content-Length': 0 }); res.end();
  });
  server.requestTimeout = 10000; server.headersTimeout = 10000;
  server.maxConnections = 8;
  server.on('connection', socket => {
    sockets.add(socket); socket.setTimeout(10000, () => socket.destroy());
    socket.on('close', () => sockets.delete(socket));
  });
  server.on('clientError', (_error, socket) => socket.destroy());
  server.on('upgrade', (req, socket, head) => {
    if (closing || active || req.method !== 'GET' || req.url !== '/stream') {
      socket.end(`HTTP/1.1 ${active ? 409 : 404} Rejected\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`); return;
    }
    socket.setTimeout(0);
    wss.handleUpgrade(req, socket, head, ws => wss.emit('connection', ws));
  });
  async function dispose(state) {
    const jobs = [];
    for (const [resource, operation] of [[state.reader, 'cancel'], [state.client, 'close'], [state.adb, 'close']]) {
      if (resource && !state.disposed.has(resource)) {
        state.disposed.add(resource);
        jobs.push(Promise.resolve().then(() => resource[operation]()).catch(() => {}));
      }
    }
    if (typeof state.removeSizeListener === 'function') { state.removeSizeListener(); state.removeSizeListener = undefined; }
    await Promise.all(jobs);
  }
  function stop(state) {
    if (state.stopTask) return state.stopTask;
    state.stopped = true; state.ready = false; clearTimeout(state.startTimer);
    state.ws.close(1000, 'Controller closed');
    // Close currently acquired resources immediately, then again after startup
    // settles to catch resources acquired after disconnect. Never free the slot early.
    state.stopTask = (async () => {
      await dispose(state);
      await state.startTask;
      await dispose(state);
      await state.controls;
      await state.pump;
      if (active === state) active = undefined;
    })();
    return state.stopTask;
  }
  wss.on('connection', ws => {
    const state = { ...options, ws, stopped: false, ready: false, alive: true, started: false,
      pointers: new Set(), tokens: 360, refill: performance.now(), pending: 0,
      controls: Promise.resolve(), disposed: new Set() };
    active = state;
    const send = value => sendBounded(ws, JSON.stringify(value));
    state.startTimer = setTimeout(() => { ws.close(1011, 'Android startup timed out'); void stop(state); }, 25000);
    state.startTimer.unref();
    ws.on('error', () => { void stop(state); });
    ws.on('pong', () => { state.alive = true; });
    ws.on('close', () => { void stop(state); });
    ws.on('message', (data, binary) => {
      if (state.stopped || ws.readyState !== WebSocket.OPEN) return;
      const now = performance.now();
      state.tokens = Math.min(360, state.tokens + (now - state.refill) * 0.24); state.refill = now;
      if (--state.tokens < 0 || state.pending >= 360) { ws.close(1008, 'Control rate exceeded'); return; }
      let m; try { m = binary ? null : JSON.parse(data.toString()); } catch { /* Invalid below. */ }
      if (!state.started) {
        if (!validStart(m)) { ws.close(1008, 'Start message required'); return; }
        state.started = true; state.quality = m.quality;
        send({ type: 'status', message: 'Connecting to Android…' });
        state.startTask = Promise.resolve().then(() => {
          if (!state.stopped) return deviceStarter(state, send);
        }).catch(() => {
          send({ type: 'error', message: 'Could not start Android streaming. Please reconnect.' });
          ws.close(1011, 'Android unavailable');
        }).finally(() => { clearTimeout(state.startTimer); });
        return;
      }
      if (!validateControl(m)) { ws.close(1008, 'Invalid control'); return; }
      if (!state.ready) return;
      if ((m.type === 'touch' || m.type === 'scroll') && (m.width !== state.video.width || m.height !== state.video.height)) return;
      if (m.type === 'touch') {
        if (m.action === 0) {
          if (state.pointers.size >= 10 || state.pointers.has(m.id)) return;
          state.pointers.add(m.id);
        } else if (!state.pointers.has(m.id)) return;
        if (m.action === 1 || m.action === 3) state.pointers.delete(m.id);
      }
      state.pending++;
      state.controls = state.controls.then(() => inject(state, m)).catch(() => {
        ws.close(1011, 'Control channel failed');
      }).finally(() => { state.pending--; });
    });
  });
  const heartbeat = setInterval(() => {
    for (const ws of wss.clients) {
      if (active?.ws === ws) {
        if (!active.alive) { ws.terminate(); continue; }
        active.alive = false; ws.ping();
      }
    }
  }, 15000);
  heartbeat.unref();
  async function listen() {
    if (listenStarted || closing) throw new Error('Worker already started or closed');
    listenStarted = true;
    try {
      await isolationProbe(options);
      const dir = path.dirname(socketPath);
      const stat = await fs.lstat(dir);
      if (!stat.isDirectory() || stat.isSymbolicLink() || await fs.realpath(dir) !== dir || stat.uid !== process.getuid() || (stat.mode & 0o022)) throw new Error('Unsafe worker socket directory');
      staging = await fs.mkdtemp(path.join(dir, '.w-'));
      await fs.chmod(staging, 0o700);
      const temporary = path.join(staging, 's');
      if (Buffer.byteLength(temporary) > 107) throw new Error('Unix socket path too long');
      await new Promise((resolve, reject) => {
        const fail = error => { server.off('listening', ready); reject(error); };
        const ready = () => { server.off('error', fail); resolve(); };
        server.once('error', fail); server.once('listening', ready); server.listen(temporary);
      });
      await fs.chown(temporary, process.getuid(), webGid);
      await fs.chmod(temporary, 0o660);
      // link is atomic and refuses existing files/sockets/symlinks, unlike rename.
      await fs.link(temporary, socketPath);
      published = await fs.lstat(socketPath);
      return socketPath;
    } catch (error) { await close(); throw error; }
  }
  function close() {
    if (closeTask) return closeTask;
    closing = true; clearInterval(heartbeat);
    closeTask = (async () => {
      for (const ws of wss.clients) ws.terminate();
      for (const socket of sockets) socket.destroy();
      if (active) await stop(active);
      await new Promise(resolve => wss.close(resolve));
      if (server.listening) await new Promise(resolve => server.close(resolve));
      if (published) {
        const current = await fs.lstat(socketPath).catch(error => { if (error.code !== 'ENOENT') throw error; });
        if (current && current.dev === published.dev && current.ino === published.ino) await fs.unlink(socketPath);
      }
      if (staging) await fs.rm(staging, { recursive: true, force: true });
    })();
    return closeTask;
  }
  return { listen, close };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const config = JSON.parse(process.env.CLOUDPHONE_WORKER_CONFIG ?? 'null');
    if (!record(config) || !only(config, ['phone', 'scrcpyServer', 'socketPath', 'webGid', 'hostNetNamespace', 'networkMode'])) throw new Error('Invalid trusted worker configuration');
    const worker = await createPhoneWorker(config);
    await worker.listen();
    let exiting = false;
    for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, async () => {
      if (exiting) return;
      exiting = true;
      const deadline = setTimeout(() => process.exit(1), 8000); deadline.unref();
      try { await worker.close(); process.exit(0); } catch { process.exit(1); }
    });
  } catch (error) { console.error('[phone-worker]', error.message); process.exitCode = 1; }
}
