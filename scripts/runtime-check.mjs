#!/usr/bin/env node
import { readRootJSON } from '../lib/broker.mjs';
import { PhoneManager } from '../lib/isolation.mjs';
if (process.getuid?.() !== 0) throw new Error('Root runtime prerequisite required');
const config = await readRootJSON(process.env.CONFIG_FILE || '/etc/cloudphone-platform/config.json');
const manager = new PhoneManager({ stateDir: config.stateDir, sdkDir: config.sdkDir, config });
try {
  await manager.verifyRuntimeCheck();
  console.log('Installed runtime prerequisite matches this boot/source.');
} catch {
  console.log(JSON.stringify(await manager.runtimeSelfCheck()));
}
