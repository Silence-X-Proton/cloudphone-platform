import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { once } from 'node:events';
import { setTimeout as delay } from 'node:timers/promises';
import { WebSocket } from 'ws';
import { createPhoneWorker, assertWorkerIsolation, validateControl, encodePacket, sendPacket, MAX_BUFFERED, MAX_INBOUND, QUALITY } from '../lib/phone-worker.mjs';

const phone = { id: '0123456789abcdef', adbPort: 15000, consolePort: 5556, serial: 'emulator-5556' };
const base = { phone, scrcpyServer: '/opt/cloudphone/bin/scrcpy-server.jar', webGid: process.getgid() || 1, networkMode: 'private', hostNetNamespace: 'net:[100]' };
const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };
async function eventually(check) {
  for (let i = 0; i < 100; i++) { if (check()) return; await delay(5); }
  assert.ok(check(), 'condition did not settle');
}
async function fixture(t, starter, overrides = {}) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'cpw-'));
  const socketPath = path.join(dir, 'stream.sock');
  const worker = await createPhoneWorker({ ...base, socketPath, isolationProbe: async () => {}, deviceStarter: starter, ...overrides });
  t.after(async () => { await worker.close(); await fs.rm(dir, { recursive: true, force: true }); });
  await worker.listen();
  return { worker, socketPath, dir };
}
async function connect(t, socketPath) {
  const ws = new WebSocket(`ws+unix://${socketPath}:/stream`, { perMessageDeflate: false, maxPayload: MAX_BUFFERED });
  const messages = [];
  ws.on('message', (data, binary) => messages.push(binary ? data : JSON.parse(data)));
  await once(ws, 'open');
  t.after(() => ws.terminate());
  return { ws, messages };
}
function fakeStarter(calls, states = []) {
  return async (state, send) => {
    states.push(state);
    state.adb = { close: async () => calls.push(['adb.close']) };
    state.client = { close: async () => calls.push(['client.close']), controller: Object.fromEntries(
      ['injectKeyCode', 'injectText', 'setClipboard', 'injectTouch', 'injectScroll'].map(name => [name, async value => calls.push([name, value])])) };
    state.video = { width: 720, height: 1520 };
    state.ready = true;
    send({ type: 'metadata', width: 720, height: 1520, codec: 0x68323634, audio: false });
    sendPacket(state.ws, { type: 'configuration', data: Buffer.from([0, 0, 0, 1, 0x67]) });
  };
}
async function start(ws, messages, quality = 'balanced') {
  ws.send(JSON.stringify({ type: 'start', quality }));
  await eventually(() => messages.some(m => m.type === 'metadata'));
}

test('strict control schemas reject capabilities, extra fields, invalid bounds', () => {
  assert.ok(validateControl({ type: 'key', keyCode: 3, action: 0 }));
  assert.ok(validateControl({ type: 'text', text: '你好' }));
  for (const m of [null, [], { type: 'shell', command: 'id' }, { type: 'key', keyCode: 3, action: 0, serial: 'evil' },
    { type: 'key', keyCode: 9999, action: 0 }, { type: 'text', text: '\0' }, { type: 'text', text: 'a'.repeat(4097) },
    { type: 'text', text: '😀'.repeat(1025) }, { type: 'scroll', width: 1, height: 1, x: 1, y: 0, dx: 0, dy: 0 },
    { type: 'touch', width: 1, height: 1, x: 0, y: 0, id: 1, action: 2, pressure: Infinity }]) assert.equal(validateControl(m), false);
  assert.equal(QUALITY.balanced.videoBitRate, 4000000);
});

test('binary H264 protocol preserves flags, u64 microseconds and Annex-B bytes', () => {
  const data = Buffer.from([0, 0, 0, 1, 0x65, 0x80]);
  const packet = encodePacket({ type: 'data', keyframe: true, pts: 9007199254740993n, data });
  assert.equal(packet.toString('hex'), '020020000000000001000000016580');
  assert.equal(encodePacket({ type: 'configuration', data }).subarray(0, 9).toString('hex'), '010000000000000000');
  assert.equal(encodePacket({ type: 'data', data })[0], 0);
  assert.throws(() => encodePacket({ type: 'data', pts: -1n, data }));
});

test('outbound bound closes rather than dropping deltas or overallocating', () => {
  const sent = []; const closed = [];
  const ws = { readyState: WebSocket.OPEN, bufferedAmount: MAX_BUFFERED - 10, send: x => sent.push(x), close: (...x) => closed.push(x) };
  assert.equal(sendPacket(ws, { type: 'data', data: Buffer.alloc(1) }), true);
  assert.equal(sendPacket(ws, { type: 'data', data: Buffer.alloc(2) }), false);
  assert.equal(closed[0][0], 1013); assert.equal(sent.length, 1);
  ws.readyState = WebSocket.CLOSED;
  assert.equal(sendPacket(ws, { type: 'data', data: Buffer.alloc(1) }), false);
});

test('confinement verifies phone UID, cgroup, memory/swap and namespace; no egress fallback', async () => {
  const options = { ...base, socketPath: '/srv/cloudphone/run/stream.sock' };
  const group = `/system.slice/cloudphone-${phone.id}.service`;
  const files = { '/proc/self/cgroup': `0::${group}\n`, [`/sys/fs/cgroup${group}/memory.max`]: '2147483648\n', [`/sys/fs/cgroup${group}/memory.swap.max`]: '0\n' };
  const io = { readFile: async p => files[p], readlink: async () => 'net:[101]' };
  await assertWorkerIsolation(options, { uid: 200000, io });
  for (const uid of [0, 200001]) await assert.rejects(assertWorkerIsolation(options, { uid, io }), /UID|unprivileged/);
  await assert.rejects(assertWorkerIsolation(options, { uid: 200000, io: { ...io, readlink: async () => 'net:[100]' } }), /namespace/);
  for (const [p, bad] of [['/proc/self/cgroup', '0::/'], [`/sys/fs/cgroup${group}/memory.max`, 'max'], [`/sys/fs/cgroup${group}/memory.swap.max`, 'max']]) {
    const original = files[p]; files[p] = bad;
    await assert.rejects(assertWorkerIsolation(options, { uid: 200000, io }), /cgroup|boundary/); files[p] = original;
  }
  await assert.rejects(createPhoneWorker({ ...options, networkMode: 'slirp' }), /egress helper unavailable/);
  await assert.rejects(createPhoneWorker({ ...options, networkMode: 'host' }), /private networking/);
});

test('socket is mode0660 shared gid, no HTTP routes, cleans socket and staging', async t => {
  const { worker, socketPath, dir } = await fixture(t, fakeStarter([]));
  const st = await fs.lstat(socketPath);
  assert.ok(st.isSocket()); assert.equal(st.mode & 0o777, 0o660); assert.equal(st.gid, base.webGid);
  const status = await new Promise((resolve, reject) => {
    http.get({ socketPath, path: '/adb' }, res => { res.resume(); resolve(res.statusCode); }).on('error', reject);
  });
  assert.equal(status, 404);
  await worker.close(); assert.deepEqual(await fs.readdir(dir), []);
});

test('fails closed before binding when isolation probe rejects', async t => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'cpw-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const worker = await createPhoneWorker({ ...base, socketPath: `${dir}/stream.sock`, isolationProbe: async () => { throw new Error('not isolated'); } });
  await assert.rejects(worker.listen(), /not isolated/);
  assert.deepEqual(await fs.readdir(dir), []);
});

test('does not replace existing socket path or symlink; rejects writable directory', async t => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'cpw-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const socketPath = `${dir}/stream.sock`;
  await fs.writeFile(socketPath, 'keep');
  let worker = await createPhoneWorker({ ...base, socketPath, isolationProbe: async () => {} });
  await assert.rejects(worker.listen(), { code: 'EEXIST' });
  assert.equal(await fs.readFile(socketPath, 'utf8'), 'keep');
  await fs.unlink(socketPath); await fs.symlink('/does-not-exist', socketPath);
  worker = await createPhoneWorker({ ...base, socketPath, isolationProbe: async () => {} });
  await assert.rejects(worker.listen(), { code: 'EEXIST' });
  assert.equal(await fs.readlink(socketPath), '/does-not-exist');
  await fs.chmod(dir, 0o777);
  worker = await createPhoneWorker({ ...base, socketPath, isolationProbe: async () => {} });
  await assert.rejects(worker.listen(), /Unsafe worker socket directory/);
});

test('Unix frontend gets original metadata/binary and allowlisted Unicode/key/touch/scroll controls', async t => {
  const calls = [], states = [];
  const { socketPath } = await fixture(t, fakeStarter(calls, states));
  const { ws, messages } = await connect(t, socketPath);
  assert.equal(states.length, 0);
  await start(ws, messages, 'sharp');
  assert.equal(states[0].quality, 'sharp');
  assert.equal(messages.find(Buffer.isBuffer).toString('hex'), '0100000000000000000000000167');
  const touch = { type: 'touch', id: 4, action: 0, x: 20, y: 30, width: 720, height: 1520, pressure: 1 };
  for (const m of [{ type: 'key', keyCode: 3, action: 0 }, { type: 'text', text: 'A' }, { type: 'text', text: '你好' },
    touch, { ...touch, action: 3 }, { type: 'scroll', x: 1, y: 2, width: 720, height: 1520, dx: -1, dy: 1 }]) ws.send(JSON.stringify(m));
  await eventually(() => calls.length === 6);
  assert.deepEqual(calls.map(c => c[0]), ['injectKeyCode', 'injectText', 'setClipboard', 'injectTouch', 'injectTouch', 'injectScroll']);
  assert.deepEqual(calls[2][1], { sequence: 0n, content: '你好', paste: 1 });
  assert.equal(calls[4][1].pressure, 0); assert.equal(calls[4][1].action, 1); assert.equal(calls[4][1].pointerId, 4n);
  ws.send(JSON.stringify({ ...touch, width: 719 })); ws.send(JSON.stringify({ ...touch, action: 2 }));
  await delay(20); assert.equal(calls.length, 6);
  ws.close(); await once(ws, 'close');
  await eventually(() => calls.filter(c => c[0].endsWith('.close')).length === 2);
});

for (const [label, payload, code] of [
  ['invalid JSON', '{', 1008], ['binary', Buffer.from('{}'), 1008], ['missing start', JSON.stringify({ type: 'key', keyCode: 3, action: 0 }), 1008],
  ['injected serial', JSON.stringify({ type: 'start', quality: 'balanced', serial: 'elsewhere' }), 1008],
  ['inherited quality key', JSON.stringify({ type: 'start', quality: 'constructor' }), 1008], ['oversized', 'x'.repeat(MAX_INBOUND + 1), 1009],
]) test(`rejects ${label} before device access`, async t => {
  let starts = 0;
  const { socketPath } = await fixture(t, async () => { starts++; });
  const { ws } = await connect(t, socketPath); const closed = once(ws, 'close');
  ws.send(payload); assert.equal((await closed)[0], code); assert.equal(starts, 0);
});

test('quality changes require fresh connection; reject second start', async t => {
  const { socketPath } = await fixture(t, fakeStarter([]));
  const { ws, messages } = await connect(t, socketPath); await start(ws, messages);
  const closed = once(ws, 'close'); ws.send(JSON.stringify({ type: 'start', quality: 'economy' }));
  assert.equal((await closed)[0], 1008);
});

test('startup failure reports generic error and closes acquired resources', async t => {
  let closed = 0;
  const { socketPath } = await fixture(t, async state => {
    state.adb = { close: async () => { closed++; } };
    throw new Error('secret ADB internals');
  });
  const { ws, messages } = await connect(t, socketPath); const end = once(ws, 'close');
  ws.send(JSON.stringify({ type: 'start', quality: 'balanced' }));
  assert.equal((await end)[0], 1011); await eventually(() => closed === 1);
  assert.ok(messages.some(m => m.type === 'error'));
  assert.equal(JSON.stringify(messages).includes('secret'), false);
});

test('disconnect during startup retains exclusive slot and closes late resources', async t => {
  const entered = deferred(), release = deferred(); let closed = 0;
  const { socketPath } = await fixture(t, async state => {
    entered.resolve(); await release.promise;
    state.client = { close: async () => { closed++; } };
  });
  // Always release on assertion failure, so teardown cannot strand startup.
  t.after(() => release.resolve());
  const { ws } = await connect(t, socketPath);
  ws.send(JSON.stringify({ type: 'start', quality: 'balanced' })); await entered.promise;
  ws.close(); await once(ws, 'close');
  const other = new WebSocket(`ws+unix://${socketPath}:/stream`);
  other.on('error', () => {});
  const rejected = once(other, 'unexpected-response');
  const [, response] = await rejected; assert.equal(response.statusCode, 409); response.resume(); other.terminate();
  release.resolve(); await eventually(() => closed === 1);
  const next = await connect(t, socketPath); next.ws.close(); await once(next.ws, 'close');
});

test('controller failure prevents queued controls after closing begins', async t => {
  let injected = 0;
  const { socketPath } = await fixture(t, async (state, send) => {
    await fakeStarter([])(state, send);
    state.client.controller.injectKeyCode = async () => { injected++; throw new Error('transport failed'); };
  });
  const { ws, messages } = await connect(t, socketPath); await start(ws, messages);
  const closed = once(ws, 'close');
  for (let i = 0; i < 20; i++) ws.send(JSON.stringify({ type: 'key', keyCode: 3, action: 0 }));
  assert.equal((await closed)[0], 1011);
  assert.equal(injected, 1);
});

test('bounded control burst closes abusive peer', async t => {
  const release = deferred(); const calls = [];
  const { socketPath } = await fixture(t, async (state, send) => {
    await fakeStarter(calls)(state, send);
    state.client.controller.injectKeyCode = () => release.promise;
  });
  const { ws, messages } = await connect(t, socketPath); await start(ws, messages);
  const closed = once(ws, 'close');
  for (let i = 0; i < 600; i++) ws.send(JSON.stringify({ type: 'key', keyCode: 3, action: 0 }));
  release.resolve(); assert.equal((await closed)[0], 1008);
});

test('audio wire tags preserve raw payload and timestamp independently of H264', () => {
  const data=Buffer.from([0,128,255,127]);
  assert.equal(encodePacket({type:'data',pts:123n,data},true).toString('hex'),'03000000000000007b0080ff7f');
  assert.equal(encodePacket({type:'configuration',data},true)[0],4);
});
test('worker start validates audio codec and fractional encoded scale, not guest geometry', async () => {
  const {validStart,streamOptions}=await import('../lib/phone-worker.mjs');
  assert(validStart({type:'start',quality:'gaming',scale:.5,audio:'raw'}));
  for(const m of [{scale:50},{audio:'aac'},{scale:0},{latency:'gaming'}])assert.equal(validStart({type:'start',quality:'balanced',...m}),false);
  assert.deepEqual(streamOptions({quality:'gaming',scale:.5,audio:'raw'}),{videoBitRate:2500000,maxSize:480,maxFps:60,audio:true,audioCodec:'raw',audioBitRate:128000});
  assert.equal(streamOptions({quality:'balanced'}).audio,true);
  assert.equal(streamOptions({quality:'balanced',audio:'off'}).audio,false);
});
test('installed audioStream success/disabled/errored API is drained and bounded without ending video', async () => {
  const {pumpAudio}=await import('../lib/phone-worker.mjs');
  const sent=[],metadata=[];
  const state={stopped:false,ws:{readyState:WebSocket.OPEN,bufferedAmount:0,send:data=>sent.push(data),close:()=>{}},client:{audioStream:Promise.resolve({type:'success',codec:{optionValue:'raw'},stream:new ReadableStream({start(c){c.enqueue({type:'data',pts:20n,data:Buffer.from([0,0,0,0])});c.close();}})})}};
  await pumpAudio(state,m=>metadata.push(m));assert.deepEqual(metadata[0],{type:'audio',supported:true,codec:'pcm',sampleRate:48000,channels:2});assert.equal(sent[0][0],3);
  for(const type of ['disabled','errored']){metadata.length=0;state.client.audioStream=Promise.resolve({type});await pumpAudio(state,m=>metadata.push(m));assert.equal(metadata[0].supported,false);}
});
