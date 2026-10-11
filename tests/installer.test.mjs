import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { scryptSync } from 'node:crypto';
import { makeConfig, webConfig, validateLock } from '../scripts/config.mjs';
import { initializeCredentials } from '../scripts/credentials.mjs';
import { provision, chooseStandaloneSize } from '../scripts/provision.mjs';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const scripts = path.join(root, 'scripts');
async function temporary(fn) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'cloudphone-installer-test-'));
  try { return await fn(dir); } finally { await fs.rm(dir, { recursive: true, force: true }); }
}
function python(code, args = []) {
  return spawnSync('python3', ['-c', `import sys; sys.path.insert(0, ${JSON.stringify(scripts)});\n${code}`, ...args], {
    encoding: 'utf8', env: { ...process.env, PYTHONDONTWRITEBYTECODE: '1' }, timeout: 10000 });
}
function ok(result) { assert.equal(result.status, 0, result.stderr || result.stdout); }

test('mode/port defaults protect independent live deployment', () => {
  const config = makeConfig('standalone');
  assert.equal(config.port, 8790); assert.equal(config.host, '127.0.0.1');
  assert.equal(config.standalone.sizing, 'available-resources-v1');
  assert.equal(config.reserve.hostMemoryMiB, 2048); assert.equal(config.reserve.diskGiB, 10);
  assert.equal(makeConfig('dashboard', 9000).port, 9000);
  for (const port of [8787, 80, 65536, '8790\nX=y', '8e3', '8790;id']) assert.throws(() => makeConfig('dashboard', port));
  assert.throws(() => makeConfig('invalid'));
});

test('npm direct versions and registry lock integrity must be pinned', () => {
  const pkg = { dependencies: { example: '1.2.3' } };
  const lock = { lockfileVersion: 3, packages: { '': pkg, 'node_modules/example': {
    version: '1.2.3', resolved: 'https://registry.npmjs.org/example/-/example-1.2.3.tgz', integrity: 'sha512-YWJjZA==' } } };
  validateLock(pkg, lock);
  for (const version of ['^1.2.3', '~1.2.3', '*', 'latest', 'git+https://x']) assert.throws(() => validateLock({ dependencies: { example: version } }, lock));
  for (const change of [{ integrity: '' }, { resolved: 'http://evil/example.tgz' }, { resolved: 'file:../x' }, { link: true }]) {
    const copy = structuredClone(lock); Object.assign(copy.packages['node_modules/example'], change);
    assert.throws(() => validateLock(pkg, copy));
  }
});

test('credentials are private, scrypt password, preserve existing and never rotate', async () => temporary(async dir => {
  assert.deepEqual(await initializeCredentials(dir), { created: true });
  const before = await fs.readFile(path.join(dir, 'credentials.json'), 'utf8');
  const token = (await fs.readFile(path.join(dir, 'initial-admin-password'), 'utf8')).trim();
  assert.equal(token.length, 43);
  const credential = JSON.parse(before);
  assert.equal(credential.username, 'admin');
  assert.equal(credential.passwordHash, scryptSync(token, Buffer.from(credential.salt, 'hex'), 64, { N: 16384, r: 8, p: 1 }).toString('hex'));
  assert.ok(!before.includes(token));
  for (const file of ['credentials.json', 'initial-admin-password']) assert.equal((await fs.stat(path.join(dir, file))).mode & 0o777, 0o600);
  await fs.unlink(path.join(dir, 'initial-admin-password'));
  assert.deepEqual(await initializeCredentials(dir), { created: false });
  assert.equal(await fs.readFile(path.join(dir, 'credentials.json'), 'utf8'), before);
  await assert.rejects(fs.stat(path.join(dir, 'initial-admin-password')), { code: 'ENOENT' });
}));

test('credential initialization rejects symlinks, invalid existing state and partial tokens', async () => temporary(async dir => {
  const credential = path.join(dir, 'credentials.json');
  await fs.symlink('/etc/passwd', credential);
  await assert.rejects(initializeCredentials(dir), /private regular/);
  await fs.unlink(credential);
  await fs.writeFile(credential, '{}', { mode: 0o600 });
  await assert.rejects(initializeCredentials(dir), /incompatible/);
  await fs.unlink(credential);
  await fs.writeFile(path.join(dir, 'initial-admin-password'), 'old-token', { mode: 0o600 });
  await assert.rejects(initializeCredentials(dir), { code: 'EEXIST' });
  assert.equal(await fs.readFile(path.join(dir, 'initial-admin-password'), 'utf8'), 'old-token');
}));

test('standalone creates one phone with guest/host budgets; restart reuses id', async () => {
  const calls = []; const phones = [];
  const manager = { capabilities: async () => ({ supported: true, checks: { networkIsolation: { ok: true }, streamingIsolation: { ok: true } } }), list: async () => phones,
    usage: async () => ({ memoryAllocatableBytes: 16 * 1024 ** 3, diskAllocatableBytes: 100 * 1024 ** 3 }),
    create: async input => { calls.push(['create', input]); const p = { id: 'abc' }; phones.push(p); return p; },
    start: async id => calls.push(['start', id]) };
  const config = makeConfig('standalone');
  assert.equal((await provision(manager, config)).id, 'abc');
  await provision(manager, config);
  assert.equal(calls.filter(c => c[0] === 'create').length, 1);
  assert.deepEqual(calls[0][1], { name: 'My phone', guestRamMiB: 9728, hostMemoryMiB: 13056, diskGiB: 80 });
  assert.deepEqual(calls.slice(1), [['start', 'abc'], ['start', 'abc']]);
  phones.push({ id: 'extra' }); await assert.rejects(provision(manager, config), /at most one/);
  manager.capabilities = async () => ({ supported: false }); await assert.rejects(provision(manager, config), /blocked/);
  assert.deepEqual(await provision({}, makeConfig('dashboard')), { skipped: true });
});

test('official XML pins parse and DTD/entities, changed hashes, ambiguous archives fail closed', () => {
  ok(python(`from artifacts import parse_metadata, PINS
filename, digest = PINS['system-images;android-36;google_apis;x86_64']
package = '<remotePackage path="system-images;android-36;google_apis;x86_64"><archives><archive><complete><size>42</size><checksum type="sha1">' + digest + '</checksum><url>' + filename + '</url></complete></archive></archives></remotePackage>'
xml = ('<sdk>' + package + '</sdk>').encode()
r = parse_metadata(xml, 'image')
assert r[0]['url'] == 'https://dl.google.com/android/repository/sys-img/google_apis/x86_64-36_r07.zip'
assert r[0]['size'] == 42
bad = [b'<!DOCTYPE sdk [<!ENTITY x SYSTEM "file:///etc/passwd">]><sdk/>', xml.replace(digest.encode(), b'0'*40), ('<sdk>'+package+package+'</sdk>').encode(), xml.replace(filename.encode(), b'../../x.zip'), b'<sdk/>']
for data in bad:
    try: parse_metadata(data, 'image')
    except ValueError: pass
    else: raise AssertionError('unsafe metadata accepted')`));
});

test('release checksum required and corrupt artifact rejected before extraction', async () => temporary(async dir => {
  ok(python(`from artifacts import verify, cloudflare_checksum
import json
from pathlib import Path
p = Path(sys.argv[1]) / 'artifact'; p.write_bytes(b'abc')
verify(p, 'sha256', 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad', '3')
for args in [('sha256', '0'*64), ('sha256', 'x'*64), ('md5', '0'*32), ('sha256', 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad', '4')]:
    try: verify(p, *args)
    except ValueError: pass
    else: raise AssertionError('bad checksum accepted')
pin='d33ff2d14475178d2012c2c56beba87389ac5ded27649519f198a7d3134a99db'
r={'tag_name':'2026.10.0','body':'cloudflared-linux-amd64: '+pin}
assert cloudflare_checksum(json.dumps(r)) == pin
for body in ['', 'cloudflared-linux-amd64: '+'0'*64, r['body']+'\\n'+r['body']]:
    try: cloudflare_checksum(json.dumps({**r,'body':body}))
    except ValueError: pass
    else: raise AssertionError('bad release accepted')`, [dir]));
}));

test('ZIP extractor rejects traversal, symlinks and duplicate names before writes', async () => temporary(async dir => {
  ok(python(`from artifacts import extract
from pathlib import Path
import zipfile, stat
root = Path(sys.argv[1])
for index, bad in enumerate(['../escape', '/absolute', 'x/../../escape', 'x\\\\escape', 'link']):
    archive = root / (str(index)+'.zip'); dest=root/('out'+str(index))
    with zipfile.ZipFile(archive,'w') as z:
        z.writestr('safe', b'ok')
        info=zipfile.ZipInfo(bad)
        if bad == 'link': info.external_attr = (stat.S_IFLNK | 0o777) << 16
        z.writestr(info, b'evil')
    try: extract(archive,dest)
    except ValueError: pass
    else: raise AssertionError('unsafe ZIP accepted')
    assert not (dest/'safe').exists()
archive=root/'good.zip'
with zipfile.ZipFile(archive,'w') as z:
    info=zipfile.ZipInfo('emulator/emulator'); info.external_attr=(stat.S_IFREG|0o755)<<16; z.writestr(info,b'good')
extract(archive,root/'good')
assert (root/'good/emulator/emulator').read_bytes() == b'good'
assert (root/'good/emulator/emulator').stat().st_mode & 0o777 == 0o755`, [dir]));
}));

test('source validator permits safe npm executable symlinks, rejects escapes and write access', { skip: process.getuid?.() !== 0 }, async () => temporary(async dir => {
  ok(python(`import importlib.util, os
from pathlib import Path
spec=importlib.util.spec_from_file_location('validator', ${JSON.stringify(path.join(scripts, 'validate-install.py'))}); m=importlib.util.module_from_spec(spec); spec.loader.exec_module(m)
r=Path(sys.argv[1]); (r/'node_modules/.bin').mkdir(parents=True); (r/'node_modules/pkg').mkdir()
f=r/'node_modules/pkg/cli'; f.write_text('ok'); f.chmod(0o755)
link=r/'node_modules/.bin/pkg'; link.symlink_to('../pkg/cli'); m.source(r)
link.unlink(); link.symlink_to('/etc/passwd')
try: m.source(r)
except ValueError: pass
else: raise AssertionError('escaping npm symlink accepted')
link.unlink(); f.chmod(0o777)
try: m.source(r)
except ValueError: pass
else: raise AssertionError('writable root code accepted')`, [dir]));
}));

test('shell syntax/help and invalid arguments never invoke operational commands', async () => temporary(async dir => {
  const names = (await fs.readdir(scripts)).filter(n => n.endsWith('.sh'));
  for (const name of names) ok(spawnSync('bash', ['-n', path.join(scripts, name)], { encoding: 'utf8' }));
  for (const command of ['systemctl', 'curl', 'npm', 'git', 'mount', 'losetup']) {
    await fs.writeFile(path.join(dir, command), '#!/bin/sh\necho unexpected-operation >&2\nexit 99\n', { mode: 0o755 });
  }
  for (const name of ['install.sh', 'start.sh', 'stop.sh', 'uninstall.sh', 'preflight.sh', 'bootstrap.sh', 'dependencies.sh', 'sync-origin.sh']) {
    const result = spawnSync('bash', [path.join(scripts, name), '--help'], { encoding: 'utf8', env: { ...process.env, PATH: `${dir}:${process.env.PATH}` } });
    ok(result); assert.match(result.stdout, /Usage:/); assert.doesNotMatch(result.stderr, /unexpected-operation/);
  }
  for (const name of ['install.sh', 'start.sh', 'stop.sh', 'uninstall.sh']) {
    const result = spawnSync('bash', [path.join(scripts, name), '--unknown-unsafe-option'], { encoding: 'utf8', env: { ...process.env, PATH: `${dir}:${process.env.PATH}` } });
    assert.notEqual(result.status, 0); assert.doesNotMatch(result.stderr, /unexpected-operation/);
  }
}));

test('preflight excludes host-changing probes and service defaults remain private', async () => {
  const preflight = await fs.readFile(path.join(scripts, 'preflight.py'), 'utf8');
  assert.doesNotMatch(preflight, /0xAE01|LOOP_SET_FD|modprobe|apt-get|sock\.bind|\.mkdir\(/);
  const install = await fs.readFile(path.join(scripts, 'install.sh'), 'utf8');
  assert.match(install, /npm ci --ignore-scripts/); assert.match(install, /GIT_OPTIONAL_LOCKS=0/);
  assert.match(install, /ACCEPT ANDROID SDK LICENSE/);
  assert.match(install, /start\.sh" --tunnel --initial-setup/);
  assert.ok(install.indexOf('download.sh') < install.lastIndexOf('start.sh'));
  assert.match(install, /Initial setup previously failed/);
  const tunnel = await fs.readFile(path.join(root, 'deploy/cloudphone-platform-tunnel.service'), 'utf8');
  assert.match(tunnel, /DynamicUser=yes/); assert.match(tunnel, /http:\/\/127\.0\.0\.1:\$\{PORT\}/);
  const uninstall = await fs.readFile(path.join(scripts, 'uninstall.sh'), 'utf8');
  assert.match(uninstall, /--remove-data/); assert.doesNotMatch(uninstall, /rm[^\n]+\"\$SDK\"|pkill|killall/);
});

test('immutable SDK requires exact safe manifest, ownership and unwritable content', { skip: process.getuid?.() !== 0 }, async () => temporary(async dir => {
  ok(python(`import importlib.util, hashlib, os
from pathlib import Path
spec=importlib.util.spec_from_file_location('validator', ${JSON.stringify(path.join(scripts, 'validate-install.py'))}); m=importlib.util.module_from_spec(spec); spec.loader.exec_module(m)
r=Path(sys.argv[1]); marker=r/'.cloudphone-sdk'; marker.write_text('cloudphone-sdk-api36-v1\\n'); artifact=r/'artifact'; artifact.write_bytes(b'abc')
manifest=r/'SHA256SUMS'; manifest.write_text(''.join(hashlib.sha256(p.read_bytes()).hexdigest()+'  ./'+p.name+'\\n' for p in [marker,artifact]))
for p in [marker,artifact,manifest]: p.chmod(0o444)
r.chmod(0o555)
try:
    m.sdk(r)
    artifact.chmod(0o644)
    try: m.sdk(r)
    except ValueError: pass
    else: raise AssertionError('writable SDK accepted')
    artifact.chmod(0o444); r.chmod(0o755); extra=r/'unlisted'; extra.write_text('oops'); extra.chmod(0o444); r.chmod(0o555)
    try: m.sdk(r)
    except ValueError: pass
    else: raise AssertionError('unlisted SDK entry accepted')
finally:
    r.chmod(0o755)
    for p in r.iterdir(): p.chmod(0o644)`, [dir]));
}));

test('web configuration exposes no root credentials and allows only canonical local/tunnel origin', () => {
  const config = makeConfig('dashboard');
  const web = webConfig({ ...config, password: 'secret' }, 'https://one-two.trycloudflare.com');
  assert.equal(web.publicOrigin, 'https://one-two.trycloudflare.com');
  for (const key of ['password', 'credentialsFile', 'stateDir', 'standalone']) assert.ok(!(key in web));
  for (const origin of ['https://one.trycloudflare.com/evil', 'https://one.trycloudflare.com.evil.org', 'https://user@one.trycloudflare.com', 'https://one.trycloudflare.com\nPORT=80', 'http://one.trycloudflare.com']) assert.throws(() => webConfig(config, origin));
});

test('standalone sizing uses actual allocatable resources and refuses absent enforcement before mutation', async () => {
  const big = chooseStandaloneSize({ memoryAllocatableBytes: 64 * 1024 ** 3, diskAllocatableBytes: 500 * 1024 ** 3 });
  assert.equal(big.guestRamMiB, 32768); assert.equal(big.hostMemoryMiB, 49152); assert.equal(big.diskGiB, 256);
  for (const usage of [{}, { memoryAllocatableBytes: 1024 ** 3, diskAllocatableBytes: 100 * 1024 ** 3 }, { memoryAllocatableBytes: 16 * 1024 ** 3, diskAllocatableBytes: 5 * 1024 ** 3 }]) assert.throws(() => chooseStandaloneSize(usage));
  for (const checks of [{}, { networkIsolation: { ok: true } }, { networkIsolation: { ok: true }, streamingIsolation: { ok: false } }]) {
    const manager = { capabilities: async () => ({ supported: true, checks }), list: async () => assert.fail('must not touch phone state') };
    await assert.rejects(provision(manager, makeConfig('standalone')), /blocked/);
  }
});

test('split units isolate web secrets, keep broker mounts visible, and avoid dependency-stop cycles', async () => {
  const read = name => fs.readFile(path.join(root, 'deploy', name), 'utf8');
  const web = await read('cloudphone-platform.service');
  const broker = await read('cloudphone-platform-broker.service');
  const tunnel = await read('cloudphone-platform-tunnel.service');
  assert.match(web, /User=cloudphone-web/); assert.match(web, /CapabilityBoundingSet=\n/);
  assert.match(web, /CONFIG_FILE=\/etc\/cloudphone-platform-web\/config.json/);
  assert.match(web, /InaccessiblePaths=\/var\/lib\/cloudphone-platform \/etc\/cloudphone-platform/);
  assert.match(broker, /User=root/); assert.match(broker, /Group=cloudphone-web/);
  assert.match(broker, /RuntimeDirectoryMode=0750/); assert.match(broker, /ExecStopPost=.*cleanup.mjs/);
  assert.doesNotMatch(broker, /^(ProtectSystem|ProtectHome|PrivateTmp|PrivateMounts|ReadOnlyPaths|ReadWritePaths)=/m);
  assert.doesNotMatch(tunnel, /Requires=cloudphone-platform.service/);
  assert.doesNotMatch(web, /Requires=cloudphone-platform-broker.service/);
  assert.match(tunnel, /ExecStartPost=.*--no-block restart cloudphone-platform-origin.service/);
  const origin = await fs.readFile(path.join(scripts, 'sync-origin.sh'), 'utf8');
  assert.match(origin, /_SYSTEMD_INVOCATION_ID=/); assert.match(origin, /flock -w 120 9/);
  assert.match(origin, /systemctl restart "\$UNIT"/); assert.doesNotMatch(origin, /systemctl restart "\$BROKER_UNIT"/);
});

test('bootstrap fetches full public source; dependency installation verifies official pinned Node first', async () => {
  const boot = await fs.readFile(path.join(scripts, 'bootstrap.sh'), 'utf8');
  const deps = await fs.readFile(path.join(scripts, 'dependencies.sh'), 'utf8');
  assert.match(boot, /https:\/\/github.com\/Silence-X-Proton\/cloudphone-platform.git/);
  assert.match(boot, /fetch --depth=1 --no-tags/); assert.match(boot, /install.sh" --source/);
  assert.match(deps, /ACCEPT HOST CHANGES/); assert.match(deps, /SHASUMS256.txt/);
  assert.match(deps, /df450af89261115ef9f9e3830c3eeb2cc9213b63c720b1af623cb5dcbe2e02de/);
  assert.ok(deps.indexOf('sha256sum --check --status') < deps.indexOf('tar --extract'));
  assert.match(deps, /REPAIR_NPM=yes/); assert.doesNotMatch(deps, /ln -s[fF]|apt-get upgrade/);
});
