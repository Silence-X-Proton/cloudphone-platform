import fs from 'node:fs/promises';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import http from 'node:http';
import { PhoneManager } from '../lib/isolation.mjs';
const run=(cmd,args=[])=>execFileSync(cmd,args,{encoding:'utf8'}).trim();
assert.equal(run('hostname'),'cloudphone-runtime');
assert.equal((await fs.readFile('/proc/1/comm','utf8')).trim(),'systemd');
const root='/var/lib/runtime-tests/worker',sdk='/opt/runtime-tests/sdk';
const id='eeeeeeeeeeeeeeee',unit=`cloudphone-${id}.service`;
await fs.mkdir(root,{recursive:true,mode:0o700});await fs.mkdir(sdk,{recursive:true});
await fs.mkdir('/srv/cloudphone',{recursive:true});
try{run('groupadd',['--system','cloudphone-web']);}catch{}
const gid=Number(run('getent',['group','cloudphone-web']).split(':')[2]);
const m=new PhoneManager({stateDir:root,sdkDir:sdk,config:{networkMode:'none'}});
const p=m.paths(id);await fs.mkdir(p.mount,{recursive:true});
const image=p.image;run('fallocate',['-l','128M',image]);run('mkfs.ext4',['-q','-F','-m','0','-E','nodiscard,lazy_itable_init=0,lazy_journal_init=0',image]);
let loop;
try{
loop=run('losetup',['--find','--show',image]);run('mount',['-o','rw,nosuid,nodev,noexec,nodiscard',loop,p.mount]);
for(const name of ['home','tmp','vartmp','shm','logs','avd','run']){const dir=p.mount+'/'+name;await fs.mkdir(dir);await fs.chown(dir,200030,name==='run'?gid:200030);await fs.chmod(dir,name==='run'?0o750:0o700);}
await fs.chmod(p.mount,0o755);
const r={id,adbPort:15030,consolePort:5616,serial:'emulator-5616',hostMemoryMiB:128,guestRamMiB:1024,webGid:gid,hostNetNamespace:await fs.readlink('/proc/self/ns/net'),volumeDevice:String((await fs.stat(p.mount)).dev),startToken:'a'.repeat(32)};
const cfg={phone:{id,adbPort:15030,consolePort:5616,serial:'emulator-5616'},scrcpyServer:sdk+'/scrcpy.jar',socketPath:'/srv/cloudphone/run/stream.sock',webGid:gid,hostNetNamespace:r.hostNetNamespace,networkMode:'private'};
let args=m.serviceArgs(r);args=args.slice(0,args.indexOf('/usr/bin/node'));
await m.verifyIdentity(30);
assert.ok(args.includes('OOMPolicy=kill'));
assert.ok(!args.some(x=>x.startsWith('MemoryOOMGroup=')));
args.push('--setenv','CLOUDPHONE_WORKER_CONFIG='+JSON.stringify(cfg),'/usr/bin/node','/opt/runtime-tests/source/lib/phone-worker.mjs');
console.log('Exact production serviceArgs properties; worker executable selected for prerequisite test');
try{run('systemctl',['reset-failed',unit]);}catch{}
run('systemd-run',args);
let pid;for(let n=0;n<80;n++){pid=run('systemctl',['show',unit,'-p','MainPID','--value']);try{await fs.lstat(p.mount+'/run/stream.sock');break;}catch{}await new Promise(r=>setTimeout(r,100));}
const st=await fs.lstat(p.mount+'/run/stream.sock');assert(st.isSocket());assert.equal(st.uid,200030);assert.equal(st.gid,gid);assert.equal(st.mode&0o777,0o660);
const group='/system.slice/'+unit;assert.equal((await fs.readFile('/proc/'+pid+'/cgroup','utf8')).trim(),'0::'+group);assert.notEqual(await fs.readlink('/proc/'+pid+'/ns/net'),r.hostNetNamespace);
assert.equal((await fs.readFile('/sys/fs/cgroup'+group+'/memory.max','utf8')).trim(),'134217728');assert.equal((await fs.readFile('/sys/fs/cgroup'+group+'/memory.swap.max','utf8')).trim(),'0');
{assert.equal(String((await fs.stat('/proc/'+pid+'/root/run')).dev),r.volumeDevice);await assert.rejects(fs.stat('/proc/'+pid+'/root/run/systemd/private'),{code:'ENOENT'});}assert.equal(await m.mounted({...r,loop}),true);await assert.rejects(m.mounted({...r,loop:'/dev/loop999'}),/mismatch/);
console.log(JSON.stringify({pid,uid:st.uid,gid:st.gid,mode:(st.mode&0o777).toString(8),cgroup:group,net:await fs.readlink('/proc/'+pid+'/ns/net'),mount:await fs.readlink('/proc/'+pid+'/ns/mnt')}));
const status=await new Promise((resolve,reject)=>http.get({socketPath:p.mount+'/run/stream.sock',path:'/adb'},res=>{res.resume();resolve(res.statusCode);}).on('error',reject));assert.equal(status,404);
console.log('PASS actual worker isolation probe under exact production namespace properties, socket permissions, raw HTTP denial');
run('systemctl',['stop',unit]);await assert.rejects(fs.stat('/proc/'+pid),{code:'ENOENT'});await assert.rejects(fs.lstat(p.mount+'/run/stream.sock'),{code:'ENOENT'});
console.log('PASS stop kills worker and removes owned socket before detach');
}catch(e){console.log(run('journalctl',['-u',unit,'--no-pager','-n','30']));throw e;}
finally{try{run('systemctl',['stop',unit]);}catch{}if(loop){run('umount',[p.mount]);run('losetup',['-d',loop]);}}
