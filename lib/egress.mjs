/**
 * Dormant CONNECT-proxy building blocks, NOT an online network implementation.
 * Importing this module opens no sockets. No listener, HTTP parsing, proxy auth,
 * namespace setup, host-network fallback, routing or isolation-gate changes.
 * A future authenticated helper must run inside the phone's accounting boundary,
 * enforce byte/buffer/request budgets and tear down on helper/tenant death.
 * Never accept dependency injection or connector options from proxy clients.
 * IPv6 is deliberately unsupported; even mixed A/AAAA answers fail closed.
 * Interface checks cover assigned addresses, not NAT/public aliases or routes;
 * deployment firewall/isolation enforcement remains mandatory. The static special-
 * use list needs maintenance. DNS pinning is not an application-layer trust check.
 */
import { Resolver } from 'node:dns/promises';
import { networkInterfaces } from 'node:os';
import { createConnection } from 'node:net';

export class EgressError extends Error {
  constructor(code, message) { super(message); this.name = 'EgressError'; this.code = code; }
}
const fail = (code, message) => { throw new EgressError(code, message); };

/** Return an unsigned integer; reject shorthand, octal, hex, whitespace and IPv6. */
export function parseIPv4(address) {
  if (typeof address !== 'string' || !/^(?:0|[1-9]\d{0,2})(?:\.(?:0|[1-9]\d{0,2})){3}$/.test(address)) {
    fail('INVALID_ADDRESS', 'Expected a canonical IPv4 literal');
  }
  const octets = address.split('.').map(Number);
  if (octets.some(n => n > 255)) fail('INVALID_ADDRESS', 'IPv4 octet out of range');
  return octets.reduce((n, octet) => n * 256 + octet, 0);
}

// Intentionally deny entire special-use blocks, including globally reachable
// exceptions (e.g. PCP/TURN anycast), not just RFC1918. Azure's platform VIP is
// public-numbered but privileged. CGNAT also covers Alibaba metadata.
const DENIED = [
  ['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8],
  ['169.254.0.0', 16], ['172.16.0.0', 12], ['192.0.0.0', 24],
  ['192.0.2.0', 24], ['192.31.196.0', 24], ['192.52.193.0', 24],
  ['192.88.99.0', 24], ['192.168.0.0', 16], ['192.175.48.0', 24],
  ['198.18.0.0', 15], ['198.51.100.0', 24], ['203.0.113.0', 24],
  ['224.0.0.0', 4], ['240.0.0.0', 4], ['168.63.129.16', 32],
].map(([base, bits]) => [parseIPv4(base), 2 ** (32 - bits)]);

/** Strict ASCII DNS name or canonical IPv4; never parse a URL/authority. */
export function validateHost(host) {
  if (typeof host !== 'string' || host.length === 0 || host.length > 253) fail('INVALID_HOST', 'Invalid host length');
  if (/^[0-9.]+$/.test(host)) { parseIPv4(host); return host; }
  if (!/^[A-Za-z0-9.-]+$/.test(host)) fail('INVALID_HOST', 'Host must be plain ASCII DNS or IPv4');
  const labels = host.split('.');
  if (labels.length < 2 || labels.some(label => !/^[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?$/.test(label)) ||
      !/^[A-Za-z][A-Za-z0-9-]*$/.test(labels.at(-1))) fail('INVALID_HOST', 'Invalid DNS labels');
  const name = host.toLowerCase();
  for (const suffix of ['localhost', 'local', 'internal', 'home.arpa', 'onion', 'invalid']) {
    if (name === suffix || name.endsWith(`.${suffix}`)) fail('DENIED_HOST', 'Local/special DNS name');
  }
  return name;
}

/** Fresh enumeration by default; enumeration failure is an error, never allow. */
export function hostIPv4Addresses(interfaces = networkInterfaces) {
  const result = interfaces();
  if (!result || typeof result !== 'object' || Array.isArray(result)) fail('INTERFACES_UNAVAILABLE', 'Cannot enumerate host interfaces');
  const addresses = new Set();
  for (const entries of Object.values(result)) {
    if (!Array.isArray(entries)) fail('INTERFACES_UNAVAILABLE', 'Malformed interface list');
    for (const entry of entries) {
      if (!entry || typeof entry !== 'object') fail('INTERFACES_UNAVAILABLE', 'Malformed interface entry');
      if (entry.family === 'IPv4' || entry.family === 4) { parseIPv4(entry.address); addresses.add(entry.address); }
      else if (entry.family !== 'IPv6' && entry.family !== 6) fail('INTERFACES_UNAVAILABLE', 'Unknown interface family');
    }
  }
  return addresses;
}

/** Throws for non-public, special or assigned host-interface addresses. */
export function assertPublicIPv4(address, { interfaces = networkInterfaces } = {}) {
  const value = parseIPv4(address);
  if (DENIED.some(([base, size]) => value >= base && value < base + size)) fail('DENIED_ADDRESS', 'Special-use IPv4 destination');
  if (hostIPv4Addresses(interfaces).has(address)) fail('DENIED_ADDRESS', 'Host interface destination');
  return address;
}

function integer(value, min, max, name) {
  if (!Number.isInteger(value) || value < min || value > max) fail('INVALID_OPTIONS', `Invalid ${name}`);
  return value;
}
function aborted(signal) {
  if (signal?.aborted) fail('ABORTED', 'Egress operation aborted');
}

/** Independent resolver per request: all A AND AAAA records, no search suffixes,
 * hosts-file fallback, family filtering, or address-selection retries. */
export async function lookupAll(host, { signal } = {}) {
  host = validateHost(host);
  if (/^[0-9.]+$/.test(host)) fail('INVALID_HOST', 'lookupAll requires a DNS name');
  aborted(signal);
  const resolver = new Resolver({ timeout: 2000, tries: 1 });
  const cancel = () => resolver.cancel();
  signal?.addEventListener('abort', cancel, { once: true });
  const records = async (method, family) => {
    try { return (await resolver[method](`${host}.`)).map(address => ({ address, family })); }
    catch (error) { if (error.code === 'ENODATA') return []; throw error; }
  };
  try {
    const results = await Promise.all([records('resolve4', 4), records('resolve6', 6)]);
    aborted(signal);
    return results.flat();
  } finally {
    signal?.removeEventListener('abort', cancel);
    resolver.cancel();
  }
}

/** Validate every answer before returning immutable checked literals. An injected
 * lookup must return all families and honor AbortSignal; it is trusted test glue.
 * No DNS cache: subsequent calls must be revalidated, and results never authorize
 * a second hostname lookup by the dialer. */
export async function resolvePublicTarget(host, {
  lookup = lookupAll, interfaces = networkInterfaces, timeoutMs = 3000, maxAnswers = 32, signal,
} = {}) {
  integer(timeoutMs, 1, 10000, 'DNS timeout');
  integer(maxAnswers, 1, 64, 'answer limit');
  host = validateHost(host);
  aborted(signal);
  if (/^[0-9.]+$/.test(host)) return Object.freeze([assertPublicIPv4(host, { interfaces })]);
  const controller = new AbortController();
  let timer;
  let onAbort;
  try {
    const stop = new Promise((resolve, reject) => {
      onAbort = () => { controller.abort(); reject(new EgressError('ABORTED', 'DNS resolution aborted')); };
      signal?.addEventListener('abort', onAbort, { once: true });
      timer = setTimeout(() => { controller.abort(); reject(new EgressError('DNS_TIMEOUT', 'DNS deadline exceeded')); }, timeoutMs);
    });
    const answers = await Promise.race([Promise.resolve().then(() => lookup(host, { signal: controller.signal })), stop]);
    aborted(signal);
    if (!Array.isArray(answers) || answers.length === 0 || answers.length > maxAnswers) fail('INVALID_DNS', 'Empty, malformed or excessive DNS answer set');
    const addresses = Array.from(answers, answer => {
      if (!answer || answer.family !== 4) fail('DENIED_ADDRESS', 'Non-IPv4 DNS answer');
      return assertPublicIPv4(answer.address, { interfaces });
    });
    return Object.freeze([...new Set(addresses)]);
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', onAbort);
    controller.abort();
  }
}

/** Explicit opt-in factory, not installed or invoked by the platform. connect()
 * accepts separate host and numeric port, never a CONNECT authority or URL.
 * Defaults allow only 80/443. Capacity covers DNS, connecting and live sockets;
 * no queues/retries. Returns a paused raw TCP socket; owner must attach handlers
 * and resume/pipe it. Idle and absolute lifetime limits remain after handoff.
 * Dependencies/options are administrator-owned, not request-controlled. */
export function createPublicTcpConnector({
  lookup = lookupAll, interfaces = networkInterfaces, dial = createConnection,
  allowedPorts = [80, 443], maxConnections = 32, maxAnswers = 32,
  dnsTimeoutMs = 3000, connectTimeoutMs = 5000, idleTimeoutMs = 30000, lifetimeMs = 120000,
} = {}) {
  integer(maxConnections, 1, 256, 'connection limit');
  integer(maxAnswers, 1, 64, 'answer limit');
  integer(dnsTimeoutMs, 1, 10000, 'DNS timeout');
  integer(connectTimeoutMs, 1, 10000, 'connect timeout');
  integer(idleTimeoutMs, 1, 60000, 'idle timeout');
  integer(lifetimeMs, 1, 300000, 'lifetime');
  if (!Array.isArray(allowedPorts) || !allowedPorts.length || allowedPorts.length > 1024) fail('INVALID_OPTIONS', 'Invalid port allowlist');
  const ports = new Set(allowedPorts.map(port => integer(port, 1, 65535, 'port')));
  const operations = new Set();
  let closed = false;
  return Object.freeze({
    get activeCount() { return operations.size; },
    close() {
      closed = true;
      for (const operation of operations) operation.abort();
    },
    async connect(host, port) {
      if (closed) fail('CLOSED', 'Connector closed');
      host = validateHost(host);
      if (!Number.isInteger(port) || !ports.has(port)) fail('DENIED_PORT', 'Port not allowed');
      if (operations.size >= maxConnections) fail('CAPACITY', 'Connector capacity exhausted');
      const operation = new AbortController();
      operations.add(operation);
      let socket;
      try {
        const addresses = await resolvePublicTarget(host, { lookup, interfaces, maxAnswers, timeoutMs: dnsTimeoutMs, signal: operation.signal });
        aborted(operation.signal);
        // Re-enumerate immediately before dialing; no hostname is passed to net.
        for (const address of addresses) assertPublicIPv4(address, { interfaces });
        const address = addresses[0];
        socket = dial({ host: address, port, family: 4, autoSelectFamily: false,
          lookup: () => fail('UNEXPECTED_DNS', 'Pinned connections must not resolve DNS') });
        socket.pause();
        return await new Promise((resolve, reject) => {
          let connected = false;
          let connectTimer;
          let lifetimeTimer;
          const stop = error => { if (!connected) reject(error); socket.destroy(); };
          const onAbort = () => stop(new EgressError('ABORTED', 'Connector closed'));
          const onError = error => stop(error);
          const onClose = () => {
            clearTimeout(connectTimer); clearTimeout(lifetimeTimer);
            operation.signal.removeEventListener('abort', onAbort);
            socket.removeListener('timeout', onTimeout);
            socket.removeListener('connect', onConnect);
            operations.delete(operation);
            if (!connected) reject(new EgressError('CONNECT_CLOSED', 'Socket closed before connect'));
          };
          const onTimeout = () => stop(new EgressError('IDLE_TIMEOUT', 'TCP idle deadline exceeded'));
          const onConnect = () => {
            try {
              aborted(operation.signal);
              if (socket.remoteAddress !== address || socket.remoteFamily !== 'IPv4' || socket.remotePort !== port) fail('PEER_MISMATCH', 'Connected peer differs from pinned target');
              assertPublicIPv4(address, { interfaces });
              clearTimeout(connectTimer);
              connected = true;
              resolve(socket);
            } catch (error) { stop(error); }
          };
          socket.on('error', onError); // Keep a handler through destruction/close.
          socket.once('close', onClose);
          socket.once('connect', onConnect);
          socket.on('timeout', onTimeout);
          operation.signal.addEventListener('abort', onAbort, { once: true });
          socket.setTimeout(idleTimeoutMs);
          connectTimer = setTimeout(() => stop(new EgressError('CONNECT_TIMEOUT', 'TCP connect deadline exceeded')), connectTimeoutMs);
          lifetimeTimer = setTimeout(() => stop(new EgressError('LIFETIME', 'TCP lifetime exceeded')), lifetimeMs);
          if (operation.signal.aborted) onAbort();
        });
      } catch (error) {
        if (socket) socket.destroy();
        else operations.delete(operation);
        throw error;
      }
    },
  });
}
