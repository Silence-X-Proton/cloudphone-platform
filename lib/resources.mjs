import fs from 'node:fs/promises';

export const MiB = 1024 ** 2;
export const GiB = 1024 ** 3;
export const MEMORY_RESERVE_MIB = 2048;
export const DISK_RESERVE_GIB = 10;

export function parseMeminfo(text) {
  const values = Object.fromEntries([...text.matchAll(/^(MemTotal|MemAvailable):\s+(\d+) kB$/gm)]
    .map(([, key, value]) => [key, Number(value) * 1024]));
  if (!Number.isSafeInteger(values.MemTotal) || values.MemTotal <= 0 || !Number.isSafeInteger(values.MemAvailable) || values.MemAvailable < 0 || values.MemAvailable > values.MemTotal) throw new Error('Cannot determine host memory');
  return values;
}

/** Host-level readings, not Android guest RAM. Existing allocated images already reduce free disk. */
export async function hostUsage(stateDir, records = [], io = fs) {
  const mem = parseMeminfo(await io.readFile('/proc/meminfo', 'utf8'));
  const disk = await io.statfs(stateDir);
  const diskTotalBytes = Number(disk.blocks) * Number(disk.bsize);
  const diskAvailableBytes = Number(disk.bavail) * Number(disk.bsize);
  if (![diskTotalBytes, diskAvailableBytes].every(Number.isSafeInteger) || diskTotalBytes <= 0 || diskAvailableBytes < 0 || diskAvailableBytes > diskTotalBytes) throw new Error('Cannot determine host disk');
  const reservedMemoryBytes = records.reduce((sum, r) => sum + r.hostMemoryMiB * MiB, 0);
  const diskCommittedBytes = records.reduce((sum, r) => sum + r.diskGiB * GiB, 0);
  const memoryReserveBytes = Math.max(MEMORY_RESERVE_MIB * MiB, Math.ceil(mem.MemTotal * 0.1));
  const diskReserveBytes = Math.max(DISK_RESERVE_GIB * GiB, Math.ceil(diskTotalBytes * 0.05));
  return {
    memoryTotalBytes: mem.MemTotal, memoryAvailableBytes: mem.MemAvailable,
    memoryReservedBytes: reservedMemoryBytes, memoryReserveBytes,
    memoryAllocatableBytes: Math.max(0, Math.min(mem.MemAvailable - memoryReserveBytes,
      mem.MemTotal - reservedMemoryBytes - memoryReserveBytes)),
    diskTotalBytes, diskAvailableBytes, diskCommittedBytes, diskReserveBytes,
    diskAllocatableBytes: Math.max(0, diskAvailableBytes - diskReserveBytes),
    phoneCount: records.length,
  };
}

export function validateRequest(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input) ||
      Object.keys(input).some(k => !['name', 'guestRamMiB', 'hostMemoryMiB', 'diskGiB'].includes(k))) {
    throw new Error('Only name, guestRamMiB, hostMemoryMiB and diskGiB are accepted');
  }
  const { name, guestRamMiB, hostMemoryMiB, diskGiB } = input;
  if (typeof name !== 'string' || !name.trim() || name.length > 80 || [...name].some(c => c.charCodeAt(0) < 32 || c.charCodeAt(0) === 127)) throw new Error('Invalid phone name');
  if (!Number.isInteger(guestRamMiB) || guestRamMiB < 2560 || guestRamMiB > 65536) throw new Error('guestRamMiB must be 2560..65536 (pinned API36 emulator minimum)');
  if (!Number.isInteger(hostMemoryMiB) || hostMemoryMiB < guestRamMiB + 1024 || hostMemoryMiB > 131072) throw new Error('hostMemoryMiB must include at least 1024 MiB emulator overhead (maximum 131072)');
  if (!Number.isInteger(diskGiB) || diskGiB < 8 || diskGiB > 1024) throw new Error('diskGiB must be 8..1024');
  return { name: name.trim(), guestRamMiB, hostMemoryMiB, diskGiB };
}

/** Measured filesystem counters; filesystem metadata is included in used bytes. */
export function filesystemUsage(stat) {
  const blockSize = Number(stat.bsize);
  const totalBytes = Number(stat.blocks) * blockSize;
  const freeBytes = Number(stat.bfree) * blockSize;
  const availableBytes = Number(stat.bavail) * blockSize;
  if (![blockSize, totalBytes, freeBytes, availableBytes].every(Number.isSafeInteger) || blockSize <= 0 || totalBytes <= 0 || freeBytes < 0 || freeBytes > totalBytes || availableBytes < 0 || availableBytes > freeBytes) throw new Error('Invalid filesystem counters');
  return { totalBytes, usedBytes: totalBytes - freeBytes, availableBytes };
}
