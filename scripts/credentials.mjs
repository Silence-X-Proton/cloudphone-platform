#!/usr/bin/env node
import fs from 'node:fs/promises';
import path from 'node:path';
import { randomBytes, scryptSync } from 'node:crypto';
import { pathToFileURL } from 'node:url';
export async function initializeCredentials(stateDir) {
  if (!path.isAbsolute(stateDir)) throw new Error('STATE_DIR must be absolute');
  await fs.mkdir(stateDir, { recursive: true, mode: 0o700 });
  const info = await fs.lstat(stateDir);
  if (info.isSymbolicLink() || !info.isDirectory() || (info.mode & 0o077)) throw new Error('STATE_DIR must be a private directory');
  const destination = path.join(stateDir, 'credentials.json');
  try {
    const existing = await fs.lstat(destination);
    if (!existing.isFile() || existing.isSymbolicLink() || (existing.mode & 0o077)) throw new Error('Existing credentials must be a private regular file');
    const value = JSON.parse(await fs.readFile(destination, 'utf8'));
    if (value.schemaVersion !== 1 || value.username !== 'admin' || !/^[a-f0-9]{32}$/.test(value.salt) || !/^[a-f0-9]{128}$/.test(value.passwordHash)) throw new Error('Existing credentials have incompatible schema; refusing overwrite');
    return { created: false };
  } catch (error) { if (error.code !== 'ENOENT') throw error; }
  // Exclusive lock prevents concurrent initialization; never break an unknown stale lock automatically.
  const lock = path.join(stateDir, '.credentials-init.lock');
  const handle = await fs.open(lock, 'wx', 0o600);
  try {
    const password = randomBytes(32).toString('base64url');
    const salt = randomBytes(16).toString('hex');
    const tokenFile = path.join(stateDir, 'initial-admin-password');
    // Password first: interrupted init cannot leave valid credentials whose password was never saved.
    await fs.writeFile(tokenFile, `${password}\n`, { flag: 'wx', mode: 0o600 });
    await fs.writeFile(destination, JSON.stringify({ schemaVersion: 1,
      username: 'admin', salt, passwordHash: scryptSync(password, Buffer.from(salt, 'hex'), 64, { N: 16384, r: 8, p: 1 }).toString('hex') }, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
    return { created: true };
  } finally { await handle.close(); await fs.unlink(lock); }
}
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try {
    if (process.argv[2] !== 'init' || !process.env.STATE_DIR) throw new Error('Usage: STATE_DIR=/private/path node scripts/credentials.mjs init');
    const result = await initializeCredentials(process.env.STATE_DIR);
    console.log(result.created ? 'Credentials initialized; retrieve STATE_DIR/initial-admin-password privately.' : 'Existing credentials preserved.');
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
