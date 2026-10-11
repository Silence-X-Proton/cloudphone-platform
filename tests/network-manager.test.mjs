import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { createNetworkManager } from '../lib/network-manager.mjs';
const input = { id: 'a'.repeat(16), mainPid: 100, memoryBytes: 134217728 };
const evidence = () => ({ ready: true, id: input.id, mainPid: 100, mainStarttime: '11',
  monitorPid: 200, monitorStarttime: '12', launcherPid: 201, launcherStarttime: '13',
  helperPid: 202, helperStarttime: '14', cgroup: `/system.slice/cloudphone-${input.id}.service`,
  dns: ['1.1.1.1', '9.9.9.9'], firewallDigest: 'b'.repeat(64) });
function fixture(action, options = {}) {
  const calls = [];
  const manager = createNetworkManager({ timeoutMs: 100, ...options, spawnProcess: (exe, args, settings) => {
    const child = new EventEmitter();
    Object.assign(child, { pid: 200, exitCode: null, signalCode: null, stdout: new PassThrough(), kills: [], unrefs: 0 });
    child.kill = signal => { child.kills.push(signal); return true; };
    child.unref = () => { child.unrefs++; };
    child.close = (code = 0, signal = null) => { child.exitCode = code; child.signalCode = signal; child.emit('close', code, signal); };
    calls.push({ exe, args, settings, child });
    queueMicrotask(() => action(child));
    return child;
  } });
  return { manager, calls };
}
test('start accepts split readiness, binds spawned PID, detaches without killing monitor', async () => {
  const { manager, calls } = fixture(c => { const json = JSON.stringify(evidence()); c.stdout.write(json.slice(0, 30)); c.stdout.write(json.slice(30) + '\n'); });
  const result = await manager.startNetwork({ ...input, mainPid: '100' });
  assert.deepEqual(result, evidence()); assert.ok(Object.isFrozen(result)); assert.ok(Object.isFrozen(result.dns));
  const { exe, args, settings, child } = calls[0];
  assert.equal(exe, '/usr/bin/python3'); assert.match(args[0], /scripts\/phone-network\.py$/);
  assert.deepEqual(args.slice(1), ['start', input.id, '100', '134217728']);
  assert.equal(settings.detached, true); assert.equal(settings.shell, false);
  assert.deepEqual(settings.stdio, ['ignore', 'pipe', 'ignore']);
  assert.equal(child.unrefs, 1); assert.equal(child.stdout.destroyed, true); assert.deepEqual(child.kills, []);
  child.emit('error', new Error('late error')); child.close(1);
  assert.deepEqual(child.kills, []);
});
test('verify reconnect invokes only read-only verify and returns exactly three PIDs', async () => {
  const { manager, calls } = fixture(c => { c.stdout.end(JSON.stringify(evidence()) + '\n'); c.close(); });
  assert.deepEqual(await manager.verifyNetwork(input, evidence()), [200, 201, 202]);
  assert.equal(calls.length, 1); assert.equal(calls[0].args[1], 'verify');
  assert.equal(calls[0].settings.detached, false); assert.deepEqual(calls[0].child.kills, []);
});
test('stop invokes cleanup once and never kills existing monitor', async () => {
  const { manager, calls } = fixture(c => c.close());
  assert.equal(await manager.stopNetwork(input.id), undefined);
  assert.deepEqual(calls[0].args.slice(1), ['stop', input.id]); assert.deepEqual(calls[0].child.kills, []);
});
test('invalid contracts/evidence fail before spawning', async () => {
  const { manager, calls } = fixture(() => {});
  for (const invalid of [{ ...input, id: '../x' }, { ...input, mainPid: 0 }, { ...input, mainPid: '01' }, { ...input, memoryBytes: '128' }]) await assert.rejects(manager.startNetwork(invalid));
  for (const change of [{ ready: false }, { extra: true }, { helperPid: 200 }, { mainPid: 999 }, { dns: ['127.0.0.1'] }, { firewallDigest: 'x' }, { mainStarttime: 1 }]) await assert.rejects(manager.verifyNetwork(input, { ...evidence(), ...change }));
  await assert.rejects(manager.stopNetwork('../x')); assert.equal(calls.length, 0);
});
test('malformed, multiline, invalid UTF8, oversized and wrong-PID readiness kill pending start once', async () => {
  for (const output of ['bad\n', JSON.stringify(evidence()) + '\n{}\n', Buffer.from([255, 10]), ' '.repeat(8193), JSON.stringify({ ...evidence(), monitorPid: 300 }) + '\n']) {
    const { manager, calls } = fixture(c => c.stdout.write(output));
    await assert.rejects(manager.startNetwork(input));
    assert.deepEqual(calls[0].child.kills, ['SIGKILL']); assert.equal(calls.length, 1);
  }
});
test('start deadline and early exit fail without mutation retries', async () => {
  const pending = fixture(() => {}, { timeoutMs: 10 });
  await assert.rejects(pending.manager.startNetwork(input), /deadline/);
  assert.deepEqual(pending.calls[0].child.kills, ['SIGKILL']); assert.equal(pending.calls.length, 1);
  const exited = fixture(c => c.close(1));
  await assert.rejects(exited.manager.startNetwork(input), /exited/);
  assert.deepEqual(exited.calls[0].child.kills, []);
});
test('verify requires exit0 and exact unchanged evidence, never kills saved helper PIDs', async () => {
  for (const [output, code] of [[JSON.stringify(evidence()), 1], [JSON.stringify({ ...evidence(), helperStarttime: '999' }), 0], ['{}', 0], [' '.repeat(8193), 0]]) {
    const { manager, calls } = fixture(c => { c.stdout.write(output); c.close(code); });
    await assert.rejects(manager.verifyNetwork(input, evidence()));
    assert.equal(calls.length, 1); assert.equal(calls[0].args[1], 'verify');
  }
});
test('spawn error and cleanup failure reject', async () => {
  const failed = fixture(c => c.emit('error', new Error('spawn failed')));
  await assert.rejects(failed.manager.startNetwork(input), /spawn failed/);
  const cleanup = fixture(c => c.close(1));
  await assert.rejects(cleanup.manager.stopNetwork(input.id), /exited/);
  const extra = fixture(c => { c.stdout.write('unexpected'); c.close(); });
  await assert.rejects(extra.manager.stopNetwork(input.id), /Unexpected/);
});
function safeIO(change = () => ({})) {
  return { lstat: async p => ({ uid: 0, mode: 0o755, isFile: () => true, isSymbolicLink: () => false, ...change(p) }),
    realpath: async p => p, access: async () => {} };
}
test('prerequisites are read-only immutable artifact checks, not online success', async () => {
  const manager = createNetworkManager({ io: safeIO(), spawnProcess: () => { throw new Error('must not execute'); } });
  const result = await manager.networkPrerequisites();
  assert.equal(result.ok, true); assert.ok(result.artifacts.includes('/usr/bin/slirp4netns'));
  assert.ok(result.artifacts.includes('/usr/lib/x86_64-linux-gnu/libseccomp.so.2'));
  for (const change of [{ uid: 1000 }, { mode: 0o777 }]) {
    await assert.rejects(createNetworkManager({ io: safeIO(p => p === '/usr' ? change : {}) }).networkPrerequisites(), /Unsafe/);
  }
  await assert.rejects(createNetworkManager({ io: { ...safeIO(), access: async () => { throw new Error('missing'); } } }).networkPrerequisites(), /missing/);
});
