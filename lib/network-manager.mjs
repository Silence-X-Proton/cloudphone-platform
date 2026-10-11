import fs from 'node:fs/promises';
import { constants as F } from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { isDeepStrictEqual } from 'node:util';

const HELPER = fileURLToPath(new URL('../scripts/phone-network.py', import.meta.url));
const SELF = fileURLToPath(import.meta.url);
const LIMIT = 8192;
const ID = /^[a-f0-9]{16}$/;
const ROLES = ['monitor', 'launcher', 'helper'];
const KEYS = ['ready', 'id', 'mainPid', 'mainStarttime', 'monitorPid', 'monitorStarttime',
  'launcherPid', 'launcherStarttime', 'helperPid', 'helperStarttime', 'cgroup', 'dns', 'firewallDigest'];
const integer = value => Number.isSafeInteger(value) && value > 0;
function contract(value) {
  if (!value || !ID.test(value.id ?? '') || typeof value.id !== 'string' ||
      !['number', 'string'].includes(typeof value.mainPid) ||
      !/^[1-9][0-9]*$/.test(String(value.mainPid)) || !integer(Number(value.mainPid)) ||
      !integer(value.memoryBytes)) throw new Error('Invalid network contract');
  return { id: value.id, mainPid: Number(value.mainPid), memoryBytes: value.memoryBytes };
}
function evidenceFor(value, expected) {
  if (!value || typeof value !== 'object' || Array.isArray(value) ||
      Object.keys(value).length !== KEYS.length || !KEYS.every(key => Object.hasOwn(value, key)) ||
      value.ready !== true || value.id !== expected.id || value.mainPid !== expected.mainPid ||
      value.cgroup !== `/system.slice/cloudphone-${expected.id}.service` ||
      !isDeepStrictEqual(value.dns, ['1.1.1.1', '9.9.9.9']) ||
      typeof value.firewallDigest !== 'string' || !/^[a-f0-9]{64}$/.test(value.firewallDigest)) throw new Error('Invalid network evidence');
  for (const role of ['main', ...ROLES]) {
    if (!integer(value[role + 'Pid']) || typeof value[role + 'Starttime'] !== 'string' ||
        !/^[0-9]+$/.test(value[role + 'Starttime'])) throw new Error('Invalid network process identity');
  }
  if (new Set(['main', ...ROLES].map(role => value[role + 'Pid'])).size !== 4) throw new Error('Duplicate network process identity');
  // Return a detached snapshot: callers cannot mutate pending verification args.
  const snapshot = JSON.parse(JSON.stringify(value));
  if (Buffer.byteLength(JSON.stringify(snapshot)) > 4096) throw new Error('Network evidence too large');
  Object.freeze(snapshot.dns);
  return Object.freeze(snapshot);
}

/** Trusted construction only; injection exists for tests, never HTTP configuration.
 * No global monitor registry or process-exit hooks. Persist evidence in root-owned
 * state; reconnect by verifyNetwork, not startNetwork. No mutation retries.
 */
export function createNetworkManager({ spawnProcess = spawn, io = fs, timeoutMs = 15000 } = {}) {
  if (!integer(timeoutMs) || timeoutMs > 30000) throw new Error('Invalid network deadline');
  function invoke(args, { readiness = false, validate = value => value } = {}) {
    return new Promise((resolve, reject) => {
      let child, timer, settled = false, chunks = [], bytes = 0;
      const finish = (error, value) => {
        if (settled) return;
        settled = true; clearTimeout(timer);
        if (error) {
          // Kill only this failed invocation, never the phone group or a saved PID.
          if (child && child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
          child?.stdout?.destroy();
          reject(error);
        } else {
          if (readiness) {
            // The helper prints exactly once. Closing this read end neither sends
            // a lifecycle signal nor closes the monitor's private slirp exit-FD.
            child.stdout.destroy(); child.unref();
          }
          resolve(value);
        }
        chunks = [];
      };
      const decode = () => new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks));
      try {
        child = spawnProcess('/usr/bin/python3', [HELPER, ...args], {
          shell: false, detached: readiness, stdio: ['ignore', 'pipe', 'ignore'],
          env: { PATH: '/usr/sbin:/usr/bin:/sbin:/bin', LANG: 'C', PYTHONDONTWRITEBYTECODE: '1' },
        });
        timer = setTimeout(() => finish(new Error('Network helper deadline exceeded')), timeoutMs);
        child.on('error', error => finish(error));
        child.stdout.on('error', error => finish(error));
        child.stdout.on('data', chunk => {
          if (settled) return;
          bytes += chunk.length;
          if (bytes > LIMIT) return finish(new Error('Network helper output limit exceeded'));
          chunks.push(Buffer.from(chunk));
          if (readiness && chunk.includes(10)) {
            try {
              const text = decode();
              if (!text.endsWith('\n') || text.indexOf('\n') !== text.length - 1) throw new Error('Invalid readiness framing');
              const value = validate(JSON.parse(text));
              if (value.monitorPid !== child.pid || child.exitCode !== null || child.signalCode !== null) throw new Error('Network monitor identity/execution mismatch');
              finish(null, value);
            } catch (error) { finish(error); }
          }
        });
        child.on('close', (code, signal) => {
          if (settled) return;
          try {
            if (readiness || code !== 0 || signal) throw new Error('Network helper exited without successful result');
            finish(null, validate(decode()));
          } catch (error) { finish(error); }
        });
      } catch (error) { finish(error); }
    });
  }
  return Object.freeze({
    async startNetwork(input) {
      const c = contract(input);
      return invoke(['start', c.id, String(c.mainPid), String(c.memoryBytes)], {
        readiness: true, validate: value => evidenceFor(value, c),
      });
    },
    async verifyNetwork(input, evidence) {
      const c = contract(input), expected = evidenceFor(evidence, c);
      return invoke(['verify', c.id, String(c.mainPid), String(c.memoryBytes), JSON.stringify(expected)], {
        validate: text => {
          const actual = evidenceFor(JSON.parse(text), c);
          if (!isDeepStrictEqual(actual, expected)) throw new Error('Network verification evidence changed');
          return Object.freeze(ROLES.map(role => actual[role + 'Pid']));
        },
      });
    },
    async stopNetwork(id) {
      if (typeof id !== 'string' || !ID.test(id)) throw new Error('Invalid phone ID');
      await invoke(['stop', id], { validate: text => {
        if (text.trim()) throw new Error('Unexpected network cleanup output');
      } });
    },
    async networkPrerequisites() {
      // Read-only artifact checks, NOT installed nft/kernel/online attestation.
      // Ubuntu merged-/usr and versioned Python symlinks are allowed only when
      // their lexical AND resolved ancestor trees are root-owned/non-writable.
      const artifacts = [];
      const tree = async filename => {
        for (let current = filename; ; current = path.dirname(current)) {
          const st = await io.lstat(current);
          if (st.uid !== 0 || (!st.isSymbolicLink() && st.mode & 0o022)) throw new Error(`Unsafe network artifact: ${current}`);
          if (current === '/') break;
        }
      };
      for (const [filename, executable] of [[SELF, false], [HELPER, false],
        ...['/usr/bin/python3', '/usr/bin/slirp4netns', '/usr/sbin/nft', '/usr/bin/unshare',
          '/usr/bin/mount', '/usr/bin/systemctl'].map(p => [p, true]),
        ['/usr/lib/x86_64-linux-gnu/libseccomp.so.2', false]]) {
        await tree(filename);
        const real = await io.realpath(filename); await tree(real);
        const st = await io.lstat(real);
        if (!st.isFile() || st.isSymbolicLink()) throw new Error('Network artifact is not a regular file');
        await io.access(real, executable ? F.R_OK | F.X_OK : F.R_OK);
        artifacts.push(real);
      }
      return { ok: true, artifacts };
    },
  });
}

export const { startNetwork, verifyNetwork, stopNetwork, networkPrerequisites } = createNetworkManager();
