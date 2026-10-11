/**
 * Manual UI verification, NEVER a live-phone test.
 * Run: npm run build && node tests/render-smoke.mjs
 * Optional: PLAYWRIGHT_MODULE=/absolute/path/to/playwright-core/index.mjs
 *           CHROMIUM_PATH=/absolute/path/to/chromium
 *           EVIDENCE_DIR=/absolute/path/outside/repository
 * Requires Chromium and ffmpeg with libx264. The actual HTTP/WS server listens on
 * an ephemeral loopback port with an in-memory manager and synthetic video only.
 * No production configuration, keys, manager, emulator, ADB, or live URL is read.
 */
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { execFileSync } from 'node:child_process';
import { access, mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createApplication, encodePacket } from '../server.mjs';

const root = fileURLToPath(new URL('..', import.meta.url));
const evidence = path.resolve(process.env.EVIDENCE_DIR || '/a0/usr/workdir/cloudphone-platform-evidence');
const relative = path.relative(root, evidence);
assert(relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative), 'Evidence must be outside the repository');
await mkdir(evidence, {recursive: true});
let playwright;
if (process.env.PLAYWRIGHT_MODULE) playwright = await import(pathToFileURL(path.resolve(process.env.PLAYWRIGHT_MODULE)));
else {
  try { playwright = await import('playwright-core'); }
  catch { playwright = await import(pathToFileURL(path.resolve(root, '../cloudphone/tests/node_modules/playwright-core/index.mjs'))); }
}
const inheritedChromium = '/a0/tmp/playwright/chromium-1228/chrome-linux64/chrome';
let executablePath = process.env.CHROMIUM_PATH;
if (!executablePath) { try { await access(inheritedChromium); executablePath = inheritedChromium; } catch {} }
// Generated picture, not Android output. Only this subprocess and Chromium start.
const raw = execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i',
  'testsrc2=size=240x480:rate=1', '-frames:v', '1', '-c:v', 'libx264', '-profile:v', 'baseline',
  '-pix_fmt', 'yuv420p', '-f', 'h264', 'pipe:1'], {maxBuffer: 4 * 1024 * 1024});
const starts = [];
for (let i = 0; i < raw.length - 3; i++) {
  if (raw[i] === 0 && raw[i + 1] === 0 && (raw[i + 2] === 1 || raw[i + 2] === 0 && raw[i + 3] === 1)) {
    const length = raw[i + 2] === 1 ? 3 : 4; starts.push([i, length]); i += length - 1;
  }
}
const nals = starts.map(([start, length], i) => ({type: raw[start + length] & 31, data: raw.subarray(start, starts[i + 1]?.[0] ?? raw.length)}));
const config = Buffer.concat(nals.filter(n => [7, 8].includes(n.type)).map(n => n.data));
const frame = Buffer.concat(nals.filter(n => ![7, 8].includes(n.type)).map(n => n.data));
assert(config.length && frame.length, 'Generated H.264 SPS/PPS and frame');
const first = '0123456789abcdef', second = 'fedcba9876543210';
const keys = new Map([[first, 'MOCK-ONLY-first-phone-key'], [second, 'MOCK-ONLY-second-phone-key']]);
const password = 'MOCK-ONLY-admin-password';
const phones = [first, second].map((id, i) => ({id, name: i ? 'Mock phone · Development lab' : 'Mock phone · Everyday workspace',
  status: i ? 'stopped' : 'running', guestRamMiB: 4096, hostMemoryMiB: 6144, diskGiB: 24,
  adbPort: 15000 + i, consolePort: 5556 + i * 2, serial: `emulator-${5556 + i * 2}`}));
const revealed = [], streams = [], errors = [], logs = [];
let failReveal = false, delayedReveal = null, browser, app;
const log = text => { logs.push(text); console.log(text); };
const manager = {
  list: async () => phones.map(p => ({...p})),
  capabilities: async () => ({supported: true, checks: {mockIsolation: {ok: true}}}),
  usage: async () => ({memoryTotalBytes: 32 * 1024 ** 3, memoryAvailableBytes: 21 * 1024 ** 3, memoryReservedBytes: 12 * 1024 ** 3,
    diskTotalBytes: 256 * 1024 ** 3, diskAvailableBytes: 180 * 1024 ** 3, diskCommittedBytes: 48 * 1024 ** 3, sharedSdkBytes: 7 * 1024 ** 3}),
  metrics: async () => ({memoryBytes: 3 * 1024 ** 3, diskUsedBytes: 8 * 1024 ** 3}),
  revealKey: async id => { revealed.push(id); if (failReveal) throw new Error('Mock reveal failure'); if (delayedReveal) await delayedReveal; return keys.get(id); },
  verifyKey: async (id, key) => keys.has(id) && keys.get(id) === key,
};
async function layout(page, viewer = false) {
  const result = await page.evaluate(() => ({w: innerWidth, h: innerHeight, sw: document.documentElement.scrollWidth, sh: document.documentElement.scrollHeight,
    csp: window.cspViolations, inline: document.querySelectorAll('script:not([src]),style,[onclick],[onload]').length}));
  assert.equal(result.sw, result.w, 'No horizontal overflow');
  if (viewer) assert.equal(result.sh, result.h, 'Viewer fits viewport height');
  assert.equal(result.inline, 0); assert.deepEqual(result.csp, []);
}
async function screenshot(page, filename) { await layout(page, filename.startsWith('phone-')); await page.screenshot({path: path.join(evidence, filename), fullPage: true}); }
async function setupPage(context, origin) {
  const page = await context.newPage();
  page.setDefaultTimeout(10000);
  page.on('pageerror', error => errors.push(error.message));
  page.on('console', message => { if (message.type() === 'error' && !/Failed to load resource/.test(message.text())) errors.push(message.text()); });
  const requests = [];
  page.on('request', req => {
    const url = new URL(req.url()); assert.equal(url.origin, origin, 'No requests to other services');
    for (const key of keys.values()) assert(!req.url().includes(key), 'Keys never enter URLs');
    requests.push({pathname: url.pathname, method: req.method(), headers: req.headers(), payload: req.postDataJSON()});
  });
  await page.route('**/*', route => new URL(route.request().url()).origin === origin ? route.continue() : route.abort());
  await page.addInitScript(() => { window.cspViolations = []; document.addEventListener('securitypolicyviolation', event => window.cspViolations.push(event.violatedDirective)); });
  return {page, requests};
}
async function adminLogin(page) {
  await page.locator('#login-dialog').waitFor({state: 'visible'});
  if (await page.locator('#login-method').count()) await page.locator('#login-method').selectOption('admin');
  await page.locator('#username').fill('admin'); await page.locator('#password').fill(password); await page.locator('#login-button').click();
  await page.locator('#login-dialog').waitFor({state: 'hidden'});
}
try {
  app = await createApplication({manager, secureCookies: false, verifyCredentials: async (username, supplied) => username === 'admin' && supplied === password,
    deviceStarter: async (state, send) => {
      streams.push({id: state.phone.id, quality: state.quality}); state.ready = true; state.video = {width: 240, height: 480};
      state.client = {close: async () => {}, controller: {injectKeyCode: async () => {}, injectText: async () => {}, setClipboard: async () => {}, injectTouch: async () => {}, injectScroll: async () => {}}};
      send({type: 'metadata', codec: 0x68323634});
      state.ws.send(encodePacket({type: 'configuration', data: config}));
      state.ws.send(encodePacket({type: 'data', keyframe: true, pts: 0n, data: frame}));
    }});
  app.server.listen(0, '127.0.0.1'); await once(app.server, 'listening');
  const origin = `http://127.0.0.1:${app.server.address().port}`;
  log('MOCK-ONLY verification: actual server, ephemeral loopback, in-memory phones and synthetic H.264. No live device usage.');
  browser = await playwright.chromium.launch({executablePath, headless: true, args: ['--no-sandbox', '--disable-dev-shm-usage', '--disable-background-networking']});
  const admin = await browser.newContext({viewport: {width: 1440, height: 1000}, colorScheme: 'dark', permissions: ['clipboard-read', 'clipboard-write']});
  const {page, requests} = await setupPage(admin, origin);
  await page.goto(origin); await adminLogin(page); await page.locator('.device-card').first().waitFor();
  assert.equal(revealed.length, 0, 'No key fetched on dashboard load');
  await screenshot(page, 'dashboard-desktop-dark.png'); await page.locator('.theme-toggle').click();
  await page.waitForTimeout(200); await screenshot(page, 'dashboard-desktop-light.png');
  await page.getByRole('button', {name: `Access key for ${phones[0].name}`, exact: true}).click();
  await page.waitForFunction(() => !document.getElementById('copy-key').disabled);
  assert.equal(await page.locator('#revealed-key').inputValue(), keys.get(first));
  const revealRequest = requests.find(r => r.pathname.endsWith('/key')); assert.equal(revealRequest.method, 'POST'); assert(revealRequest.headers['x-csrf-token']);
  await page.locator('#copy-key').click(); await page.waitForFunction(() => document.getElementById('key-status').textContent.startsWith('Key copied'));
  assert.equal(await page.evaluate(() => navigator.clipboard.readText()), keys.get(first));
  await screenshot(page, 'dashboard-key-modal-mock.png');
  await page.locator('#close-key').click(); assert.equal(await page.locator('#revealed-key').inputValue(), '');
  await page.getByRole('button', {name: `Access key for ${phones[1].name}`, exact: true}).click();
  await page.waitForFunction(() => !document.getElementById('copy-key').disabled); assert.equal(await page.locator('#revealed-key').inputValue(), keys.get(second));
  await page.keyboard.press('Escape'); assert.equal(await page.locator('#revealed-key').inputValue(), '');
  failReveal = true;
  await page.getByRole('button', {name: `Access key for ${phones[0].name}`, exact: true}).click();
  await page.waitForFunction(() => document.getElementById('key-status').textContent === 'Request failed');
  assert.equal(await page.locator('#revealed-key').inputValue(), ''); assert(await page.locator('#copy-key').isDisabled());
  await page.locator('#close-key').click(); failReveal = false;
  let resolveReveal; delayedReveal = new Promise(resolve => { resolveReveal = resolve; });
  const beforeReveal = revealed.length;
  await page.getByRole('button', {name: `Access key for ${phones[0].name}`, exact: true}).click();
  for (let attempt = 0; attempt < 100 && revealed.length === beforeReveal; attempt++) await page.waitForTimeout(10);
  assert(revealed.length > beforeReveal, 'Reveal reached mock manager');
  await page.locator('#close-key').click(); resolveReveal(); delayedReveal = null;
  await page.waitForTimeout(100); assert.equal(await page.locator('#revealed-key').inputValue(), '', 'Late response must not restore hidden key');
  await page.setViewportSize({width: 390, height: 844}); await screenshot(page, 'dashboard-mobile.png');
  assert.equal(await page.locator('.device-actions button').filter({hasText: 'Access key'}).count(), 2);
  await page.setViewportSize({width: 320, height: 568}); await layout(page);
  await page.evaluate(() => navigator.clipboard.writeText('')); await admin.close();
  log('PASS admin login; explicit unique key reveal; real CSRF POST; copy; close/Escape clearing; failure and late response; dark/light desktop, 390px and 320px dashboard.');

  const scoped = await browser.newContext({viewport: {width: 390, height: 844}, colorScheme: 'dark', isMobile: true, hasTouch: true});
  const view = await setupPage(scoped, origin), phonePage = view.page;
  await phonePage.goto(`${origin}/phone?id=${first}`); await phonePage.locator('#login-dialog').waitFor({state: 'visible'});
  assert.equal(await phonePage.locator('#login-method').inputValue(), 'key'); assert.equal(await phonePage.locator('#access-phone-id').inputValue(), first);
  assert(await phonePage.locator('#access-phone-id').evaluate(node => node.readOnly));
  await screenshot(phonePage, 'phone-mobile-key-login.png');
  await phonePage.locator('#phone-access-key').fill('MOCK-wrong'); await phonePage.locator('#login-button').click();
  await phonePage.waitForFunction(() => document.getElementById('login-error').textContent === 'Invalid phone credentials');
  assert.equal(await phonePage.locator('#phone-access-key').inputValue(), '');
  await phonePage.locator('#phone-access-key').fill(keys.get(first)); await phonePage.locator('#login-button').click();
  await phonePage.waitForFunction(() => document.getElementById('status').textContent === 'Connected');
  assert.deepEqual(view.requests.filter(r => r.pathname === '/api/login').at(-1).payload, {phoneId: first, key: keys.get(first)});
  assert.equal(await phonePage.locator('#phone-access-key').inputValue(), '');
  assert.equal(await phonePage.locator('#resolution').textContent(), '240 × 480 · H.264');
  await screenshot(phonePage, 'phone-mobile-fixture.png');
  const bounds = await phonePage.locator('#screen').boundingBox(); assert(Math.abs(bounds.width / bounds.height - .5) < .005);
  await phonePage.touchscreen.tap(bounds.x + bounds.width / 2, bounds.y + bounds.height / 2);
  const economySocket = phonePage.waitForEvent('websocket', ws => new URL(ws.url()).searchParams.get('quality') === 'economy');
  await phonePage.locator('#quality').selectOption('economy'); await economySocket;
  await phonePage.waitForFunction(() => document.getElementById('status').textContent === 'Connected'); assert.equal(streams.at(-1).quality, 'economy');
  const rights = await phonePage.evaluate(async () => ({session: await (await fetch('/api/session')).json(), inventory: await (await fetch('/api/phones')).json(), resources: (await fetch('/api/resources')).status}));
  assert.equal(rights.session.role, 'phone'); assert.equal(rights.session.phoneId, first); assert.deepEqual(rights.inventory.phones.map(p => p.id), [first]); assert.equal(rights.resources, 403);
  const forbidden = await phonePage.evaluate(async id => (await fetch(`/api/phones/${id}/key`, {method: 'POST', headers: {'X-CSRF-Token': (await (await fetch('/api/session')).json()).csrf}})).status, first);
  assert.equal(forbidden, 403);
  const resourcesBefore = view.requests.filter(r => r.pathname === '/api/resources').length;
  await phonePage.goto(origin); await phonePage.waitForURL(`**/phone?id=${first}`);
  await phonePage.waitForFunction(() => document.getElementById('status').textContent === 'Connected');
  assert.equal(view.requests.filter(r => r.pathname === '/api/resources').length, resourcesBefore, 'Scoped dashboard redirects before fetching admin resources');
  await phonePage.locator('#logout').click(); await phonePage.locator('#login-dialog').waitFor({state: 'visible'});
  await adminLogin(phonePage); await phonePage.waitForFunction(() => document.getElementById('status').textContent === 'Connected');
  assert.equal((await phonePage.evaluate(async () => (await fetch('/api/session')).json())).role, 'admin');
  await phonePage.goto(`${origin}/phone?id=${second}`); await phonePage.waitForFunction(() => document.getElementById('overlay-title').textContent === 'Your phone is not running.');
  await screenshot(phonePage, 'phone-mobile-disconnected.png');
  await phonePage.setViewportSize({width: 320, height: 568}); await layout(phonePage, true);
  await phonePage.setViewportSize({width: 844, height: 390}); await layout(phonePage, true);
  await scoped.close();
  log('PASS scoped key login, invalid-key clearing, exact payload, real H.264 fixture, touch, quality reconnect, scope enforcement, scoped dashboard redirect, admin alternate login, disconnected mobile/landscape.');
  assert.deepEqual(errors, [], 'No browser runtime/decoder errors');
  log('PASS strict server CSP and no stale/missing selectors. All assertions passed; mock server and browser closed.');
} catch (error) { log(`FAIL ${error.stack}`); process.exitCode = 1; }
finally {
  try { if (browser) await browser.close(); } finally { if (app) await app.close(); }
  await writeFile(path.join(evidence, 'render-smoke.txt'), `${logs.join('\n')}\n`);
}
