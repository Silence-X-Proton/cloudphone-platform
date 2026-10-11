import fs from 'node:fs/promises';
import { constants as F } from 'node:fs';

// Live kernel observations, not a stored boolean/certificate and not a release
// gate. Call before children start and independently from the root manager.
// These checks do not authenticate a Unix peer or prove whole-host accounting.
export async function assertProcessBoundary({ id, pid = 'self', uid, memoryBytes, hostNetNamespace }, { io = fs } = {}) {
  if (!/^[a-f0-9]{16}$/.test(id) || !(pid === 'self' || /^[1-9][0-9]*$/.test(String(pid))) ||
      !Number.isSafeInteger(uid) || uid < 1 || !Number.isSafeInteger(memoryBytes) || memoryBytes < 1 ||
      !/^net:\[[0-9]+\]$/.test(hostNetNamespace ?? '')) throw new Error('Invalid process boundary contract');
  const group = `/system.slice/cloudphone-${id}.service`;
  const base = `/proc/${pid}`;
  const before = await io.readFile(`${base}/stat`, 'utf8');
  const identity = text => {
    const end = text.lastIndexOf(')');
    const fields = text.slice(end + 2).trim().split(/\s+/);
    if (end < 0 || !/^[0-9]+$/.test(fields[19] ?? '')) throw new Error('Invalid process identity');
    return fields[19]; // starttime: field 22, state is field 3
  };
  const starttime = identity(before);
  const status = await io.readFile(`${base}/status`, 'utf8');
  const uids = /^Uid:\s+(\d+)\s+(\d+)\s+(\d+)\s+(\d+)$/m.exec(status);
  if (!uids || uids.slice(1).some(value => Number(value) !== uid)) throw new Error('Process UID boundary mismatch');
  if ((await io.readFile(`${base}/cgroup`, 'utf8')).trim() !== `0::${group}`) throw new Error('Process outside phone cgroup');
  for (const [file, value] of [['memory.max', String(memoryBytes)], ['memory.swap.max', '0']]) {
    if ((await io.readFile(`/sys/fs/cgroup${group}/${file}`, 'utf8')).trim() !== value) throw new Error(`Process ${file} boundary mismatch`);
  }
  const net = await io.readlink(`${base}/ns/net`);
  if (!/^net:\[[0-9]+\]$/.test(net) || net === hostNetNamespace) throw new Error('Process private network boundary mismatch');
  if (identity(await io.readFile(`${base}/stat`, 'utf8')) !== starttime) throw new Error('Process identity changed during attestation');
  return Object.freeze({ pid: String(pid), starttime, group, net, uid });
}

// O_NONBLOCK prevents FIFO hangs; no following tenant symlinks. fstat validates
// the descriptor actually given to the child rather than only its parent path.
export async function openBudgetLog(filename, volumeDevice, { io = fs } = {}) {
  const handle = await io.open(filename, F.O_WRONLY | F.O_APPEND | F.O_CREAT | F.O_NOFOLLOW | F.O_NONBLOCK, 0o600);
  try {
    const st = await handle.stat();
    if (!st.isFile() || st.nlink !== 1 || String(st.dev) !== String(volumeDevice)) throw new Error('Unsafe log outside exclusive phone disk inode');
    return handle;
  } catch (error) { await handle.close(); throw error; }
}
