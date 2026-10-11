import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
const script = fileURLToPath(new URL('../scripts/phone-network.py', import.meta.url));
const prefix = `import importlib.util; s=importlib.util.spec_from_file_location('network',${JSON.stringify(script)}); m=importlib.util.module_from_spec(s); s.loader.exec_module(m); `;
const python = code => execFileSync('/usr/bin/python3', ['-B', '-c', prefix + code], { encoding: 'utf8', timeout: 5000 });
// Pure generation only: never runs nft, systemd, mount or cgroup mutation.
test('launcher firewall is exclusive and matches only the exact phone cgroup', () => {
  const p = python("print(m.policy('a'*16))");
  assert.match(p, /create table inet cpnet_aaaaaaaaaaaaaaaa/);
  assert.match(p, /comment "cloudphone-network-v1:aaaaaaaaaaaaaaaa"/);
  assert.match(p, /socket cgroupv2 level 2 "system.slice\/cloudphone-aaaaaaaaaaaaaaaa.service" jump public_only/);
  assert.match(p, /fib daddr type local counter drop/);
  assert.match(p, /meta nfproto != ipv4 counter drop/);
  assert.ok(p.indexOf('169.254.0.0/16') < p.indexOf('tcp dport { 80, 443 }'));
  assert.match(p, /udp dport 53 ip daddr \{ 1.1.1.1, 9.9.9.9 \}/);
  assert.doesNotMatch(p, /flush ruleset|hook forward|masquerade/);
});
test('firewall identifier rejects command injection before any side effect', () => {
  const code = `\nfor identifier in ['', '../x', 'a'*17, 'A'*16, 'a'*16+';flush ruleset']:\n try: m.policy(identifier); raise AssertionError('accepted')\n except ValueError: pass\nprint('ok')`;
  assert.equal(python(code).trim(), 'ok');
});

// All cgroup and nft operations below are mocks; no host/guest mutations.
const cleanupHarness = `
import json,sys
identifier='a'*16
calls=[]
class FakePath:
 def __init__(self, value): self.value=value
 def __truediv__(self, name): return FakePath(self.value+'/'+name)
 def exists(self): return present
 def stat(self):
  if state_error: raise state_error
  if not present: raise FileNotFoundError()
  return object()
 def read_text(self):
  if state_error: raise state_error
  return events
m.Path=FakePath
m.os.geteuid=lambda:0
sys.argv=['phone-network.py','stop',identifier]
present=False
events='populated 0\\n'
state_error=None
listing={'nftables':[]}
detail={'nftables':[{'table':{'family':'inet','name':'cpnet_'+identifier,'comment':'cloudphone-network-v1:'+identifier}}]}
listing_error=None
def fake_run(args, **kwargs):
 calls.append(args)
 if args == ['/usr/sbin/nft','-j','list','tables']:
  if listing_error: raise listing_error
  return listing if isinstance(listing,str) else json.dumps(listing)
 if args == ['/usr/sbin/nft','-j','list','table','inet','cpnet_'+identifier]:
  if not any('table' in entry and entry['table'].get('family')=='inet' and entry['table'].get('name')=='cpnet_'+identifier for entry in listing['nftables']): raise RuntimeError('table absent')
  return json.dumps(detail)
 if args == ['/usr/sbin/nft','delete','table','inet','cpnet_'+identifier]: return ''
 raise AssertionError(args)
m.run=fake_run
`;
test('cleanup accepts positively absent table only after cgroup absence/unpopulated proof', () => {
  assert.equal(python(cleanupHarness + `
for present in [False,True]:
 calls.clear(); m.main()
 assert calls == [['/usr/sbin/nft','-j','list','tables']]
print('ok')`).trim(), 'ok');
});
test('cleanup refuses populated or unreadable cgroup before querying nft', () => {
  assert.equal(python(cleanupHarness + `
present=True
for events,state_error in [('populated 1\\n',None),('',None),('populated 0\\npopulated 1\\n',None),('populated 0\\n',PermissionError('denied'))]:
 calls.clear()
 try: m.main(); raise AssertionError('accepted')
 except (RuntimeError,PermissionError): pass
 assert calls == []
print('ok')`).trim(), 'ok');
});
test('cleanup does not interpret nft errors or malformed inventory as table absence', () => {
  assert.equal(python(cleanupHarness + `
for listing in ['not-json',{}, {'nftables':None}, {'nftables':[{}]}, {'nftables':[{'error':{'message':'denied'}}]}, {'nftables':[{'table':{'name':'x'}}]}]:
 calls.clear()
 try: m.main(); raise AssertionError('accepted')
 except (RuntimeError,ValueError): pass
 assert len(calls)==1
listing={'nftables':[]}
for listing_error in [PermissionError('denied'),RuntimeError('nft failed'),TimeoutError('timeout')]:
 calls.clear()
 try: m.main(); raise AssertionError('accepted')
 except (PermissionError,RuntimeError,TimeoutError): pass
 assert len(calls)==1
print('ok')`).trim(), 'ok');
});
test('cleanup deletes only exact owned table and propagates inspection/delete failures', () => {
  assert.equal(python(cleanupHarness + `
present=True
listing={'nftables':[{'metainfo':{}},{'table':{'family':'inet','name':'cpnet_'+identifier}}]}
m.main()
assert calls[-1]==['/usr/sbin/nft','delete','table','inet','cpnet_'+identifier]
for change in [{'comment':'foreign'},{'name':'foreign'},{'family':'ip'}]:
 original=detail['nftables'][0]['table'].copy()
 detail['nftables'][0]['table'].update(change); calls.clear()
 try: m.main(); raise AssertionError('accepted foreign')
 except RuntimeError: pass
 assert not any('delete' in args for args in calls)
 detail['nftables'][0]['table']=original
for failing_operation in ['inspect','delete']:
 def broken(args,**kwargs):
  if (failing_operation=='inspect' and args[1:4]==['-j','list','table']) or (failing_operation=='delete' and args[1]=='delete'): raise PermissionError('denied')
  return fake_run(args,**kwargs)
 m.run=broken
 try: m.main(); raise AssertionError('suppressed error')
 except PermissionError: pass
print('ok')`).trim(), 'ok');
});
test('cleanup distinguishes family and rejects duplicate matching table inventory', () => {
  assert.equal(python(cleanupHarness + `
listing={'nftables':[{'table':{'family':'ip','name':'cpnet_'+identifier}}]}
m.main(); assert len(calls)==1
listing={'nftables':[{'table':{'family':'inet','name':'cpnet_'+identifier}}]*2}
calls.clear()
try: m.main(); raise AssertionError('accepted duplicate')
except RuntimeError: pass
assert len(calls)==1
print('ok')`).trim(), 'ok');
});
