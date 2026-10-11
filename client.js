// Input protocol adapted from cloudphone/client.js; H.264 Annex-B configuration
// follows @yume-chan/scrcpy-decoder-webcodecs. Native queue access is intentional:
// a resolved writable.write() does not mean the hardware decoder has caught up.
import { ScrcpyVideoCodecId, h264ParseConfiguration } from '@yume-chan/scrcpy';

const $ = id => document.getElementById(id);
const canvas = $('screen');
const context = canvas.getContext('2d', {alpha: false});
const MAX_DECODE_QUEUE = 12, MAX_RETRIES = 6, MAX_PACKET_BYTES = 8 * 1024 * 1024;
let socket, decoder, retryTimer, connectTimer, stableTimer;
let authenticated = false, csrf = '', mode = '', phoneId = '', generation = 0, failures = 0;
let width = 0, height = 0, receivedFrames = 0, rendered = 0, lastRendered = 0, lastFpsTime = performance.now();
let quality = 'balanced', preparing = false, authGeneration = 0, sessionRole = '', scopedPhoneId = '';
const urlPhoneId = new URLSearchParams(location.search).get('id') || '';
$('access-phone-id').value = urlPhoneId;
$('access-phone-id').readOnly = !!urlPhoneId;
function setLoginMethod() {
  const useKey = $('login-method').value === 'key';
  $('admin-credentials').hidden = useKey; $('admin-credentials').disabled = useKey;
  $('phone-credentials').hidden = !useKey; $('phone-credentials').disabled = !useKey;
  $('password').value = ''; $('phone-access-key').value = ''; $('login-error').textContent = '';
}
$('login-method').addEventListener('change', setLoginMethod);
if (urlPhoneId) $('login-method').value = 'key';
setLoginMethod();
const pointers = new Map(), pressedKeys = new Map();
const status = (text, live = false) => { $('status').textContent = text; $('status-dot').classList.toggle('online', live); };
const overlay = (title, text, retry = false) => { $('screen-overlay').hidden = false; $('overlay-title').textContent = title; $('overlay-text').textContent = text; $('reconnect').hidden = !retry; };
function initTheme() {
  try { const saved = localStorage.getItem('cloudphone-theme'); if (['dark', 'light'].includes(saved)) document.documentElement.dataset.theme = saved; } catch {}
  document.querySelector('.theme-toggle').addEventListener('click', () => {
    const dark = document.documentElement.dataset.theme ? document.documentElement.dataset.theme === 'dark' : matchMedia('(prefers-color-scheme: dark)').matches;
    const theme = dark ? 'light' : 'dark'; document.documentElement.dataset.theme = theme;
    try { localStorage.setItem('cloudphone-theme', theme); } catch {}
  });
}
initTheme();
const send = value => {
  if (socket?.readyState === WebSocket.OPEN && width && height && receivedFrames) {
    // Never accumulate stale input behind an overloaded transport.
    if (socket.bufferedAmount > 64 * 1024) { socket.close(4003, 'Input backlog'); return false; }
    socket.send(JSON.stringify(value)); return true;
  }
  return false;
};
const fit = () => {
  const area = $('screen-stage'), phone = $('phone');
  const ratio = (width || 450) / (height || 1000);
  const availableWidth = Math.max(1, area.clientWidth - 2), availableHeight = Math.max(1, area.clientHeight - 2);
  const w = Math.min(availableWidth, availableHeight * ratio), h = w / ratio;
  // CSSOM properties are CSP-safe: no style attributes or inline stylesheet text.
  phone.style.width = `${w}px`; phone.style.height = `${h}px`;
};
new ResizeObserver(fit).observe($('screen-stage'));
window.addEventListener('resize', fit);
window.visualViewport?.addEventListener('resize', fit);
function setSize(w, h) {
  if (!Number.isInteger(w) || !Number.isInteger(h) || w < 1 || h < 1 || w > 8192 || h > 8192) throw new Error('Invalid video dimensions');
  width = w; height = h;
  if (canvas.width !== w || canvas.height !== h) { canvas.width = w; canvas.height = h; }
  $('resolution').textContent = `${w} × ${h} · H.264`; fit();
}
function disposeDecoder() {
  const old = decoder; decoder = undefined;
  if (old && old.state !== 'closed') old.close();
  receivedFrames = 0; width = 0; height = 0; rendered = 0; lastRendered = 0; lastFpsTime = performance.now();
  pointers.clear(); pressedKeys.clear(); $('fps').textContent = '— FPS';
  context?.clearRect(0, 0, canvas.width, canvas.height);
}
function disconnect() {
  clearTimeout(retryTimer); clearTimeout(connectTimer); clearTimeout(stableTimer);
  releaseInput(); ++generation;
  if (socket) { socket.onmessage = null; socket.onclose = null; socket.onerror = null; socket.close(); socket = undefined; }
  disposeDecoder();
}
function decodingError(error, current) {
  if (current !== generation) return;
  console.error('Video decoder', error); disconnect();
  overlay('Video is not supported.', 'This browser could not decode the H.264 stream. Try a current Chrome, Edge, or Safari over HTTPS.', true);
  status('Decoder unavailable');
}
function createDecoder(codec, current) {
  if (codec !== ScrcpyVideoCodecId.H264 || decoder) throw new Error('Unsupported or duplicate video metadata');
  const active = new VideoDecoder({
    output(frame) {
      try {
        if (current !== generation || decoder !== active) return;
        setSize(frame.displayWidth, frame.displayHeight);
        context.drawImage(frame, 0, 0, canvas.width, canvas.height);
        rendered++; receivedFrames++; $('screen-overlay').hidden = true;
        if (receivedFrames === 1) {
          clearTimeout(connectTimer); status('Connected', true);
          // One frame must not reset the retry cap on a repeatedly failing stream.
          stableTimer = setTimeout(() => { if (current === generation) failures = 0; }, 30000);
        }
      } catch (error) { decodingError(error, current); }
      finally { frame.close(); }
    },
    error(error) { if (decoder === active) decodingError(error, current); },
  });
  decoder = active;
}
function lowerQuality() {
  const next = quality === 'sharp' ? 'balanced' : 'economy';
  const changed = next !== quality; quality = next; $('quality').value = next;
  $('quality-help').textContent = changed ? `Video reduced to ${next} to keep latency low. Android was not restarted.` : 'Economy quality selected. Reconnecting a fresh video stream; Android is unchanged.';
}
async function request(path, options = {}) {
  const res = await fetch(path, {credentials: 'same-origin', cache: 'no-store', signal: AbortSignal.timeout(20000), ...options});
  let body; try { body = await res.json(); } catch { body = {}; }
  if (!res.ok) { const error = new Error(typeof body.error === 'string' ? body.error : `Request failed (${res.status})`); error.status = res.status; throw error; }
  return body;
}
function connect() {
  if (!authenticated || !phoneId) return;
  disconnect(); const current = generation;
  overlay('Connecting to Android…', `Opening a fresh ${quality} video stream. Your Android workspace stays intact.`); status('Connecting');
  const params = new URLSearchParams({id: phoneId, quality});
  const ws = new WebSocket(`${location.protocol === 'https:' ? 'wss:' : 'ws:'}//${location.host}/stream?${params}`);
  socket = ws; ws.binaryType = 'arraybuffer';
  let config, keyframe = false, localBacklog = false;
  connectTimer = setTimeout(() => { if (current === generation) ws.close(4004, 'Video timeout'); }, 20000);
  ws.onmessage = event => {
    if (current !== generation || ws.readyState !== WebSocket.OPEN) return;
    try {
      if (typeof event.data === 'string') {
        const message = JSON.parse(event.data);
        if (message.type === 'metadata') createDecoder(message.codec, current);
        else if (message.type === 'size') setSize(message.width, message.height);
        else if (message.type === 'status') status(String(message.message || 'Preparing Android…'));
        else if (message.type === 'error') overlay('Android is unavailable.', String(message.message || 'Try reconnecting after the phone is ready.'), true);
        return;
      }
      if (!decoder || event.data.byteLength < 10 || event.data.byteLength > MAX_PACKET_BYTES) throw new Error('Invalid video packet');
      const view = new DataView(event.data), flags = view.getUint8(0);
      if (flags & ~3) throw new Error('Invalid video flags');
      let data = new Uint8Array(event.data, 9);
      if (flags & 1) {
        const {profileIndex, constraintSet, levelIndex, croppedWidth, croppedHeight} = h264ParseConfiguration(data);
        setSize(croppedWidth, croppedHeight);
        const codec = 'avc1.' + [profileIndex, constraintSet, levelIndex].map(value => value.toString(16).padStart(2, '0')).join('');
        config = {codec, raw: data}; keyframe = false;
        decoder.reset();
        return;
      }
      // Never decode delta frames after reset/reconnect until SPS/PPS + IDR arrive.
      if (!config || (!keyframe && !(flags & 2))) return;
      if (decoder.decodeQueueSize >= MAX_DECODE_QUEUE) {
        localBacklog = true;
        // Browsers cannot send reserved close code 1013. Use an application code
        // locally and treat server 1013 identically in onclose below.
        ws.onmessage = null; ws.close(4003, 'Decode backlog');
        releaseInput(); disposeDecoder(); return;
      }
      if (!keyframe) {
        decoder.configure({codec: config.codec, optimizeForLatency: true, hardwareAcceleration: 'no-preference'});
        const combined = new Uint8Array(config.raw.length + data.length);
        combined.set(config.raw); combined.set(data, config.raw.length); data = combined; keyframe = true;
      }
      const timestamp = Number(view.getBigUint64(1));
      if (!Number.isSafeInteger(timestamp)) throw new Error('Invalid video timestamp');
      decoder.decode(new EncodedVideoChunk({type: flags & 2 ? 'key' : 'delta', timestamp, data}));
    } catch (error) { decodingError(error, current); }
  };
  ws.onclose = async event => {
    if (current !== generation) return;
    clearTimeout(connectTimer); clearTimeout(stableTimer); disposeDecoder(); status('Disconnected');
    if (event.code === 4000) { overlay('Connected somewhere else.', 'Only one browser controls this phone. Reconnect to take control here.', true); return; }
    if (event.code === 4001) { showLogin('Your session expired. Sign in again.'); return; }
    if (event.code === 1008) { overlay('Connection refused.', 'The server rejected this connection. Check your access before reconnecting.', true); return; }
    if (event.code === 1013 || localBacklog || event.code === 4003) lowerQuality();
    try { await request(`/api/health?${new URLSearchParams({id: phoneId})}`); }
    catch (error) {
      if (current !== generation) return;
      if (error.status === 401) { showLogin('Sign in to reconnect.'); return; }
      if (error.status === 404 || error.status === 403) { overlay('Phone unavailable.', 'This phone no longer exists or is not accessible to this account.', true); return; }
    }
    if (current !== generation || !authenticated) return;
    if (++failures > MAX_RETRIES) { status('Reconnect paused'); overlay('Let’s give it a moment.', 'Automatic reconnect limit reached. Check the phone status or network, then try again.', true); return; }
    const wait = Math.min(10000, 1000 * 2 ** (failures - 1));
    overlay('Reconnecting…', `Your Android stays running. Attempt ${failures} of ${MAX_RETRIES} in ${wait / 1000}s · ${quality} quality.`, true);
    retryTimer = setTimeout(() => { if (current === generation) connect(); }, wait);
  };
  ws.onerror = () => { if (current === generation) status('Connection interrupted'); };
}
function showLogin(message = '') {
  authenticated = false; csrf = ''; sessionRole = ''; scopedPhoneId = ''; $('phone-access-key').value = ''; authGeneration++; preparing = false; disconnect();
  status('Sign in required'); $('logout').hidden = true; $('login-error').textContent = message;
  $('phone-name').textContent = 'Your phone'; $('serial').textContent = 'Private Android workspace';
  overlay('Your phone is ready.', 'Sign in to connect to your private Android workspace.');
  if (!$('login-dialog').open) $('login-dialog').showModal();
}
function acceptSession(data) {
  if (typeof data.csrf !== 'string') throw new Error('Invalid session response. Please sign in again.');
  authenticated = true; csrf = data.csrf; mode = data.mode; sessionRole = data.role; scopedPhoneId = data.phoneId || '';
  if (sessionRole === 'phone') { $('access-phone-id').value = scopedPhoneId; $('dashboard-link').href = `/phone?id=${encodeURIComponent(scopedPhoneId)}`; }
  else $('dashboard-link').href = '/'; authGeneration++; preparing = false;
  $('logout').hidden = false; $('login-dialog').close();
  $('dashboard-link').setAttribute('aria-label', mode === 'standalone' || sessionRole === 'phone' ? 'Cloudphone home' : 'Back to Cloudphone console');
}
async function preparePhone() {
  if (!authenticated || preparing) return;
  preparing = true; const current = authGeneration;
  try {
    const inventory = await request('/api/phones');
    if (current !== authGeneration || !authenticated) return;
    const id = sessionRole === 'phone' ? scopedPhoneId : new URLSearchParams(location.search).get('id');
    const selected = Array.isArray(inventory.phones) ? (id ? inventory.phones.find(phone => String(phone.id) === id) : inventory.phones[0]) : null;
    if (!selected) { phoneId = ''; status('No phone available'); overlay('No phone available.', id ? 'This phone was not found or is not accessible to your account.' : 'No phone is assigned yet. Ask your administrator to prepare one.', true); return; }
    phoneId = String(selected.id); $('phone-name').textContent = selected.name || phoneId;
    document.title = `${selected.name || 'Phone'} · Cloudphone`;
    try {
      const health = await request(`/api/health?${new URLSearchParams({id: phoneId})}`);
      if (current !== authGeneration || !authenticated) return;
      $('serial').textContent = health.serial ? `Android · ${health.serial}` : 'H.264 · Private Android workspace';
    } catch (error) { if (error.status === 401) throw error; }
    if (current !== authGeneration || !authenticated) return;
    if (!window.isSecureContext || typeof VideoDecoder === 'undefined' || !context) {
      status('Browser not supported'); overlay('A newer browser is needed.', 'Use a current Chrome, Edge, or Safari with H.264 WebCodecs, over HTTPS (or localhost). Audio is disabled.'); return;
    }
    if (selected.status && selected.status !== 'running' && selected.status !== 'starting') {
      status(`Phone ${selected.status}`); overlay('Your phone is not running.', mode === 'standalone' || sessionRole === 'phone' ? 'Ask your administrator to start Android, then reconnect.' : 'Start this phone from the console, then reconnect here.', true); return;
    }
    connect();
  } catch (error) {
    if (current !== authGeneration) return;
    if (error.status === 401) showLogin('Your session expired. Sign in again.');
    else { status('Service unavailable'); overlay('Could not connect.', error.message, true); }
  } finally { if (current === authGeneration) preparing = false; }
}
$('login-dialog').addEventListener('cancel', event => event.preventDefault());
$('login-form').addEventListener('submit', async event => {
  event.preventDefault(); if ($('login-button').disabled) return; $('login-button').disabled = true; $('login-method').disabled = true; $('login-error').textContent = '';
  try {
    const body = await request('/api/login', {method: 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify($('login-method').value === 'key' ? {phoneId: $('access-phone-id').value.trim(), key: $('phone-access-key').value} : {username: $('username').value.trim(), password: $('password').value})});
    $('password').value = ''; $('phone-access-key').value = ''; acceptSession(body); failures = 0; await preparePhone();
  } catch (error) { $('login-error').textContent = error.message; }
  finally { $('password').value = ''; $('phone-access-key').value = ''; $('login-button').disabled = false; $('login-method').disabled = false; }
});
$('logout').addEventListener('click', async () => {
  $('logout').disabled = true;
  try { await request('/api/logout', {method: 'POST', headers: {'X-CSRF-Token': csrf}}); showLogin(); }
  catch (error) { if (error.status === 401) showLogin(); else status(error.message); }
  finally { $('logout').disabled = false; }
});
$('reconnect').addEventListener('click', () => { failures = 0; disconnect(); void preparePhone(); });
$('quality').addEventListener('change', () => {
  if (!['balanced', 'economy', 'sharp'].includes($('quality').value)) return;
  quality = $('quality').value; failures = 0;
  $('quality-help').textContent = `Using ${quality} quality. Only the video stream reconnects; Android keeps running.`;
  disconnect(); void preparePhone();
});
$('fullscreen').addEventListener('click', async () => {
  try { if (document.fullscreenElement) await document.exitFullscreen(); else await $('viewer-main').requestFullscreen(); }
  catch { status('Fullscreen unavailable in this browser'); }
});
const position = event => {
  const rect = canvas.getBoundingClientRect();
  return {x: Math.min(width - 1, Math.max(0, Math.floor((event.clientX - rect.left) * width / rect.width))), y: Math.min(height - 1, Math.max(0, Math.floor((event.clientY - rect.top) * height / rect.height))), width, height};
};
function touch(event, action) {
  const point = position(event);
  return send({type: 'touch', ...point, id: event.pointerId, action, pressure: action === 1 || action === 3 ? 0 : (event.pressure || 0.5)});
}
canvas.addEventListener('contextmenu', e => e.preventDefault());
canvas.addEventListener('pointerdown', event => {
  event.preventDefault(); canvas.focus({preventScroll: true});
  if (event.pointerType === 'mouse' && event.button !== 0) return;
  if (touch(event, 0)) { pointers.set(event.pointerId, {event, last: performance.now()}); canvas.setPointerCapture(event.pointerId); }
});
canvas.addEventListener('pointermove', event => {
  const pointer = pointers.get(event.pointerId); if (!pointer) return; event.preventDefault(); pointer.event = event;
  if (performance.now() - pointer.last >= 12) { touch(event, 2); pointer.last = performance.now(); }
});
for (const name of ['pointerup', 'pointercancel', 'lostpointercapture']) canvas.addEventListener(name, event => {
  if (!pointers.has(event.pointerId)) return;
  event.preventDefault(); touch(event, name === 'pointerup' ? 1 : 3); pointers.delete(event.pointerId);
  if (canvas.hasPointerCapture(event.pointerId)) canvas.releasePointerCapture(event.pointerId);
});
canvas.addEventListener('wheel', event => {
  event.preventDefault(); const unit = event.deltaMode === 1 ? 20 : event.deltaMode === 2 ? 500 : 1;
  send({type: 'scroll', ...position(event), dx: Math.max(-1, Math.min(1, -event.deltaX * unit / 100)), dy: Math.max(-1, Math.min(1, -event.deltaY * unit / 100))});
}, {passive: false});
function key(keyCode, action, event = {}) {
  const metaState = (event.shiftKey ? 1 : 0) | (event.altKey ? 2 : 0) | (event.ctrlKey ? 4096 : 0) | (event.metaKey ? 65536 : 0);
  return send({type: 'key', keyCode, action, repeat: event.repeat ? 1 : 0, metaState});
}
document.querySelectorAll('[data-key]').forEach(button => button.addEventListener('click', () => { const code = Number(button.dataset.key); key(code, 0); key(code, 1); canvas.focus({preventScroll: true}); }));
const keyMap = {Backspace: 67, Delete: 112, Enter: 66, Tab: 61, Escape: 4, ArrowUp: 19, ArrowDown: 20, ArrowLeft: 21, ArrowRight: 22, Home: 122, End: 123, PageUp: 92, PageDown: 93};
canvas.addEventListener('keydown', event => {
  if (event.isComposing || event.key === 'Tab') return;
  let code = keyMap[event.key];
  if ((event.ctrlKey || event.metaKey || event.altKey) && /^[a-z]$/i.test(event.key)) code = 29 + event.key.toLowerCase().charCodeAt(0) - 97;
  if (code !== undefined) { event.preventDefault(); if (key(code, 0, event)) pressedKeys.set(event.code, code); }
  else if (event.key.length === 1 && !event.ctrlKey && !event.metaKey && !event.altKey) { event.preventDefault(); send({type: 'text', text: event.key}); }
});
canvas.addEventListener('keyup', event => { const code = pressedKeys.get(event.code); if (code === undefined) return; event.preventDefault(); key(code, 1, event); pressedKeys.delete(event.code); });
function releaseInput() {
  for (const [id, pointer] of pointers) { touch(pointer.event, 3); if (canvas.hasPointerCapture(id)) canvas.releasePointerCapture(id); }
  pointers.clear(); for (const code of pressedKeys.values()) key(code, 1); pressedKeys.clear();
}
canvas.addEventListener('blur', releaseInput);
window.addEventListener('blur', releaseInput);
document.addEventListener('visibilitychange', () => { if (document.hidden) releaseInput(); });
$('text-form').addEventListener('submit', event => { event.preventDefault(); const input = $('text-input'); if (!input.value) return; if (new TextEncoder().encode(input.value).length > 4096) { status('Text limit: 4096 UTF-8 bytes'); return; } if (send({type: 'text', text: input.value})) input.value = ''; else status('Wait for the phone to connect'); });
setInterval(() => {
  const now = performance.now();
  if (receivedFrames) $('fps').textContent = `${Math.round((rendered - lastRendered) * 1000 / (now - lastFpsTime))} FPS`;
  lastRendered = rendered; lastFpsTime = now;
}, 1000);
window.addEventListener('pagehide', () => { authenticated = false; authGeneration++; disconnect(); });
window.addEventListener('pageshow', event => { if (event.persisted) location.reload(); });
async function init() {
  try { acceptSession(await request('/api/session')); await preparePhone(); }
  catch (error) { showLogin(error.status === 401 ? '' : 'Service unavailable. Please sign in to try again.'); }
  requestAnimationFrame(fit);
}
init();
