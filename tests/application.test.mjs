import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { scryptSync } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import WebSocket from 'ws';
import { createApplication, encodePacket, validateControl, originAllowed, sendPacket, QUALITY, validatePhoneIdentity, loadRuntimeConfig } from '../server.mjs';
import { createAuth, validateCredentials } from '../lib/auth.mjs';

const password = 'test-only-long-admin-password';
const salt = '0123456789abcdef0123456789abcdef';
const credentials = { schemaVersion: 1, username: 'admin', salt,
  passwordHash: scryptSync(password, Buffer.from(salt, 'hex'), 64, { N: 16384, r: 8, p: 1 }).toString('hex') };
const first = '0123456789abcdef', second = 'fedcba9876543210';
function mockManager(count = 2) {
  const phones = [first, second].slice(0, count).map((id, i) => ({ id, name: `Phone ${i}`, status: 'running',
    guestRamMiB: 4096, hostMemoryMiB: 6144, diskGiB: 12, adbPort: 15000 + i, consolePort: 5556 + i * 2, serial: `emulator-${5556 + i * 2}` }));
  const calls = [];
  return { phones, calls, list: async () => phones.map(p => ({ ...p })),
    capabilities: async () => ({ supported: true, checks: { memory: { ok: true } } }),
    usage: async () => ({ memoryTotalBytes: 1000, memoryAvailableBytes: 600, memoryReservedBytes: 200,
      diskTotalBytes: 2000, diskAvailableBytes: 900, diskCommittedBytes: 400, sharedSdkBytes: 30 }),
    metrics: async id => ({ memoryBytes: id === first ? 123 : null, diskUsedBytes: 456 }),
    create: async input => { calls.push(['create', input]); return { id: 'aaaaaaaaaaaaaaaa', ...input, status: 'stopped' }; },
    start: async id => { calls.push(['start', id]); return phones.find(p => p.id === id); },
    stop: async id => { calls.push(['stop', id]); const p = phones.find(p => p.id === id); p.status = 'stopped'; return p; },
    delete: async id => { calls.push(['delete', id]); phones.splice(phones.findIndex(p => p.id === id), 1); return { id }; },
  };
}
async function fixture(t, options = {}) {
  const manager = options.manager ?? mockManager();
  const states = [], controls = [];
  const starter = async state => {
    states.push(state); state.ready = true; state.video = { width: 100, height: 200 };
    state.client = { close: async () => { state.wasClosed = true; }, controller: {
      injectKeyCode: async value => controls.push([state.phone.id, 'key', value]),
      injectText: async value => controls.push([state.phone.id, 'text', value]),
      setClipboard: async value => controls.push([state.phone.id, 'clipboard', value]),
      injectTouch: async value => controls.push([state.phone.id, 'touch', value]),
      injectScroll: async value => controls.push([state.phone.id, 'scroll', value]),
    } };
  };
  const app = await createApplication({ credentials, manager, secureCookies: false, deviceStarter: starter, ...options });
  app.server.listen(0, '127.0.0.1'); await once(app.server, 'listening');
  t.after(() => app.close());
  const base = `http://127.0.0.1:${app.server.address().port}`;
  const request = (url, init = {}) => fetch(base + url, init);
  const login = (body = { username: 'admin', password }, headers = {}) => request('/api/login', {
    method: 'POST', headers: { Origin: base, 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body) });
  const signIn = async () => { const r = await login(); assert.equal(r.status, 200); return { cookie: r.headers.get('set-cookie').split(';')[0], ...(await r.json()) }; };
  const open = async (session, id = first, quality = 'balanced') => {
    const ws = new WebSocket(`${base.replace('http', 'ws')}/stream?id=${id}&quality=${quality}`, { headers: { Origin: base, Cookie: session.cookie } });
    await once(ws, 'open'); return ws;
  };
  return { ...app, base, request, login, signIn, open, states, controls, manager };
}
async function eventually(predicate) {
  for (let n = 0; n < 100; n++) { if (predicate()) return; await delay(5); }
  assert.ok(predicate(), 'Condition did not become true');
}
async function rejectWS(f, headers, status, suffix = `?id=${first}`) {
  await new Promise((resolve, reject) => {
    const ws = new WebSocket(`${f.base.replace('http', 'ws')}/stream${suffix}`, { headers });
    ws.on('error', () => {});
    ws.on('unexpected-response', (_, response) => { response.resume(); ws.terminate(); try { assert.equal(response.statusCode, status); resolve(); } catch (e) { reject(e); } });
    ws.on('open', () => { ws.terminate(); reject(new Error('Unexpected WS acceptance')); });
  });
}

test('H264 frames retain flags, complete Annex-B payload and microsecond PTS; pressure closes without dropping deltas', () => {
  const data = Uint8Array.of(0, 0, 0, 1, 0x65), pts = 123456789012345n;
  const packet = encodePacket({ type: 'data', pts, keyframe: true, data });
  assert.equal(packet[0], 2); assert.equal(packet.readBigUInt64BE(1), pts); assert.deepEqual(packet.subarray(9), Buffer.from(data));
  assert.equal(encodePacket({ type: 'configuration', data })[0], 1);
  assert.equal(encodePacket({ type: 'data', pts: 0n, data })[0], 0);
  const sent = [], closed = [];
  const ws = { readyState: WebSocket.OPEN, bufferedAmount: 0, send: b => sent.push(b), close: (...args) => closed.push(args) };
  assert.equal(sendPacket(ws, { type: 'data', pts, data }, 14), true);
  ws.bufferedAmount = 1;
  assert.equal(sendPacket(ws, { type: 'data', pts, data }, 14), false);
  assert.equal(sent.length, 1); assert.equal(closed[0][0], 1013);
  assert.deepEqual(Object.keys(QUALITY), ['economy', 'balanced', 'sharp']);
});
test('input rejects commands and invalid coordinate, key and UTF8 boundaries', () => {
  assert.equal(validateControl({ type: 'shell', command: 'id' }), false);
  assert.equal(validateControl({ type: 'text', text: 'Hello 🌎' }), true);
  assert.equal(validateControl({ type: 'text', text: '🌎'.repeat(1025) }), false);
  assert.equal(validateControl({ type: 'text', text: '\0' }), false);
  const touch = { type: 'touch', id: 1, action: 0, x: 40, y: 60, width: 100, height: 200, pressure: 0.5 };
  assert.equal(validateControl(touch), true);
  for (const patch of [{ x: 100 }, { x: -1 }, { pressure: NaN }, { id: -1 }, { width: 0 }, { action: 9 }]) assert.equal(validateControl({ ...touch, ...patch }), false);
  assert.equal(validateControl({ type: 'key', keyCode: 187, action: 1 }), true);
  assert.equal(validateControl({ type: 'key', keyCode: 999, action: 0 }), false);
  assert.throws(() => validatePhoneIdentity({ ...mockManager().phones[0], adbPort: 5037 }));
  assert.throws(() => validatePhoneIdentity({ ...mockManager().phones[0], consolePort: 5554, serial: 'emulator-5554' }));
});
test('strict canonical origin ignores forged forwarding headers and rejects absent/opaque/path origins', () => {
  const req = origin => ({ headers: { host: 'phone.example', origin, 'x-forwarded-proto': 'https' } });
  assert.equal(originAllowed(req('https://phone.example')), false);
  assert.equal(originAllowed(req('https://phone.example'), 'https://phone.example'), true);
  for (const origin of [undefined, 'null', 'https://evil.example', 'https://phone.example/', 'https://phone.example/path']) assert.equal(originAllowed(req(origin), 'https://phone.example'), false);
});
test('scrypt schema, bounded sessions/rate map, expiration and CSRF', async () => {
  assert.throws(() => validateCredentials({ ...credentials, passwordHash: '00' }));
  let time = 0;
  const auth = createAuth({ credentials, maxSessions: 1, maxAttempts: 1, maxRateEntries: 1, sessionMs: 1000, now: () => time });
  assert.equal(await auth.verify({ username: 'admin', password }), true);
  assert.equal(await auth.verify({ username: 'wrong', password }), false);
  assert.equal(await auth.verify({ username: 'admin', password: 'wrong' }), false);
  assert.equal(auth.attempt('a'), true); assert.equal(auth.attempt('a'), false); assert.equal(auth.attempt('b'), false);
  const a = auth.issue(), b = auth.issue(); assert.equal(auth.sessions.has(a.id), false); assert.equal(auth.sessions.size, 1);
  assert.equal(auth.csrf({ headers: { 'x-csrf-token': b.csrf } }, b), true);
  assert.equal(auth.csrf({ headers: {} }, b), false);
  assert.match(auth.cookie(b.id), /HttpOnly; SameSite=Strict/); assert.match(auth.cookie(b.id), /; Secure$/);
  time = 1000; auth.prune(); assert.equal(auth.sessions.size, 0);
  time = 60000; assert.equal(auth.attempt('b'), true);
});
test('HTTP login demands same origin, bounded JSON, secure cookie and CSRF on all mutations', async t => {
  const f = await fixture(t, { secureCookies: true });
  assert.equal((await f.request('/api/session')).status, 401);
  assert.equal((await f.login(undefined, { Origin: '' })).status, 403);
  assert.equal((await f.login(undefined, { Origin: 'https://evil.example' })).status, 403);
  assert.equal((await f.login({ username: 'admin', password: 'wrong' })).status, 401);
  assert.equal((await f.request('/api/login', { method: 'POST', headers: { Origin: f.base, 'Content-Type': 'application/json' }, body: 'x'.repeat(9000) })).status, 413);
  assert.equal((await f.request('/api/login', { method: 'POST', headers: { Origin: f.base, 'Content-Type': 'application/json' }, body: '{' })).status, 400);
  assert.equal((await f.login(undefined, { 'Content-Type': 'text/plain' })).status, 415);
  const login = await f.login(); assert.equal(login.status, 200); assert.match(login.headers.get('set-cookie'), /; Secure$/);
  const s = { ...(await login.json()), cookie: login.headers.get('set-cookie').split(';')[0] };
  assert.equal(s.username, 'admin'); assert.equal(s.mode, 'dashboard'); assert.equal(s.csrf.length, 64);
  const headers = { Cookie: s.cookie, Origin: f.base };
  for (const url of ['/api/logout', `/api/phones/${first}/stop`, '/api/nope']) assert.equal((await f.request(url, { method: 'POST', headers })).status, 403);
  assert.equal((await f.request('/api/logout', { method: 'POST', headers: { ...headers, 'X-CSRF-Token': s.csrf, Origin: 'https://evil.example' } })).status, 403);
  assert.equal((await f.request('/api/logout', { method: 'POST', headers: { ...headers, 'X-CSRF-Token': s.csrf } })).status, 200);
  assert.equal((await f.request('/api/session', { headers })).status, 401);
});
test('API maps live per-phone metrics and nested UI resources; provisioning validates before manager', async t => {
  const f = await fixture(t), s = await f.signIn(), headers = { Cookie: s.cookie, Origin: f.base, 'X-CSRF-Token': s.csrf };
  const phones = await (await f.request('/api/phones', { headers })).json();
  assert.equal(phones.phones[0].memoryBytes, 123); assert.equal(phones.phones[1].memoryBytes, null); assert.equal(phones.phones[0].diskUsedBytes, 456);
  assert.equal(phones.phones[0].adbPort, undefined);
  const resources = await (await f.request('/api/resources', { headers })).json();
  assert.equal(resources.host.memoryAvailableBytes, 600); assert.equal(resources.reserved.diskBytes, 400); assert.equal(resources.capabilities.ok, true);
  const request = { name: 'My phone', guestRamMiB: 4096, hostMemoryMiB: 6144, diskGiB: 12 };
  for (const bad of [{ ...request, shell: 'id' }, { ...request, guestRamMiB: -1 }, { ...request, hostMemoryMiB: 4096 }]) {
    assert.equal((await f.request('/api/phones', { method: 'POST', headers: { ...headers, 'Content-Type': 'application/json' }, body: JSON.stringify(bad) })).status, 400);
  }
  assert.equal(f.manager.calls.length, 0);
  assert.equal((await f.request('/api/phones', { method: 'POST', headers: { ...headers, 'Content-Type': 'application/json' }, body: JSON.stringify(request) })).status, 201);
  f.manager.capabilities = async () => ({ supported: false, checks: { cgroup: { ok: false, reason: 'Unavailable' } } });
  assert.equal((await f.request(`/api/phones/${first}/start`, { method: 'POST', headers })).status, 503);
  assert.equal((await f.request('/api/health?id=../../secret', { headers })).status, 400);
  for (const url of ['/server.mjs', '/credentials.json', '/lib/auth.mjs', '/deploy/INTEGRATION.md']) assert.equal((await f.request(url)).status, 404);
});
test('standalone serves viewer, denies dashboard and provisioning/deletion, refuses multiple phones at startup and runtime', async t => {
  await assert.rejects(createApplication({ credentials, manager: mockManager(), mode: 'standalone' }), /at most one/);
  const f = await fixture(t, { manager: mockManager(1), mode: 'standalone' }), s = await f.signIn();
  assert.match(await (await f.request('/')).text(), /viewer-page/);
  for (const url of ['/index.html', '/app.js', '/dashboard', '/dashboard.html']) assert.equal((await f.request(url)).status, 404);
  const headers = { Cookie: s.cookie, Origin: f.base, 'X-CSRF-Token': s.csrf };
  assert.equal((await f.request('/api/phones', { method: 'POST', headers })).status, 403);
  assert.equal((await f.request(`/api/phones/${first}`, { method: 'DELETE', headers })).status, 403);
  f.manager.phones.push(mockManager().phones[1]);
  assert.equal((await f.request('/api/phones', { headers })).status, 409);
});
test('WS rejects missing session/origin, foreign origin, unknown phones, duplicate query and invalid quality', async t => {
  const f = await fixture(t), s = await f.signIn();
  await rejectWS(f, { Origin: f.base }, 401);
  await rejectWS(f, { Cookie: s.cookie }, 403);
  await rejectWS(f, { Cookie: s.cookie, Origin: 'https://evil.example' }, 403);
  const h = { Cookie: s.cookie, Origin: f.base };
  await rejectWS(f, h, 400, `?id=${first}&quality=ultra`);
  await rejectWS(f, h, 400, `?id=${first}&id=${second}`);
  await rejectWS(f, h, 404, '?id=aaaaaaaaaaaaaaaa');
  f.manager.phones[0].status = 'stopped'; await rejectWS(f, h, 409);
});
test('phones stream independently; takeover/stop affects only selected phone and Unicode controls retain contract', async t => {
  const f = await fixture(t), s = await f.signIn();
  const a = await f.open(s), b = await f.open(s, second, 'economy');
  await eventually(() => f.states.length === 2);
  assert.equal(f.states[0].phone.adbPort, 15000); assert.equal(f.states[1].phone.serial, 'emulator-5558'); assert.equal(f.states[1].quality, 'economy');
  b.send(JSON.stringify({ type: 'text', text: 'Hello 🌎' }));
  await eventually(() => f.controls.length === 1); assert.equal(f.controls[0][0], second); assert.equal(f.controls[0][1], 'clipboard');
  const closed = once(a, 'close'); const c = await f.open(s, first, 'sharp');
  assert.equal((await closed)[0], 4000); await eventually(() => f.states.length === 3);
  assert.equal(b.readyState, WebSocket.OPEN); assert.equal(f.states[0].wasClosed, true);
  const cClosed = once(c, 'close');
  assert.equal((await f.request(`/api/phones/${first}/stop`, { method: 'POST', headers: { Cookie: s.cookie, Origin: f.base, 'X-CSRF-Token': s.csrf } })).status, 200);
  await cClosed; assert.equal(b.readyState, WebSocket.OPEN);
  const bClosed = once(b, 'close'); b.send(JSON.stringify({ type: 'shell', command: 'id' })); assert.equal((await bClosed)[0], 1008);
});
test('queued same-phone replacements close superseded controllers, not another phone', async t => {
  const states = [];
  const f = await fixture(t, { deviceStarter: async state => { states.push(state); await delay(40); state.client = { close: async () => {} }; } });
  const s = await f.signIn(), a = await f.open(s), ac = once(a, 'close');
  const b = await f.open(s), bc = once(b, 'close');
  const c = await f.open(s), d = await f.open(s, second);
  assert.equal((await ac)[0], 4000); assert.equal((await bc)[0], 4000);
  await eventually(() => states.some(state => state.ws.readyState === WebSocket.OPEN && state.phone.id === first));
  assert.equal(c.readyState, WebSocket.OPEN); assert.equal(d.readyState, WebSocket.OPEN);
  c.close(); d.close();
});
test('missing isolated worker fails stream closed, timeout is bounded, and runtime defaults never use live port', async t => {
  const f = await fixture(t, { deviceStarter: undefined });
  const s = await f.signIn();
  const ws = new WebSocket(`${f.base.replace('http', 'ws')}/stream?id=${first}`, { headers: { Origin: f.base, Cookie: s.cookie } });
  assert.equal((await once(ws, 'close'))[0], 1011);
  const timeout = await fixture(t, { deviceStarter: () => new Promise(() => {}), startupTimeoutMs: 20 });
  const ss = await timeout.signIn(), slow = await timeout.open(ss);
  assert.equal((await once(slow, 'close'))[0], 1011);
  const config = await loadRuntimeConfig({}); assert.equal(config.port, 8790); assert.equal(config.host, '127.0.0.1');
  await assert.rejects(loadRuntimeConfig({ PORT: '8787' }), /reserved/);
  await assert.rejects(loadRuntimeConfig({ HOST: '0.0.0.0' }), /loopback/);
  await assert.rejects(loadRuntimeConfig({ CONFIG_FILE: 'relative.json' }), /absolute/);
});

test('trusted broker verifier needs no credential material in HTTP process', async t => {
  const calls = [];
  const f = await fixture(t, { credentials: undefined, verifyCredentials: async (username, supplied) => {
    calls.push([username, supplied]); return username === 'admin' && supplied === password;
  } });
  const s = await f.signIn(); assert.equal(s.role, 'admin'); assert.equal(calls.length, 1);
  assert.equal((await f.login({ username: 'admin', password: 'wrong' })).status, 401);
});
test('phone-key login is scoped across inventory, health, resource/mutation APIs and WebSocket; reveal requires admin CSRF', async t => {
  const manager = mockManager();
  manager.verifyKey = async (id, key) => id === first && key === 'phone-test-key';
  manager.revealKey = async () => 'phone-test-key';
  manager.metrics = async () => ({ memoryCurrentBytes: 321, diskUsedBytes: 654 });
  const f = await fixture(t, { manager });
  const admin = await f.signIn();
  const adminHeaders = { Cookie: admin.cookie, Origin: f.base, 'X-CSRF-Token': admin.csrf };
  const reveal = await f.request(`/api/phones/${first}/key`, { method: 'POST', headers: adminHeaders });
  assert.equal(reveal.status, 200); assert.equal((await reveal.json()).key, 'phone-test-key');
  assert.equal((await f.request(`/api/phones/${first}/key`, { method: 'POST', headers: { Cookie: admin.cookie, Origin: f.base } })).status, 403);
  assert.equal((await f.login({ phoneId: first, key: 'wrong' })).status, 401);
  const login = await f.login({ phoneId: first, key: 'phone-test-key' }); assert.equal(login.status, 200);
  const scoped = { ...(await login.json()), cookie: login.headers.get('set-cookie').split(';')[0] };
  assert.equal(scoped.role, 'phone'); assert.equal(scoped.phoneId, first);
  const headers = { Cookie: scoped.cookie, Origin: f.base, 'X-CSRF-Token': scoped.csrf };
  const list = await (await f.request('/api/phones', { headers })).json();
  assert.equal(list.phones.length, 1); assert.equal(list.phones[0].id, first); assert.equal(list.phones[0].memoryBytes, 321);
  for (const url of [`/api/health?id=${second}`, '/api/resources']) assert.equal((await f.request(url, { headers })).status, 403);
  for (const url of [`/api/phones/${first}/start`, `/api/phones/${first}/key`, '/api/phones']) assert.equal((await f.request(url, { method: 'POST', headers })).status, 403);
  await rejectWS(f, { Cookie: scoped.cookie, Origin: f.base }, 403, `?id=${second}`);
  const ws = await f.open(scoped); await eventually(() => f.states.length === 1);
  const closed = once(ws, 'close');
  assert.equal((await f.request('/api/logout', { method: 'POST', headers })).status, 200);
  assert.equal((await closed)[0], 4001);
});

test('closing during unresolved device startup cancels the lifecycle wait', async t => {
  let starting = false;
  const f = await fixture(t, { startupTimeoutMs: 25000, deviceStarter: () => { starting = true; return new Promise(() => {}); } });
  const s = await f.signIn(); await f.open(s); await eventually(() => starting);
  let closed = false;
  const close = f.close().then(() => { closed = true; });
  await eventually(() => closed); await close;
});
test('chunked oversized bodies return 413 and login rate limits return Retry-After', async t => {
  const f = await fixture(t, { maxAttempts: 2 });
  async function* chunks() { yield 'a'.repeat(4096); yield 'b'.repeat(4096); yield 'c'; }
  const response = await f.request('/api/login', { method: 'POST', headers: { Origin: f.base, 'Content-Type': 'application/json' }, body: chunks(), duplex: 'half' });
  assert.equal(response.status, 413);
  assert.equal((await f.login({ username: 'admin', password: 'wrong' })).status, 401);
  const blocked = await f.login(); assert.equal(blocked.status, 429); assert.equal(blocked.headers.get('retry-after'), '60');
});
