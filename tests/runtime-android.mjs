import fs from 'node:fs/promises';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { PhoneManager } from '../lib/isolation.mjs';
const run=(cmd,args=[])=>execFileSync(cmd,args,{encoding:'utf8'}).trim();
assert.equal(run('hostname'),'cloudphone-runtime');
assert.equal((await fs.readFile('/proc/1/comm','utf8')).trim(),'systemd');
const m=new PhoneManager({stateDir:'/var/lib/runtime-tests/android',sdkDir:'/opt/runtime-sdk',config:{networkMode:'none'}});
await m.initialize();await m.verifyIdentity(29);
const usage=await m.usage();
assert.ok(usage.memoryAllocatableBytes>=512*1024**2,'Preserve host memory reserve');
assert.ok(usage.diskAllocatableBytes>=8*1024**3,'Preserve host disk reserve');
const r={id:'bbbbbbbbbbbbbbbb',adbPort:15029,consolePort:5614,serial:'emulator-5614',guestRamMiB:1024,hostMemoryMiB:512,diskGiB:8,
webGid:await m.webGroup(),hostNetNamespace:await fs.readlink('/proc/self/ns/net'),startToken:'b'.repeat(32)};
const p=m.paths(r.id);await fs.mkdir(p.mount,{recursive:true});
console.log('DIAGNOSTIC ONLY: actual supervisor/Android, 512MiB cgroup below production minimum; production admission is NOT bypassed or claimed');
let loop;
try{
run('fallocate',['-l',String(8*1024**3),p.image]);run('chmod',['600',p.image]);
run('mkfs.ext4',['-q','-F','-m','0','-E','nodiscard,lazy_itable_init=0,lazy_journal_init=0',p.image]);
loop=run('losetup',['--find','--show',p.image]);r.loop=loop;
run('mount',['-t','ext4','-o','rw,nosuid,nodev,noexec,nodiscard',loop,p.mount]);
await m.prepare(r);r.volumeDevice=String((await fs.stat(p.mount)).dev);
try{run('systemctl',['reset-failed',p.unit]);}catch{}
await m.command('/usr/bin/systemd-run',m.serviceArgs(r));
try{await m.waitReady(r);console.log('SUPERVISOR_READY',await m.unitState(r));await new Promise(resolve=>setTimeout(resolve,15000));}catch(e){console.log('ACTUAL_START_RESULT',e.message);}
console.log(run('systemctl',['show',p.unit,'-p','Result,ActiveState,ExecMainStatus,MemoryPeak,MemorySwapPeak']));
for(const name of ['adb','emulator','worker']){try{console.log(name, (await fs.readFile(p.mount+'/logs/'+name+'.log','utf8')).slice(-20000));}catch{}}
console.log(run('journalctl',['-u',p.unit,'--no-pager','-n','20']));
}finally{
try{run('systemctl',['stop',p.unit]);}catch{}
await m.assertStopped(r);
if(loop){run('umount',[p.mount]);run('losetup',['-d',loop]);}
await fs.unlink(p.image);await fs.rmdir(p.mount);await fs.rmdir(p.dir);
}
