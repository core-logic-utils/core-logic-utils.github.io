'use strict';
/*
 * Tabspace account + sync API.  Node 18+.  One dependency: firebase-admin,
 * used ONLY for the Realtime Database (no Auth / Storage / Firestore / Functions / Hosting).
 *
 * Why this exists: Realtime Database cannot verify a username/password on its own, and
 * Firebase Auth is off-limits. So this server verifies passwords (scrypt), issues HttpOnly
 * session cookies, and is the only thing that touches the database. The database rules deny
 * every direct browser read/write.
 *
 * Environment variables
 *   FIREBASE_SERVICE_ACCOUNT  service-account JSON (whole file contents)            [required]
 *   FIREBASE_DATABASE_URL     https://<project>-default-rtdb.firebaseio.com          [required]
 *   ALLOWED_ORIGINS           comma-separated site origins, e.g. https://a.com,https://b.github.io  [required]
 *   IMAGE_HOSTS               allowed background-image hosts (default res.cloudinary.com)
 *   TRUST_PROXY=1             read client IP from X-Forwarded-For (set on Render/Railway/Fly)
 *   PORT                      default 3000
 */
const http = require('http'), crypto = require('crypto'), admin = require('firebase-admin');
const need = (n) => { if (!process.env[n]) { console.error('Missing env var ' + n); process.exit(1); } return process.env[n]; };
admin.initializeApp({ credential: admin.credential.cert(JSON.parse(need('FIREBASE_SERVICE_ACCOUNT'))), databaseURL: need('FIREBASE_DATABASE_URL') });
const db = admin.database();
const ORIGINS = need('ALLOWED_ORIGINS').split(',').map((s) => s.trim()).filter(Boolean);
const IMG_HOSTS = (process.env.IMAGE_HOSTS || 'res.cloudinary.com').split(',').map((s) => s.trim());
const COOKIE = 'ts_session', DAYS = 30, MAX_SAVE = 200000;

const sha = (s) => crypto.createHash('sha256').update(s).digest('hex');
const scrypt = (pw, salt, N) => new Promise((ok, no) => crypto.scrypt(pw, salt, 64, { N, r: 8, p: 3, maxmem: 64 * 1024 * 1024 }, (e, k) => (e ? no(e) : ok(k))));
async function hashPw(pw) { const salt = crypto.randomBytes(16), N = 32768; return ['scrypt', N, salt.toString('base64'), (await scrypt(pw, salt, N)).toString('base64')].join('$'); }
async function verifyPw(pw, stored) {
  const [alg, N, salt, key] = String(stored).split('$');
  if (alg !== 'scrypt') return false;
  const want = Buffer.from(key, 'base64'), got = await scrypt(pw, Buffer.from(salt, 'base64'), +N);
  return want.length === got.length && crypto.timingSafeEqual(want, got);
}
let dummy; const dummyHash = () => (dummy = dummy || hashPw('timing-equalizer'));

const hits = new Map();
const limited = (key, max, win) => { const n = Date.now(), a = (hits.get(key) || []).filter((t) => n - t < win); a.push(n); hits.set(key, a); return a.length > max; };
setInterval(() => hits.clear(), 3600e3).unref();

const send = (res, code, obj, headers) => { res.writeHead(code, Object.assign({ 'Content-Type': 'application/json' }, headers)); res.end(JSON.stringify(obj)); };
const readJson = (req) => new Promise((ok, no) => {
  let b = ''; req.on('data', (c) => { b += c; if (b.length > 400000) { no(Object.assign(new Error('Body too large'), { code: 413 })); req.destroy(); } });
  req.on('end', () => { try { ok(b ? JSON.parse(b) : {}); } catch (e) { no(Object.assign(new Error('Invalid JSON'), { code: 400 })); } });
});
const cookie = (req, n) => { const m = (req.headers.cookie || '').split(/;\s*/).find((c) => c.startsWith(n + '=')); return m ? decodeURIComponent(m.slice(n.length + 1)) : null; };
const ip = (req) => (process.env.TRUST_PROXY === '1' && req.headers['x-forwarded-for'] ? req.headers['x-forwarded-for'].split(',')[0].trim() : req.socket.remoteAddress) || '?';
const setCookie = (v, age) => `${COOKIE}=${encodeURIComponent(v)}; Max-Age=${age}; Path=/; HttpOnly; Secure; SameSite=None`;

async function startSession(res, uid, username, code) {
  const token = crypto.randomBytes(32).toString('base64url'), now = Date.now();
  await db.ref('sessions/' + sha(token)).set({ uid, created: now, exp: now + DAYS * 864e5 });
  send(res, code, { user: { id: uid, username }, token }, { 'Set-Cookie': setCookie(token, DAYS * 86400) });
}
async function auth(req) {
  const h = req.headers.authorization, token = cookie(req, COOKIE) || (h && h.startsWith('Bearer ') ? h.slice(7) : null);
  if (!token) return null;
  const ref = db.ref('sessions/' + sha(token)), s = (await ref.once('value')).val();
  if (!s || s.exp < Date.now()) { if (s) ref.remove(); return null; }
  const username = (await db.ref('accounts/' + s.uid + '/username').once('value')).val();
  if (!username) { ref.remove(); return null; }          // account deleted
  return { uid: s.uid, username, ref };
}

// ----- validators -----
const validImg = (x) => {
  if (!x || typeof x !== 'object' || typeof x.url !== 'string' || x.url.length > 500) return undefined;
  let u; try { u = new URL(x.url); } catch (e) { return undefined; }
  if (u.protocol !== 'https:' || !IMG_HOSTS.includes(u.hostname)) return undefined;
  const n = (v, m) => (Number.isInteger(v) && v >= 0 && v <= m ? v : 0);
  return { url: u.href, w: n(x.w, 1e5), h: n(x.h, 1e5), bytes: n(x.bytes, 5e7), name: typeof x.name === 'string' ? x.name.slice(0, 80) : '' };
};
const SETTINGS = {
  theme: (s) => (typeof s === 'string' && /^#[0-9a-f]{6}$/i.test(s) ? s.toLowerCase() : undefined),
  interactiveBg: (b) => (typeof b === 'boolean' ? b : undefined),
  bgImage: (x) => (x === null ? null : validImg(x))
};

const server = http.createServer(async (req, res) => {
  try {
    res.setHeader('X-Content-Type-Options', 'nosniff'); res.setHeader('Cache-Control', 'no-store');
    const url = new URL(req.url, 'http://x'), path = url.pathname, origin = req.headers.origin;
    if (path === '/health') return send(res, 200, { ok: true });
    const allowed = !!origin && ORIGINS.includes(origin);
    if (allowed) {
      res.setHeader('Access-Control-Allow-Origin', origin); res.setHeader('Access-Control-Allow-Credentials', 'true'); res.setHeader('Vary', 'Origin');
      res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization'); res.setHeader('Access-Control-Allow-Methods', 'GET,POST,PUT,OPTIONS'); res.setHeader('Access-Control-Max-Age', '600');
    }
    if (req.method === 'OPTIONS') { res.writeHead(allowed ? 204 : 403); return res.end(); }
    if (!allowed) return send(res, 403, { error: 'Origin not allowed' });   // also blocks cross-site cookie abuse (CSRF)

    // ----- register / login -----
    if (req.method === 'POST' && (path === '/api/register' || path === '/api/login')) {
      const b = await readJson(req), username = b.username, pw = b.password;
      if (typeof username !== 'string' || typeof pw !== 'string' || !/^[A-Za-z0-9_]{3,20}$/.test(username) || pw.length < 8 || pw.length > 128)
        return send(res, 400, { error: 'Username must be 3–20 letters, numbers or underscores and the password 8–128 characters.' });
      const key = username.toLowerCase();
      if (path === '/api/register') {
        if (limited('reg:' + ip(req), 10, 3600e3)) return send(res, 429, { error: 'Too many attempts' });
        const uid = crypto.randomUUID(), passHash = await hashPw(pw), now = Date.now();
        const claim = await db.ref('usernames/' + key).transaction((c) => (c ? undefined : uid));   // atomic: duplicates rejected
        if (!claim.committed) return send(res, 409, { error: 'That username is already taken.' });
        try {
          await db.ref().update({
            ['accounts/' + uid]: { username, passHash, createdAt: now, schema: 1 },
            ['users/' + uid + '/profile']: { username, createdAt: now },
            ['users/' + uid + '/metadata']: { schema: 1, createdAt: now }
          });
        } catch (e) { await db.ref('usernames/' + key).remove(); throw e; }
        return startSession(res, uid, username, 201);
      }
      if (limited('login:' + ip(req) + ':' + key, 10, 15 * 60e3)) return send(res, 429, { error: 'Too many attempts' });
      const uid = (await db.ref('usernames/' + key).once('value')).val();
      const acct = uid ? (await db.ref('accounts/' + uid).once('value')).val() : null;
      const ok = await verifyPw(pw, acct ? acct.passHash : await dummyHash());
      if (!acct || !ok) return send(res, 401, { error: 'Invalid username or password.' });
      return startSession(res, uid, acct.username, 200);
    }

    // ----- everything below needs a session -----
    const me = await auth(req);
    if (!me) return send(res, 401, { error: 'Not signed in' });
    const base = 'users/' + me.uid;

    if (req.method === 'POST' && path === '/api/logout') { await me.ref.remove(); return send(res, 200, { ok: true }, { 'Set-Cookie': setCookie('', 0) }); }
    if (req.method === 'GET' && path === '/api/session') return send(res, 200, { user: { id: me.uid, username: me.username } });
    if (req.method === 'GET' && path === '/api/data') {
      const [s, g] = await Promise.all([db.ref(base + '/settings').once('value'), db.ref(base + '/gameProgress').once('value')]);
      return send(res, 200, { settings: s.val() || {}, gameProgress: g.val() || {} });
    }
    if (req.method === 'PUT' && limited('w:' + me.uid, 120, 60e3)) return send(res, 429, { error: 'Slow down' });

    if (req.method === 'PUT' && path === '/api/settings') {
      const patch = (await readJson(req)).patch, clean = {}, now = Date.now();
      if (!patch || typeof patch !== 'object') return send(res, 400, { error: 'Missing patch' });
      for (const [k, x] of Object.entries(patch)) {
        if (!SETTINGS[k]) return send(res, 400, { error: 'Unknown setting ' + k });
        if (!x || typeof x.t !== 'number' || !isFinite(x.t) || x.t > now + 864e5) return send(res, 400, { error: 'Bad timestamp for ' + k });
        const v = SETTINGS[k](x.v);
        if (v === undefined) return send(res, 400, { error: 'Invalid value for ' + k });
        clean[k] = v === null ? { t: Math.floor(x.t) } : { v, t: Math.floor(x.t) };
      }
      // per-field last-write-wins; fields not in the patch (including ones newer app versions add) are untouched
      const r = await db.ref(base + '/settings').transaction((cur) => { cur = cur || {}; for (const k in clean) if (!cur[k] || (cur[k].t || 0) <= clean[k].t) cur[k] = clean[k]; return cur; });
      return send(res, 200, { settings: r.snapshot.val() });
    }

    const m = /^\/api\/progress\/([A-Za-z0-9_-]{1,120})$/.exec(path);
    if (req.method === 'PUT' && m) {
      const b = await readJson(req);
      if (typeof b.data !== 'string' || !Number.isInteger(b.baseRev) || b.baseRev < 0) return send(res, 400, { error: 'Bad request' });
      if (b.data.length > MAX_SAVE) return send(res, 413, { error: 'Save too large' });
      const ref = db.ref(base + '/gameProgress/' + m[1]), mk = (rev) => ({ data: b.data, rev, t: Date.now(), size: b.data.length });
      let prev = null;
      const r = await ref.transaction((cur) => {
        prev = cur;
        if (cur === null) return mk(1);                       // first pass may be a cache miss; Firebase re-runs with real data
        if (cur.data === b.data) return cur;                  // identical: no new revision
        if (cur.rev !== b.baseRev && b.force !== true) return;   // someone saved since: abort -> 409
        return mk(cur.rev + 1);
      });
      if (!r.committed) return send(res, 409, { error: 'conflict', current: r.snapshot.val() });
      if (b.force === true && prev && prev.data !== b.data) await db.ref('users/' + me.uid + '/backups/' + m[1]).set(Object.assign({}, prev, { replacedAt: Date.now() }));
      return send(res, 200, { rev: r.snapshot.val().rev });
    }
    return send(res, 404, { error: 'Not found' });
  } catch (e) {
    if (e.code === 413 || e.code === 400) return send(res, e.code, { error: e.message });
    console.error('Server error:', e.message);   // never log passwords or tokens
    send(res, 500, { error: 'Server error' });
  }
});
server.listen(+process.env.PORT || 3000, () => console.log('Tabspace API listening'));
