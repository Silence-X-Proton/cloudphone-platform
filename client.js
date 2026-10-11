// Input protocol adapted from cloudphone/client.js; H.264 Annex-B configuration
// follows @yume-chan/scrcpy-decoder-webcodecs. Native queue access is intentional:
// a resolved writable.write() does not mean the hardware decoder has caught up.
import { ScrcpyVideoCodecId, h264ParseConfiguration } from '@yume-chan/scrcpy';

// Only these nonsecret presentation/stream preferences may cross reloads.
export const DEFAULT_PREFERENCES = Object.freeze({quality: 'balanced', latency: 'balanced', scale: 100, zoom: 100, audio: 'opus', muted: false, volume: 80});
export function sanitizePreferences(value) {
  const v = value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  return {quality: ['gaming', 'economy', 'balanced', 'sharp'].includes(v.quality) ? v.quality : 'balanced',
    latency: ['balanced', 'gaming'].includes(v.latency) ? v.latency : 'balanced',
    scale: [50, 75, 100].includes(v.scale) ? v.scale : 100,
    zoom: [100, 125, 150, 200].includes(v.zoom) ? v.zoom : 100,
    audio: ['off', 'opus', 'raw'].includes(v.audio) ? v.audio : 'opus',
    muted: v.muted === true, volume: Number.isFinite(v.volume) ? Math.round(Math.max(0, Math.min(100, v.volume))) : 80};
}
export function mapTouch(rect, x, y, width, height) {
  // Canvas content and its CSS box have the same aspect ratio, including zoom.
  return {x: Math.min(width - 1, Math.max(0, Math.floor((x - rect.left) * width / rect.width))),
    y: Math.min(height - 1, Math.max(0, Math.floor((y - rect.top) * height / rect.height))), width, height};
}
export function opusDescription(data) {
  // Android MediaCodec CSD may wrap OpusHead in AOPUSHDR + u64 LE length.
  let head = data;
  const text = bytes => String.fromCharCode(...bytes);
  if (text(data.subarray(0, 8)) === 'AOPUSHDR') {
    if (data.length < 16) throw new Error('Truncated Opus configuration');
    const size = Number(new DataView(data.buffer, data.byteOffset, data.byteLength).getBigUint64(8, true));
    if (!Number.isSafeInteger(size) || size < 19 || size > data.length - 16) throw new Error('Invalid Opus configuration');
    head = data.subarray(16, 16 + size);
  }
  if (head.length !== 19 || text(head.subarray(0, 8)) !== 'OpusHead' || head[8] !== 1 || head[9] !== 2 || head[18] !== 0) throw new Error('Unsupported Opus channel mapping');
  return head.slice();
}
export class PhoneAudio {
  constructor(report = () => {}, env = globalThis) {
    this.report = report; this.env = env; this.sources = new Set(); this.epoch = 0;
    this.volume = 0.8; this.muted = false; this.limit = 0.2;
  }
  clearScheduled() {
    for (const source of this.sources) { try { source.stop(); } catch {} source.disconnect(); }
    this.sources.clear(); this.anchor = undefined; this.lastPTS = undefined; this.end = 0;
  }
  dispose(preserveContext = false) {
    this.epoch++; this.clearScheduled();
    if (this.decoder && this.decoder.state !== 'closed') this.decoder.close();
    this.decoder = undefined; this.description = undefined; this.metadata = undefined;
    if (preserveContext) {
      this.report(this.context?.state === 'running' ? 'Audio enabled · waiting for stream' : 'Tap Enable audio after connecting');
      return;
    }
    const ctx = this.context; this.context = undefined; this.gain = undefined;
    if (ctx) void ctx.close().catch(() => {});
    this.report('Tap Enable audio after connecting');
  }
  fail(text) {
    this.clearScheduled();
    if (this.decoder && this.decoder.state !== 'closed') this.decoder.close();
    this.decoder = undefined; this.metadata = undefined; this.report(text);
  }
  setVolume(volume, muted) {
    this.volume = Math.max(0, Math.min(1, volume)); this.muted = muted;
    if (this.gain) this.gain.gain.value = muted ? 0 : this.volume;
    if (muted) {
      this.clearScheduled();
      if (this.decoder && this.decoder.state !== 'closed') this.decoder.close();
      this.decoder = undefined;
    }
  }
  async enable() {
    try {
      const Context = this.env.AudioContext || this.env.webkitAudioContext;
      if (!Context) { this.report('Audio unsupported: Web Audio unavailable'); return; }
      if (!this.context) {
        this.context = new Context({latencyHint: 'interactive', sampleRate: 48000});
        this.gain = this.context.createGain(); this.gain.connect(this.context.destination);
        this.setVolume(this.volume, this.muted);
      }
      const ctx = this.context;
      await ctx.resume();
      if (ctx !== this.context) return;
      this.clearScheduled();
      this.report(ctx.state === 'running' ? (this.metadata ? 'Audio enabled · waiting for samples' : 'Audio enabled · waiting for stream') : 'Audio blocked · tap Enable audio again');
    } catch { this.report('Audio unavailable · tap to retry'); }
  }
  metadataMessage(m) {
    this.clearScheduled();
    if (this.decoder && this.decoder.state !== 'closed') this.decoder.close();
    this.decoder = undefined; this.description = undefined; this.metadata = undefined;
    if (m.supported !== true) { this.report('Audio ' + (['disabled', 'unsupported', 'unavailable'].includes(m.reason) ? m.reason : 'unavailable')); return; }
    if (!['opus', 'pcm'].includes(m.codec) || m.sampleRate !== 48000 || m.channels !== 2) { this.report('Audio format unsupported'); return; }
    if (m.codec === 'opus' && !this.env.AudioDecoder) { this.report('Opus unsupported · select PCM audio'); return; }
    this.metadata = m;
    this.report(this.context?.state === 'running' ? 'Audio enabled · waiting for samples' : 'Audio ready · tap Enable audio');
  }
  configureOpus() {
    const current = this.epoch;
    const active = new this.env.AudioDecoder({output: frame => {
      try {
        if (current !== this.epoch || this.decoder !== active || !this.canPlay()) return;
        if (frame.numberOfChannels !== 2 || frame.sampleRate !== 48000 || frame.numberOfFrames > 5760) throw new Error('Invalid decoded audio');
        const buffer = this.context.createBuffer(2, frame.numberOfFrames, 48000);
        for (let channel = 0; channel < 2; channel++) frame.copyTo(buffer.getChannelData(channel), {planeIndex: channel, format: 'f32-planar'});
        this.schedule(buffer, frame.timestamp);
      } catch { this.fail('Audio decoding failed · reconnect or select PCM'); }
      finally { frame.close(); }
    }, error: () => { if (this.decoder === active) this.fail('Opus unavailable · select PCM audio'); }});
    this.decoder = active;
    active.configure({codec: 'opus', sampleRate: 48000, numberOfChannels: 2, ...(this.description ? {description: this.description} : {})});
  }
  canPlay() { return this.metadata && this.context?.state === 'running' && !this.muted; }
  packet(flags, timestamp, data) {
    try {
      if (![3, 4].includes(flags) || !Number.isSafeInteger(timestamp) || timestamp < 0 || !data.length || data.length > 256 * 1024) throw new Error('Invalid audio packet');
      if (!this.metadata) return;
      if (flags === 4) {
        if (this.metadata.codec !== 'opus') throw new Error('Unexpected PCM configuration');
        this.description = opusDescription(data); this.clearScheduled();
        if (this.decoder && this.decoder.state !== 'closed') this.decoder.close();
        this.decoder = undefined; return;
      }
      if (!this.canPlay()) return; // Never retain media while muted or gesture-blocked.
      if (this.metadata.codec === 'pcm') {
        if (data.length % 4 || data.length > 48000 * 4 * 0.12) throw new Error('Invalid PCM sample count');
        const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
        const buffer = this.context.createBuffer(2, data.length / 4, 48000);
        for (let channel = 0; channel < 2; channel++) {
          const target = buffer.getChannelData(channel);
          for (let i = 0; i < target.length; i++) target[i] = view.getInt16(i * 4 + channel * 2, true) / 32768;
        }
        this.schedule(buffer, timestamp);
      } else {
        if (!this.decoder) this.configureOpus();
        if (this.decoder.decodeQueueSize >= 6) {
          this.decoder.close(); this.decoder = undefined; this.clearScheduled();
          this.configureOpus(); // Opus packets are independently decodable (quality may briefly dip).
          this.report('Audio queue reset to reduce delay');
        }
        this.decoder.decode(new this.env.EncodedAudioChunk({type: 'key', timestamp, data}));
      }
    } catch { this.fail('Audio data unsupported · reconnect or select PCM'); }
  }
  schedule(buffer, timestamp) {
    if (!this.canPlay() || !Number.isSafeInteger(timestamp) || timestamp < 0 || buffer.duration > this.limit) return;
    const now = this.context.currentTime;
    const lead = Math.min(0.025, Math.max(0, this.limit - buffer.duration));
    let when = this.anchor === undefined ? now + lead : this.anchor + (timestamp - this.basePTS) / 1e6;
    // Source PTS supplies spacing, not a claim of wall-clock or A/V synchronization.
    // Rebase discontinuities and stale/bursty audio instead of building a seconds-long queue.
    if (this.lastPTS !== undefined && (timestamp <= this.lastPTS || when < now - 0.04 || when + buffer.duration > now + this.limit) || this.sources.size >= 16) {
      this.clearScheduled(); when = now + lead;
    }
    if (this.anchor === undefined) { this.anchor = when; this.basePTS = timestamp; }
    this.lastPTS = timestamp;
    const source = this.context.createBufferSource(); source.buffer = buffer; source.connect(this.gain);
    this.sources.add(source); source.onended = () => { this.sources.delete(source); source.disconnect(); };
    source.start(Math.max(now, when)); this.end = when + buffer.duration;
    this.report(this.volume ? 'Audio playing · local buffer ≤ ' + Math.round(this.limit * 1000) + ' ms' : 'Audio enabled · volume zero');
  }
}

if (typeof document !== 'undefined') {
const $ = id => document.getElementById(id);
const canvas = $('screen');
const context = canvas.getContext('2d', {alpha: false});
const MAX_DECODE_QUEUE = 6, MAX_RETRIES = 6, MAX_OVERLOAD_RECOVERIES = 3, MAX_PACKET_BYTES = 8 * 1024 * 1024;
let socket, decoder, retryTimer, connectTimer, stableTimer;
let authenticated = false, csrf = '', mode = '', phoneId = '', generation = 0, failures = 0;
let width = 0, height = 0, receivedFrames = 0, rendered = 0, lastRendered = 0, lastFpsTime = performance.now();
let preferences;
try { preferences = sanitizePreferences(JSON.parse(localStorage.getItem('cloudphone-viewer-v1'))); } catch { preferences = sanitizePreferences(); }
const savePreferences = () => { try { localStorage.setItem('cloudphone-viewer-v1', JSON.stringify(sanitizePreferences(preferences))); } catch {} };
const audio = new PhoneAudio(text => { $('audio-status').textContent = text; });
let encoderDraft = {...preferences}, settingsState = '', overloadRecoveries = 0;
let quality = preferences.quality, preparing = false, authGeneration = 0, sessionRole = '', scopedPhoneId = '';
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
  const w = Math.min(availableWidth, availableHeight * ratio) * preferences.zoom / 100, h = w / ratio;
  area.classList.toggle('zoomed', preferences.zoom > 100);
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
  audio.dispose(authenticated);
  const old = decoder; decoder = undefined;
  if (old && old.state !== 'closed') old.close();
  receivedFrames = 0; width = 0; height = 0; rendered = 0; lastRendered = 0; lastFpsTime = performance.now();
  pointers.clear(); pressedKeys.clear(); $('fps').textContent = '— FPS';
  context?.clearRect(0, 0, canvas.width, canvas.height);
}
function disconnect() {
  clearTimeout(retryTimer); clearTimeout(connectTimer); clearTimeout(stableTimer);
  releaseInput(); ++generation;
  if (authenticated) status('Disconnected');
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
          settingsState = ''; updateSettingsStatus();
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
  // Runtime adaptation must not overwrite saved preferences or pending edits.
  quality = quality === 'sharp' || quality === 'gaming' ? 'balanced' : 'economy';
  $('quality-help').textContent = `Recovery uses ${quality} quality. Saved settings and Android are unchanged.`;
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
  const params = new URLSearchParams({id: phoneId, quality, audio: preferences.audio, scale: String(preferences.scale / 100)});
  const ws = new WebSocket(`${location.protocol === 'https:' ? 'wss:' : 'ws:'}//${location.host}/stream?${params}`);
  socket = ws; ws.binaryType = 'arraybuffer';
  let config, keyframe = false, localBacklog = false, closed = false;
  audio.limit = preferences.latency === 'gaming' || quality === 'gaming' ? 0.12 : 0.2;
  audio.setVolume(preferences.volume / 100, preferences.muted);
  connectTimer = setTimeout(() => { if (current === generation) ws.close(4004, 'Video timeout'); }, 20000);
  ws.onmessage = event => {
    if (current !== generation || ws.readyState !== WebSocket.OPEN) return;
    try {
      if (typeof event.data === 'string') {
        const message = JSON.parse(event.data);
        if (message.type === 'metadata') { createDecoder(message.codec, current); if (message.audio === false) audio.metadataMessage({supported: false, reason: 'disabled'}); }
        else if (message.type === 'audio') audio.metadataMessage(message);
        else if (message.type === 'size') setSize(message.width, message.height);
        else if (message.type === 'status') status(String(message.message || 'Preparing Android…'));
        else if (message.type === 'error') overlay('Android is unavailable.', String(message.message || 'Try reconnecting after the phone is ready.'), true);
        return;
      }
      if (event.data.byteLength < 10 || event.data.byteLength > MAX_PACKET_BYTES) throw new Error('Invalid media packet');
      const view = new DataView(event.data), flags = view.getUint8(0);
      if (flags === 3 || flags === 4) { audio.packet(flags, Number(view.getBigUint64(1)), new Uint8Array(event.data, 9)); return; }
      if (!decoder) throw new Error('Missing video metadata');
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
      const pts = Number(view.getBigUint64(1));
      if (!Number.isSafeInteger(pts)) throw new Error('Invalid video timestamp');
      // scrcpy PTS is media spacing, not browser wall time. Static frames and
      // event-loop stalls do not prove backlog; only the actual decoder queue does.
      if (decoder.decodeQueueSize >= (preferences.latency === 'gaming' || quality === 'gaming' ? 3 : MAX_DECODE_QUEUE)) {
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
    if (current !== generation || closed) return;
    closed = true; socket = undefined;
    clearTimeout(connectTimer); clearTimeout(stableTimer); disposeDecoder(); status('Disconnected');
    settingsState = 'Saved for the next connection'; updateSettingsStatus();
    if (event.code === 4000) { overlay('Connected somewhere else.', 'Only one browser controls this phone. Reconnect to take control here.', true); return; }
    if (event.code === 4001) { showLogin('Your session expired. Sign in again.'); return; }
    if (event.code === 1008) { overlay('Connection refused.', 'The server rejected this connection. Check your access before reconnecting.', true); return; }
    if (event.code === 1013 || localBacklog || event.code === 4003) {
      // This budget is not reset by a single frame or the ordinary stability timer.
      if (++overloadRecoveries > MAX_OVERLOAD_RECOVERIES) {
        status('Reconnect paused');
        overlay('Stream recovery paused.', 'Repeated overload reached the automatic recovery limit. Try lower encoding settings or reconnect manually.', true); return;
      }
      lowerQuality();
    }
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
  if ($('session-settings').open) $('session-settings').close();
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
      status('Browser not supported'); overlay('A newer browser is needed.', 'Use a current Chrome, Edge, or Safari with H.264 WebCodecs, over HTTPS (or localhost). Audio support is negotiated separately.'); return;
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
    $('password').value = ''; $('phone-access-key').value = ''; acceptSession(body); failures = 0; overloadRecoveries = 0; await preparePhone();
  } catch (error) { $('login-error').textContent = error.message; }
  finally { $('password').value = ''; $('phone-access-key').value = ''; $('login-button').disabled = false; $('login-method').disabled = false; }
});
$('logout').addEventListener('click', async () => {
  $('logout').disabled = true;
  try { await request('/api/logout', {method: 'POST', headers: {'X-CSRF-Token': csrf}}); showLogin(); }
  catch (error) { if (error.status === 401) showLogin(); else status(error.message); }
  finally { $('logout').disabled = false; }
});
$('reconnect').addEventListener('click', () => { failures = 0; overloadRecoveries = 0; quality = preferences.quality; disconnect(); void preparePhone(); });
const encoderKeys = ['quality', 'scale', 'audio'];
function hasEncoderDraft() { return encoderKeys.some(id => encoderDraft[id] !== preferences[id]); }
function updateSettingsStatus() {
  const pending = hasEncoderDraft();
  $('apply-settings').disabled = !pending;
  $('settings-status').textContent = pending ? 'Unapplied encoding changes · Apply restarts the stream once' : (settingsState || 'Encoding settings saved · local controls apply immediately');
}
function syncPreferences() {
  for (const id of ['quality', 'latency', 'scale', 'zoom', 'audio', 'volume']) $(id).value = String(encoderKeys.includes(id) ? encoderDraft[id] : preferences[id]);
  $('mute').checked = preferences.muted;
  audio.limit = preferences.latency === 'gaming' || quality === 'gaming' ? 0.12 : 0.2;
  audio.setVolume(preferences.volume / 100, preferences.muted);
  $('volume-value').textContent = preferences.volume + '%';
  updateSettingsStatus();
}
syncPreferences();
for (const id of encoderKeys) $(id).addEventListener('change', () => {
  encoderDraft = sanitizePreferences({...encoderDraft, [id]: id === 'scale' ? Number($(id).value) : $(id).value});
  syncPreferences();
});
$('apply-settings').addEventListener('click', () => {
  if (!hasEncoderDraft()) return;
  for (const id of encoderKeys) preferences[id] = encoderDraft[id];
  quality = preferences.quality; savePreferences();
  const active = socket && [WebSocket.OPEN, WebSocket.CONNECTING].includes(socket.readyState);
  // Cancel queued retries even when disconnected. Apply saves, never starts Android
  // or silently reconnects a disconnected viewer. In-flight preparation uses new values.
  if (!active && !preparing) disconnect();
  failures = 0; overloadRecoveries = 0;
  settingsState = active || preparing ? 'Applying encoding settings…' : 'Saved for the next connection';
  syncPreferences();
  if (active) connect();
});
$('latency').addEventListener('change', () => {
  preferences = sanitizePreferences({...preferences, latency: $('latency').value});
  audio.clearScheduled(); savePreferences(); syncPreferences();
});
$('zoom').addEventListener('change', () => { preferences.zoom = Number($('zoom').value); savePreferences(); fit(); });
$('fit').addEventListener('click', () => { preferences.zoom = 100; savePreferences(); syncPreferences(); fit(); });
$('volume').addEventListener('input', () => { preferences.volume = Number($('volume').value); savePreferences(); syncPreferences(); });
$('mute').addEventListener('change', () => { preferences.muted = $('mute').checked; savePreferences(); syncPreferences(); });
$('enable-audio').addEventListener('click', () => {
  if (preferences.audio === 'off') { $('audio-status').textContent = 'Select Opus or PCM audio first'; return; }
  if (!authenticated || !socket || socket.readyState !== WebSocket.OPEN) { $('audio-status').textContent = 'Connect to Android before enabling audio'; return; }
  void audio.enable();
});
$('reset-settings').addEventListener('click', () => {
  encoderDraft = sanitizePreferences();
  for (const id of ['latency', 'zoom', 'volume', 'muted']) preferences[id] = DEFAULT_PREFERENCES[id];
  audio.clearScheduled(); savePreferences(); syncPreferences(); fit(); $('screen-stage').scrollTo(0, 0);
});
$('open-settings').addEventListener('click', () => {
  releaseInput(); $('session-settings').showModal(); $('close-settings').focus();
});
$('close-settings').addEventListener('click', () => $('session-settings').close());
$('session-settings').addEventListener('keydown', event => {
  if (event.key !== 'Tab') return;
  const controls = [...$('session-settings').querySelectorAll('button, input, select, [tabindex]')]
    .filter(element => !element.disabled && element.tabIndex >= 0 && element.getClientRects().length);
  const first = controls[0], last = controls.at(-1);
  if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
  else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
});
$('session-settings').addEventListener('close', () => {
  if (!$('login-dialog').open) $('open-settings').focus({preventScroll: true});
});
document.addEventListener('fullscreenchange', fit);
$('fullscreen').addEventListener('click', async () => {
  try { if (document.fullscreenElement) await document.exitFullscreen(); else await $('viewer-main').requestFullscreen(); }
  catch { status('Fullscreen unavailable in this browser'); }
});
const position = event => mapTouch(canvas.getBoundingClientRect(), event.clientX, event.clientY, width, height);
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
document.addEventListener('visibilitychange', () => {
  if (document.hidden) { releaseInput(); audio.clearScheduled(); void audio.context?.suspend().catch(() => {}); }
  else if (audio.context) $('audio-status').textContent = 'Tap Enable audio to resume';
});
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

}
