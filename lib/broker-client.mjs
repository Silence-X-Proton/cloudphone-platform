import net from 'node:net';
import { WebSocket } from 'ws';

export const BROKER_SOCKET = '/run/cloudphone-platform/broker.sock';
export const MAX_REQUEST_BYTES = 8192;
export const MAX_RESPONSE_BYTES = 1024 * 1024;
export const BROKER_TIMEOUT_MS = 15 * 60 * 1000;

/** Trusted local IPC only. Never retry mutations: a lost reply has an unknown outcome. */
export class BrokerClient {
  constructor({ socketPath = BROKER_SOCKET, streamSocketPath = STREAM_SOCKET, timeoutMs = BROKER_TIMEOUT_MS } = {}) {
    if (typeof socketPath !== 'string' || !socketPath.startsWith('/') || socketPath.includes('\0') ||
        !Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > BROKER_TIMEOUT_MS) throw new Error('Invalid broker client settings');
    unixStreamURL(streamSocketPath, '/stream');
    this.socketPath = socketPath; this.streamSocketPath = streamSocketPath; this.timeoutMs = timeoutMs;
  }
  request(op, args = []) {
    let body;
    try { body = Buffer.from(JSON.stringify({ op, args })); } catch { return Promise.reject(new Error('Invalid broker request')); }
    if (body.length > MAX_REQUEST_BYTES) return Promise.reject(new Error('Broker request too large'));
    return new Promise((resolve, reject) => {
      const socket = net.createConnection({ path: this.socketPath });
      const chunks = []; let size = 0, settled = false;
      const finish = (error, value) => {
        if (settled) return;
        settled = true; clearTimeout(timer); socket.destroy();
        if (error) reject(error); else resolve(value);
      };
      const timer = setTimeout(() => finish(Object.assign(new Error('Broker timeout; mutation outcome unknown'), { code: 'TIMEOUT', status: 504 })), this.timeoutMs);
      socket.on('error', error => finish(error));
      socket.on('connect', () => socket.end(body));
      socket.on('data', chunk => {
        size += chunk.length;
        if (size > MAX_RESPONSE_BYTES) return finish(new Error('Broker response too large'));
        chunks.push(chunk);
      });
      socket.on('end', () => {
        try {
          const reply = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks)));
          if (!reply || typeof reply.ok !== 'boolean') throw new Error('Invalid broker response');
          if (!reply.ok) {
            if (!reply.error || typeof reply.error.message !== 'string' || typeof reply.error.code !== 'string' || !Number.isInteger(reply.error.status)) throw new Error('Invalid broker error');
            return finish(Object.assign(new Error(reply.error.message), { code: reply.error.code, status: reply.error.status }));
          }
          if (!Object.hasOwn(reply, 'result')) throw new Error('Invalid broker response');
          finish(null, reply.result);
        } catch (error) { finish(error); }
      });
      socket.on('close', () => { if (!settled) finish(new Error('Broker connection closed without a reply')); });
    });
  }
  startStream(state, send) { return startBrokerStream(this.streamSocketPath, state, send); }
  list() { return this.request('list'); }
  usage() { return this.request('usage'); }
  capabilities() { return this.request('capabilities'); }
  create(input) { return this.request('create', [input]); }
  start(id) { return this.request('start', [id]); }
  stop(id) { return this.request('stop', [id]); }
  delete(id) { return this.request('delete', [id]); }
  metrics(id) { return this.request('metrics', [id]); }
  revealKey(id) { return this.request('revealKey', [id]); }
  verifyKey(id, key) { return this.request('verifyKey', [id, key]); }
  verifyCredentials(username, password) { return this.request('verifyCredentials', [username, password]); }
}

export const STREAM_SOCKET = '/run/cloudphone-platform/stream.sock';
export const STREAM_BUFFER_BYTES = 4 * 1024 * 1024;
export const STREAM_CONTROL_BYTES = 8192;
export const STREAM_QUALITIES = Object.freeze(['economy', 'balanced', 'sharp']);

// A colon/query/fragment in a Unix path changes ws+unix URL parsing. Never accept it.
export function unixStreamURL(socketPath, endpoint) {
  if (typeof socketPath !== 'string' || !/^\/[A-Za-z0-9_./-]+$/.test(socketPath) ||
      socketPath.split('/').some(part => part === '.' || part === '..') || Buffer.byteLength(socketPath) > 107) throw new Error('Invalid stream socket path');
  return `ws+unix://${socketPath}:${endpoint}`;
}

/** No buffering of our own, compression or frame dropping; reconnect for a fresh decoder. */
export function sendStreamBounded(ws, data, binary = false, limit = STREAM_BUFFER_BYTES) {
  if (ws.readyState !== WebSocket.OPEN) return false;
  if (ws.bufferedAmount + Buffer.byteLength(data) > limit) { ws.terminate(); return false; }
  ws.send(data, { binary }, error => { if (error) ws.terminate(); });
  return true;
}

// Deliberately independent of phone-worker.mjs: importing it loads privileged ADB code.
export function validStreamControl(m) {
  const int = (n, lo, hi) => Number.isInteger(n) && n >= lo && n <= hi;
  const finite = (n, lo, hi) => Number.isFinite(n) && n >= lo && n <= hi;
  if (!m || typeof m !== 'object' || Array.isArray(m)) return false;
  const only = keys => Object.keys(m).every(key => keys.includes(key));
  if (m.type === 'key') return only(['type', 'action', 'keyCode', 'repeat', 'metaState']) &&
    ([3, 4, 19, 20, 21, 22, 23, 24, 25, 61, 62, 66, 67, 92, 93, 111, 112, 122, 123, 124, 187].includes(m.keyCode) ||
      int(m.keyCode, 29, 54) || int(m.keyCode, 7, 16)) && int(m.action, 0, 1) &&
    int(m.repeat ?? 0, 0, 30) && int(m.metaState ?? 0, 0, 0x7fffffff);
  if (m.type === 'text') return only(['type', 'text']) && typeof m.text === 'string' &&
    m.text.length > 0 && Buffer.byteLength(m.text) <= 4096 && !m.text.includes('\0');
  const base = ['type', 'width', 'height', 'x', 'y'];
  if (!int(m.width, 1, 8192) || !int(m.height, 1, 8192) || !int(m.x, 0, m.width - 1) || !int(m.y, 0, m.height - 1)) return false;
  if (m.type === 'touch') return only([...base, 'id', 'action', 'pressure']) && int(m.id, 0, 2147483647) &&
    int(m.action, 0, 3) && finite(m.pressure, 0, 1);
  return m.type === 'scroll' && only([...base, 'dx', 'dy']) && finite(m.dx, -1, 1) && finite(m.dy, -1, 1);
}

function workerMessage(data) {
  if (data.length > STREAM_CONTROL_BYTES) throw new Error('Worker metadata too large');
  const m = JSON.parse(data.toString());
  if (!m || !['metadata', 'size', 'status', 'error'].includes(m.type)) throw new Error('Invalid worker message');
  if (m.type === 'metadata' || m.type === 'size') {
    if (![m.width, m.height].every(n => Number.isInteger(n) && n >= 1 && n <= 8192)) throw new Error('Invalid worker dimensions');
    // Whitelist metadata instead of forwarding arbitrary worker JSON to the browser.
    return { type: m.type, width: m.width, height: m.height,
      ...(m.type === 'metadata' ? { codec: Number.isInteger(m.codec) ? m.codec : 0x68323634, audio: false, android: 'Android 16 · Google image' } : {}) };
  }
  return { type: m.type, message: m.type === 'error' ? 'Isolated Android stream unavailable' : 'Connecting to Android…' };
}

async function startBrokerStream(socketPath, state, send) {
  if (!state || typeof state.phone?.id !== 'string' || !/^[a-f0-9]{16}$/.test(state.phone.id) ||
      !STREAM_QUALITIES.includes(state.quality) || state.stopped || state.ws?.readyState !== WebSocket.OPEN || typeof send !== 'function') throw new Error('Invalid stream state');
  const upstream = new WebSocket(unixStreamURL(socketPath, `/stream?id=${state.phone.id}&quality=${state.quality}`), {
    perMessageDeflate: false, maxPayload: STREAM_BUFFER_BYTES, handshakeTimeout: 10000,
  });
  let closed = false, settled = false, resolveStart, rejectStart;
  const started = new Promise((resolve, reject) => { resolveStart = resolve; rejectStart = reject; });
  const settle = error => {
    if (settled) return;
    settled = true; clearTimeout(timer);
    if (error) rejectStart(error); else resolveStart();
  };
  const close = () => {
    if (closed) return;
    closed = true; state.ready = false;
    settle(new Error('Isolated stream closed'));
    upstream.terminate();
    state.ws.off('close', close); state.ws.off('error', close);
    if (state.ws.readyState === WebSocket.OPEN) state.ws.terminate();
  };
  const timer = setTimeout(close, 25000);
  const control = async message => {
    if (closed || state.stopped || !state.ready || !validStreamControl(message)) throw new Error('Invalid or unavailable stream control');
    const data = JSON.stringify(message);
    if (Buffer.byteLength(data) > STREAM_CONTROL_BYTES || !sendStreamBounded(upstream, data, false, STREAM_CONTROL_BYTES)) {
      close(); throw new Error('Stream control buffer exceeded');
    }
  };
  // Match server.mjs's scrcpy controller interface, but send only fixed worker JSON.
  state.client = { close: async () => close(), controller: {
    injectKeyCode: m => control({ type: 'key', action: m.action, keyCode: m.keyCode, repeat: m.repeat, metaState: m.metaState }),
    injectText: text => control({ type: 'text', text }),
    setClipboard: m => control({ type: 'text', text: m.content }),
    injectTouch: m => control({ type: 'touch', id: Number(m.pointerId), action: m.action, x: m.pointerX, y: m.pointerY,
      width: m.videoWidth, height: m.videoHeight, pressure: m.pressure }),
    injectScroll: m => control({ type: 'scroll', x: m.pointerX, y: m.pointerY,
      width: m.videoWidth, height: m.videoHeight, dx: m.scrollX, dy: m.scrollY }),
  } };
  state.ws.once('close', close); state.ws.once('error', close);
  upstream.on('error', close); upstream.once('close', close);
  upstream.on('message', (data, binary) => {
    if (closed || state.stopped) { close(); return; }
    try {
      if (binary) {
        if (data.length < 9 || ![0, 1, 2].includes(data[0]) || !state.ready || !sendStreamBounded(state.ws, data, true)) close();
      } else {
        const m = workerMessage(data);
        if (m.type === 'metadata' || m.type === 'size') state.video = { width: m.width, height: m.height };
        if (state.ws.bufferedAmount + Buffer.byteLength(JSON.stringify(m)) > STREAM_BUFFER_BYTES) { close(); return; }
        send(m);
        if (m.type === 'metadata') { state.ready = true; settle(); }
        if (m.type === 'error') close();
      }
    } catch { close(); }
  });
  await started;
}
