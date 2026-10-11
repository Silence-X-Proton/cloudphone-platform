import fs from 'node:fs/promises';
import assert from 'node:assert/strict';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {PhoneManager} from '../lib/isolation.mjs';
const exec=promisify(execFile);
assert.equal((await fs.readFile('/etc/hostname','utf8')).trim(),'cloudphone-runtime');
const m=new PhoneManager({stateDir:'/var/lib/runtime-tests/genuine',sdkDir:'/opt/cloudphone-sdk/api36-v1',config:{networkMode:'public'}});
const output='/var/lib/runtime-tests/active-phone.json';
await m.initialize();
let phone;
try {
 await m.runtimeSelfCheck();
 console.log('USAGE',await m.usage());
 const records=await m.records();assert.equal(records.length,0,'Inspect existing phone before repeating');
 phone=await m.create({name:'Actual API36',guestRamMiB:2560,hostMemoryMiB:3584,diskGiB:8});
 const details={id:phone.id,unit:m.paths(phone.id).unit,sdk:m.sdkDir,stateDir:m.stateDir,paths:m.paths(phone.id),source:'/opt/runtime-current',bootCompleted:false};
 await fs.writeFile(output,JSON.stringify(details,null,2),{mode:0o600});
 console.log('CREATED',phone);
 console.log('STARTED',await m.start(phone.id));
 const r=await m.read(phone.id);const state=await m.unitState(r);
 Object.assign(details,{mainPid:state.MainPID,adbPort:r.adbPort,serial:r.serial,streamSocket:m.paths(r.id).mount+'/run/stream.sock',adbCommand:['nsenter','-t',state.MainPID,'-n',m.sdkDir+'/platform-tools/adb','-P',String(r.adbPort),'-s',r.serial],note:'Run only inside disposable Ubuntu through SSH; no raw ADB forward. Phone retained for media verification.'});
 await fs.writeFile(output,JSON.stringify(details,null,2),{mode:0o600});
 for(let attempt=0;attempt<90;attempt++) {
  await m.verifyLimits(r);
  try {
   const {stdout}=await exec('/usr/bin/nsenter',details.adbCommand.slice(1).concat(['shell','getprop','sys.boot_completed']),{timeout:4000,maxBuffer:65536});
   console.log('BOOT_POLL',attempt,stdout.trim());
   if(stdout.trim()==='1') {
    details.bootCompleted=true;
    details.android=(await exec('/usr/bin/nsenter',details.adbCommand.slice(1).concat(['shell','getprop','ro.build.version.release']),{timeout:4000})).stdout.trim();
    details.api=(await exec('/usr/bin/nsenter',details.adbCommand.slice(1).concat(['shell','getprop','ro.build.version.sdk']),{timeout:4000})).stdout.trim();
    await fs.writeFile(output,JSON.stringify(details,null,2),{mode:0o600});
    console.log('BOOT_COMPLETED',details.android,details.api);break;
   }
  }catch(e){console.log('BOOT_PENDING',attempt,e.message.slice(0,160));}
  await new Promise(resolve=>setTimeout(resolve,2000));
 }
 if(!details.bootCompleted)throw new Error('Boot did not complete within bounded verification window');
 console.log('RETAINED',details.id);
}catch(error){console.error('GENUINE_FAILURE',error.stack);if(phone){console.log('RETAINED_FOR_INSPECTION',phone.id);try{console.log(await m.unitState(await m.read(phone.id)));}catch{}}process.exitCode=1;}
