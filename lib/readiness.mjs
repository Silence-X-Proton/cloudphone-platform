import fs from 'node:fs/promises';
import { constants as F } from 'node:fs';
import path from 'node:path';

const DIR = F.O_RDONLY | F.O_DIRECTORY | F.O_NOFOLLOW | F.O_NONBLOCK;
const FILE = F.O_RDONLY | F.O_NOFOLLOW | F.O_NONBLOCK;
const MAX_BYTES = 34; // 32-byte ASCII token, optional LF, one overflow byte.

/** Linux-only; /proc must be the trusted kernel procfs in the root broker.
 * Every path component is opened relative to a pinned directory descriptor.
 * The intentional /proc/self/fd magic link names OUR held descriptor; each
 * appended component uses O_NOFOLLOW, never an untrusted compound pathname.
 * io injection is trusted test glue only. No unbounded readFile or polling here.
 * Returns false for incomplete/mismatched tokens; ENOENT propagates for polling.
 * Unsafe directories/inodes and overflow throw. This is a bounded observation,
 * not an immutable attestation against a phone that controls its own ready file.
 */
export async function readReadyToken({ stateDir, id, volumeDevice, uid, token }, { io = fs } = {}) {
  if (typeof stateDir !== 'string' || !/^\/[A-Za-z0-9_./-]+$/.test(stateDir) ||
      stateDir === '/' || stateDir.length > 4096 || path.normalize(stateDir) !== stateDir ||
      !/^[a-f0-9]{16}$/.test(id ?? '') || typeof id !== 'string' ||
      !Number.isSafeInteger(uid) || uid < 1 ||
      !['string', 'number', 'bigint'].includes(typeof volumeDevice) || !/^\d+$/.test(String(volumeDevice)) ||
      typeof token !== 'string' || !/^[a-f0-9]{32}$/.test(token)) throw new Error('Invalid readiness contract');
  const handles = [];
  const open = async (filename, flags) => {
    const h = await io.open(filename, flags); handles.push(h); return h;
  };
  const directory = async (h, owner, onVolume = false) => {
    const st = await h.stat();
    if (!st.isDirectory() || st.uid !== owner || (st.mode & 0o022) ||
        (onVolume && String(st.dev) !== String(volumeDevice))) throw new Error('Unsafe readiness directory');
  };
  const fileStat = async h => {
    const st = await h.stat();
    if (!st.isFile() || st.uid !== uid || st.nlink !== 1 || (st.mode & 0o022) ||
        String(st.dev) !== String(volumeDevice) || st.size > MAX_BYTES - 1 || st.size < 0) throw new Error('Unsafe readiness file');
    return st;
  };
  try {
    let dir = await open('/', DIR); await directory(dir, 0);
    for (const name of [...stateDir.slice(1).split('/'), id, 'volume']) {
      dir = await open(`/proc/self/fd/${dir.fd}/${name}`, DIR);
      await directory(dir, 0);
    }
    await directory(dir, 0, true); // Final volume, not an ancestor named volume.
    dir = await open(`/proc/self/fd/${dir.fd}/run`, DIR);
    await directory(dir, uid, true);
    const file = await open(`/proc/self/fd/${dir.fd}/ready`, FILE);
    await fileStat(file);
    const bytes = Buffer.alloc(MAX_BYTES);
    let used = 0;
    while (used < bytes.length) {
      const { bytesRead } = await file.read(bytes, used, bytes.length - used, used);
      if (!Number.isInteger(bytesRead) || bytesRead < 0 || bytesRead > bytes.length - used) throw new Error('Invalid readiness read');
      if (bytesRead === 0) break;
      used += bytesRead;
    }
    const after = await fileStat(file);
    if (used === MAX_BYTES) throw new Error('Readiness token overflow');
    if (after.size !== used) return false; // Concurrent/incomplete write; retry later.
    return bytes.subarray(0, used).equals(Buffer.from(token)) || bytes.subarray(0, used).equals(Buffer.from(token + '\n'));
  } finally {
    // Close all handles even if one close fails; never leave tenant-controlled FDs.
    const results = await Promise.allSettled(handles.reverse().map(h => h.close()));
    const failed = results.find(result => result.status === 'rejected');
    if (failed) throw failed.reason;
  }
}
