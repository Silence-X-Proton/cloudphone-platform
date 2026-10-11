#!/usr/bin/env node
// Backend alone validates per-phone ownership, stops exact transient units and detaches owned loops.
import fs from 'node:fs/promises';
try {
  const config = JSON.parse(await fs.readFile(process.env.CONFIG_FILE || '/etc/cloudphone-platform/config.json', 'utf8'));
  if (config.stateDir !== '/var/lib/cloudphone-platform' || config.sdkDir !== '/opt/cloudphone-sdk/api36-v1') throw new Error('Refusing cleanup outside fixed deployment');
  const { PhoneManager } = await import('../lib/isolation.mjs');
  const manager = new PhoneManager({ stateDir: config.stateDir, sdkDir: config.sdkDir });
  const phones = await manager.list();
  let failed = false;
  for (const phone of phones) {
    try { await manager.stop(phone.id); }
    catch (error) { failed = true; console.error(`Cleanup ${phone.id}: ${error.message}`); }
  }
  if (failed) process.exitCode = 1;
} catch (error) { console.error(error.message); process.exitCode = 1; }
