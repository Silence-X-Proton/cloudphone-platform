import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { constants as F } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { readReadyToken } from '../lib/readiness.mjs';
const base = fileURLToPath(new URL('../', import.meta.url));
const root = { skip: process.getuid?.() !== 0 ? 'Real UID/ownership checks require root' : false };
async function fixture(t) {
  const stateDir = await fs.mkdtemp(path.join(base, '.readiness-test-'));
  t.after(() => fs.rm(stateDir, { recursive: true, force: true }));
  const id = 'a'.repeat(16), uid = 200030, token = 'b'.repeat(32);
  const volume = path.join(stateDir, id, 'volume'), run = path.join(volume, 'run'), ready = path.join(run, 'ready');
  await fs.mkdir(run, { recursive: true, mode: 0o700 });
  await fs.chown(run, uid, uid);
  const write = async text => { await fs.writeFile(ready, text, { mode: 0o600 }); await fs.chown(ready, uid, uid); };
  await write(token);
  return { stateDir, id, uid, token, volumeDevice: String((await fs.stat(volume)).dev), volume, run, ready, write };
}
function observingIO(hook = {}) {
  const handles = []; let readBytes = 0;
  const io = { open: async (name, flags) => {
    assert.ok(flags & F.O_NOFOLLOW); assert.ok(flags & F.O_NONBLOCK);
    const h = await fs.open(name, flags); handles.push(h);
    await hook.open?.(name, h);
    let stats = 0;
    return { fd: h.fd, close: () => h.close(), stat: async () => {
      const st = await h.stat(); await hook.stat?.(name, h, ++stats); return st;
    }, read: async (...args) => {
      await hook.read?.(name, h);
      const result = await h.read(...args); readBytes += result.bytesRead;
      assert.ok(readBytes <= 34); return result;
    } };
  } };
  return { io, handles, get readBytes() { return readBytes; } };
}
async function closed(observed) { for (const h of observed.handles) assert.equal(h.fd, -1); }

test('exact token and optional newline accepted; missing/incomplete/mismatch handled', root, async t => {
  const f = await fixture(t);
  for (const [text, expected] of [[f.token, true], [f.token+'\n', true], ['', false], ['b'.repeat(31), false], ['c'.repeat(32), false], [' '+f.token, false]]) {
    await f.write(text); assert.equal(await readReadyToken(f), expected);
  }
  await fs.unlink(f.ready); await assert.rejects(readReadyToken(f), { code: 'ENOENT' });
});
test('symlink, FIFO, hardlink, directory, wrong UID/device and oversized file refused', root, async t => {
  const f = await fixture(t);
  await assert.rejects(readReadyToken({ ...f, uid: f.uid+1 }), /Unsafe/);
  await assert.rejects(readReadyToken({ ...f, volumeDevice: '0' }), /Unsafe/);
  await f.write('x'.repeat(4096)); await assert.rejects(readReadyToken(f), /Unsafe/);
  await fs.unlink(f.ready); await fs.symlink('/dev/zero', f.ready);
  await assert.rejects(readReadyToken(f));
  await fs.unlink(f.ready); execFileSync('/usr/bin/mkfifo', [f.ready]);
  const start = performance.now(); await assert.rejects(readReadyToken(f), /Unsafe/);
  assert.ok(performance.now()-start < 2000, 'FIFO must not block');
  await fs.unlink(f.ready); await fs.mkdir(f.ready); await assert.rejects(readReadyToken(f), /Unsafe/);
  await fs.rmdir(f.ready); await f.write(f.token); await fs.link(f.ready, path.join(f.run, 'alias'));
  await assert.rejects(readReadyToken(f), /Unsafe/);
});
test('directory symlinks and writable trusted ancestors refused', root, async t => {
  const f = await fixture(t);
  await fs.rename(f.run, f.run+'-saved'); await fs.symlink(f.run+'-saved', f.run);
  await assert.rejects(readReadyToken(f));
  await fs.unlink(f.run); await fs.rename(f.run+'-saved', f.run);
  await fs.chmod(f.stateDir, 0o777); await assert.rejects(readReadyToken(f), /Unsafe/);
  await fs.chmod(f.stateDir, 0o700);
  await fs.chmod(f.run, 0o777); await assert.rejects(readReadyToken(f), /Unsafe/);
});
test('ready swapped to symlink after open never redirects pinned file read', root, async t => {
  const f = await fixture(t); let swapped = false;
  const seen = observingIO({ stat: async (name, _h, n) => {
    if (name.endsWith('/ready') && n === 1) {
      await fs.rename(f.ready, f.ready+'-saved'); await fs.symlink('/dev/zero', f.ready); swapped = true;
    }
  } });
  assert.equal(await readReadyToken(f, { io: seen.io }), true);
  assert.ok(swapped); assert.equal(seen.readBytes, 32); await closed(seen);
});
test('run replacement after directory open cannot redirect subsequent ready lookup', root, async t => {
  const f = await fixture(t);
  const seen = observingIO({ open: async name => {
    if (name.endsWith('/run')) {
      await fs.rename(f.run, f.run+'-saved'); await fs.mkdir(f.run, { mode: 0o700 });
      await fs.chown(f.run, f.uid, f.uid); await fs.symlink('/dev/zero', f.ready);
    }
  } });
  assert.equal(await readReadyToken(f, { io: seen.io }), true);
  assert.equal(seen.readBytes, 32); await closed(seen);
});
test('in-place growth after fstat is capped at34 bytes and rejected; all FDs closed', root, async t => {
  const f = await fixture(t);
  const seen = observingIO({ stat: async (name, _h, n) => {
    if (name.endsWith('/ready') && n === 1) await fs.appendFile(f.ready, 'x'.repeat(4096));
  } });
  await assert.rejects(readReadyToken(f, { io: seen.io }), /Unsafe|overflow/);
  assert.equal(seen.readBytes, 34); await closed(seen);
});
test('file substitution before open is rejected and releases directory descriptors', root, async t => {
  const f = await fixture(t);
  const seen = observingIO({ stat: async name => {
    if (name.endsWith('/run')) { await fs.unlink(f.ready); await fs.symlink('/dev/zero', f.ready); }
  } });
  await assert.rejects(readReadyToken(f, { io: seen.io }));
  assert.equal(seen.readBytes, 0); await closed(seen);
});
test('invalid contracts fail before any IO', async () => {
  const good = { stateDir: '/var/lib/test', id: 'a'.repeat(16), uid: 200030, token: 'b'.repeat(32), volumeDevice: '123' };
  for (const invalid of [{ stateDir: '/var/../tmp' }, { id: '../etc' }, { token: 'short' }, { uid: 0 }, { volumeDevice: '-1' }]) {
    await assert.rejects(readReadyToken({ ...good, ...invalid }, { io: { open: () => assert.fail('unexpected IO') } }), /Invalid/);
  }
});
