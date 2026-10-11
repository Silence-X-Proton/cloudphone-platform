import { randomBytes, scrypt, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';

const derive = promisify(scrypt);
export const SCRYPT = Object.freeze({ N: 16384, r: 8, p: 1, maxmem: 64 * 1024 * 1024 });
export const COOKIE = 'cloudphone_session';
const hex = (s, length) => typeof s === 'string' && s.length === length && /^[a-f0-9]+$/i.test(s);
export function validateCredentials(c) {
  if (!c || c.schemaVersion !== 1 || typeof c.username !== 'string' || !/^[A-Za-z0-9_.@-]{1,64}$/.test(c.username) ||
      typeof c.salt !== 'string' || !/^(?:[a-f0-9]{2}){16,64}$/i.test(c.salt) || !hex(c.passwordHash, 128)) throw new Error('Invalid scrypt credentials');
  return { schemaVersion: 1, username: c.username, salt: c.salt, passwordHash: c.passwordHash };
}
export function safeEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  const x = Buffer.from(a), y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}
export function originAllowed(req, publicOrigin) {
  const supplied = req.headers.origin;
  if (typeof supplied !== 'string' || supplied === 'null') return false;
  try {
    const origin = new URL(supplied);
    if (origin.origin !== supplied || !['http:', 'https:'].includes(origin.protocol)) return false;
    // Forwarding headers are not a trust boundary. Configure the external origin explicitly.
    const expected = publicOrigin ?? `${req.socket?.encrypted ? 'https' : 'http'}://${req.headers.host}`;
    return supplied === expected;
  } catch { return false; }
}
export function createAuth({ credentials, verifyCredentials, username = 'admin', secureCookies = true, publicOrigin, sessionMs = 12 * 60 * 60 * 1000,
  maxSessions = 64, maxAttempts = 20, maxRateEntries = 1024, maxVerifications = 2, now = Date.now } = {}) {
  const stored = credentials ? validateCredentials(credentials) : null;
  if (!stored && typeof verifyCredentials !== 'function') throw new Error('Credentials or trusted verifier required');
  if (!/^[A-Za-z0-9_.@-]{1,64}$/.test(username)) throw new Error('Invalid username');
  for (const value of [sessionMs, maxSessions, maxAttempts, maxRateEntries, maxVerifications]) {
    if (!Number.isSafeInteger(value) || value < 1) throw new Error('Invalid authentication limit');
  }
  if (publicOrigin) {
    const u = new URL(publicOrigin);
    if (u.origin !== publicOrigin || !['http:', 'https:'].includes(u.protocol)) throw new Error('Invalid public origin');
    if (u.protocol === 'https:' && !secureCookies) throw new Error('HTTPS requires secure cookies');
  }
  const sessions = new Map(), attempts = new Map();
  let verifications = 0;
  const prune = () => {
    const time = now();
    for (const [id, s] of sessions) if (s.expires <= time) sessions.delete(id);
    for (const [ip, rate] of attempts) if (rate.until <= time) attempts.delete(ip);
  };
  return {
    username: stored?.username ?? username, sessions, prune,
    allowed: req => originAllowed(req, publicOrigin),
    cookie: (id = '') => `${COOKIE}=${id}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${id ? Math.floor(sessionMs / 1000) : 0}${secureCookies ? '; Secure' : ''}`,
    session(req) {
      const cookies = (req.headers.cookie ?? '').split(';').map(s => s.trim()).filter(s => s.startsWith(`${COOKIE}=`));
      if (cookies.length !== 1) return undefined;
      const id = cookies[0].slice(COOKIE.length + 1);
      const s = sessions.get(id);
      if (!s || s.expires <= now()) { sessions.delete(id); return undefined; }
      return { id, ...s };
    },
    attempt(ip) {
      prune();
      let rate = attempts.get(ip);
      if (!rate) {
        // Do not evict live entries: rotating source addresses cannot reset existing limits.
        if (attempts.size >= maxRateEntries) return false;
        rate = { count: 0, until: now() + 60_000 }; attempts.set(ip, rate);
      }
      return ++rate.count <= maxAttempts;
    },
    async verify(body) {
      if (!body || typeof body !== 'object' || Array.isArray(body) || Object.keys(body).some(k => !['username', 'password'].includes(k)) ||
          typeof body.username !== 'string' || body.username.length > 64 || typeof body.password !== 'string' ||
          !body.password.length || Buffer.byteLength(body.password) > 1024) return false;
      if (verifications >= maxVerifications) { const error = new Error('Authentication busy'); error.status = 429; throw error; }
      verifications++;
      try {
        if (!stored) return (await verifyCredentials(body.username, body.password)) === true;
        const candidate = await derive(body.password, Buffer.from(stored.salt, 'hex'), 64, SCRYPT);
        const passwordOK = timingSafeEqual(candidate, Buffer.from(stored.passwordHash, 'hex'));
        return safeEqual(body.username, stored.username) && passwordOK;
      } finally { verifications--; }
    },
    issue(previous, scope = {}) {
      prune();
      if (previous) sessions.delete(previous.id);
      while (sessions.size >= maxSessions) sessions.delete(sessions.keys().next().value);
      const id = randomBytes(32).toString('hex');
      const session = { role: scope.phoneId ? 'phone' : 'admin', ...(scope.phoneId ? { phoneId: scope.phoneId } : {}), csrf: randomBytes(32).toString('hex'), expires: now() + sessionMs };
      sessions.set(id, session);
      return { id, ...session };
    },
    revoke(id) { sessions.delete(id); },
    csrf(req, session) { return safeEqual(req.headers['x-csrf-token'], session.csrf); },
  };
}
