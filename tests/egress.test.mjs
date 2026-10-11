import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter, once } from 'node:events';
import { Resolver } from 'node:dns/promises';
import { networkInterfaces } from 'node:os';
import { setTimeout as delay } from 'node:timers/promises';
import {
  EgressError, parseIPv4, validateHost, hostIPv4Addresses, assertPublicIPv4,
  lookupAll, resolvePublicTarget, createPublicTcpConnector,
} from '../lib/egress.mjs';

// No real DNS, TCP, listeners, filesystem writes or isolation mutations.
const interfaces = () => ({});
const record = address => ({ address, family: 4 });
const publicLookup = async () => [record('8.8.8.8')];
const policy = address => assertPublicIPv4(address, { interfaces });
class Socket extends EventEmitter {
  constructor(options) {
    super();
    this.remoteAddress = options.host;
    this.remoteFamily = 'IPv4';
    this.remotePort = options.port;
    this.destroyed = false;
  }
  pause() { this.paused = true; }
  setTimeout(ms) { this.idleMs = ms; }
  destroy() {
    if (!this.destroyed) { this.destroyed = true; queueMicrotask(() => this.emit('close')); }
  }
}
function fixture(t, options = {}, onDial = socket => queueMicrotask(() => socket.emit('connect'))) {
  const calls = [];
  const sockets = [];
  const connector = createPublicTcpConnector({ interfaces, lookup: publicLookup,
    dial: options => {
      calls.push(options);
      const socket = new Socket(options);
      sockets.push(socket);
      onDial(socket, options);
      return socket;
    }, ...options });
  t.after(() => connector.close());
  return { connector, calls, sockets };
}

test('canonical IPv4 parsing and strict ASCII hosts reject authority tricks', () => {
  assert.equal(parseIPv4('255.255.255.255'), 4294967295);
  assert.equal(parseIPv4('0.0.0.0'), 0);
  for (const value of ['', null, 123, '127.1', '127', '2130706433', '0177.0.0.1', '127.00.0.1',
    '0x7f000001', '0x7f.0.0.1', '1.2.3.256', '+1.2.3.4', '1.2.3.4 ', '1.2.3.4\n',
    '::1', '::ffff:8.8.8.8', '64:ff9b::808:808', '[8.8.8.8]', '1.2.3.4.']) {
    assert.throws(() => parseIPv4(value), EgressError, String(value));
  }
  assert.equal(validateHost('WWW.Example.COM'), 'www.example.com');
  assert.equal(validateHost('xn--bcher-kva.example'), 'xn--bcher-kva.example');
  assert.equal(validateHost('8.8.8.8'), '8.8.8.8');
  assert.equal(validateHost(`${'a'.repeat(63)}.example`), `${'a'.repeat(63)}.example`);
  for (const host of ['', null, {}, 'singlelabel', '127.1', '2130706433', '0177.0.0.1', '0x7f000001',
    '0x7f.0.0.1', 'https://example.com', 'example.com:443', 'user@example.com', 'example.com/path',
    'example.com?x', 'example.com#x', 'example.com\\foo', 'example.com.', '.example.com', 'x..com',
    '-x.com', 'x-.com', '_service.example.com', ' example.com', 'example.com\n', 'exam\0ple.com',
    'bücher.example', 'ｅxample.com', 'example。com', '%31%32%37.0.0.1', '[::1]', '::ffff:8.8.8.8',
    '64:ff9b::808:808', '2002:0808:0808::1', `${'a'.repeat(64)}.com`, `${'a.'.repeat(127)}com`,
    'x.localhost', 'x.local', 'metadata.google.internal', 'x.home.arpa', 'x.onion', 'x.invalid']) {
    assert.throws(() => validateHost(host), EgressError, String(host));
  }
});

test('conservative special-use blocks, metadata and IPv6 are forbidden', () => {
  for (const address of [
    '0.0.0.0', '0.255.255.255', '10.0.0.0', '10.255.255.255',
    '100.64.0.0', '100.100.100.200', '100.127.255.255', '127.0.0.0', '127.255.255.255',
    '169.254.0.0', '169.254.169.254', '169.254.170.2', '169.254.255.255',
    '172.16.0.0', '172.31.255.255', '192.0.0.0', '192.0.0.9', '192.0.0.255',
    '192.0.2.0', '192.0.2.255', '192.31.196.0', '192.31.196.255',
    '192.52.193.0', '192.52.193.255', '192.88.99.0', '192.88.99.255',
    '192.168.0.0', '192.168.255.255', '192.175.48.0', '192.175.48.255',
    '198.18.0.0', '198.19.255.255', '198.51.100.0', '198.51.100.255',
    '203.0.113.0', '203.0.113.255', '224.0.0.0', '239.255.255.255',
    '240.0.0.0', '255.255.255.255', '168.63.129.16',
  ]) assert.throws(() => policy(address), { code: 'DENIED_ADDRESS' }, address);
  for (const address of ['::1', '::', '2001:4860:4860::8888', '::ffff:8.8.8.8', '64:ff9b::808:808']) {
    assert.throws(() => policy(address), { code: 'INVALID_ADDRESS' });
  }
  for (const address of ['1.1.1.1', '8.8.8.8', '9.9.9.9', '100.63.255.255', '100.128.0.0',
    '172.15.255.255', '172.32.0.0', '169.253.255.255', '169.255.0.0',
    '198.17.255.255', '198.20.0.0', '168.63.129.15', '168.63.129.17', '223.255.255.255']) {
    assert.equal(policy(address), address);
  }
});

test('assigned public host IP denied; default provider reads real OS interfaces', async () => {
  const host = () => ({ eth0: [{ family: 'IPv4', address: '8.8.8.8', internal: false },
    { family: 4, address: '9.9.9.9' }, { family: 'IPv6', address: '::1' }] });
  assert.deepEqual([...hostIPv4Addresses(host)], ['8.8.8.8', '9.9.9.9']);
  assert.throws(() => assertPublicIPv4('8.8.8.8', { interfaces: host }), { code: 'DENIED_ADDRESS' });
  await assert.rejects(resolvePublicTarget('example.com', { interfaces: host, lookup: publicLookup }), { code: 'DENIED_ADDRESS' });
  const expected = Object.values(networkInterfaces()).flat().filter(e => e.family === 'IPv4' || e.family === 4).map(e => e.address);
  assert.deepEqual([...hostIPv4Addresses()].sort(), [...new Set(expected)].sort());
  for (const address of expected) assert.throws(() => assertPublicIPv4(address), { code: 'DENIED_ADDRESS' });
  for (const result of [null, [], { eth0: null }, { eth0: [null] }, { eth0: [{ family: 'unknown' }] }]) {
    assert.throws(() => policyWith(result), { code: 'INTERFACES_UNAVAILABLE' });
  }
  function policyWith(result) { return assertPublicIPv4('8.8.8.8', { interfaces: () => result }); }
  assert.throws(() => assertPublicIPv4('8.8.8.8', { interfaces: () => { throw new Error('OS failure'); } }), /OS failure/);
});

test('resolver checks every answer, rejects malformed/empty/excessive and mixed results', async () => {
  for (const answers of [[], new Array(1), [record('8.8.8.8'), ,], null, {}, [null], [record('127.0.0.1')],
    [record('8.8.8.8'), record('10.1.2.3')], [record('10.1.2.3'), record('8.8.8.8')],
    [record('8.8.8.8'), { address: '2001:4860::8888', family: 6 }],
    [record('8.8.8.8'), { address: '::ffff:8.8.8.8', family: 6 }],
    [{ address: '8.8.8.8', family: '4' }], [record('008.8.8.8')],
    Array.from({ length: 33 }, () => record('8.8.8.8'))]) {
    await assert.rejects(resolvePublicTarget('example.com', { interfaces, lookup: async () => answers }), EgressError);
  }
  const addresses = await resolvePublicTarget('Example.COM', { interfaces,
    lookup: async host => { assert.equal(host, 'example.com'); return [record('8.8.8.8'), record('1.1.1.1'), record('8.8.8.8')]; } });
  assert.deepEqual(addresses, ['8.8.8.8', '1.1.1.1']);
  assert.ok(Object.isFrozen(addresses));
  assert.deepEqual(await resolvePublicTarget('8.8.8.8', { interfaces, lookup: () => assert.fail('literal resolved') }), ['8.8.8.8']);
  await assert.rejects(resolvePublicTarget('example.com', { interfaces, lookup: async () => { throw new Error('DNS failed'); } }), /DNS failed/);
});

test('default lookup queries both families using absolute name; ENODATA only is tolerated', async t => {
  const calls = [];
  let cancelled = 0;
  t.mock.method(Resolver.prototype, 'resolve4', async name => { calls.push(['A', name]); return ['8.8.8.8']; });
  t.mock.method(Resolver.prototype, 'resolve6', async name => { calls.push(['AAAA', name]); return ['2001:4860::8888']; });
  t.mock.method(Resolver.prototype, 'cancel', () => { cancelled++; });
  for (const host of ['8.8.8.8', 'http://example.com', 'example.com:443', '::1']) {
    await assert.rejects(lookupAll(host), EgressError);
  }
  assert.deepEqual(calls, []);
  assert.deepEqual(await lookupAll('example.com'), [record('8.8.8.8'), { address: '2001:4860::8888', family: 6 }]);
  assert.deepEqual(calls, [['A', 'example.com.'], ['AAAA', 'example.com.']]);
  await assert.rejects(resolvePublicTarget('example.com', { interfaces }), { code: 'DENIED_ADDRESS' });
  t.mock.method(Resolver.prototype, 'resolve6', async () => { throw Object.assign(new Error('no AAAA'), { code: 'ENODATA' }); });
  assert.deepEqual(await resolvePublicTarget('example.com', { interfaces }), ['8.8.8.8']);
  t.mock.method(Resolver.prototype, 'resolve6', async () => { throw Object.assign(new Error('failed AAAA'), { code: 'ETIMEOUT' }); });
  await assert.rejects(resolvePublicTarget('example.com', { interfaces }), { code: 'ETIMEOUT' });
  assert.ok(cancelled >= 4);
});

test('DNS deadline and cancellation cannot trigger late dial', async t => {
  let finish;
  let signal;
  const f = fixture(t, { dnsTimeoutMs: 10, lookup: (host, options) => {
    signal = options.signal; return new Promise(resolve => { finish = resolve; });
  } });
  await assert.rejects(f.connector.connect('example.com', 443), { code: 'DNS_TIMEOUT' });
  assert.equal(signal.aborted, true);
  finish([record('8.8.8.8')]);
  await delay(0);
  assert.equal(f.calls.length, 0);
  assert.equal(f.connector.activeCount, 0);
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(resolvePublicTarget('8.8.8.8', { interfaces, signal: controller.signal }), { code: 'ABORTED' });
});

test('connector pins one checked literal, refuses rebinding and never retries', async t => {
  let queries = 0;
  const f = fixture(t, { lookup: async () => ++queries === 1 ? [record('8.8.8.8'), record('1.1.1.1')] : [record('127.0.0.1')] });
  const socket = await f.connector.connect('Example.COM', 443);
  assert.equal(queries, 1);
  assert.equal(socket.paused, true);
  assert.equal(socket.idleMs, 30000);
  assert.equal(f.calls[0].host, '8.8.8.8');
  assert.equal(f.calls[0].family, 4);
  assert.equal(f.calls[0].autoSelectFamily, false);
  assert.throws(() => f.calls[0].lookup('example.com'), { code: 'UNEXPECTED_DNS' });
  await assert.rejects(f.connector.connect('example.com', 443), { code: 'DENIED_ADDRESS' });
  assert.equal(f.calls.length, 1);
  f.connector.close();
  await delay(0);
  assert.equal(socket.destroyed, true);
  assert.equal(f.connector.activeCount, 0);
  await assert.rejects(f.connector.connect('8.8.8.8', 443), { code: 'CLOSED' });
});

test('invalid targets, mixed answers and disallowed ports never dial', async t => {
  const f = fixture(t, { lookup: async () => [record('8.8.8.8'), record('168.63.129.16')] });
  for (const host of ['example.com', '127.0.0.1', '168.63.129.16', '::1', 'http://example.com']) {
    await assert.rejects(f.connector.connect(host, 443), EgressError);
  }
  for (const port of [0, 22, 65536, '443', 443.1, null]) await assert.rejects(f.connector.connect('8.8.8.8', port), { code: 'DENIED_PORT' });
  assert.equal(f.calls.length, 0);
  assert.equal(f.connector.activeCount, 0);
});

test('rechecks changing host interfaces before dial and after connect', async t => {
  let checks = 0;
  const f = fixture(t, { interfaces: () => ++checks >= 2 ? { eth0: [{ family: 'IPv4', address: '8.8.8.8' }] } : {} });
  await assert.rejects(f.connector.connect('8.8.8.8', 443), { code: 'DENIED_ADDRESS' });
  assert.equal(f.calls.length, 0);
  checks = 0;
  const g = fixture(t, { interfaces: () => ++checks >= 3 ? { eth0: [{ family: 'IPv4', address: '8.8.8.8' }] } : {} });
  await assert.rejects(g.connector.connect('8.8.8.8', 443), { code: 'DENIED_ADDRESS' });
  assert.equal(g.sockets[0].destroyed, true);
});

test('capacity includes DNS and live sockets; close aborts pending work', async t => {
  let started;
  const ready = new Promise(resolve => { started = resolve; });
  const f = fixture(t, { maxConnections: 1, lookup: (host, { signal }) => {
    started(); return new Promise((resolve, reject) => signal.addEventListener('abort', () => reject(new Error('cancelled'))));
  } });
  const pending = f.connector.connect('example.com', 443);
  await ready;
  await assert.rejects(f.connector.connect('8.8.8.8', 443), { code: 'CAPACITY' });
  f.connector.close();
  await assert.rejects(pending);
  assert.equal(f.connector.activeCount, 0);
  assert.equal(f.calls.length, 0);
  const g = fixture(t, { maxConnections: 1 });
  const socket = await g.connector.connect('8.8.8.8', 443);
  await assert.rejects(g.connector.connect('1.1.1.1', 443), { code: 'CAPACITY' });
  socket.destroy();
  await delay(0);
  assert.equal(g.connector.activeCount, 0);
  await g.connector.connect('1.1.1.1', 443);
});

test('connect timeout, early close, error, dial throw and peer mismatch fail closed', async t => {
  for (const [expected, onDial] of [
    ['CONNECT_TIMEOUT', () => {}],
    ['CONNECT_CLOSED', socket => queueMicrotask(() => socket.destroy())],
    ['ECONNREFUSED', socket => queueMicrotask(() => socket.emit('error', Object.assign(new Error('refused'), { code: 'ECONNREFUSED' })))],
    ['PEER_MISMATCH', socket => queueMicrotask(() => { socket.remoteAddress = '127.0.0.1'; socket.emit('connect'); })],
    ['PEER_MISMATCH', socket => queueMicrotask(() => { socket.remoteFamily = 'IPv6'; socket.emit('connect'); })],
    ['PEER_MISMATCH', socket => queueMicrotask(() => { socket.remotePort = 22; socket.emit('connect'); })],
  ]) {
    const f = fixture(t, { connectTimeoutMs: 10 }, onDial);
    await assert.rejects(f.connector.connect('8.8.8.8', 443), { code: expected });
    await delay(0);
    assert.equal(f.sockets[0].destroyed, true);
    assert.equal(f.calls.length, 1);
    assert.equal(f.connector.activeCount, 0);
  }
  const f = fixture(t, { dial: () => { throw new Error('dial failed'); } });
  await assert.rejects(f.connector.connect('8.8.8.8', 443), /dial failed/);
  assert.equal(f.connector.activeCount, 0);
});

test('idle and absolute lifetime limits destroy established sockets', async t => {
  const f = fixture(t);
  const socket = await f.connector.connect('8.8.8.8', 443);
  const closed = once(socket, 'close');
  socket.emit('timeout');
  await closed;
  assert.equal(f.connector.activeCount, 0);
  const g = fixture(t, { lifetimeMs: 15 });
  const other = await g.connector.connect('8.8.8.8', 443);
  await once(other, 'close');
  assert.equal(other.destroyed, true);
  assert.equal(g.connector.activeCount, 0);
});

test('all configured bounds and port allowlist are strict and copied', async t => {
  for (const options of [{ maxConnections: 0 }, { maxConnections: 257 }, { maxAnswers: 65 },
    { dnsTimeoutMs: 0 }, { dnsTimeoutMs: 10001 }, { connectTimeoutMs: Infinity },
    { idleTimeoutMs: 60001 }, { lifetimeMs: 300001 }, { allowedPorts: [] },
    { allowedPorts: ['443'] }, { allowedPorts: [65536] }, { allowedPorts: new Set([443]) }]) {
    assert.throws(() => createPublicTcpConnector(options), { code: 'INVALID_OPTIONS' });
  }
  for (const options of [{ timeoutMs: 0 }, { timeoutMs: 10001 }, { maxAnswers: 0 }, { maxAnswers: 65 }]) {
    await assert.rejects(resolvePublicTarget('8.8.8.8', { ...options, interfaces }), { code: 'INVALID_OPTIONS' });
  }
  const allowedPorts = [8443];
  const f = fixture(t, { allowedPorts });
  allowedPorts.push(22);
  await assert.rejects(f.connector.connect('8.8.8.8', 22), { code: 'DENIED_PORT' });
  await f.connector.connect('8.8.8.8', 8443);
});
