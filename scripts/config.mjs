#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
export function makeConfig(mode, port = 8790) {
  if (!['dashboard', 'standalone'].includes(mode)) throw new Error('Mode must be dashboard or standalone');
  if (!Number.isInteger(Number(port)) || !/^\d+$/.test(String(port)) || Number(port) < 1024 || Number(port) > 65535 || Number(port) === 8787) throw new Error('Invalid port (8787 reserved for live deployment)');
  return { schemaVersion: 1, mode, networkMode: 'public', host: '127.0.0.1', port: Number(port),
    stateDir: '/var/lib/cloudphone-platform', sdkDir: '/opt/cloudphone-sdk/api36-v1',
    scrcpyServer: '/opt/cloudphone-sdk/api36-v1/scrcpy-server.jar',
    credentialsFile: '/var/lib/cloudphone-platform/credentials.json',
    standalone: { name: 'My phone', sizing: 'available-resources-v1' },
    reserve: { hostMemoryMiB: 2048, diskGiB: 10 } };
}
export function webConfig(config, publicOrigin = 'http://127.0.0.1:' + config.port, tunnelInvocationId) {
  const local = 'http://127.0.0.1:' + config.port;
  if (publicOrigin !== local && !/^https:\/\/[a-z0-9]+(?:-[a-z0-9]+)*\.trycloudflare\.com$/.test(publicOrigin)) throw new Error('Untrusted public origin');
  return { schemaVersion: 1, mode: config.mode, host: '127.0.0.1', port: config.port,
    sdkDir: config.sdkDir, scrcpyServer: config.scrcpyServer,
    brokerSocket: '/run/cloudphone-platform/broker.sock', publicOrigin,
    ...(tunnelInvocationId ? { tunnelInvocationId } : {}) };
}
export function validateLock(pkg, lock) {
  if (![2, 3].includes(lock.lockfileVersion) || !lock.packages?.['']) throw new Error('Committed npm lockfile v2/v3 required');
  for (const group of ['dependencies', 'devDependencies', 'optionalDependencies']) {
    for (const [name, version] of Object.entries(pkg[group] ?? {})) {
      if (!/^\d+\.\d+\.\d+(?:-[\w.-]+)?$/.test(version)) throw new Error(`Dependency must be exactly pinned: ${name}`);
      if (lock.packages[''][group]?.[name] !== version) throw new Error(`Lockfile mismatch: ${name}`);
    }
  }
  for (const [name, item] of Object.entries(lock.packages)) {
    if (!name) continue;
    if (item.link || !/^https:\/\/registry\.npmjs\.org\//.test(item.resolved ?? '') || !/^sha512-[A-Za-z0-9+/]+={0,2}$/.test(item.integrity ?? '')) throw new Error(`Registry integrity-locked dependency required: ${name}`);
  }
}
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try {
    if (process.argv[2] === 'lock') validateLock(JSON.parse(fs.readFileSync(process.argv[3])), JSON.parse(fs.readFileSync(process.argv[4])));
    else console.log(JSON.stringify(makeConfig(process.argv[2], process.argv[3] ?? 8790), null, 2));
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
