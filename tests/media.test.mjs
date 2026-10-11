import test from 'node:test';
import assert from 'node:assert/strict';
import { PhoneAudio, opusDescription } from '../client.js';
const head = Buffer.from('4f707573486561640102380180bb0000000000','hex');
test('OpusHead accepts Android CSD wrapper and refuses truncated/multichannel config', () => {
  const wrapper = Buffer.alloc(16); wrapper.write('AOPUSHDR'); wrapper.writeBigUInt64LE(19n,8);
  assert.deepEqual(opusDescription(Buffer.concat([wrapper,head])),head);
  assert.deepEqual(opusDescription(head),head);
  for (const data of [head.subarray(0,18),Buffer.alloc(19),Buffer.concat([wrapper,head.subarray(0,18)])]) assert.throws(()=>opusDescription(data));
});
function fixture() {
  const buffers=[], sources=[], reports=[];
  class Context {
    state='suspended'; currentTime=0; destination={};
    resume() {this.state='running';return Promise.resolve();}
    close() {this.state='closed';return Promise.resolve();}
    createGain() {return {gain:{value:1},connect(){}};}
    createBuffer(channels,frames,rate) {const data=Array.from({length:channels},()=>new Float32Array(frames));const b={duration:frames/rate,getChannelData:i=>data[i]};buffers.push(b);return b;}
    createBufferSource(){const s={connect(){},disconnect(){},stop(){this.stopped=true;},start(t){this.when=t;}};sources.push(s);return s;}
  }
  return {audio:new PhoneAudio(text=>reports.push(text),{AudioContext:Context}),buffers,sources,reports};
}
test('PCM signed little-endian stereo conversion; gesture gate, gain, mute, bounded PTS and teardown',async()=>{
  const {audio,buffers,sources}=fixture();audio.metadataMessage({supported:true,codec:'pcm',sampleRate:48000,channels:2});
  const pcm=Buffer.from('0080ff7f00000040','hex');
  audio.packet(3,0,pcm);assert.equal(buffers.length,0);
  await audio.enable();audio.packet(3,0,pcm);
  assert.deepEqual([...buffers[0].getChannelData(0)],[-1,0]);
  assert.deepEqual([...buffers[0].getChannelData(1)],[32767/32768,.5]);
  audio.setVolume(.4,false);assert.equal(audio.gain.gain.value,.4);
  audio.packet(3,10_000_000,pcm);assert(sources[0].stopped);assert(audio.end<=.2);
  for(let i=0;i<100;i++)audio.packet(3,i*1000,pcm);
  assert(audio.sources.size<=16);assert(audio.end<=.2);
  audio.setVolume(.4,true);assert.equal(audio.sources.size,0);assert.equal(audio.gain.gain.value,0);
  audio.packet(3,100_000,pcm);assert.equal(audio.sources.size,0);
  const ctx=audio.context;audio.dispose();assert.equal(ctx.state,'closed');assert.equal(audio.metadata,undefined);
});
test('unsupported audio and malformed PCM are reported independently',async()=>{
  const {audio,reports}=fixture();audio.metadataMessage({supported:true,codec:'opus',sampleRate:48000,channels:2});assert.match(reports.at(-1),/Opus unsupported/);
  audio.metadataMessage({supported:true,codec:'pcm',sampleRate:48000,channels:2});await audio.enable();audio.packet(3,1,Buffer.alloc(3));assert.match(reports.at(-1),/unsupported/);assert.equal(audio.sources.size,0);
});
test('late enable resume after disconnect cannot resurrect playback context',async()=>{
  let resolve;const {audio,reports}=fixture();const enabling=audio.enable();await enabling;
  audio.context.resume=()=>new Promise(r=>{resolve=r;});const old=audio.context;const late=audio.enable();audio.dispose();resolve();await late;
  assert.equal(audio.context,undefined);assert.equal(old.state,'closed');assert.equal(reports.at(-1),'Tap Enable audio after connecting');
});
test('duplicate/backwards timestamps and late bursts rebase instead of unbounded replay',async()=>{
  const {audio,sources}=fixture();audio.metadataMessage({supported:true,codec:'pcm',sampleRate:48000,channels:2});await audio.enable();const bytes=Buffer.alloc(3840);
  audio.packet(3,100_000,bytes);audio.packet(3,100_000,bytes);assert(sources[0].stopped);
  audio.context.currentTime=20;audio.packet(3,120_000,bytes);assert(sources[1].stopped);assert(audio.end<20.2);
  audio.packet(3,119_000,bytes);assert(sources[2].stopped);assert.equal(audio.sources.size,1);
});
test('maximum PCM duration plus lead never exceeds gaming schedule budget',async()=>{
  const {audio}=fixture();audio.limit=.12;audio.metadataMessage({supported:true,codec:'pcm',sampleRate:48000,channels:2});await audio.enable();
  audio.packet(3,0,Buffer.alloc(23040));assert.equal(audio.end,.12);
  audio.packet(3,1_000_000,Buffer.alloc(23040));assert.equal(audio.end,.12);
});
test('stream reset preserves gesture-enabled AudioContext but drops old samples and metadata',async()=>{
  const {audio,sources}=fixture();await audio.enable();const ctx=audio.context;
  audio.metadataMessage({supported:true,codec:'pcm',sampleRate:48000,channels:2});audio.packet(3,0,Buffer.alloc(3840));
  const epoch=audio.epoch;audio.dispose(true);
  assert.equal(audio.context,ctx);assert.equal(ctx.state,'running');assert.equal(audio.epoch,epoch+1);
  assert.equal(audio.metadata,undefined);assert.equal(audio.sources.size,0);assert(sources[0].stopped);
  audio.metadataMessage({supported:true,codec:'pcm',sampleRate:48000,channels:2});audio.packet(3,0,Buffer.alloc(3840));assert.equal(audio.sources.size,1);
  audio.dispose();assert.equal(ctx.state,'closed');assert.equal(audio.context,undefined);
});
