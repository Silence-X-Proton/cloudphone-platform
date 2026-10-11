#!/usr/bin/env node
import fs from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import { webConfig } from './config.mjs';
// Fixed root-only writer. No credentials, state path, password or root environment reaches web.
try {
  if (process.getuid?.() !== 0) throw new Error('Root required to configure web origin');
  const config = JSON.parse(await fs.readFile('/etc/cloudphone-platform/config.json', 'utf8'));
  const origin = process.argv[2] || `http://127.0.0.1:${config.port}`;
  const invocation = process.argv[3];
  if (invocation && !/^[a-f0-9]{32}$/.test(invocation)) throw new Error('Invalid tunnel invocation');
  const dest = '/etc/cloudphone-platform-web/config.json';
  const data = JSON.stringify(webConfig(config, origin, invocation), null, 2) + '\n';
  let old;
  try { const st = await fs.lstat(dest); if (!st.isFile() || st.uid !== 0 || st.mode & 0o022) throw new Error('Unsafe web config'); old = await fs.readFile(dest, 'utf8'); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  if (old !== data) {
    const temp = `${dest}.${randomBytes(8).toString('hex')}.tmp`;
    await fs.writeFile(temp, data, { flag: 'wx', mode: 0o644 });
    await fs.chmod(temp, 0o644);
    await fs.rename(temp, dest);
    console.log('changed');
  } else console.log('unchanged');
} catch (error) { console.error(error.message); process.exitCode = 1; }
