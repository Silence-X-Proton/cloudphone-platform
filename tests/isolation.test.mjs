import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { PhoneManager, ID_RE } from '../lib/isolation.mjs';
import { MiB, GiB, hostUsage, validateRequest } from '../lib/resources.mjs';

// ALL privileged commands and host capability/resource readings are mocks.
// Only small ordinary files in mkdtemp are real; NO mount/loop/systemd/KVM is invoked.
async function fixture(t, config = {}) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'cloudphone-unit-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const calls = []; const images = new Map(); const loops = new Map(); const mounts = new Map(); const units = new Map();
  const io = new Proxy(fs, { get(target, key) {
    if (key === 'lstat') return async p => {
      const real = await fs.lstat(p);
      if (images.has(p)) return new Proxy(real, { get(s, k) { if (k === 'size') return images.get(p); if (k === 'blocks') return images.get(p) / 512; const v = s[k]; return typeof v === 'function' ? v.bind(s) : v; } });
      return real;
    };
    if (key === 'readlink') return async p => { if (['/proc/self/ns/mnt', '/proc/1/ns/mnt'].includes(p)) return 'mnt:[1]'; if (p === '/proc/self/ns/net') return 'net:[1]'; if (p === '/proc/123/ns/net') return 'net:[2]'; throw new Error('Unexpected namespace read ' + p); };
    if (key === 'readFile') return async (p, ...args) => {
      if (p === '/proc/meminfo') return 'MemTotal:       33554432 kB\nMemAvailable:   31457280 kB\n';
      if (p.startsWith('/sys/fs/cgroup/')) {
        if (p.endsWith('memory.current')) return String(123 * MiB);
        if (p.endsWith('memory.max')) return String(4096 * MiB);
        if (p.endsWith('memory.swap.max')) return '0';
        if (p.endsWith('cgroup.events')) return 'populated 0\n';
        throw new Error('Unexpected mocked host read: ' + p);
      }
      return fs.readFile(p, ...args);
    };
    if (key === 'unlink') return async p => { if (p.endsWith('/disk.ext4')) await fs.rm(path.join(path.dirname(p), 'volume-mock-data'), { recursive: true, force: true }); return fs.unlink(p); };
    if (key === 'statfs') return async p => p.endsWith('/volume') ? { blocks: 11 * GiB / 4096, bfree: 8 * GiB / 4096, bavail: 7 * GiB / 4096, bsize: 4096 } : { blocks: 200 * GiB / 4096, bfree: 150 * GiB / 4096, bavail: 150 * GiB / 4096, bsize: 4096 };
    return target[key];
  } });
  const runner = async (exe, args) => {
    calls.push({ exe, args });
    const ok = stdout => ({ code: 0, stdout: stdout || '', stderr: '' });
    if (exe.endsWith('/getent') && args[1] === 'cloudphone-web') return ok('cloudphone-web:x:990:');
    if (exe.endsWith('/getent')) return { code: 2, stdout: '', stderr: '' };
    if (exe.endsWith('/fallocate')) { images.set(args.at(-1), Number(args[1])); return ok(); }
    if (exe.endsWith('/mkfs.ext4')) return ok();
    if (exe.endsWith('/losetup')) {
      if (args.includes('--json')) { const img = args.at(-1); return ok(JSON.stringify({ loopdevices: loops.has(img) ? [{ name: loops.get(img), 'back-file': img, 'back-ino': (await fs.lstat(img)).ino, offset: 0, sizelimit: 0, ro: false }] : [] })); }
      if (args.includes('--detach')) { for (const [img, loop] of loops) if (loop === args[1]) loops.delete(img); return ok(); }
      const loop = `/dev/loop${loops.size + 90}`; loops.set(args.at(-1), loop); return ok(loop + '\n');
    }
    if (exe.endsWith('/findmnt')) {
      if (args.includes('--source')) return { code: 1, stdout: '', stderr: '' };
      const mount = args[args.indexOf('--mountpoint') + 1];
      return mounts.has(mount) ? ok(JSON.stringify({ filesystems: [{ target: mount, source: mounts.get(mount), fstype: 'ext4', options: 'rw,nosuid,nodev,noexec' }] })) : { code: 1, stdout: '', stderr: '' };
    }
    if (exe.endsWith('/mount')) { const mount = args.at(-1); const saved = mount + '-mock-data'; try { await fs.rmdir(mount); await fs.rename(saved, mount); } catch (e) { if (e.code !== 'ENOENT') throw e; await fs.mkdir(mount, { recursive: true }); } mounts.set(mount, args.at(-2)); return ok(); }
    if (exe.endsWith('/umount')) {
      const mount = args.at(-1); mounts.delete(mount);
      // Persist data outside the fake mountpoint until next mocked mount.
      await fs.rename(mount, mount + '-mock-data'); await fs.mkdir(mount);
      return ok();
    }
    if (exe.endsWith('/systemd-run')) { const unit = args[args.indexOf('--unit') + 1]; units.set(unit, 'active'); await fs.writeFile(path.join(dir, unit.slice(11, -8), 'volume/run/ready'), args.at(-1)); return ok(); }
    if (exe.endsWith('/systemctl')) {
      const unit = args[1];
      if (args[0] === 'show') {
        if (!units.has(unit)) return ok('LoadState=not-found\nActiveState=inactive\n');
        const state = units.get(unit);
        const id = unit.slice(11, -8); const record = JSON.parse(await fs.readFile(path.join(dir, id, 'record.json'), 'utf8'));
        return ok(`PrivateNetwork=yes\nTransient=yes\nDescription=Cloudphone ${id}\nUser=${200000 + record.adbPort - 15000}\nGroup=${200000 + record.adbPort - 15000}\nLoadState=loaded\nActiveState=${state}\nSubState=${state === 'active' ? 'running' : 'dead'}\nControlGroup=/system.slice/${unit}\nMemoryMax=${4096 * MiB}\nMemorySwapMax=0\nMainPID=${state === 'active' ? '123' : '0'}\n`);
      }
      if (args[0] === 'stop') units.set(unit, 'inactive');
      return ok();
    }
    throw new Error(`Unexpected mock command: ${exe} ${args.join(' ')}`);
  };
  const manager = new PhoneManager({ stateDir: dir, sdkDir: '/opt/test-sdk', runner, io, config: { networkMode: 'none', ...config } });
  manager.capabilities = async () => ({ supported: true, checks: {} });
  return { manager, dir, calls, images, loops, mounts, units, io };
}
const request = { name: 'Phone', guestRamMiB: 2048, hostMemoryMiB: 4096, diskGiB: 12 };

test('validation rejects paths, shell fields, invalid sizes and malformed IDs', async t => {
  const { manager, calls } = await fixture(t);
  for (const data of [{ ...request, command: 'sh' }, { ...request, guestRamMiB: 0 }, { ...request, hostMemoryMiB: 2050 }, { ...request, diskGiB: 8.5 }, { ...request, name: '\n' }]) assert.throws(() => validateRequest(data));
  await assert.rejects(manager.start('../../etc'), /ID/);
  assert.equal(calls.length, 0);
  assert.throws(() => new PhoneManager({ stateDir: '/tmp/a;id' }), /Invalid/);
});

test('mock lifecycle allocates exact image, verifies aggregate limits, safely stops and deletes', async t => {
  const { manager, calls, images } = await fixture(t);
  const record = await manager.create(request);
  assert.match(record.id, ID_RE); assert.equal(record.status, 'stopped');
  assert.equal(record.consolePort, 5556); assert.equal(record.adbPort, 15000);
  assert.equal(record.serial, 'emulator-5556');
  assert.equal([...images.values()][0], 12 * GiB);
  assert.equal((await manager.start(record.id)).status, 'running');
  const run = calls.find(c => c.exe.endsWith('systemd-run'));
  for (const value of [`MemoryMax=${4096 * MiB}`, 'MemorySwapMax=0', 'KillMode=control-group', 'ProtectSystem=strict', 'ReadOnlyPaths=/dev', 'User=200000', 'PrivateNetwork=yes', 'SupplementaryGroups=kvm cloudphone-web']) assert.ok(run.args.includes(value), value);
  assert.ok(run.args.some(v => v.startsWith('BindPaths=') && v.includes(':/dev/shm') && v.includes(':/tmp') && v.includes(':/var/tmp')));
  await manager.start(record.id);
  assert.equal(calls.filter(c => c.exe.endsWith('systemd-run')).length, 1);
  assert.equal((await manager.stop(record.id)).status, 'stopped');
  assert.ok(calls.findIndex(c => c.args[0] === 'stop') < calls.findIndex(c => c.exe.endsWith('/umount')));
  assert.deepEqual(await manager.delete(record.id), { id: record.id, deleted: true });
  assert.deepEqual(await manager.list(), []);
});

test('concurrent manager mutations have unique IDs and nonoverlapping ports, durable records', async t => {
  const { manager, dir } = await fixture(t);
  const records = await Promise.all([manager.create(request), manager.create(request)]);
  assert.notEqual(records[0].id, records[1].id); assert.notEqual(records[0].adbPort, records[1].adbPort);
  for (const r of records) {
    assert.equal(JSON.parse(await fs.readFile(path.join(dir, r.id, 'record.json'), 'utf8')).id, r.id);
    assert.deepEqual((await fs.readdir(path.join(dir, r.id))).sort(), ['disk.ext4', 'record.json', 'volume']);
  }
});

test('capability failure rejects before any privileged command', async t => {
  const { manager, calls } = await fixture(t);
  manager.capabilities = async () => ({ supported: false, checks: { systemd: { ok: false, reason: 'unavailable' } } });
  await assert.rejects(manager.create(request), /Strict isolation unavailable/); assert.equal(calls.length, 0);
});

test('standalone constraint survives manager re-instantiation', async t => {
  const { manager, dir, io } = await fixture(t, { mode: 'standalone' });
  await manager.create(request);
  const second = new PhoneManager({ stateDir: dir, sdkDir: '/opt/test-sdk', runner: manager.runner, io, config: { mode: 'standalone' } });
  second.capabilities = manager.capabilities;
  await assert.rejects(second.create(request), /exactly one/);
});

test('host admission includes safety reserve and existing memory commitments', async t => {
  const { manager } = await fixture(t);
  await assert.rejects(manager.create({ ...request, hostMemoryMiB: 32768 }), /Insufficient/);
  await assert.rejects(manager.create({ ...request, diskGiB: 150 }), /Insufficient/);
  await manager.create(request);
  const usage = await manager.usage();
  assert.equal(usage.memoryReservedBytes, 4096 * MiB);
  assert.equal(usage.diskCommittedBytes, 12 * GiB);
  assert.equal(usage.diskReserveBytes, 10 * GiB);
});

test('sparse image fails closed and is retained as an error record', async t => {
  const { manager, images } = await fixture(t);
  const original = manager.command.bind(manager);
  manager.command = async (...args) => { const r = await original(...args); if (args[0].endsWith('fallocate')) images.clear(); return r; };
  await assert.rejects(manager.create(request), /sparse/);
  assert.equal((await manager.list())[0].status, 'error');
});

test('wrong mount source prevents cleanup or unlink', async t => {
  const { manager, mounts, calls, dir } = await fixture(t);
  const r = await manager.create(request); await manager.start(r.id);
  mounts.set(path.join(dir, r.id, 'volume'), '/dev/loop999');
  const before = calls.length;
  await assert.rejects(manager.delete(r.id), /mismatch/);
  assert.ok(!calls.slice(before).some(c => c.exe.endsWith('/umount') || c.args.includes('--detach')));
  await fs.access(path.join(dir, r.id, 'disk.ext4'));
});

test('failed systemd stop refuses unmount and deletion', async t => {
  const { manager, calls } = await fixture(t);
  const r = await manager.create(request); await manager.start(r.id);
  const runner = manager.runner;
  manager.runner = async (exe, args) => args[0] === 'stop' ? { code: 1, stdout: '', stderr: 'busy' } : runner(exe, args);
  await assert.rejects(manager.delete(r.id), /busy/);
  assert.ok(!calls.some(c => c.exe.endsWith('/umount')));
});

test('kernel memory limit mismatch stops the service and never reports running', async t => {
  const { manager, io, calls } = await fixture(t);
  const r = await manager.create(request);
  manager.io = new Proxy(io, { get(target, key) { if (key === 'readFile') return async (p, ...args) => p.endsWith('/memory.swap.max') ? 'max' : target.readFile(p, ...args); return target[key]; } });
  await assert.rejects(manager.start(r.id), /memory.swap.max/);
  assert.ok(calls.some(c => c.args[0] === 'stop'));
  assert.equal((await manager.list())[0].status, 'error');
});

test('foreign lock fails closed and is not removed', async t => {
  const { manager, dir } = await fixture(t);
  await fs.mkdir(path.join(dir, '.mutation-lock'));
  await assert.rejects(manager.create(request), /mutation lock/);
  await fs.access(path.join(dir, '.mutation-lock'));
});


test('foreign unit identity is refused before stop', async t => {
  const { manager, calls } = await fixture(t);
  const r = await manager.create(request); await manager.start(r.id);
  const runner = manager.runner;
  manager.runner = async (exe, args) => { const result = await runner(exe, args); if (args[0] === 'show') result.stdout = result.stdout.replace('Transient=yes', 'Transient=no'); return result; };
  await assert.rejects(manager.stop(r.id), /unit identity/);
  assert.ok(!calls.some(c => c.args[0] === 'stop'));
});

test('absent unit with populated expected cgroup blocks deletion', async t => {
  const { manager, io } = await fixture(t);
  const r = await manager.create(request);
  manager.io = new Proxy(io, { get(target, key) { if (key === 'readFile') return async (p, ...args) => p.endsWith('/cgroup.events') ? 'populated 1\n' : target.readFile(p, ...args); return target[key]; } });
  await assert.rejects(manager.delete(r.id), /still populated/);
});


test('mock filesystem persists Android data across stop/start', async t => {
  const { manager, dir } = await fixture(t);
  const r = await manager.create(request); await manager.start(r.id);
  const data = path.join(dir, r.id, 'volume/avd/phone.avd/user-state');
  await fs.writeFile(data, 'persistent Android data');
  await manager.stop(r.id); await manager.start(r.id);
  assert.equal(await fs.readFile(data, 'utf8'), 'persistent Android data');
});

test('unexpected loop geometry prevents mount', async t => {
  const { manager, calls } = await fixture(t);
  const r = await manager.create(request);
  const runner = manager.runner;
  manager.runner = async (exe, args) => { const result = await runner(exe, args); if (args.includes('--json') && exe.endsWith('losetup')) { const data = JSON.parse(result.stdout); for (const device of data.loopdevices) device.offset = 4096; result.stdout = JSON.stringify(data); } return result; };
  await assert.rejects(manager.start(r.id), /geometry/);
  assert.ok(!calls.some(c => c.exe.endsWith('/mount')));
});

test('real capability logic reports absent host prerequisites using denied mock IO only', async () => {
  const denied = async () => { throw new Error('mock unavailable'); };
  const manager = new PhoneManager({ runner: denied, io: new Proxy({}, { get: () => denied }) });
  const result = await manager.capabilities();
  assert.equal(result.supported, false);
  for (const key of ['systemd', 'cgroupV2Memory', 'kvm', 'loop', 'storage', 'sdk']) {
    assert.equal(result.checks[key].ok, false);
    assert.match(result.checks[key].reason, /mock unavailable/);
  }
});


test('phone keys are unique root-only secrets, never returned in public records', async t => {
  const { manager, dir } = await fixture(t);
  const a = await manager.create(request); const b = await manager.create(request);
  const key = await manager.revealKey(a.id);
  assert.match(key, /^[A-Za-z0-9_-]{43}$/);
  assert.equal(Buffer.from(key, 'base64url').length, 32);
  assert.notEqual(key, await manager.revealKey(b.id));
  assert.equal(await manager.verifyKey(a.id, key), true);
  assert.equal(await manager.verifyKey(b.id, key), false);
  assert.equal(await manager.verifyKey(a.id, 'wrong'), false);
  assert.equal(await manager.verifyKey(a.id, null), false);
  assert.equal(JSON.stringify(await manager.list()).includes(key), false);
  assert.equal('accessKey' in a, false);
  assert.equal((await fs.stat(path.join(dir, a.id, 'record.json'))).mode & 0o777, 0o600);
  assert.equal((await fs.stat(dir)).mode & 0o777, 0o700);
});

test('metrics read actual mocked memory.current and statfs; stopped values unknown/null', async t => {
  const { manager } = await fixture(t);
  const r = await manager.create(request);
  const stopped = await manager.metrics(r.id);
  assert.equal(stopped.memoryCurrentBytes, null); assert.equal(stopped.diskUsedBytes, null);
  assert.deepEqual(stopped.known, { memory: false, disk: false });
  await manager.start(r.id);
  const live = await manager.metrics(r.id);
  assert.equal(live.memoryCurrentBytes, 123 * MiB);
  assert.equal(live.diskUsedBytes, 3 * GiB);
  assert.equal(live.diskTotalBytes, 11 * GiB);
  assert.equal(live.diskAvailableBytes, 7 * GiB);
  assert.deepEqual(live.known, { memory: true, disk: true });
});

test('reboot absent transient unit reconciles and restarts without reallocating image or key', async t => {
  const { manager, calls, units } = await fixture(t);
  const r = await manager.create(request); const key = await manager.revealKey(r.id);
  await manager.start(r.id); units.clear();
  const before = calls.length;
  assert.equal((await manager.start(r.id)).status, 'running');
  assert.ok(!calls.slice(before).some(c => c.exe.endsWith('/fallocate') || c.exe.endsWith('/mkfs.ext4')));
  assert.equal(await manager.revealKey(r.id), key);
});

test('broker private mount namespace fails before mounting', async t => {
  const { manager, io, calls } = await fixture(t);
  const r = await manager.create(request);
  manager.io = new Proxy(io, { get(target, key) { if (key === 'readlink') return async p => p === '/proc/self/ns/mnt' ? 'mnt:[99]' : target.readlink(p); return target[key]; } });
  await assert.rejects(manager.start(r.id), /PID1 mount namespace/);
  assert.ok(!calls.some(c => c.exe.endsWith('/mount')));
});

test('implicit or internet network mode is explicitly unsupported, no host fallback', async () => {
  const denied = async () => { throw new Error('mock unavailable'); };
  for (const config of [{}, { networkMode: 'internet' }]) {
    const manager = new PhoneManager({ config, runner: denied, io: new Proxy({}, { get: () => denied }) });
    const capabilities = await manager.capabilities();
    assert.equal(capabilities.supported, false);
    assert.equal(capabilities.checks.networkIsolation.ok, false);
    assert.match(capabilities.checks.networkIsolation.reason, /OFFLINE/);
    assert.equal(capabilities.network.internet, false);
    assert.equal(capabilities.checks.streamingIsolation.ok, false);
  }
});


test('generated worker config uses immutable SDK and in-budget Unix socket', async t => {
  const { manager, calls } = await fixture(t);
  const r = await manager.create(request); await manager.start(r.id);
  const command = calls.find(c => c.exe.endsWith('/systemd-run'));
  const config = JSON.parse(command.args.at(-2));
  assert.equal(config.socketPath, '/srv/cloudphone/run/stream.sock');
  assert.equal(config.scrcpyServer, '/opt/test-sdk/scrcpy-server.jar');
  assert.equal(config.networkMode, 'private');
  assert.equal(config.hostNetNamespace, 'net:[1]');
  assert.equal(config.webGid, 990);
  assert.equal(config.phone.id, r.id);
  assert.equal(JSON.stringify(config).includes(await manager.revealKey(r.id)), false);
});


test('sandbox-hidden SDK roots rejected and human hyphenated names accepted', () => {
  for (const sdkDir of ['/home/sdk', '/run/sdk', '/tmp/sdk', '/srv/cloudphone/sdk']) assert.throws(() => new PhoneManager({ sdkDir }), /hidden/);
  assert.equal(validateRequest({ ...request, name: 'My-phone' }).name, 'My-phone');
  assert.throws(() => validateRequest({ ...request, name: 'bad' + String.fromCharCode(1) }), /phone name/);
});
