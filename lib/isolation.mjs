import fs from 'node:fs/promises';
import { constants as F } from 'node:fs';
import path from 'node:path';
import { randomBytes, createHash, timingSafeEqual } from 'node:crypto';
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import net from 'node:net';
import { hostUsage, validateRequest, filesystemUsage, MiB, GiB } from './resources.mjs';

export const ID_RE = /^[a-f0-9]{16}$/;
const HERE = fileURLToPath(import.meta.url);
const WORKER = path.join(path.dirname(HERE), 'phone-worker.mjs');
const INSIDE = '/srv/cloudphone';
const IMAGE = 'system-images/android-36/google_apis/x86_64';
const C = Object.freeze({ systemctl: '/usr/bin/systemctl', run: '/usr/bin/systemd-run',
  loop: '/usr/sbin/losetup', mkfs: '/usr/sbin/mkfs.ext4', mount: '/usr/bin/mount',
  umount: '/usr/bin/umount', findmnt: '/usr/bin/findmnt', allocate: '/usr/bin/fallocate' });
const exec = promisify(execFile);
export async function defaultRunner(executable, args, options = {}) {
  try {
    const { stdout, stderr } = await exec(executable, args, {
      timeout: 120000, maxBuffer: 1024 * 1024, encoding: 'utf8', ...options,
      shell: false, env: { PATH: '/usr/sbin:/usr/bin:/sbin:/bin', LANG: 'C' },
    });
    return { code: 0, stdout, stderr };
  } catch (error) {
    if (typeof error.code === 'number' && !error.killed) return { code: error.code, stdout: error.stdout || '', stderr: error.stderr || '' };
    throw error;
  }
}
function safePath(value, label) {
  if (typeof value !== 'string' || !/^\/[a-zA-Z0-9_./-]+$/.test(value) || value === '/' || path.normalize(value) !== value || value.includes('/../')) throw new Error(`Invalid ${label}`);
  return value;
}
function props(text) { return Object.fromEntries(text.trim().split('\n').filter(Boolean).map(line => { const i = line.indexOf('='); return [line.slice(0, i), line.slice(i + 1)]; })); }
function publicRecord(r) {
  return Object.fromEntries(['id', 'name', 'guestRamMiB', 'hostMemoryMiB', 'diskGiB', 'status', 'adbPort', 'consolePort', 'serial'].map(k => [k, r[k]]));
}
const queues = new Map();

/** Trusted constructor configuration only. Never expose runner/io/stateDir/sdkDir to HTTP clients.
 * Calls are serialized in-process and guarded cross-process by an exclusive directory lock.
 * A stale lock fails closed and must be removed offline after confirming no manager is alive.
 */
export class PhoneManager {
  constructor({ stateDir = '/var/lib/cloudphone', sdkDir = '/opt/cloudphone-sdk', runner = defaultRunner, io = fs, config = {} } = {}) {
    this.stateDir = safePath(stateDir, 'stateDir'); this.sdkDir = safePath(sdkDir, 'sdkDir');
    if (['/home', '/root', '/run', '/tmp', '/var/tmp', '/dev', '/proc', '/sys', INSIDE].some(hidden => sdkDir === hidden || sdkDir.startsWith(hidden + '/'))) throw new Error('SDK path is hidden or replaced by phone sandbox');
    if (stateDir === sdkDir || stateDir.startsWith(`${sdkDir}/`) || sdkDir.startsWith(`${stateDir}/`)) throw new Error('SDK and state directories must be disjoint');
    this.runner = runner; this.io = io; this.standalone = config.mode === 'standalone';
    this.scrcpyServer = path.join(this.sdkDir, 'scrcpy-server.jar');
    this.networkMode = config.networkMode; // Only explicit 'none' is currently supported; no host fallback.
  }
  async command(exe, args, allowFailure = false, options = {}) {
    const r = await this.runner(exe, args, options);
    if (!r || !Number.isInteger(r.code)) throw new Error('Invalid runner result');
    if (r.code !== 0 && !allowFailure) throw new Error(`${path.basename(exe)} failed (${r.code}): ${String(r.stderr).slice(0, 500)}`);
    return r;
  }
  paths(id) {
    if (!ID_RE.test(id)) throw new Error('Invalid phone ID');
    const dir = path.join(this.stateDir, id);
    return { dir, record: path.join(dir, 'record.json'), image: path.join(dir, 'disk.ext4'), mount: path.join(dir, 'volume'), unit: `cloudphone-${id}.service` };
  }
  async canonical(dir) {
    const stat = await this.io.lstat(dir);
    if (!stat.isDirectory() || stat.isSymbolicLink() || await this.io.realpath(dir) !== dir) throw new Error(`Unsafe directory: ${dir}`);
    return stat;
  }
  async initialize() {
    await this.io.mkdir(this.stateDir, { recursive: true, mode: 0o700 });
    const st = await this.canonical(this.stateDir);
    if (st.uid !== 0 || (st.mode & 0o077)) throw new Error('stateDir must be root-owned mode 0700');
  }
  async mutate(fn) {
    const previous = queues.get(this.stateDir) || Promise.resolve();
    const task = previous.catch(() => {}).then(async () => {
      await this.initialize();
      const lock = path.join(this.stateDir, '.mutation-lock');
      try { await this.io.mkdir(lock, { mode: 0o700 }); } catch (error) {
        if (error.code === 'EEXIST') throw new Error('Another manager holds the mutation lock; stale locks require offline inspection');
        throw error;
      }
      try { return await fn(); } finally { await this.io.rmdir(lock); }
    });
    queues.set(this.stateDir, task);
    try { return await task; } finally { if (queues.get(this.stateDir) === task) queues.delete(this.stateDir); }
  }
  async save(r) {
    const p = this.paths(r.id);
    const temporary = `${p.record}.${randomBytes(8).toString('hex')}.tmp`;
    const handle = await this.io.open(temporary, 'wx', 0o600);
    try { await handle.writeFile(`${JSON.stringify(r)}\n`); await handle.sync(); } finally { await handle.close(); }
    await this.io.rename(temporary, p.record);
    const dir = await this.io.open(p.dir, 'r');
    try { await dir.sync(); } finally { await dir.close(); }
  }
  async read(id) {
    const p = this.paths(id); const parent = await this.canonical(this.stateDir); const instance = await this.canonical(p.dir);
    if ([parent, instance].some(st => st.uid !== 0 || st.mode & 0o077)) throw new Error('Unsafe private state permissions');
    const stat = await this.io.lstat(p.record);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.uid !== 0 || stat.mode & 0o077) throw new Error('Unsafe record');
    const r = JSON.parse(await this.io.readFile(p.record, 'utf8'));
    validateRequest({ name: r.name, guestRamMiB: r.guestRamMiB, hostMemoryMiB: r.hostMemoryMiB, diskGiB: r.diskGiB });
    if (r.id !== id || !['creating', 'stopped', 'starting', 'running', 'stopping', 'deleting', 'error'].includes(r.status) ||
        !Number.isInteger(r.adbPort) || r.adbPort < 15000 || r.adbPort > 15030 ||
        !Number.isInteger(r.consolePort) || r.consolePort < 5556 || r.consolePort > 5616 || r.consolePort % 2 ||
        r.serial !== `emulator-${r.consolePort}` || (r.loop && !/^\/dev\/loop\d+$/.test(r.loop))) throw new Error('Invalid record');
    return r;
  }
  async records() {
    let names;
    try { await this.canonical(this.stateDir); names = await this.io.readdir(this.stateDir); }
    catch (error) { if (error.code === 'ENOENT') return []; throw error; }
    const records = [];
    for (const name of names.sort()) if (ID_RE.test(name)) records.push(await this.read(name));
    return records;
  }
  async list() {
    const records = await this.records();
    for (const r of records) if (r.status === 'running') {
      try { await this.verifyLimits(r); } catch { r.status = 'error'; }
    }
    return records.map(publicRecord);
  }
  /** Trusted broker only: the HTTP adapter MUST authorize admin before reveal. */
  async revealKey(id) {
    const r = await this.read(id);
    if (typeof r.accessKey !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(r.accessKey)) throw new Error('Phone key unavailable; explicit migration required');
    return r.accessKey;
  }
  async verifyKey(id, candidate) {
    if (typeof candidate !== 'string' || candidate.length > 1024) return false;
    let key;
    try { key = await this.revealKey(id); } catch (error) { if (error.code === 'ENOENT') return false; throw error; }
    const digest = value => createHash('sha256').update(value, 'utf8').digest();
    return timingSafeEqual(digest(key), digest(candidate));
  }
  async metrics(id) {
    return this.mutate(async () => {
      const r = await this.read(id);
      const result = { id, memoryCurrentBytes: null, memoryLimitBytes: r.hostMemoryMiB * MiB,
        diskUsedBytes: null, diskTotalBytes: null, diskAvailableBytes: null,
        diskBudgetBytes: r.diskGiB * GiB, known: { memory: false, disk: false } };
      const state = await this.unitState(r);
      if (state.ActiveState === 'active') {
        await this.verifyLimits(r);
        const raw = (await this.io.readFile('/sys/fs/cgroup/system.slice/' + this.paths(id).unit + '/memory.current', 'utf8')).trim();
        const current = Number(raw);
        if (!/^\d+$/.test(raw) || !Number.isSafeInteger(current) || current < 0) throw new Error('Invalid memory.current');
        result.memoryCurrentBytes = current; result.known.memory = true;
      } else { await this.assertStopped(r); }
      if (await this.mounted(r)) {
        const disk = filesystemUsage(await this.io.statfs(this.paths(id).mount));
        if (disk.totalBytes > r.diskGiB * GiB) throw new Error('Mounted disk exceeds budget');
        result.diskUsedBytes = disk.usedBytes; result.diskTotalBytes = disk.totalBytes;
        result.diskAvailableBytes = disk.availableBytes; result.known.disk = true;
      }
      return result;
    });
  }
  /** Root broker can proxy this socket; never publish this path or raw ADB to clients. */
  async streamSocket(id) {
    const r = await this.read(id);
    await this.verifyLimits(r);
    if (!await this.mounted(r)) throw new Error('Phone volume is not mounted');
    const socket = path.join(this.paths(id).mount, 'run/stream.sock');
    const st = await this.io.lstat(socket);
    if (!st.isSocket() || st.isSymbolicLink() || st.uid !== 200000 + r.adbPort - 15000 || st.mode & 0o007) throw new Error('Unsafe stream socket');
    return socket;
  }
  async usage() { return hostUsage(this.stateDir, await this.records(), this.io); }
  /** Read-only probes: never creates test cgroups, loop attachments, mounts or emulator processes. */
  async capabilities() {
    const checks = {};
    const probe = async (name, fn) => { try { await fn(); checks[name] = { ok: true }; } catch (e) { checks[name] = { ok: false, reason: e.message }; } };
    await probe('mountNamespace', async () => { await this.assertHostMountNamespace(); });
    await probe('networkIsolation', async () => {
      if (this.networkMode !== 'none') throw new Error('Internet egress is not implemented/validated; explicit config.networkMode=none selects isolated OFFLINE phones');
    });
    await probe('streamWorker', async () => {
      for (const filename of [HERE, WORKER, this.scrcpyServer]) {
        const st = await this.io.lstat(filename);
        if (!st.isFile() || st.isSymbolicLink() || st.uid !== 0 || st.mode & 0o022) throw new Error('Worker/code artifacts must be immutable root-owned regular files');
        await this.io.access(filename, F.R_OK);
      }
      await this.webGroup();
    });
    await probe('streamingIsolation', async () => {
      throw new Error('Worker and bounded root-broker proxy are implemented, but installed namespace/cgroup/socket-identity enforcement is not validated; deployment disabled');
    });
    await probe('root', async () => { if (process.getuid?.() !== 0) throw new Error('Root manager required'); });
    await probe('systemd', async () => {
      await this.canonical('/run/systemd/system');
      await this.command(C.systemctl, ['show', '--property=Version', '--value']);
      for (const executable of Object.values(C)) await this.io.access(executable, F.X_OK);
      await this.io.access('/usr/bin/node', F.X_OK);
      await this.canonical(INSIDE);
    });
    await probe('cgroupV2Memory', async () => {
      const ctr = await this.io.readFile('/sys/fs/cgroup/cgroup.controllers', 'utf8');
      if (!ctr.split(/\s+/).includes('memory')) throw new Error('cgroup v2 memory controller unavailable');
      await this.io.access('/sys/fs/cgroup/cgroup.subtree_control', F.W_OK);
      const m = await this.command(C.findmnt, ['-n', '-o', 'FSTYPE,OPTIONS', '--target', '/sys/fs/cgroup']);
      if (!/^cgroup2\s+/.test(m.stdout) || !/(?:^|[ ,])rw(?:,|\s|$)/.test(m.stdout)) throw new Error('cgroup v2 is not writable');
    });
    await probe('kvm', async () => {
      await this.io.access('/dev/kvm', F.R_OK | F.W_OK);
    });
    await probe('loop', async () => {
      await this.io.access('/dev/loop-control', F.R_OK | F.W_OK);
      const r = await this.command(C.loop, ['--find']);
      if (!/^\/dev\/loop\d+$/.test(r.stdout.trim())) throw new Error('No free loop device');
      await this.io.access(r.stdout.trim(), F.R_OK | F.W_OK);
    });
    await probe('storage', async () => {
      const st = await this.canonical(this.stateDir);
      if (st.uid !== 0 || st.mode & 0o077) throw new Error('stateDir must be root-owned mode 0700');
      await this.io.access(this.stateDir, F.W_OK);
      const r = await this.command(C.findmnt, ['-n', '-o', 'FSTYPE', '--target', this.stateDir]);
      if (!['ext4', 'xfs'].includes(r.stdout.trim())) throw new Error('State storage must be local ext4 or XFS; backing-device thick provisioning is an installer prerequisite');
    });
    await probe('sdk', async () => {
      const st = await this.canonical(this.sdkDir);
      if (st.uid !== 0 || st.mode & 0o022) throw new Error('SDK must be root-owned and not writable by service users');
      for (const name of ['emulator/emulator', 'platform-tools/adb']) await this.io.access(`${this.sdkDir}/${name}`, F.X_OK);
      for (const name of ['system.img', 'userdata.img', 'ramdisk.img', 'kernel-ranchu']) await this.io.access(`${this.sdkDir}/${IMAGE}/${name}`, F.R_OK);
    });
    return { supported: Object.values(checks).every(c => c.ok), network: { mode: this.networkMode || 'unconfigured', internet: false }, streaming: 'in-phone-cgroup-unix-broker-proxy', backend: 'systemd-cgroup-v2-loop-ext4', checks };
  }
  async assertHostMountNamespace() {
    if (await this.io.readlink('/proc/self/ns/mnt') !== await this.io.readlink('/proc/1/ns/mnt')) throw new Error('Broker must share PID1 mount namespace; disable broker filesystem namespace hardening');
  }
  async webGroup() {
    const result = await this.command('/usr/bin/getent', ['group', 'cloudphone-web']);
    const fields = result.stdout.trim().split(':');
    if (fields.length !== 4 || fields[0] !== 'cloudphone-web' || !/^\d+$/.test(fields[2]) || Number(fields[2]) <= 0 || Number(fields[2]) > 2147483647) throw new Error('Missing cloudphone-web group');
    return Number(fields[2]);
  }
  async requireCapabilities() {
    const c = await this.capabilities();
    if (!c.supported) throw new Error(`Strict isolation unavailable: ${Object.entries(c.checks).filter(([, v]) => !v.ok).map(([k, v]) => `${k}: ${v.reason}`).join('; ')}`);
  }
  async create(input) {
    const request = validateRequest(input);
    return this.mutate(async () => {
      await this.requireCapabilities();
      const records = await this.records();
      if (this.standalone && records.length) throw new Error('Standalone mode permits exactly one phone');
      const usage = await hostUsage(this.stateDir, records, this.io);
      if (request.hostMemoryMiB * MiB > usage.memoryAllocatableBytes || request.diskGiB * GiB > usage.diskAllocatableBytes) throw new Error('Insufficient host resources after safety reserves');
      let slot = 0;
      while (slot < 31 && records.some(r => r.consolePort === 5556 + slot * 2 || r.adbPort === 15000 + slot)) slot++;
      if (slot === 31) throw new Error('No free emulator port slots');
      const id = randomBytes(8).toString('hex'); const p = this.paths(id);
      await this.io.mkdir(p.dir, { mode: 0o700 }); await this.io.mkdir(p.mount, { mode: 0o700 });
      const r = { ...request, id, status: 'creating', adbPort: 15000 + slot, consolePort: 5556 + slot * 2, serial: `emulator-${5556 + slot * 2}`, loop: null, accessKey: randomBytes(32).toString('base64url') };
      await this.save(r);
      try {
        const h = await this.io.open(p.image, 'wx', 0o600); await h.close();
        await this.command(C.allocate, ['--length', String(r.diskGiB * GiB), p.image]);
        await this.assertImage(r);
        await this.command(C.mkfs, ['-t', 'ext4', '-F', '-m', '0', '-E', 'nodiscard,lazy_itable_init=0,lazy_journal_init=0', p.image], false, { timeout: 600000 });
        await this.assertImage(r);
        const allocated = await this.io.open(p.image, 'r+');
        try { await allocated.sync(); } finally { await allocated.close(); }
        r.status = 'stopped'; await this.save(r); return publicRecord(r);
      } catch (error) { r.status = 'error'; r.lastError = error.message; await this.save(r); throw error; }
    });
  }
  async assertImage(r) {
    const s = await this.io.lstat(this.paths(r.id).image);
    if (!s.isFile() || s.isSymbolicLink() || s.nlink !== 1 || s.uid !== 0 || s.mode & 0o077 || s.size !== r.diskGiB * GiB || s.blocks * 512 < s.size) throw new Error('Disk image is unsafe, sparse or not exactly the reserved size');
  }
  async loopInfo(r) {
    const result = await this.command(C.loop, ['--json', '--list', '--output', 'NAME,BACK-FILE,BACK-INO,OFFSET,SIZELIMIT,RO', '--associated', this.paths(r.id).image]);
    const devices = JSON.parse(result.stdout).loopdevices;
    if (!Array.isArray(devices) || devices.length > 1) throw new Error('Ambiguous loop ownership');
    const d = devices[0];
    if (d && (!/^\/dev\/loop\d+$/.test(d.name) || d['back-file'] !== this.paths(r.id).image || r.loop && r.loop !== d.name)) throw new Error('Loop backing file mismatch');
    if (d) {
      const st = await this.io.lstat(this.paths(r.id).image);
      if (String(d['back-ino']) !== String(st.ino) || Number(d.offset) !== 0 || Number(d.sizelimit) !== 0 || ![false, 0].includes(d.ro)) throw new Error('Loop identity/geometry mismatch');
    }
    return d?.name || null;
  }
  async mounted(r) {
    const p = this.paths(r.id); await this.canonical(p.mount);
    const result = await this.command(C.findmnt, ['--json', '--submounts', '--mountpoint', p.mount, '--output', 'TARGET,SOURCE,FSTYPE,OPTIONS'], true);
    if (result.code === 1 && !result.stdout.trim()) return false;
    if (result.code !== 0) throw new Error('Cannot inspect mount');
    const entries = JSON.parse(result.stdout).filesystems;
    if (!Array.isArray(entries) || entries.length !== 1) throw new Error('Ambiguous mount');
    const m = entries[0]; const loop = await this.loopInfo(r);
    if (!loop || m.target !== p.mount || m.source !== loop || m.fstype !== 'ext4' || !['rw', 'nosuid', 'nodev', 'noexec'].every(option => m.options.split(',').includes(option)) || m.options.split(',').includes('discard') || m.children?.length) throw new Error('Mount ownership/filesystem mismatch');
    return true;
  }
  async attach(r) {
    await this.assertImage(r);
    if (await this.mounted(r)) return;
    let loop = await this.loopInfo(r);
    if (!loop) {
      const result = await this.command(C.loop, ['--find', '--show', '--nooverlap', this.paths(r.id).image]);
      loop = result.stdout.trim();
      if (!/^\/dev\/loop\d+$/.test(loop)) throw new Error('Invalid allocated loop device');
    }
    r.loop = loop; await this.save(r);
    if (await this.loopInfo(r) !== loop) throw new Error('Loop ownership changed');
    await this.command(C.mount, ['-t', 'ext4', '-o', 'rw,nosuid,nodev,noexec,nodiscard', loop, this.paths(r.id).mount]);
    if (!await this.mounted(r)) throw new Error('Mount did not become active');
  }
  async prepare(r) {
    if (!await this.mounted(r)) throw new Error('Cannot initialize unmounted phone');
    const root = this.paths(r.id).mount;
    await this.assertStopped(r);
    for (const name of ['stream.sock', 'ready']) {
      const stale = path.join(root, 'run', name);
      try {
        const st = await this.io.lstat(stale);
        if (st.isSymbolicLink() || !(name === 'stream.sock' ? st.isSocket() : st.isFile())) throw new Error('Unsafe stale runtime entry');
        await this.io.unlink(stale);
      } catch (error) { if (error.code !== 'ENOENT') throw error; }
    }
    await this.io.chmod(root, 0o755);
    for (const name of ['home', 'tmp', 'vartmp', 'shm', 'logs', 'avd', 'avd/phone.avd', 'run']) {
      const dir = path.join(root, name);
      await this.io.mkdir(dir, { recursive: true, mode: 0o777 });
      await this.canonical(dir); await this.io.chown(dir, 200000 + r.adbPort - 15000, 200000 + r.adbPort - 15000); await this.io.chmod(dir, 0o700);
    }
    await this.io.chown(path.join(root, 'run'), 200000 + r.adbPort - 15000, r.webGid);
    await this.io.chmod(path.join(root, 'run'), 0o750);
    // Config is generated only by this backend; user names never enter commands or config.
    const config = [
      'avd.ini.encoding=UTF-8', 'AvdId=phone', 'abi.type=x86_64', 'hw.cpu.arch=x86_64',
      'hw.cpu.ncore=2', `hw.ramSize=${r.guestRamMiB}`, 'hw.lcd.width=720', 'hw.lcd.height=1520',
      'hw.lcd.density=320', 'hw.gpu.enabled=yes', 'hw.gpu.mode=swiftshader_indirect',
      'hw.keyboard=yes', 'hw.audioInput=no', 'hw.camera.back=none', 'hw.camera.front=none',
      `disk.dataPartition.size=${Math.max(2, Math.floor(r.diskGiB * 0.5))}G`,
      `image.sysdir.1=${this.sdkDir}/${IMAGE}/`, 'tag.id=google_apis', 'tag.display=Google APIs',
      'PlayStore.enabled=false', 'showDeviceFrame=no', 'fastboot.forceColdBoot=yes',
    ].join('\n') + '\n';
    for (const [name, content] of [['avd/phone.ini', `avd.ini.encoding=UTF-8\npath=${INSIDE}/avd/phone.avd\ntarget=android-36\n`], ['avd/phone.avd/config.ini', config]]) {
      const dest = path.join(root, name);
      const h = await this.io.open(dest, F.O_WRONLY | F.O_CREAT | F.O_TRUNC | F.O_NOFOLLOW, 0o666);
      try { await h.writeFile(content); await h.chown(200000 + r.adbPort - 15000, 200000 + r.adbPort - 15000); await h.chmod(0o600); } finally { await h.close(); }
    }
  }
  async unitState(r) {
    const result = await this.command(C.systemctl, ['show', this.paths(r.id).unit, '--property=LoadState,ActiveState,SubState,ControlGroup,MemoryMax,MemorySwapMax,MainPID,Transient,Description,User,Group,PrivateNetwork'], true);
    const state = props(result.stdout);
    if (state.LoadState === 'not-found' && (!state.ActiveState || state.ActiveState === 'inactive')) return { ...state, absent: true };
    if (result.code !== 0 || !state.LoadState || !state.ActiveState) throw new Error('Cannot establish systemd unit state');
    if (state.Transient !== 'yes' || state.Description !== `Cloudphone ${r.id}` || state.User !== String(200000 + r.adbPort - 15000) || state.Group !== state.User || (state.ControlGroup && state.ControlGroup !== `/system.slice/${this.paths(r.id).unit}`)) throw new Error('Foreign or ambiguous systemd unit identity');
    return state;
  }
  async assertStopped(r) {
    const s = await this.unitState(r);
    if (!s.absent && (!['inactive', 'failed'].includes(s.ActiveState) || s.MainPID !== '0')) throw new Error('Service is not fully stopped');
    const group = '/system.slice/' + this.paths(r.id).unit;
    try {
      const events = await this.io.readFile('/sys/fs/cgroup' + group + '/cgroup.events', 'utf8');
      if (!/^populated 0$/m.test(events)) throw new Error('Service cgroup still populated');
    } catch (error) { if (error.code !== 'ENOENT') throw error; }
  }

  serviceArgs(r) {
    const p = this.paths(r.id);
    const properties = [
      'Type=exec', `Description=Cloudphone ${r.id}`, 'Slice=system.slice', `User=${200000 + r.adbPort - 15000}`, `Group=${200000 + r.adbPort - 15000}`, 'SupplementaryGroups=kvm cloudphone-web', 'PrivateNetwork=yes',
      'MemoryAccounting=yes', `MemoryMax=${r.hostMemoryMiB * MiB}`, 'MemorySwapMax=0',
      'MemoryOOMGroup=yes', 'OOMPolicy=stop', 'KillMode=control-group', 'TimeoutStopSec=30s',
      'SendSIGKILL=yes', 'Restart=no', 'TasksMax=512', 'LimitCORE=0', 'UMask=0002',
      'ProtectSystem=strict', 'ProtectHome=yes', 'PrivateMounts=yes', 'PrivateTmp=no',
      'NoNewPrivileges=yes', 'CapabilityBoundingSet=', 'RestrictSUIDSGID=yes',
      'ProtectKernelTunables=yes', 'ProtectKernelModules=yes', 'ProtectControlGroups=yes', 'ProtectProc=invisible', 'PrivateIPC=yes',
      'RestrictNamespaces=yes', 'LockPersonality=yes', 'RestrictRealtime=yes',
      'DevicePolicy=closed', 'DeviceAllow=/dev/kvm rw', 'ReadOnlyPaths=/dev', 'RestrictAddressFamilies=AF_UNIX AF_INET AF_INET6 AF_NETLINK',
      `InaccessiblePaths=${this.stateDir} /run`, `BindReadOnlyPaths=${this.sdkDir}`,
      `BindPaths=${p.mount}:${INSIDE} ${p.mount}/tmp:/tmp ${p.mount}/vartmp:/var/tmp ${p.mount}/shm:/dev/shm`,
      `ReadWritePaths=${INSIDE} /tmp /var/tmp /dev/shm`, `WorkingDirectory=${INSIDE}`,
      'StandardOutput=null', 'StandardError=null', 'KeyringMode=private',
    ];
    return ['--quiet', '--unit', p.unit, '--service-type=exec', ...properties.flatMap(v => ['--property', v]),
      '/usr/bin/node', HERE, '--supervise', this.sdkDir, String(r.adbPort), String(r.consolePort), String(r.guestRamMiB), JSON.stringify({ phone: { id: r.id, adbPort: r.adbPort, consolePort: r.consolePort, serial: r.serial }, scrcpyServer: this.scrcpyServer, socketPath: `${INSIDE}/run/stream.sock`, webGid: r.webGid, hostNetNamespace: r.hostNetNamespace, networkMode: 'private', volumeDevice: r.volumeDevice }), r.startToken];
  }
  async verifyLimits(r) {
    const s = await this.unitState(r);
    const group = `/system.slice/${this.paths(r.id).unit}`;
    if (s.PrivateNetwork !== 'yes' || s.ActiveState !== 'active' || s.ControlGroup !== group || s.MemoryMax !== String(r.hostMemoryMiB * MiB) || s.MemorySwapMax !== '0') throw new Error('systemd did not enforce requested limits');
    if (!/^[1-9][0-9]*$/.test(s.MainPID) || await this.io.readlink(`/proc/${s.MainPID}/ns/net`) === await this.io.readlink('/proc/self/ns/net')) throw new Error('Phone private network namespace is not active');
    for (const [file, expected] of [['memory.max', String(r.hostMemoryMiB * MiB)], ['memory.swap.max', '0']]) {
      if ((await this.io.readFile(`/sys/fs/cgroup${group}/${file}`, 'utf8')).trim() !== expected) throw new Error(`Kernel ${file} differs from request`);
    }
  }
  async start(id) {
    return this.mutate(async () => {
      const r = await this.read(id);
      await this.requireCapabilities();
      if (r.status === 'running') {
        const state = await this.unitState(r);
        if (!state.absent) { await this.verifyLimits(r); return publicRecord(r); }
        // Reboot removed transient units. Prove absence of descendants before any storage action.
        await this.assertStopped(r); await this.stopRecord(r);
      }
      if (r.status !== 'stopped') throw new Error('Phone must be stopped before starting (stop recovers interrupted operations)');
      await this.assertStopped(r);
      const identity = await this.command('/usr/bin/getent', ['passwd', String(200000 + r.adbPort - 15000)], true);
      if (identity.code !== 2 || identity.stdout.trim()) throw new Error('Reserved service UID conflicts with an existing host account');
      const groupIdentity = await this.command('/usr/bin/getent', ['group', String(200000 + r.adbPort - 15000)], true);
      if (groupIdentity.code !== 2 || groupIdentity.stdout.trim()) throw new Error('Reserved service GID conflicts with an existing host group');
      const usage = await hostUsage(this.stateDir, await this.records(), this.io);
      if (usage.memoryAvailableBytes - usage.memoryReserveBytes < r.hostMemoryMiB * MiB) throw new Error('Insufficient available host memory');
      r.webGid = await this.webGroup();
      r.hostNetNamespace = await this.io.readlink('/proc/self/ns/net');
      r.status = 'starting'; r.startToken = randomBytes(16).toString('hex'); await this.save(r);
      try {
        await this.assertHostMountNamespace();
        await this.attach(r); await this.prepare(r);
        r.volumeDevice = String((await this.io.stat(this.paths(id).mount)).dev);
        await this.save(r);
        await this.command(C.systemctl, ['reset-failed', this.paths(id).unit], true);
        await this.command(C.run, this.serviceArgs(r));
        await this.verifyLimits(r);
        await this.waitReady(r);
        r.status = 'running'; await this.save(r); return publicRecord(r);
      } catch (error) {
        // Stop on any ambiguous start or enforcement failure. Never detach without proof.
        try { const state = await this.unitState(r); if (!state.absent) await this.command(C.systemctl, ['stop', this.paths(id).unit]); await this.assertStopped(r); }
        catch (stopError) { r.cleanupError = stopError.message; }
        r.status = 'error'; r.lastError = error.message; await this.save(r); throw error;
      }
    });
  }
  async waitReady(r) {
    const ready = path.join(this.paths(r.id).mount, 'run', 'ready');
    for (let attempt = 0; attempt < 400; attempt++) {
      await this.verifyLimits(r);
      try {
        const st = await this.io.lstat(ready);
        if (!st.isFile() || st.isSymbolicLink() || st.size > 64) throw new Error('Unsafe readiness file');
        if ((await this.io.readFile(ready, 'utf8')).trim() === r.startToken) return;
      } catch (error) { if (error.code !== 'ENOENT') throw error; }
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    throw new Error('Phone supervisor failed readiness handshake');
  }
  async detach(r) {
    await this.assertHostMountNamespace();
    await this.assertStopped(r);
    const p = this.paths(r.id);
    const mounted = await this.mounted(r);
    const loop = await this.loopInfo(r);
    if (mounted) {
      await this.command(C.umount, ['--', p.mount]);
      if (await this.mounted(r)) throw new Error('Volume remains mounted');
    }
    if (loop) {
      if (await this.loopInfo(r) !== loop) throw new Error('Loop changed before detach');
      const users = await this.command(C.findmnt, ['--json', '--source', loop, '--output', 'TARGET'], true);
      if (users.code !== 1 || users.stdout.trim()) throw new Error('Loop still has mount users or mount ownership is ambiguous');
      await this.command(C.loop, ['--detach', loop]);
      if (await this.loopInfo(r)) throw new Error('Loop remains attached');
    }
    r.loop = null;
  }
  async stopRecord(r) {
    r.status = 'stopping'; await this.save(r);
    try {
      const s = await this.unitState(r);
      if (!s.absent) await this.command(C.systemctl, ['stop', this.paths(r.id).unit]);
      await this.assertStopped(r); await this.detach(r);
      r.status = 'stopped'; delete r.lastError; await this.save(r); return publicRecord(r);
    } catch (error) { r.status = 'error'; r.lastError = error.message; await this.save(r); throw error; }
  }
  async stop(id) { return this.mutate(async () => this.stopRecord(await this.read(id))); }
  async delete(id) {
    return this.mutate(async () => {
      const r = await this.read(id); await this.stopRecord(r);
      r.status = 'deleting'; await this.save(r);
      await this.assertStopped(r);
      if (await this.mounted(r) || await this.loopInfo(r)) throw new Error('Refusing deletion of attached storage');
      const p = this.paths(id);
      // Do not recursively traverse an instance tree: rmdir refuses any residual mounts/files.
      await this.io.rmdir(p.mount);
      try {
        const s = await this.io.lstat(p.image);
        if (!s.isFile() || s.isSymbolicLink() || s.nlink !== 1) throw new Error('Unsafe image cleanup');
        await this.io.unlink(p.image);
      } catch (error) { if (error.code !== 'ENOENT') throw error; }
      await this.io.unlink(p.record); await this.io.rmdir(p.dir);
      return { id, deleted: true };
    });
  }
}

/** Invoked only by systemd in the sandbox. No shell; children share its memory cgroup.
 * Exit of either child terminates its peer; systemd KillMode also kills all descendants.
 */
async function supervise(sdk, adbPort, consolePort, ram, workerJSON, token) {
  safePath(sdk, 'SDK');
  if (!/^[a-f0-9]{32}$/.test(token) || ![adbPort, consolePort, ram].every(x => /^\d+$/.test(x))) throw new Error('Invalid supervisor arguments');
  const workerConfig = JSON.parse(workerJSON);
  if (!ID_RE.test(workerConfig.phone?.id) || !/^[0-9]+$/.test(workerConfig.volumeDevice)) throw new Error('Invalid worker contract');
  const volume = await fs.stat(INSIDE); const filesystem = await fs.statfs(INSIDE);
  if (String(volume.dev) !== workerConfig.volumeDevice || Number(filesystem.type) !== 0xef53 || await fs.readlink('/proc/self/ns/net') === workerConfig.hostNetNamespace) throw new Error('Phone namespace/volume isolation mismatch');
  for (const writable of [INSIDE, '/tmp', '/var/tmp', '/dev/shm', `${INSIDE}/home`, `${INSIDE}/logs`, `${INSIDE}/run`, `${INSIDE}/avd`]) {
    if (String((await fs.stat(writable)).dev) !== workerConfig.volumeDevice) throw new Error('Writable path outside phone disk budget');
  }
  const { volumeDevice, ...workerOptions } = workerConfig;
  const env = { ...process.env, CLOUDPHONE_WORKER_CONFIG: JSON.stringify(workerOptions), HOME: `${INSIDE}/home`, TMPDIR: '/tmp', TMP: '/tmp', TEMP: '/tmp',
    XDG_CACHE_HOME: `${INSIDE}/home/.cache`, XDG_CONFIG_HOME: `${INSIDE}/home/.config`,
    XDG_DATA_HOME: `${INSIDE}/home/.local/share`, XDG_RUNTIME_DIR: `${INSIDE}/run`,
    ANDROID_HOME: sdk, ANDROID_SDK_ROOT: sdk, ANDROID_AVD_HOME: `${INSIDE}/avd`,
    ANDROID_EMULATOR_HOME: `${INSIDE}/home`, ANDROID_USER_HOME: `${INSIDE}/home/.android`,
    ANDROID_ADB_SERVER_PORT: adbPort, ADB_SERVER_SOCKET: `tcp:127.0.0.1:${adbPort}`,
  };
  const handles = []; const children = []; let stopping = false;
  const stop = () => { if (stopping) return; stopping = true; for (const c of children) c.kill('SIGTERM'); setTimeout(() => process.exit(1), 25000).unref(); };
  process.on('SIGTERM', stop); process.on('SIGINT', stop);
  const launch = async (name, exe, args) => {
    const log = await fs.open(`${INSIDE}/logs/${name}.log`, 'a', 0o600); handles.push(log);
    const child = spawn(exe, args, { env, cwd: INSIDE, stdio: ['ignore', log.fd, log.fd], shell: false });
    children.push(child); child.once('error', stop); child.once('exit', stop);
    return child;
  };
  try {
  // Refuse a port already serving someone else's adb; do not send kill-server to it.
  await new Promise((resolve, reject) => {
    const server = net.createServer(); server.once('error', reject);
    server.listen(Number(adbPort), '127.0.0.1', () => server.close(resolve));
  });
  const adb = await launch('adb', `${sdk}/platform-tools/adb`, ['-L', `tcp:127.0.0.1:${adbPort}`, 'server', 'nodaemon']);
  let ready = false;
  for (let i = 0; i < 100 && !stopping; i++) {
    ready = await new Promise(resolve => { const s = net.connect({ host: '127.0.0.1', port: Number(adbPort) }); s.once('connect', () => { s.destroy(); resolve(true); }); s.once('error', () => resolve(false)); });
    if (ready) break;
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  if (!ready || stopping || adb.exitCode !== null) { stop(); throw new Error('Dedicated adb failed to start'); }
  await launch('emulator', `${sdk}/emulator/emulator`, [
    '-avd', 'phone', '-no-window', '-no-audio', '-no-boot-anim', '-no-snapshot',
    '-gpu', 'swiftshader_indirect', '-accel', 'on', '-memory', ram,
    '-ports', `${consolePort},${Number(consolePort) + 1}`, '-no-metrics', '-netfast',
  ]);
  let emulatorReady = false;
  for (let attempt = 0; attempt < 70 && !stopping; attempt++) {
    emulatorReady = await new Promise(resolve => { const socket = net.connect({ host: '127.0.0.1', port: Number(consolePort) + 1 }); socket.once('connect', () => { socket.destroy(); resolve(true); }); socket.once('error', () => resolve(false)); });
    if (emulatorReady) break;
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  if (!emulatorReady) throw new Error('Emulator transport not ready');
  if (stopping || children.some(c => c.exitCode !== null)) throw new Error('Phone child exited before readiness');
  await launch('worker', '/usr/bin/node', [WORKER]);
  let workerReady = false;
  for (let attempt = 0; attempt < 100 && !stopping; attempt++) {
    try { const socket = await fs.lstat(`${INSIDE}/run/stream.sock`); if (!socket.isSocket() || socket.isSymbolicLink()) throw new Error('Invalid worker socket'); workerReady = true; break; }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  if (!workerReady || stopping) throw new Error('Stream worker failed readiness');
  const readyHandle = await fs.open(`${INSIDE}/run/ready`, F.O_WRONLY | F.O_CREAT | F.O_TRUNC | F.O_NOFOLLOW, 0o600);
  try { await readyHandle.writeFile(token); } finally { await readyHandle.close(); }
  await Promise.all(children.map(c => c.exitCode !== null ? Promise.resolve() : new Promise(resolve => c.once('exit', resolve))));
  } finally {
    stop();
    for (const h of handles) await h.close();
    // Even if a child ignores SIGTERM, systemd will kill the entire cgroup on exit.
    setTimeout(() => process.exit(1), 1000);
  }
  process.exitCode = 1;
}
if (process.argv[1] && path.resolve(process.argv[1]) === HERE && process.argv[2] === '--supervise') {
  supervise(...process.argv.slice(3)).catch(() => { process.exitCode = 1; });
}
