import net from 'node:net';
import fs from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { assertProcessBoundary } from './runtime-attestation.mjs';
const helper = fileURLToPath(new URL('../scripts/socket-peer.py', import.meta.url));
const worker = fileURLToPath(new URL('./phone-worker.mjs', import.meta.url));

export async function socketCredentials(socket) {
  const fd = socket._handle?.fd;
  if (!Number.isInteger(fd) || fd < 0) throw new Error('Connected Unix descriptor unavailable');
  return new Promise((resolve, reject) => {
    const child = spawn('/usr/bin/python3', [helper], { stdio: ['ignore', 'pipe', 'ignore', fd], env: { PATH: '/usr/bin:/bin' } });
    let text = '', settled = false;
    const finish = (error, value) => { if (settled) return; settled = true; clearTimeout(timer); if (error) { child.kill('SIGKILL'); reject(error); } else resolve(value); };
    const timer = setTimeout(() => finish(new Error('Unix credential timeout')), 3000);
    child.on('error', finish);
    child.stdout.on('data', data => { text += data; if (text.length > 256) finish(new Error('Invalid Unix credentials')); });
    child.on('close', code => {
      try {
        if (code !== 0) throw new Error('Unix peer credential query failed');
        const values = JSON.parse(text);
        if (!['pid', 'uid', 'gid'].every(k => Number.isSafeInteger(values[k]) && values[k] >= (k === 'pid' ? 1 : 0))) throw new Error('Invalid Unix credentials');
        finish(null, values);
      } catch (error) { finish(error); }
    });
  });
}

export async function verifyWorkerPeer(manager, id, socket) {
  const credentials = await socketCredentials(socket);
  const record = await manager.read(id);
  await manager.verifyLimits(record);
  const unit = await manager.unitState(record);
  const uid = 200000 + record.adbPort - 15000;
  if (credentials.uid !== uid || credentials.gid !== uid) throw new Error('Connected worker identity mismatch');
  const boundary = await assertProcessBoundary({ id, pid: credentials.pid, uid,
    memoryBytes: record.hostMemoryMiB * 1024 ** 2, hostNetNamespace: await fs.readlink('/proc/self/ns/net') });
  const args = (await fs.readFile(`/proc/${credentials.pid}/cmdline`, 'utf8')).split('\0');
  if (args[0] !== '/usr/bin/node' || args[1] !== worker) throw new Error('Connected peer is not the installed worker');
  let pid = credentials.pid;
  const seen = new Set();
  while (String(pid) !== unit.MainPID) {
    if (seen.has(pid) || seen.size >= 16) throw new Error('Worker supervisor ancestry invalid');
    seen.add(pid);
    const status = await fs.readFile(`/proc/${pid}/status`, 'utf8');
    pid = Number(/^PPid:\s+(\d+)$/m.exec(status)?.[1]);
    if (!Number.isSafeInteger(pid) || pid <= 1) throw new Error('Worker is not a supervisor descendant');
  }
  const after = await assertProcessBoundary({ id, pid: credentials.pid, uid,
    memoryBytes: record.hostMemoryMiB * 1024 ** 2, hostNetNamespace: await fs.readlink('/proc/self/ns/net') });
  if (after.starttime !== boundary.starttime || socket.destroyed) throw new Error('Connected worker changed during verification');
  return boundary;
}

export async function connectWorker(path, verify) {
  const socket = net.createConnection({ path });
  socket.on('error', () => {});
  const timeout = setTimeout(() => socket.destroy(new Error('Worker connect timeout')), 5000);
  try {
    await new Promise((resolve, reject) => { socket.once('connect', resolve); socket.once('error', reject); });
    socket.pause();
    await verify(socket);
    if (socket.destroyed) throw new Error('Worker disconnected');
    return socket;
  } catch (error) { socket.destroy(); throw error; }
  finally { clearTimeout(timeout); }
}
