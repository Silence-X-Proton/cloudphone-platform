/** Manual real Chromium/WebCodecs verification, SYNTHETIC media, never Android.
 * npm run build && node tests/media-browser.mjs
 * Uses existing optional Playwright/Chromium and ffmpeg. No dependency installation.
 */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { once } from 'node:events';
import { mkdir, writeFile, mkdtemp, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { createStreamBroker, createBroker } from '../lib/broker.mjs';
import { BrokerClient } from '../lib/broker-client.mjs';
import { pathToFileURL } from 'node:url';
import { createApplication } from '../server.mjs';
import { encodePacket, createPhoneWorker, pumpAudio } from '../lib/phone-worker.mjs';
const evidence=path.resolve(process.env.EVIDENCE_DIR || '/a0/usr/workdir/cloudphone-platform-evidence/media');
await mkdir(evidence,{recursive:true});
const playwright=await import(pathToFileURL(process.env.PLAYWRIGHT_MODULE || '/a0/usr/workdir/cloudphone/tests/node_modules/playwright-core/index.mjs'));
const raw=execFileSync('ffmpeg',['-hide_banner','-loglevel','error','-f','lavfi','-i','testsrc2=size=240x480:rate=1','-frames:v','1','-c:v','libx264','-profile:v','baseline','-pix_fmt','yuv420p','-f','h264','pipe:1']);
const starts=[];for(let i=0;i<raw.length-3;i++){if(raw[i]===0&&raw[i+1]===0&&(raw[i+2]===1||raw[i+2]===0&&raw[i+3]===1)){const n=raw[i+2]===1?3:4;starts.push([i,n]);i+=n-1;}}
const nals=starts.map(([start,n],i)=>({type:raw[start+n]&31,data:raw.subarray(start,starts[i+1]?.[0]??raw.length)}));
const config=Buffer.concat(nals.filter(n=>[7,8].includes(n.type)).map(n=>n.data)),frame=Buffer.concat(nals.filter(n=>![7,8].includes(n.type)).map(n=>n.data));
const ogg=execFileSync('ffmpeg',['-hide_banner','-loglevel','error','-f','lavfi','-i','sine=frequency=440:sample_rate=48000:duration=0.2','-ac','2','-c:a','libopus','-frame_duration','20','-f','ogg','pipe:1']);
const packets=[];let chunks=[];
for(let offset=0;offset<ogg.length;){assert.equal(ogg.subarray(offset,offset+4).toString(),'OggS');const segments=ogg[offset+26];let cursor=offset+27+segments;for(let i=0;i<segments;i++){const size=ogg[offset+27+i];chunks.push(ogg.subarray(cursor,cursor+size));cursor+=size;if(size<255){packets.push(Buffer.concat(chunks));chunks=[];}}offset=cursor;}
const head=packets.shift();assert.equal(head.subarray(0,8).toString(),'OpusHead');assert.equal(packets.shift().subarray(0,8).toString(),'OpusTags');
const pcm=execFileSync('ffmpeg',['-hide_banner','-loglevel','error','-f','lavfi','-i','sine=frequency=880:sample_rate=48000:duration=0.02','-ac','2','-f','s16le','pipe:1']);
const id='0123456789abcdef', streams=[],controls=[],errors=[],logs=[];let browser,app,worker,proxy,rpc,dir;
const log=text=>{logs.push(text);console.log(text);};
try {
  dir=await mkdtemp(path.join(os.tmpdir(),'cp-media-'));
  const phone={id,name:'Synthetic media fixture · not Android',status:'running',adbPort:15000,consolePort:5556,serial:'emulator-5556'};
  const workerPath=path.join(dir,'worker.sock'),streamPath=path.join(dir,'stream.sock'),rpcPath=path.join(dir,'rpc.sock');
  worker=await createPhoneWorker({phone,socketPath:workerPath,scrcpyServer:'/synthetic-only/server.jar',webGid:process.getgid()||1,
    isolationProbe:async()=>{},deviceStarter:async(state,send)=>{
      // Worker start uses audio; HTTP's requested mode lives in audioMode, metadata in audio.
      streams.push({quality:state.quality,scale:state.scale,audioMode:state.audio});state.ready=true;state.video={width:240,height:480};
      let timer;
      const audioStream=state.audio==='off'?undefined:Promise.resolve({type:'success',codec:{optionValue:state.audio},stream:new ReadableStream({
        start(controller){
          if(state.audio==='opus')controller.enqueue({type:'configuration',data:head});
          let index=0;timer=setInterval(()=>{controller.enqueue({type:'data',pts:BigInt(index*20000),data:state.audio==='raw'?pcm:packets[index%packets.length]});index++;},20);
        },cancel(){clearInterval(timer);}
      })});
      state.client={audioStream,close:async()=>{clearInterval(timer);},controller:{injectTouch:async m=>controls.push(m),injectKeyCode:async()=>{},injectText:async()=>{},setClipboard:async()=>{},injectScroll:async()=>{}}};
      send({type:'metadata',codec:0x68323634,width:240,height:480});
      state.ws.send(encodePacket({type:'configuration',data:config}));state.ws.send(encodePacket({type:'data',keyframe:true,pts:0n,data:frame}));
      state.audioPump=pumpAudio(state,send);
    }});
  await worker.listen();
  const manager={list:async()=>[phone],metrics:async()=>({memoryBytes:null,diskUsedBytes:null}),capabilities:async()=>({supported:true,checks:{networkIsolation:{ok:true},streamingIsolation:{ok:true}}}),streamSocket:async requested=>{assert.equal(requested,id);return workerPath;}};
  proxy=createStreamBroker({manager});await new Promise(resolve=>proxy.listen(streamPath,resolve));
  rpc=createBroker({manager,verifyCredentials:async(u,p)=>u==='test'&&p==='synthetic-only'});await new Promise(resolve=>rpc.listen(rpcPath,resolve));
  const client=new BrokerClient({socketPath:rpcPath,streamSocketPath:streamPath});
  app=await createApplication({secureCookies:false,manager:client,verifyCredentials:(u,p)=>client.verifyCredentials(u,p)});
  app.server.listen(0,'127.0.0.1');await once(app.server,'listening');const origin=`http://127.0.0.1:${app.server.address().port}`;
  browser=await playwright.chromium.launch({executablePath:process.env.CHROMIUM_PATH||'/a0/tmp/playwright/chromium-1228/chrome-linux64/chrome',headless:true,args:['--no-sandbox','--disable-dev-shm-usage','--disable-background-networking']});
  const context=await browser.newContext({viewport:{width:1440,height:1000}});const page=await context.newPage();page.setDefaultTimeout(15000);page.on('pageerror',e=>errors.push(e.message));
  await page.addInitScript(()=>{window.csp=[];document.addEventListener('securitypolicyviolation',e=>window.csp.push(e.violatedDirective));});
  await page.goto(`${origin}/phone?id=${id}`);await page.locator('#login-method').selectOption('admin');await page.locator('#username').fill('test');await page.locator('#password').fill('synthetic-only');await page.locator('#login-button').click();await page.waitForFunction(()=>document.getElementById('status').textContent==='Connected').catch(async error=>{console.error(await page.locator('body').innerText(),{streams,errors});throw error;});
  assert.equal(await page.locator('#audio-status').textContent(),'Audio ready · tap Enable audio');
  await page.locator('#open-settings').click();
  await page.locator('#enable-audio').click();assert.match(await page.locator('#audio-status').textContent(),/Audio enabled|Audio playing/);
  await page.locator('#volume').fill('37');await page.locator('#mute').check();
  const scaleSocket=page.waitForEvent('websocket',ws=>new URL(ws.url()).searchParams.get('scale')==='0.5');await page.locator('#scale').selectOption('50');assert.equal(streams.length,1);await page.locator('#apply-settings').click();await scaleSocket;await page.waitForFunction(()=>document.getElementById('status').textContent==='Connected');assert.equal(streams.at(-1).scale,.5);
  const gamingSocket=page.waitForEvent('websocket',ws=>new URL(ws.url()).searchParams.get('quality')==='gaming');await page.locator('#latency').selectOption('gaming');assert.equal(streams.length,2);await page.locator('#quality').selectOption('gaming');assert.equal(streams.length,2);await page.locator('#apply-settings').click();await gamingSocket;await page.waitForFunction(()=>document.getElementById('status').textContent==='Connected');assert.equal(streams.at(-1).quality,'gaming');
  await page.locator('#zoom').selectOption('200');await page.locator('#close-settings').click();
  const before=controls.length;const rect=await page.locator('#screen').boundingBox();const stage=await page.locator('#screen-stage').boundingBox();
  const x=Math.max(rect.x,stage.x)+Math.min(stage.width,rect.width)/2,y=Math.max(rect.y,stage.y)+Math.min(stage.height,rect.height)/2;
  await page.mouse.click(x,y);await page.waitForTimeout(50);assert(controls.length>before);
  const touch=controls[before];assert.equal(touch.videoWidth,240);assert.equal(touch.videoHeight,480);assert(Math.abs(touch.pointerX-Math.floor((x-rect.x)*240/rect.width))<=1);assert(Math.abs(touch.pointerY-Math.floor((y-rect.y)*480/rect.height))<=1);
  await page.reload();await page.waitForFunction(()=>document.getElementById('status').textContent==='Connected');await page.locator('#open-settings').click();assert.equal(await page.locator('#volume').inputValue(),'37');assert(await page.locator('#mute').isChecked());assert.equal(await page.locator('#zoom').inputValue(),'200');
  const saved=await page.evaluate(()=>localStorage.getItem('cloudphone-viewer-v1'));assert(!saved.includes('synthetic-only'));assert(!saved.includes(id));
  await page.locator('#fit').click();assert.equal(await page.locator('#zoom').inputValue(),'100');
  await page.keyboard.press('Escape');assert.equal(await page.evaluate(()=>document.activeElement.id),'open-settings');
  await page.locator('#fullscreen').click();await page.waitForFunction(()=>!!document.fullscreenElement);
  await page.locator('#fullscreen').click();await page.waitForFunction(()=>!document.fullscreenElement);
  for(const [name,width,height]of[['desktop',1440,1000],['mobile',390,844],['small',320,568],['landscape',844,390]]){
    await page.setViewportSize({width,height});await page.waitForTimeout(100);
    const layout=await page.evaluate(()=>({w:innerWidth,h:innerHeight,sw:document.documentElement.scrollWidth,sh:document.documentElement.scrollHeight,screen:document.getElementById('screen-stage').clientHeight,csp:window.csp}));assert.equal(layout.sw,width);assert.equal(layout.sh,height);assert(layout.screen>10);assert.deepEqual(layout.csp,[]);
    const stageBefore=await page.locator('#screen-stage').boundingBox();await page.locator('#open-settings').click();
    assert.equal(await page.evaluate(()=>document.activeElement.id),'close-settings');
    assert.deepEqual(await page.locator('#screen-stage').boundingBox(),stageBefore);
    await page.keyboard.press('Shift+Tab');assert(await page.evaluate(()=>document.getElementById('session-settings').contains(document.activeElement)));
    await page.keyboard.press('Tab');assert(await page.evaluate(()=>document.getElementById('session-settings').contains(document.activeElement)));
    await page.locator('#reset-settings').scrollIntoViewIfNeeded();assert(await page.locator('#reset-settings').isVisible());
    await page.locator('#close-settings').scrollIntoViewIfNeeded();
    await page.screenshot({path:path.join(evidence,`settings-${name}.png`)});
    await page.keyboard.press('Escape');assert.equal(await page.evaluate(()=>document.activeElement.id),'open-settings');
  }
  await page.locator('#open-settings').click();await page.locator('#reset-settings').click();await page.waitForFunction(()=>document.getElementById('status').textContent==='Connected');assert.equal(await page.locator('#volume').inputValue(),'80');assert.equal(await page.locator('#scale').inputValue(),'100');assert.equal(await page.locator('#latency').inputValue(),'balanced');
  log('PASS real broker-chain app + synthetic H264/modal dialog: gestures, fractional scale/gaming forwarding, encoded-coordinate zoom touch, persistent whitelist/reset, 1440/390/320/landscape layout and CSP.');
  // Observe the production player's decoded buffers, never inject browser samples.
  // Bytes traverse real worker -> Unix broker -> BrokerClient -> HTTP WS -> browser.
  await page.evaluate(async()=>{
    const {PhoneAudio}=await import('/client.js');window.sampleEnergy=[];
    const schedule=PhoneAudio.prototype.schedule;
    PhoneAudio.prototype.schedule=function(buffer,pts){window.sampleEnergy.push({codec:this.metadata.codec,energy:[...buffer.getChannelData(0)].reduce((sum,x)=>sum+x*x,0)});return schedule.call(this,buffer,pts);};
  });
  await page.locator('#enable-audio').click();
  await page.waitForFunction(()=>window.sampleEnergy.filter(x=>x.codec==='opus'&&x.energy>.1).length>=3);
  const opusFrames=await page.evaluate(()=>window.sampleEnergy.length);
  await page.locator('#mute').check();await page.waitForTimeout(100);const mutedCount=await page.evaluate(()=>window.sampleEnergy.length);await page.waitForTimeout(100);assert.equal(await page.evaluate(()=>window.sampleEnergy.length),mutedCount);
  await page.locator('#mute').uncheck();
  const pcmSocket=page.waitForEvent('websocket',ws=>new URL(ws.url()).searchParams.get('audio')==='raw');await page.locator('#audio').selectOption('raw');await page.locator('#apply-settings').click();await pcmSocket;
  await page.waitForFunction(()=>document.getElementById('status').textContent==='Connected');
  assert.equal(streams.at(-1).audioMode,'raw');
  await page.waitForFunction(()=>window.sampleEnergy.filter(x=>x.codec==='pcm'&&x.energy>.1).length>=3); // No second gesture: context survives Apply.
  const energy=await page.evaluate(()=>window.sampleEnergy);
  const healthAudio=await page.evaluate(async id=>(await (await fetch('/api/health?id='+id)).json()).audio,id);
  assert.deepEqual(healthAudio,{type:'audio',supported:true,codec:'pcm',sampleRate:48000,channels:2});
  const offSocket=page.waitForEvent('websocket',ws=>new URL(ws.url()).searchParams.get('audio')==='off');await page.locator('#audio').selectOption('off');await page.locator('#apply-settings').click();await offSocket;
  await page.waitForFunction(()=>document.getElementById('status').textContent==='Connected'&&document.getElementById('audio-status').textContent==='Audio disabled');assert.equal(streams.at(-1).audioMode,'off');
  const stoppedCount=await page.evaluate(()=>window.sampleEnergy.length);await page.waitForTimeout(100);assert.equal(await page.evaluate(()=>window.sampleEnergy.length),stoppedCount);
  const result={healthAudio,opusFrames,pcmFrames:energy.filter(x=>x.codec==='pcm').length,energy,muted:true,reconnectPreservesGesture:true,off:true};
  log('PASS production PhoneAudio decoded nonzero Opus/PCM through real createPhoneWorker + pumpAudio -> createStreamBroker -> BrokerClient -> HTTP WebSocket -> Chromium. Synthetic ffmpeg samples, injected isolation/Android source only. Mute, preserved gesture after reconnect, audio off verified.');
  assert.deepEqual(errors,[]);await writeFile(path.join(evidence,'results.json'),JSON.stringify({streams,controls,result,errors,logs},(_key,value)=>typeof value==='bigint'?String(value):value,2));
} finally {await browser?.close();await app?.close();await proxy?.closeBroker();await rpc?.closeBroker();await worker?.close();if(dir)await rm(dir,{recursive:true,force:true});}
