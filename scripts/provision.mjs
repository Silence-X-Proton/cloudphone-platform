#!/usr/bin/env node
import fs from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
export function chooseStandaloneSize(usage, name = 'My phone') {
  for (const key of ['memoryAllocatableBytes', 'diskAllocatableBytes']) {
    if (!Number.isSafeInteger(usage?.[key]) || usage[key] < 0) throw new Error('Cannot determine available resources');
  }
  // Broker usage already deducts max(2GiB,10%) RAM and max(10GiB,5%) disk reserves.
  // Leave a further 20% of allocatable resources for shared web/tunnel/build activity.
  const hostMemoryMiB = Math.min(49152, Math.floor(usage.memoryAllocatableBytes / 1024 ** 2 * 0.8 / 256) * 256);
  const overhead = Math.max(2048, Math.ceil(hostMemoryMiB * 0.25 / 256) * 256);
  const guestRamMiB = Math.min(32768, hostMemoryMiB - overhead);
  const diskGiB = Math.min(256, Math.floor(usage.diskAllocatableBytes / 1024 ** 3 * 0.8));
  if (guestRamMiB < 1024 || diskGiB < 8) throw new Error('Insufficient resources after host and emulator overhead reserves');
  return { name, guestRamMiB, hostMemoryMiB, diskGiB };
}
export async function provision(manager, config) {
  if (config.mode !== 'standalone') return { skipped: true };
  const capabilities = await manager.capabilities();
  if (capabilities.supported !== true || !capabilities.checks ||
      !Object.values(capabilities.checks).every(c => c.ok === true) ||
      capabilities.checks.networkIsolation?.ok !== true || capabilities.checks.streamingIsolation?.ok !== true) {
    throw new Error('Standalone blocked: verified network/stream isolation and all backend capabilities are required; no phone created or started');
  }
  const phones = await manager.list();
  if (!Array.isArray(phones) || phones.length > 1) throw new Error('Standalone requires at most one existing phone');
  const request = phones.length ? null : chooseStandaloneSize(await manager.usage(), config.standalone?.name);
  const phone = phones[0] ?? await manager.create(request);
  if (!phone?.id) throw new Error('Broker returned no phone id');
  await manager.start(phone.id);
  return { id: phone.id, ...(request ? { resources: request } : {}) };
}
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try {
    const config = JSON.parse(await fs.readFile(process.env.CONFIG_FILE || '/etc/cloudphone-platform/config.json', 'utf8'));
    const { BrokerClient } = await import('../lib/broker-client.mjs');
    console.log(JSON.stringify(await provision(new BrokerClient(), config)));
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
