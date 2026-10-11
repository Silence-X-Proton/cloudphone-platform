import fs from 'node:fs/promises';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { PhoneManager } from '../lib/isolation.mjs';
assert.equal((await fs.readFile('/etc/hostname','utf8')).trim(),'cloudphone-runtime');
if (process.argv[2] === '--inside') {
  console.log('UMASK',process.umask().toString(8));
  console.log((await fs.readFile('/proc/self/status','utf8')).split('\n').filter(x=>/^(Cap|NoNewPrivs)/.test(x)).join('\n'));
  const manager=new PhoneManager({stateDir:'/var/lib/runtime-tests/broker-context',sdkDir:'/opt/cloudphone-sdk/api36-v1',config:{networkMode:'public'}});
  console.log(await manager.runtimeSelfCheck());
  console.log(await manager.capabilities());
} else {
  const unit=await fs.readFile(new URL('../deploy/cloudphone-platform-broker.service',import.meta.url),'utf8');
  const keys=new Set(['User','Group','UMask','NoNewPrivileges','RestrictSUIDSGID','LockPersonality','RestrictRealtime','CapabilityBoundingSet','TasksMax','LimitNOFILE']);
  const properties=unit.split('\n').filter(line=>keys.has(line.split('=')[0]));
  console.log(execFileSync('/usr/bin/systemd-run',['--wait','--pipe','--collect','--unit','runtime-broker-context',...properties.flatMap(p=>['--property',p]),'/usr/bin/node',new URL(import.meta.url).pathname,'--inside'],{encoding:'utf8',timeout:120000}));
}
