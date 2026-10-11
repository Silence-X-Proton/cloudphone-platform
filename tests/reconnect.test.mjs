import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

// Execute real client event handlers. Only browser/transport/codec primitives are fakes.
const source = readFileSync(new URL('../client.js', import.meta.url), 'utf8')
  .replace(/^import .*;$/m, '').replace(/^export /gm, '');
async function fixture() {
  let now = 0, next = 0;
  const timers = new Map(), sockets = [], decoders = [], elements = new Map(), storage = new Map();
  const flush = async () => { for (let i = 0; i < 20; i++) await Promise.resolve(); };
  class Element {
    value = ''; checked = false; disabled = false; open = false; style = {}; dataset = {}; handlers = {};
    clientWidth = 500; clientHeight = 900; classList = {toggle(){}};
    addEventListener(type, fn) { (this.handlers[type] ||= []).push(fn); }
    async emit(type, patch = {}) { for (const fn of this.handlers[type] || []) await fn({preventDefault(){}, ...patch}); await flush(); }
    getContext() { return {clearRect(){}, drawImage(){}}; }
    showModal() { this.open = true; } close() { this.open = false; }
    setAttribute() {} focus() {} scrollTo() {} querySelectorAll() { return []; }
  }
  const $ = id => { if (!elements.has(id)) elements.set(id, new Element()); return elements.get(id); };
  class Socket {
    static OPEN = 1; readyState = 1; bufferedAmount = 0; closes = []; sent = [];
    constructor(url) { this.url = url; sockets.push(this); }
    send(data) { this.sent.push(data); } close(code = 1000) { this.closes.push(code); this.readyState = 3; }
    async end(code) { this.readyState = 3; await this.onclose?.({code}); await flush(); }
    message(data) { this.onmessage?.({data}); }
  }
  class Decoder {
    state = 'unconfigured'; decodeQueueSize = 0;
    constructor(callbacks) { this.callbacks = callbacks; decoders.push(this); }
    close() { this.state = 'closed'; } reset() { this.state = 'unconfigured'; }
    configure() { this.state = 'configured'; }
    decode() { this.callbacks.output({displayWidth: 240, displayHeight: 480, close(){}}); }
  }
  let fetchOverride;
  const env = {
    console, URLSearchParams, TextEncoder, AbortSignal, DataView, Uint8Array,
    ScrcpyVideoCodecId: {H264: 1}, h264ParseConfiguration: () => ({profileIndex:66,constraintSet:0,levelIndex:30,croppedWidth:240,croppedHeight:480}),
    document: {getElementById:$,documentElement: new Element(), querySelector: () => new Element(),querySelectorAll: () => [],addEventListener(){}},
    window: {isSecureContext:true,addEventListener(){}}, location: {search:'?id=0123456789abcdef',protocol:'https:',host:'test'},
    localStorage: {getItem:k=>storage.get(k),setItem:(k,v)=>storage.set(k,v)}, matchMedia:()=>({matches:false}),
    performance: {now:()=>now}, ResizeObserver: class {observe(){}}, WebSocket: Socket, VideoDecoder: Decoder, EncodedVideoChunk: class {constructor(v){Object.assign(this,v);}},
    setTimeout: (fn, ms) => { const id = ++next; timers.set(id,{fn,at:now+ms,ms}); return id; }, clearTimeout: id => timers.delete(id), setInterval(){}, requestAnimationFrame(){},
    fetch: async path => {
      if (fetchOverride) { const response = fetchOverride(path); if (response) return response; }
      return {ok:true,json:async()=>path==='/api/session'?{csrf:'test',mode:'standalone',role:'admin'}:path==='/api/phones'?{phones:[{id:'0123456789abcdef',status:'running'}]}:{}};
    },
  };
  vm.runInNewContext(source, env); await flush();
  assert.equal(sockets.length,1,'fixture must authenticate and open a stream');
  function packet(flags, pts=0) { const b = new ArrayBuffer(10), v = new DataView(b); v.setUint8(0,flags); v.setBigUint64(1,BigInt(pts)); return b; }
  function start(ws=sockets.at(-1)) { ws.message(JSON.stringify({type:'metadata',codec:1})); ws.message(packet(1)); ws.message(packet(2)); }
  async function tick(ms) { const end=now+ms; while(true) { const entry=[...timers].filter(([,v])=>v.at<=end).sort((a,b)=>a[1].at-b[1].at)[0]; if(!entry)break; timers.delete(entry[0]);now=entry[1].at;entry[1].fn();await flush(); } now=end;await flush(); }
  async function change(id,value,type='change') { $(id).value=String(value);await $(id).emit(type); }
  return {$,sockets,decoders,timers,start,packet,tick,change,flush,storage,setFetch:fn=>{fetchOverride=fn;}};
}

test('encoder changes remain drafts until one explicit Apply; same values never reconnect', async () => {
  const f=await fixture(); f.start(); const original=f.sockets[0];
  await f.change('quality','sharp'); await f.change('scale',50); await f.change('audio','raw');
  assert.deepEqual(original.closes,[], 'draft changes must not close the active stream');
  assert.equal(f.sockets.length,1);
  assert.equal(f.$('apply-settings').disabled,false);
  await f.$('apply-settings').emit('click');
  assert.equal(f.sockets.length,2); assert.equal(original.closes.length,1);
  const params=new URL(f.sockets[1].url).searchParams;
  assert.equal(params.get('quality'),'sharp');assert.equal(params.get('scale'),'0.5');assert.equal(params.get('audio'),'raw');
  await f.$('apply-settings').emit('click'); await f.change('quality','sharp'); await f.$('apply-settings').emit('click');
  assert.equal(f.sockets.length,2);
});
test('local latency, zoom, fit, volume and mute never reconnect or erase encoder draft',async()=>{
  const f=await fixture();f.start();await f.change('quality','sharp');
  for(const [id,value,type] of [['latency','gaming'],['zoom',200],['volume',30,'input']]) await f.change(id,value,type);
  f.$('mute').checked=true;await f.$('mute').emit('change');await f.$('fit').emit('click');
  assert.equal(f.sockets.length,1);assert.deepEqual(f.sockets[0].closes,[]);assert.equal(f.$('quality').value,'sharp');
});
test('90s static/repeated PTS and scheduling bursts with empty decoder queue never reconnect',async()=>{
  const f=await fixture();f.start();const ws=f.sockets[0];
  for(let i=0;i<90;i++){await f.tick(1000);ws.message(f.packet(0,0));}
  assert.deepEqual(ws.closes,[]);assert.equal(f.sockets.length,1);
});
test('reverting encoder drafts and resetting defaults do not restart a stream',async()=>{
  const f=await fixture();f.start();await f.change('quality','sharp');await f.change('quality','balanced');
  assert.equal(f.$('apply-settings').disabled,true);await f.$('apply-settings').emit('click');assert.equal(f.sockets.length,1);
  await f.change('scale',50);await f.$('apply-settings').emit('click');f.start();
  await f.$('reset-settings').emit('click');assert.equal(f.sockets.length,2);assert.equal(f.$('apply-settings').disabled,false);
  await f.$('apply-settings').emit('click');assert.equal(f.sockets.length,3);assert.equal(new URL(f.sockets[2].url).searchParams.get('scale'),'1');
});
test('Apply while disconnected saves and cancels retries; even captured stale timers cannot reconnect',async()=>{
  const f=await fixture();f.start();const ws=f.sockets[0];await ws.end(1006);
  const retry=[...f.timers.values()].find(t=>t.ms===1000);assert.ok(retry);
  await f.change('scale',50);await f.$('apply-settings').emit('click');retry.fn();await f.tick(90000);
  assert.equal(f.sockets.length,1);assert.match(f.$('settings-status').textContent,/next connection/);
  await f.$('reconnect').emit('click');assert.equal(f.sockets.length,2);assert.equal(new URL(f.sockets[1].url).searchParams.get('scale'),'0.5');
});
test('late health response, socket events and decoder output cannot disturb an applied generation',async()=>{
  const f=await fixture();f.start();const old=f.sockets[0], message=old.onmessage, close=old.onclose, error=old.onerror, output=f.decoders[0].callbacks.output;
  let resolve;f.setFetch(path=>path.startsWith('/api/health')?new Promise(r=>{resolve=r;}):undefined);
  const closing=old.end(1006);await f.flush();assert.ok(resolve);
  await f.change('quality','sharp');await f.$('apply-settings').emit('click');
  resolve({ok:true,json:async()=>({})});await closing;
  f.setFetch();await f.$('reconnect').emit('click');f.start();const status=f.$('status').textContent;
  message({data:'invalid'});await close({code:4001});error();let frameClosed=false;output({close(){frameClosed=true;}});
  assert.equal(frameClosed,true);assert.equal(f.$('status').textContent,status);await f.tick(90000);assert.equal(f.sockets.length,2);
});
test('a single decoder backlog keeps the session and requests a fresh keyframe',async()=>{
  const f=await fixture();f.start();await f.tick(31000);
  const ws=f.sockets.at(-1);f.decoders.at(-1).decodeQueueSize=6;
  ws.message(f.packet(0,1));
  assert.deepEqual(ws.closes,[],'a single backlog must not disconnect');
  assert.deepEqual(ws.sent.map(data=>JSON.parse(data).type),['keyframe'],'a fresh keyframe is requested');
});
test('sustained decoder backlog still closes once, with at most three automatic overload recoveries',async()=>{
  const f=await fixture();
  for(let i=0;i<4;i++){
    f.start();await f.tick(31000);const ws=f.sockets.at(-1);const d=f.decoders.at(-1);d.decodeQueueSize=6;
    // After each skip the viewer waits for a keyframe, so sustained backlog is
    // measured over keyframes. Only exceeding the budget gives up and reconnects.
    for(let n=0;n<21;n++) ws.message(f.packet(2,n+1));
    assert.deepEqual(ws.closes,[4003]);await ws.end(4003);await f.tick(10000);
  }
  assert.equal(f.sockets.length,4);assert.match(f.$('status').textContent,/paused/);await f.tick(90000);assert.equal(f.sockets.length,4);
  assert.deepEqual(f.sockets.map(ws=>new URL(ws.url).searchParams.get('quality')),['balanced','economy','economy','economy']);
  assert.equal(JSON.parse(f.storage.get('cloudphone-viewer-v1') || '{}').quality,undefined,'adaptive downshift does not write storage');
  assert.equal(f.$('quality').value,'balanced');
});
test('90s scheduling stalls with an empty queue, backwards PTS, and queue threshold boundary',async()=>{
  const f=await fixture();f.start();const ws=f.sockets[0];await f.tick(90000);
  for(const pts of [900000,1,1,0,100]) ws.message(f.packet(0,pts));
  assert.deepEqual(ws.closes,[]);await f.change('latency','gaming');
  f.decoders[0].decodeQueueSize=4;ws.message(f.packet(0,200));assert.deepEqual(ws.closes,[]);
  // Gaming reaches its threshold at five queued frames and skips rather than closing.
  f.decoders[0].decodeQueueSize=5;ws.message(f.packet(0,300));assert.deepEqual(ws.closes,[]);
  assert.deepEqual(ws.sent.map(data=>JSON.parse(data).type),['keyframe']);
});
test('server overload follows the same bounded policy; access refusal is never retried',async()=>{
  const f=await fixture();
  for(let i=0;i<4;i++){f.start();await f.sockets.at(-1).end(1013);await f.tick(10000);}
  assert.equal(f.sockets.length,4);await f.tick(90000);assert.equal(f.sockets.length,4);
  const g=await fixture();await g.sockets[0].end(1008);await g.tick(90000);assert.equal(g.sockets.length,1);
});
