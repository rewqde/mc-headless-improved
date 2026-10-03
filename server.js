'use strict';
/*
 * mc-headless-improved dashboard (v2).
 * Hardened rewrite of the original server.js:
 *  - single source of truth for version via MC_VERSION / MC_LOADER env
 *  - safe log tailing (never reads whole files into memory)
 *  - command-injection safe (single-line enforced for everything sent to HMC stdin)
 *  - login-code / full status require dashboard auth (no unauth log/code leak)
 *  - CSRF origin check, security headers, rate limits, trustworthy client IP
 *  - structured Microsoft auth state shared with entrypoint via auth-status.json
 *  - password change + logout-all + auth retry without container restart
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const express = require('express');

// ---------------------------------------------------------------- config ---
function numEnv(name, dflt, min, max) {
  const v = Number(process.env[name]);
  if (!Number.isFinite(v) || v < min || v > max) return dflt;
  return Math.floor(v);
}

const PORT = numEnv('PORT', 3000, 1, 65535);
const BIND = process.env.BIND || '0.0.0.0';
const HMC_HOME = process.env.HMC_HOME || '/data';
const LOGS = process.env.MC_LOGS || path.join(HMC_HOME, 'logs');
const GDIR = process.env.MC_GDIR || '/data/.minecraft';
const DATA_DIR = process.env.DASH_DATA || '/app/data';
const TRUST_PROXY = process.env.TRUST_PROXY === '1';
const MC_VERSION = (process.env.MC_VERSION || '1.21.11').trim() || '1.21.11';
const MC_LOADER = (process.env.MC_LOADER || 'fabric').trim().toLowerCase() || 'fabric';
const VERSION_LABEL = `${MC_LOADER}:${MC_VERSION}`;
const LOGIN_DONE = path.join(HMC_HOME, 'logs', '.login-done');
const LOGIN_RETRY_FLAG = path.join(HMC_HOME, 'logs', '.login-retry');
const AUTH_STATUS_FILE = path.join(HMC_HOME, 'logs', 'auth-status.json');
const SERVER_TARGET = path.join(HMC_HOME, 'server.target');
const HMC_CMD = path.join(HMC_HOME, 'hmc-cmd.log');

const PASSWORD_HASH_FILE = path.join(DATA_DIR, 'dashboard-password.hash');
const SESSIONS_FILE = path.join(DATA_DIR, 'dashboard-sessions.json');
const LOGIN_GUARD_FILE = path.join(DATA_DIR, 'dashboard-login-guard.json');
const REVIVE_STATE_FILE = path.join(DATA_DIR, 'revive-state.json');
const MS_DIR = path.join(GDIR, 'minescript');
const APIKEY_REQ = path.join(MS_DIR, 'apikey_request.json');
const APIKEY_RES = path.join(MS_DIR, 'apikey_result.json');

const SESSION_TTL_MS = 30 * 24 * 3600 * 1000;
const MAX_LOGIN_FAILS = 5;
const LOGIN_LOCKOUT_MS = 15 * 60 * 1000;
const MAX_LOG_TAIL_BYTES = 128 * 1024;
const MAX_CMD_FILE_BYTES = 1 * 1024 * 1024;

// ---------------------------------------------------------------- logging --
function log(...a) { console.log(new Date().toISOString(), ...a); }
function warn(...a) { console.warn(new Date().toISOString(), ...a); }

// ------------------------------------------------- filesystem helpers ------
function readJsonFile(p, dflt) {
  try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return dflt; }
}
function writeFileAtomic(p, data, mode = 0o600) {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  const tmp = `${p}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, data, { mode });
  fs.renameSync(tmp, p);
}
function writeJsonFile(p, v) {
  try { writeFileAtomic(p, JSON.stringify(v)); } catch (e) { warn('write failed', p, e.message); }
}

/** Safe tail: reads at most the last MAX_LOG_TAIL_BYTES, returns last `lines`. */
function tailSafe(file, lines = 200) {
  try {
    const st = fs.statSync(file);
    if (st.size === 0) return '';
    const start = Math.max(0, st.size - MAX_LOG_TAIL_BYTES);
    const len = st.size - start;
    const fd = fs.openSync(file, 'r');
    try {
      const buf = Buffer.alloc(len);
      fs.readSync(fd, buf, 0, len, start);
      return buf.toString('utf8').split('\n').filter(Boolean).slice(-lines).join('\n');
    } finally { fs.closeSync(fd); }
  } catch (e) {
    if (e && e.code === 'ENOENT') return '';
    throw e;
  }
}

/** Keep command files bounded so hmc-cmd.log never grows forever. */
function appendBounded(file, line) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  try {
    const st = fs.statSync(file);
    if (st.size > MAX_CMD_FILE_BYTES) {
      const kept = tailSafe(file, 500);
      fs.writeFileSync(file, kept ? kept + '\n' : '');
    }
  } catch (e) { if (!e || e.code !== 'ENOENT') warn('rotate failed', file, e.message); }
  fs.appendFileSync(file, line + '\n');
}
function appendCmd(line) {
  try { appendBounded(path.join(LOGS, 'dashboard-commands.log'), line); }
  catch (e) { warn('appendCmd failed', e.message); }
}
/** Send one single-line command to the running game via HMC stdin bridge. */
function hmc(line) {
  if (typeof line !== 'string' || /[\r\n]/.test(line) || line.length === 0 || line.length > 500) {
    warn('hmc: rejected non-single-line command');
    return;
  }
  try { appendBounded(HMC_CMD, line); }
  catch (e) { warn('hmc bridge write failed', e.message); }
}
/** Strip control chars / newlines from user chat; return '' if nothing safe left. */
function cleanChatLine(s, max = 256) {
  if (typeof s !== 'string') return '';
  const oneLine = s.replace(/[\r\n]+/g, ' ').replace(/[\u0000-\u001F\u007F]/g, '').trim();
  return oneLine.slice(0, max);
}
function bad(res, status, error, extra) {
  res.status(status).json(extra ? { error, ...extra } : { error });
}

// ------------------------------------------------------- dashboard secret --
function loadServiceToken() {
  const TOKEN_FILE = path.join(DATA_DIR, 'dashboard-token');
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    if (fs.existsSync(TOKEN_FILE)) {
      const t = fs.readFileSync(TOKEN_FILE, 'utf8').trim();
      if (t.length >= 16) return t;
    }
    const t = crypto.randomBytes(24).toString('hex');
    writeFileAtomic(TOKEN_FILE, t + '\n');
    log('dashboard service token generated at ' + TOKEN_FILE);
    return t;
  } catch (e) { warn('token load failed', e.message); return ''; }
}
const DASH_TOKEN = loadServiceToken();

// ------------------------------------------------------- password auth -----
function hashDashboardPassword(pw) {
  const salt = crypto.randomBytes(16).toString('hex');
  return `${salt}$${crypto.scryptSync(pw, salt, 32).toString('hex')}`;
}
function loadPasswordHash() {
  try {
    const t = fs.readFileSync(PASSWORD_HASH_FILE, 'utf8').trim();
    if (/^[0-9a-f]{32}\$[0-9a-f]{64}$/.test(t)) return t;
  } catch {}
  const pw = process.env.DASHBOARD_PASSWORD || '';
  if (pw.length >= 4) {
    try {
      const h = hashDashboardPassword(pw);
      // Never overwrite an existing hash; seed only when absent (wx = atomic).
      try {
        fs.mkdirSync(DATA_DIR, { recursive: true });
        fs.writeFileSync(PASSWORD_HASH_FILE, h + '\n', { mode: 0o600, flag: 'wx' });
        log('dashboard password hash seeded at ' + PASSWORD_HASH_FILE + ' (unset DASHBOARD_PASSWORD now)');
        return h;
      } catch (e) {
        if (e.code !== 'EEXIST') throw e;
        // Lost the race / hash appeared — fall through to re-read below.
      }
      const t = fs.readFileSync(PASSWORD_HASH_FILE, 'utf8').trim();
      if (/^[0-9a-f]{32}\$[0-9a-f]{64}$/.test(t)) return t;
    } catch (e) { warn('password seed failed', e.message); }
  }
  if (!process.env.DASHBOARD_PASSWORD) warn('dashboard password NOT set — open the dashboard to create one');
  return '';
}
function verifyDashboardPassword(pw, stored) {
  try {
    const parts = (stored || '').split('$');
    if (parts.length !== 2 || !pw) return false;
    const cand = crypto.scryptSync(pw, parts[0], 32);
    const want = Buffer.from(parts[1], 'hex');
    return cand.length === want.length && crypto.timingSafeEqual(cand, want);
  } catch { return false; }
}
let DASH_PASSWORD_HASH = loadPasswordHash();

// Sessions with a small in-memory cache to avoid file reads on every request.
let sessionCache = { mtime: 0, size: -1, map: {} };
function loadSessions() {
  try {
    const st = fs.statSync(SESSIONS_FILE);
    if (st.mtimeMs === sessionCache.mtime && st.size === sessionCache.size) return sessionCache.map;
    const map = JSON.parse(fs.readFileSync(SESSIONS_FILE, 'utf8'));
    sessionCache = { mtime: st.mtimeMs, size: st.size, map: (map && typeof map === 'object') ? map : {} };
    return sessionCache.map;
  } catch (e) {
    if (e && e.code !== 'ENOENT') warn('sessions read failed', e.message);
    return sessionCache.map || {};
  }
}
function saveSessions(map) {
  writeJsonFile(SESSIONS_FILE, map);
  try {
    const st = fs.statSync(SESSIONS_FILE);
    sessionCache = { mtime: st.mtimeMs, size: st.size, map };
  } catch { sessionCache = { mtime: 0, size: -1, map }; }
}
function sessionTokenFrom(req) {
  const m = /(?:^|;\s*)mch_session=([0-9a-f]{64})/.exec(req.headers.cookie || '');
  if (!m) return null;
  const sessions = loadSessions();
  const exp = sessions[m[1]];
  if (!exp) return null;
  if (Date.now() > exp) {
    delete sessions[m[1]];
    saveSessions(sessions);
    return null;
  }
  return m[1];
}
function issueSession(req, res) {
  const token = crypto.randomBytes(32).toString('hex');
  const now = Date.now();
  const sessions = loadSessions();
  for (const [t, exp] of Object.entries(sessions)) if (now > exp) delete sessions[t];
  // Bound growth: keep at most 50 live sessions, evicting the soonest-expiring.
  const keys = Object.keys(sessions);
  if (keys.length >= 50) {
    keys.sort((a, b) => sessions[a] - sessions[b]);
    for (const k of keys.slice(0, keys.length - 49)) delete sessions[k];
  }
  sessions[token] = now + SESSION_TTL_MS;
  saveSessions(sessions);
  const secure = isSecureRequest(req);
  res.setHeader('Set-Cookie',
    `mch_session=${token}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${Math.floor(SESSION_TTL_MS / 1000)}${secure ? '; Secure' : ''}`);
  return token;
}
function isSecureRequest(req) {
  try {
    if (req && req.socket && req.socket.encrypted) return true;
    if (TRUST_PROXY && req && String(req.headers['x-forwarded-proto'] || '').split(',')[0].trim() === 'https') return true;
  } catch {}
  return false;
}

// Trust X-Forwarded-* only behind an explicit trusted proxy; otherwise the
// socket address is the client (prevents XFF-spoofed lockout bypass).
function clientIp(req) {
  if (TRUST_PROXY) {
    const xff = (req.headers['x-forwarded-for'] || '').split(',')[0].trim();
    if (xff) return xff.slice(0, 64);
  }
  return (req.socket.remoteAddress || 'unknown').slice(0, 64);
}

// ------------------------------------------------- Microsoft auth state ----
/*
 * Entrypoint v2 writes logs/auth-status.json atomically:
 *   { status, code, verification_uri, full_url, expires_at, message, updated_at }
 * status: pending | waiting | authenticated | expired | failed | skipped | unknown
 * The dashboard prefers that file and falls back to parsing login.log so old
 * images / in-progress logins still surface a code.
 */
function parseLoginLog(raw) {
  if (!raw) return null;
  const uriM = raw.match(/https?:\/\/[^\s"'<>]*microsoft\.com\/(?:link|devicelogin)[^\s"'<>]*/i)
    || raw.match(/https?:\/\/aka\.ms[^\s"'<>]*/i);
  if (!uriM) return null;
  let uri = uriM[0].replace(/[.,;)]+$/, '');
  // Most reliable: the code embedded in the printed URL (?otc=XXXXXXXX).
  let code = null;
  const otcM = uri.match(/[?&]otc=([A-Z0-9-]{4,17})/i);
  if (otcM) code = otcM[1].toUpperCase();
  if (!code) {
    // Fallback: standalone code near the URL. Prefer XXXX-XXXX form, then a
    // bare token — but only if it is NOT part of a longer word and not a
    // common log word (avoids surfacing e.g. DOWNLOAD as a "code").
    const near = raw.slice(Math.max(0, raw.indexOf(uriM[0]) - 300), raw.indexOf(uriM[0]) + uriM[0].length + 300);
    const dashM = near.match(/\b([A-Z0-9]{4}-[A-Z0-9]{4})\b/);
    const bareM = near.match(/\b([A-Z0-9]{8,9})\b/);
    const STOP = new Set(['DOWNLOAD', 'FABRIC', 'MINECRAFT', 'MICROSOFT', 'HEADLESS', 'LAUNCHER', 'VERSION', 'SPECIFICS', 'SUCCESS']);
    code = (dashM && dashM[1]) || null;
    if (!code && bareM && !STOP.has(bareM[1])) code = bareM[1];
  }
  if (!code) return null;
  const hasOtc = /[?&]otc=/i.test(uri);
  const base = uri.replace(/[?&]otc=[^&\s]*/i, '').replace(/[?&]$/, '');
  const fullUrl = hasOtc ? uri : `${base}${base.includes('?') ? '&' : '?'}otc=${code}`;
  const expM = raw.match(/expir\w*\s*(?:in|within)?\s*(\d+)\s*(minute|second)/i);
  let expiresInSec = null;
  if (expM) expiresInSec = expM[2].toLowerCase().startsWith('min') ? Number(expM[1]) * 60 : Number(expM[1]);
  const lastLine = raw.trim().split('\n').slice(-1)[0].slice(0, 300);
  return { code, url: base, fullUrl, expiresInSec, lastLine };
}
function readMsAuth() {
  // 1) structured file from entrypoint v2
  try {
    const s = JSON.parse(fs.readFileSync(AUTH_STATUS_FILE, 'utf8'));
    if (s && typeof s === 'object') {
      const authenticated = s.status === 'authenticated' || fs.existsSync(LOGIN_DONE);
      if (!authenticated && (s.status === 'waiting' || s.status === 'pending')) {
        // A code printed >20 min ago is dead (device codes live ~15 min).
        // Report expired so the UI prompts Retry instead of showing a dead code.
        const ageMs = s.updated_at ? Date.now() - new Date(s.updated_at).getTime() : NaN;
        if (Number.isFinite(ageMs) && ageMs > 20 * 60 * 1000) {
          return {
            source: 'auth-status.json', status: 'expired', needs_login: true, authenticated: false,
            code: s.code || null, url: s.verification_uri || s.url || null,
            fullUrl: s.full_url || s.fullUrl || null, expires_at: null,
            message: 'Code expired — use Retry login for a fresh one', updated_at: s.updated_at || null,
          };
        }
      }
      return {
        source: 'auth-status.json',
        status: s.status || (authenticated ? 'authenticated' : 'unknown'),
        needs_login: !authenticated,
        authenticated,
        code: s.code || null,
        url: s.verification_uri || s.url || null,
        fullUrl: s.full_url || s.fullUrl || null,
        expires_at: s.expires_at || null,
        message: s.message || null,
        updated_at: s.updated_at || null,
      };
    }
  } catch {}
  // 2) legacy: marker + log parse
  let authenticated = false;
  try { authenticated = fs.existsSync(LOGIN_DONE); } catch {}
  if (authenticated) return { source: 'marker', status: 'authenticated', needs_login: false, authenticated: true };
  const raw = tailSafe(path.join(LOGS, 'login.log'), 500);
  if (!raw) {
    // also try HMC_HOME/logs (LOGS may be remapped)
    const alt = HMC_HOME === LOGS ? '' : tailSafe(path.join(HMC_HOME, 'logs', 'login.log'), 500);
    const parsed = parseLoginLog(alt);
    if (parsed) return { source: 'login.log', status: 'waiting', needs_login: true, authenticated: false, ...parsed };
    return { source: 'none', status: 'unknown', needs_login: true, authenticated: false };
  }
  const low = raw.toLowerCase();
  if (/signed in|logged in|login completed|login successful|authenticated/.test(low)) {
    return { source: 'login.log', status: 'authenticated', needs_login: false, authenticated: true };
  }
  const parsed = parseLoginLog(raw);
  if (parsed) {
    const expired = /expired|cancelled/.test(low);
    return { source: 'login.log', status: expired ? 'expired' : 'waiting', needs_login: true, authenticated: false, ...parsed };
  }
  return { source: 'login.log', status: 'unknown', needs_login: true, authenticated: false, lastLine: raw.trim().split('\n').slice(-1)[0].slice(0, 300) };
}
function hasStoredAccount() {
  // HeadlessMC keeps credentials under <home>/HeadlessMC/auth/ (.account.json).
  // Only report presence (boolean) — never read or return secrets.
  try {
    const dir = path.join(HMC_HOME, 'HeadlessMC', 'auth');
    return fs.existsSync(path.join(dir, '.account.json')) || fs.existsSync(path.join(dir, 'account.json'));
  } catch { return false; }
}

// -------------------------------------------------------------- app --------
const app = express();
app.disable('x-powered-by');
app.use(express.json({ limit: '32kb' }));

// Security headers (no extra dependency so `npm ci` stays trivial).
app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
  next();
});

// Lightweight CSRF check: browsers send Origin on cross-site POSTs.
// Same-origin fetch and curl (no Origin) pass; forged cross-site forms fail.
app.use((req, res, next) => {
  if (req.method === 'GET' || req.method === 'HEAD') return next();
  const origin = req.headers.origin;
  if (!origin) return next();
  try {
    const o = new URL(origin);
    const host = (req.headers.host || '').split(':')[0].toLowerCase();
    const oh = o.hostname.toLowerCase();
    if (oh === host || oh === 'localhost' || oh === '127.0.0.1') return next();
  } catch {}
  return bad(res, 403, 'origin not allowed');
});

// Static frontend with no-cache for HTML shell.
const pub = path.join(__dirname, 'public');
if (fs.existsSync(pub)) {
  app.use((req, res, next) => {
    if (req.path === '/' || req.path.endsWith('.html')) res.setHeader('Cache-Control', 'no-store');
    next();
  }, express.static(pub, { dotfiles: 'ignore', index: 'index.html' }));
}

// Simple in-memory rate limiter (per-IP sliding window) for hot endpoints.
const buckets = new Map();
function rateLimit({ windowMs, max, key = '' }) {
  return (req, res, next) => {
    const ip = clientIp(req);
    const k = `${key}|${ip}`;
    const now = Date.now();
    let b = buckets.get(k);
    if (!b || now > b.reset) b = { n: 0, reset: now + windowMs };
    b.n += 1;
    buckets.set(k, b);
    // Bound memory: drop expired buckets when the table gets large.
    if (buckets.size > 2000) {
      for (const [kk, bb] of buckets) if (now > bb.reset) buckets.delete(kk);
    }
    if (b.n > max) {
      res.setHeader('Retry-After', Math.ceil((b.reset - now) / 1000));
      return bad(res, 429, 'too many requests', { retry_after_sec: Math.ceil((b.reset - now) / 1000) });
    }
    next();
  };
}

// ---------------------------------------------------------- auth routes ----
app.post('/api/login', rateLimit({ windowMs: 60 * 1000, max: 30, key: 'login' }), async (req, res) => {
  const ip = clientIp(req);
  const guard = readJsonFile(LOGIN_GUARD_FILE, {});
  // Prune stale guard entries so the file cannot grow forever (one per IP).
  const now0 = Date.now();
  for (const [k, v] of Object.entries(guard)) {
    if (!v || typeof v !== 'object') { delete guard[k]; continue; }
    if ((!v.locked_until || now0 >= v.locked_until) && (!v.at || now0 - v.at > 24 * 3600 * 1000)) delete guard[k];
  }
  const g = guard[ip] || { fails: 0, locked_until: 0, at: now0 };
  const now = Date.now();
  if (g.locked_until && now < g.locked_until) {
    return bad(res, 429, 'locked out', { retry_after_sec: Math.ceil((g.locked_until - now) / 1000) });
  }
  const pw = typeof req.body?.password === 'string' ? req.body.password : '';
  if (!DASH_PASSWORD_HASH || !verifyDashboardPassword(pw, DASH_PASSWORD_HASH)) {
    await new Promise((r) => setTimeout(r, 800 + Math.floor(Math.random() * 700)));
    g.fails = (g.fails || 0) + 1;
    g.at = now;
    if (g.fails >= MAX_LOGIN_FAILS) {
      g.locked_until = now + LOGIN_LOCKOUT_MS;
      g.fails = 0;
      warn(`dashboard login: ${ip} LOCKED OUT for 15m after ${MAX_LOGIN_FAILS} failed attempts`);
    } else {
      warn(`dashboard login: failed attempt ${g.fails}/${MAX_LOGIN_FAILS} from ${ip}`);
    }
    guard[ip] = g;
    writeJsonFile(LOGIN_GUARD_FILE, guard);
    return bad(res, 401, 'wrong password');
  }
  delete guard[ip];
  writeJsonFile(LOGIN_GUARD_FILE, guard);
  issueSession(req, res);
  log(`dashboard login: ${ip} logged in`);
  res.json({ ok: true });
});

app.post('/api/logout', (req, res) => {
  const tok = sessionTokenFrom(req);
  if (tok) { const s = loadSessions(); delete s[tok]; saveSessions(s); }
  const secure = isSecureRequest(req);
  res.setHeader('Set-Cookie', `mch_session=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0${secure ? '; Secure' : ''}`);
  res.json({ ok: true });
});

app.post('/api/logout-all', (req, res) => {
  if (!sessionTokenFrom(req)) return bad(res, 401, 'auth required');
  saveSessions({});
  const secure = isSecureRequest(req);
  res.setHeader('Set-Cookie', `mch_session=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0${secure ? '; Secure' : ''}`);
  res.json({ ok: true });
});

// First-run setup only. Creates the password AND logs the browser in
// immediately so no restart / second login step is needed.
app.post('/api/setup', rateLimit({ windowMs: 3600 * 1000, max: 20, key: 'setup' }), (req, res) => {
  if (DASH_PASSWORD_HASH || fs.existsSync(PASSWORD_HASH_FILE))
    return bad(res, 403, 'already configured');
  const pw = typeof req.body?.password === 'string' ? req.body.password : '';
  if (pw.length < 12 || pw.length > 256)
    return bad(res, 400, 'Use a password between 12 and 256 characters');
  try {
    const hash = hashDashboardPassword(pw);
    // Atomic first-writer-wins: 'wx' fails if another setup won the race.
    fs.mkdirSync(DATA_DIR, { recursive: true });
    try {
      fs.writeFileSync(PASSWORD_HASH_FILE, hash + '\n', { mode: 0o600, flag: 'wx' });
    } catch (e) {
      if (e.code === 'EEXIST') return bad(res, 403, 'already configured');
      throw e;
    }
  } catch (e) {
    warn('dashboard setup failed', e.message);
    return bad(res, 500, 'Could not save password');
  }
  // Re-read to handle a concurrent winner; keep the first writer's hash.
  try {
    const onDisk = fs.readFileSync(PASSWORD_HASH_FILE, 'utf8').trim();
    if (/^[0-9a-f]{32}\$[0-9a-f]{64}$/.test(onDisk)) DASH_PASSWORD_HASH = onDisk;
  } catch {}
  log('dashboard password configured');
  issueSession(req, res);
  res.json({ ok: true });
});

app.post('/api/change-password', (req, res) => {
  if (!sessionTokenFrom(req)) return bad(res, 401, 'auth required');
  const cur = typeof req.body?.current === 'string' ? req.body.current : '';
  const next = typeof req.body?.password === 'string' ? req.body.password : '';
  if (!verifyDashboardPassword(cur, DASH_PASSWORD_HASH)) return bad(res, 401, 'wrong password');
  if (next.length < 12 || next.length > 256) return bad(res, 400, 'Use a password between 12 and 256 characters');
  const hash = hashDashboardPassword(next);
  writeFileAtomic(PASSWORD_HASH_FILE, hash + '\n', 0o600);
  DASH_PASSWORD_HASH = hash;
  saveSessions({}); // invalidate all sessions incl. current — user logs in again
  log('dashboard password changed; all sessions revoked');
  res.json({ ok: true });
});

app.get('/api/auth-check', (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  res.json({ authed: !!sessionTokenFrom(req), configured: !!DASH_PASSWORD_HASH });
});

// ------------------------------------------------------- authz gate --------
const PUBLIC_API = new Set(['/api/health', '/api/auth-check', '/api/ms-needs-login']);
app.use((req, res, next) => {
  if (!req.path.startsWith('/api/')) return next();
  if (req.method === 'GET' && PUBLIC_API.has(req.path)) return next();
  if (req.path === '/api/login' || req.path === '/api/logout' || req.path === '/api/setup') return next();
  if (sessionTokenFrom(req)) return next();
  if (DASH_TOKEN && (req.headers.authorization || '') === `Bearer ${DASH_TOKEN}`) {
    // service-to-service only (pulse revival loop) — same guard as before.
    if (req.path === '/api/revive-key') return next();
  }
  bad(res, 401, 'auth required');
});

// ------------------------------------------------------------- helpers -----
function isRunning() {
  try {
    for (const pid of fs.readdirSync('/proc')) {
      if (!/^\d+$/.test(pid)) continue;
      try {
        const cmd = fs.readFileSync(`/proc/${pid}/cmdline`, 'utf8').replace(/\0/g, ' ');
        if (cmd.includes('headlessmc') || cmd.includes('.minecraft')) return true;
      } catch {}
    }
  } catch {}
  return false;
}
function readTarget() {
  try {
    const raw = fs.readFileSync(SERVER_TARGET, 'utf8').trim().split('\n')[0].trim();
    // host:port — hostname, IPv4, or bracketed IPv6.
    const m = raw.match(/^(?:\[([0-9a-fA-F:]+)\]|([A-Za-z0-9.-]+)):(\d+)$/);
    if (m) {
      const host = m[1] || m[2];
      const port = Number(m[3]);
      if (port >= 1 && port <= 65535 && host.length <= 253) return { host, port, target: raw };
    }
  } catch {}
  return { host: '', port: 25565, target: '' };
}

// -------------------------------------------------------------- routes -----
app.get('/api/health', (_req, res) => {
  res.json({ status: 'ok', mc: MC_VERSION, loader: MC_LOADER, port: PORT });
});

/** Public minimal Microsoft state — booleans only, never codes/URLs/logs. */
app.get('/api/ms-needs-login', rateLimit({ windowMs: 60 * 1000, max: 60, key: 'ms' }), (_req, res) => {
  const ms = readMsAuth();
  res.json({ needs_login: ms.needs_login, authenticated: ms.authenticated, configured: !!DASH_PASSWORD_HASH });
});

app.get('/api/status', (_req, res) => {
  const ms = readMsAuth();
  const t = readTarget();
  res.json({
    running: isRunning(),
    loginPending: ms.needs_login,
    ms: { status: ms.status, authenticated: ms.authenticated, account_present: hasStoredAccount() },
    version: VERSION_LABEL,
    mc: MC_VERSION,
    loader: MC_LOADER,
    target: t.target || null,
    log: tailSafe(path.join(LOGS, 'entrypoint.log'), 30),
  });
});

/** Full Microsoft device-login state. Requires dashboard auth (no code leak). */
app.get('/api/auth-status', (req, res) => {
  const ms = readMsAuth();
  let expiresInSec = null;
  if (ms.expires_at) expiresInSec = Math.max(0, Math.round((new Date(ms.expires_at).getTime() - Date.now()) / 1000));
  else if (typeof ms.expiresInSec === 'number') expiresInSec = ms.expiresInSec;
  res.json({
    needs_login: ms.needs_login,
    authenticated: ms.authenticated,
    status: ms.status,
    code: ms.code || null,
    url: ms.url || null,
    fullUrl: ms.fullUrl || null,
    expires_in_sec: expiresInSec,
    account_present: hasStoredAccount(),
    message: ms.message || null,
    last_line: ms.lastLine || null,
    login_timeout_sec: numEnv('HMC_LOGIN_TIMEOUT', 600, 30, 3600),
  });
});

// Back-compat alias for older dashboards.
app.get('/api/login-code', (req, res) => {
  const ms = readMsAuth();
  if (ms.authenticated || !ms.code || !ms.url) return bad(res, 404, 'No pending login code');
  let expiresInSec = null;
  if (ms.expires_at) expiresInSec = Math.max(0, Math.round((new Date(ms.expires_at).getTime() - Date.now()) / 1000));
  else if (typeof ms.expiresInSec === 'number') expiresInSec = ms.expiresInSec;
  res.json({ code: ms.code, url: ms.url, fullUrl: ms.fullUrl, expires_in_sec: expiresInSec, raw: ms.lastLine || '' });
});

/*
 * Ask the entrypoint supervisor for a fresh Microsoft device code WITHOUT
 * restarting the container. The entrypoint watches this flag file and starts
 * a new interactive `login` run within ~10s. (On the legacy entrypoint the
 * flag is ignored — the response tells the user to restart instead.)
 */
app.post('/api/auth-retry', (req, res) => {
  try {
    fs.mkdirSync(path.dirname(LOGIN_RETRY_FLAG), { recursive: true });
    fs.writeFileSync(LOGIN_RETRY_FLAG, String(Date.now()) + '\n');
    try { fs.unlinkSync(LOGIN_DONE); } catch {}
    try { fs.unlinkSync(AUTH_STATUS_FILE); } catch {}
    appendCmd('auth-retry requested from dashboard');
    log('auth-retry requested from dashboard');
    res.json({ ok: true, message: 'Fresh Microsoft login requested — a new code appears within ~10s. If nothing appears, restart the container.' });
  } catch (e) {
    warn('auth-retry failed', e.message);
    bad(res, 500, 'Could not request login retry');
  }
});

app.post('/api/chat', (req, res) => {
  const msg = cleanChatLine(req.body?.msg, 256);
  if (!msg) return bad(res, 400, 'msg required');
  appendCmd(`msg ${msg}`);
  hmc(`msg ${msg}`);
  res.json({ ok: true });
});

const SCRIPT_ALLOW = new Set(['afk', 'telemetry']);
app.post('/api/script', (req, res) => {
  const name = typeof req.body?.name === 'string' ? req.body.name.trim() : '';
  const action = req.body?.action === undefined ? 'start' : req.body.action;
  if (action !== 'start' && action !== 'stop') return bad(res, 400, 'action must be start|stop');
  if (!SCRIPT_ALLOW.has(name)) return bad(res, 400, 'script not allowed');

  const cfgPath = path.join(GDIR, 'minescript', 'config.txt');
  const autorunLine = `autorun[*]=${name}`;

  if (action === 'start') {
    if (!fs.existsSync(path.join(GDIR, 'minescript', `${name}.py`)))
      return bad(res, 404, 'script not installed');
    try {
      fs.mkdirSync(path.dirname(cfgPath), { recursive: true });
      let txt = '';
      try { txt = fs.readFileSync(cfgPath, 'utf8'); } catch (e) { if (!e || e.code !== 'ENOENT') throw e; }
      if (!txt.split('\n').includes(autorunLine)) {
        const sep = txt && !txt.endsWith('\n') ? '\n' : '';
        if (!txt) txt = 'python="/usr/bin/python3"\n';
        fs.writeFileSync(cfgPath, txt + sep + autorunLine + '\n');
      }
    } catch (e) {
      warn('script config write failed', e.message);
      return bad(res, 500, 'Failed to write minescript config');
    }
    appendCmd(`run ${name}`);
    hmc('msg \\' + name);
    const { host, port, target } = readTarget();
    if (!host) return res.json({ ok: true, script: name, action: 'start', target: null, note: 'No server target saved — set one with Connect first.' });
    hmc('disconnect');
    setTimeout(() => hmc(`connect ${host} ${port}`), 8000);
    return res.json({ ok: true, script: name, action: 'start', target });
  }

  try {
    if (fs.existsSync(cfgPath)) {
      const txt = fs.readFileSync(cfgPath, 'utf8');
      fs.writeFileSync(cfgPath, txt.split('\n').filter((l) => l !== autorunLine).join('\n'));
    }
  } catch (e) {
    warn('script config write failed', e.message);
    return bad(res, 500, 'Failed to write minescript config');
  }
  hmc('disconnect');
  return res.json({ ok: true, script: name, action: 'stop' });
});

const MOVE_ALLOW = new Set(['forward', 'back', 'left', 'right', 'jump', 'sneak', 'stop']);
const MOVE_KEY = {
  forward: 'key w --duration 600',
  back: 'key s --duration 600',
  left: 'key a --duration 600',
  right: 'key d --duration 600',
  jump: 'key space --duration 400',
  sneak: 'key shift --duration 800',
  stop: ['key -release w', 'key -release a', 'key -release s', 'key -release d', 'key -release space', 'key -release shift'],
};
app.post('/api/move', (req, res) => {
  const { dir, yaw, pitch } = req.body || {};
  if (typeof dir === 'string' && dir.trim()) {
    const d = dir.trim();
    if (!MOVE_ALLOW.has(d)) return bad(res, 400, 'dir must be forward|back|left|right|jump|sneak|stop');
    appendCmd(`move ${d}`);
    const k = MOVE_KEY[d];
    if (Array.isArray(k)) k.forEach((l) => hmc(l));
    else hmc(k);
    return res.json({ ok: true, dir: d });
  }
  if (yaw !== undefined || pitch !== undefined) {
    const y = Number(yaw), p = Number(pitch);
    if (!Number.isFinite(y) || !Number.isFinite(p)) return bad(res, 400, 'yaw and pitch must be numbers');
    if (y < -180 || y > 180 || p < -90 || p > 90) return bad(res, 400, 'yaw must be -180..180, pitch -90..90');
    appendCmd(`orient ${y} ${p}`);
    // Honest contract: the base hmc-specifics build has no look command, so the
    // request is queued for the optional look-supervisor instead of pretending.
    try {
      writeFileAtomic(path.join(MS_DIR, 'look_request.json'), JSON.stringify({ yaw: y, pitch: p, at: Date.now() }));
    } catch (e) { warn('look queue failed', e.message); }
    return res.json({ ok: true, yaw: y, pitch: p, applied: false, note: 'Look is queued — it applies when the look supervisor script is running.' });
  }
  return bad(res, 400, 'Provide dir (forward|back|left|right|jump|sneak|stop) or yaw+pitch');
});

const PRESS_ALLOW = new Set(['sneak', 'attack', 'use']);
const PRESS_KEY = {
  sneak: 'key shift --duration 800',
  attack: 'key mouse0 --duration 500',
  use: 'key mouse1 --duration 500',
};
app.post('/api/press', (req, res) => {
  const key = typeof req.body?.key === 'string' ? req.body.key.trim() : '';
  if (!PRESS_ALLOW.has(key)) return bad(res, 400, 'key must be sneak|attack|use');
  appendCmd(`press ${key}`);
  hmc(PRESS_KEY[key]);
  res.json({ ok: true });
});

app.get('/api/logs', (req, res) => {
  const lines = Math.min(Math.max(Number(req.query.lines) || 200, 1), 500);
  res.json({
    game: tailSafe(path.join(GDIR, 'logs', 'latest.log'), lines),
    entrypoint: tailSafe(path.join(LOGS, 'entrypoint.log'), lines),
    dashboard: tailSafe(path.join(LOGS, 'dashboard.log'), lines),
  });
});

app.post('/api/connect', (req, res) => {
  const host = typeof req.body?.host === 'string' ? req.body.host.trim() : '';
  const rawPort = req.body?.port;
  const port = rawPort === undefined || rawPort === '' ? 25565 : Number(rawPort);
  if (!/^[A-Za-z0-9]([A-Za-z0-9.-]{0,251}[A-Za-z0-9])?$/.test(host) || host.length > 253)
    return bad(res, 400, 'invalid host (hostname or IPv4; IPv6 not supported yet)');
  if (!Number.isInteger(port) || port < 1 || port > 65535) return bad(res, 400, 'invalid port');
  // Block newline/command injection even though the regex already excludes it.
  if (/[\r\n]/.test(host)) return bad(res, 400, 'invalid host');
  const target = `${host}:${port}`;
  try {
    writeFileAtomic(SERVER_TARGET, target + '\n', 0o644);
  } catch (e) {
    warn('server.target write failed', e.message);
    return bad(res, 500, 'Failed to write server.target');
  }
  hmc(`connect ${host} ${port}`);
  res.json({ ok: true, target });
});

app.post('/api/disconnect', (_req, res) => {
  hmc('disconnect');
  res.json({ ok: true });
});

app.get('/api/telemetry', (_req, res) => {
  // latest.log can be hundreds of MB on long AFK runs — tail only.
  const logText = tailSafe(path.join(GDIR, 'logs', 'latest.log'), 200);
  if (!logText) {
    try { fs.statSync(path.join(GDIR, 'logs', 'latest.log')); }
    catch (e) {
      if (e.code === 'ENOENT') return bad(res, 404, 'No telemetry yet — join a world and run telemetry script');
      warn('telemetry read failed', e.message);
      return bad(res, 500, 'Failed to read latest.log');
    }
    return bad(res, 404, 'No telemetry yet — join a world and run telemetry script');
  }
  const last = logText.split('\n').reverse().find((l) => l.includes('TELEMETRY '));
  if (!last) return bad(res, 404, 'No telemetry yet — join a world and run telemetry script');
  const json = last.slice(last.indexOf('TELEMETRY ') + 'TELEMETRY '.length).trim();
  try {
    const obj = JSON.parse(json);
    if (obj && typeof obj === 'object' && typeof obj.ts === 'number') {
      obj.age_sec = Math.max(0, Math.round(Date.now() / 1000 - obj.ts));
    }
    res.json(obj);
  } catch (e) {
    warn('telemetry parse failed', e.message);
    bad(res, 500, 'Failed to parse telemetry');
  }
});

// Diagnostics bundle for "why won't it join?" — no secrets included.
app.get('/api/doctor', (_req, res) => {
  const t = readTarget();
  const ms = readMsAuth();
  let mods = [];
  try { mods = fs.readdirSync(path.join(GDIR, 'mods')).filter((f) => f.endsWith('.jar')).slice(0, 50); }
  catch {}
  res.json({
    version: VERSION_LABEL,
    running: isRunning(),
    ms_status: ms.status,
    account_present: hasStoredAccount(),
    target: t.target || null,
    disk_free_mb: (() => {
      try {
        if (typeof fs.statfsSync === 'function') {
          const s = fs.statfsSync(HMC_HOME);
          return Math.floor((s.bfree * s.bsize) / (1024 * 1024));
        }
      } catch {}
      return null;
    })(),
    mods_count: mods.length,
    mods: mods.slice(0, 20),
    files: {
      login_log: tailSafe(path.join(LOGS, 'login.log'), 5).split('\n').filter(Boolean).length > 0,
      entrypoint_log: tailSafe(path.join(LOGS, 'entrypoint.log'), 1).length > 0,
      game_log: (() => { try { return fs.statSync(path.join(GDIR, 'logs', 'latest.log')).size; } catch { return -1; } })(),
    },
  });
});

// ------------------------------------- API key revival (kept, tightened) --
const REVIVE_COOLDOWN_OK_MS = 4 * 3600 * 1000;
const REVIVE_COOLDOWN_FAIL_MS = 30 * 60 * 1000;
const REVIVE_TIMEOUT_MS = 20 * 60 * 1000;
const APIKEY_AUTORUN = 'autorun[*]=\\apikey';

function reviveState() { return readJsonFile(REVIVE_STATE_FILE, { in_progress: false }); }
function writeReviveState(s) {
  try { writeFileAtomic(REVIVE_STATE_FILE, JSON.stringify(s)); } catch (e) { warn('revive state write failed', e.message); }
}
function ensureApikeyAutorun(on) {
  const cfgPath = path.join(MS_DIR, 'config.txt');
  let txt = '';
  try { txt = fs.readFileSync(cfgPath, 'utf8'); } catch {}
  const has = txt.split('\n').includes(APIKEY_AUTORUN);
  try {
    fs.mkdirSync(path.dirname(cfgPath), { recursive: true });
    if (on && !has) {
      const sep = txt && !txt.endsWith('\n') ? '\n' : '';
      if (!txt) txt = 'python="/usr/bin/python3"\n';
      fs.writeFileSync(cfgPath, txt + sep + APIKEY_AUTORUN + '\n');
    } else if (!on && has) {
      fs.writeFileSync(cfgPath, txt.split('\n').filter((l) => l !== APIKEY_AUTORUN).join('\n'));
    }
  } catch (e) { warn('apikey autorun write failed', e.message); }
}
function postCallback(url, payload, attempt) {
  const body = JSON.stringify(payload);
  let u;
  try { u = new URL(url); } catch { return; }
  const mod = u.protocol === 'https:' ? require('https') : require('http');
  const creq = mod.request({
    method: 'POST', hostname: u.hostname, port: u.port, path: u.pathname + u.search,
    headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body), 'Authorization': `Bearer ${DASH_TOKEN}` },
    timeout: 10000,
  }, (cres) => {
    log(`revive callback -> ${cres.statusCode} (attempt ${attempt})`);
    cres.resume();
    if (cres.statusCode >= 400 && attempt < 4) setTimeout(() => postCallback(url, payload, attempt + 1), 15000 * attempt);
  });
  creq.on('error', (e) => {
    warn('revive callback error', e.message);
    if (attempt < 4) setTimeout(() => postCallback(url, payload, attempt + 1), 15000 * attempt);
  });
  creq.on('timeout', () => creq.destroy(new Error('timeout')));
  try { creq.write(body); creq.end(); }
  catch (e) {
    warn('revive callback write failed', e.message);
    if (attempt < 4) setTimeout(() => postCallback(url, payload, attempt + 1), 15000 * attempt);
  }
}
let revivePoller = null;
function watchReviveResult(id, callbackUrl, startedAt) {
  if (revivePoller) clearInterval(revivePoller);
  revivePoller = setInterval(() => {
    const st = reviveState();
    if (!st.in_progress || st.id !== id) { clearInterval(revivePoller); revivePoller = null; return; }
    if (Date.now() - startedAt > REVIVE_TIMEOUT_MS) {
      clearInterval(revivePoller); revivePoller = null;
      ensureApikeyAutorun(false);
      writeReviveState({ ...st, in_progress: false, finished_at: Date.now(), last_result: { status: 'error', error: 'timeout waiting for in-game capture' } });
      postCallback(callbackUrl, { status: 'error', error: 'timeout waiting for in-game capture' }, 1);
      return;
    }
    const out = readJsonFile(APIKEY_RES, null);
    if (!out || out.id !== id) return;
    clearInterval(revivePoller); revivePoller = null;
    ensureApikeyAutorun(false);
    try { fs.unlinkSync(APIKEY_RES); } catch {}
    writeReviveState({ ...st, in_progress: false, finished_at: Date.now(), last_result: { status: out.status, error: out.error || null, chat_tail: (out.chat || []).slice(-8) } });
    postCallback(callbackUrl, { status: out.status, key: out.key || null, error: out.error || null }, 1);
  }, 5000);
}
app.get('/api/revive-key', (_req, res) => {
  const st = reviveState();
  res.json({
    in_progress: !!st.in_progress,
    id: st.id || null,
    requested_at: st.requested_at || null,
    last_attempt_at: st.last_attempt_at || null,
    last_result: st.last_result || null,
    cooldown_ok_ms: REVIVE_COOLDOWN_OK_MS,
    cooldown_fail_ms: REVIVE_COOLDOWN_FAIL_MS,
  });
});
app.post('/api/revive-key', (req, res) => {
  const callbackUrl = typeof req.body?.callback_url === 'string' ? req.body.callback_url.trim() : '';
  let u;
  try { u = new URL(callbackUrl); } catch { return bad(res, 400, 'callback_url required'); }
  if (u.protocol !== 'http:' || !/^(172\.17\.0\.1|127\.0\.0\.1|localhost)$/.test(u.hostname))
    return bad(res, 400, 'callback_url must be internal');
  const st = reviveState();
  if (st.in_progress) return res.status(409).json({ error: 'revival already in progress', id: st.id });
  const now = Date.now();
  const cooldown = st.last_result && st.last_result.status === 'ok' ? REVIVE_COOLDOWN_OK_MS : REVIVE_COOLDOWN_FAIL_MS;
  if (st.last_attempt_at && now - st.last_attempt_at < cooldown)
    return res.status(429).json({ error: 'cooldown', retry_after_sec: Math.ceil((cooldown - (now - st.last_attempt_at)) / 1000) });
  if (!fs.existsSync(path.join(MS_DIR, 'apikey.py'))) return bad(res, 500, 'apikey.py not installed');

  const id = crypto.randomBytes(8).toString('hex');
  try { fs.unlinkSync(APIKEY_RES); } catch {}
  try {
    writeFileAtomic(APIKEY_REQ, JSON.stringify({ id, requested_at: Math.floor(now / 1000) }));
  } catch (e) { warn('revive request write failed', e.message); return bad(res, 500, 'failed to write request file'); }
  ensureApikeyAutorun(true);
  writeReviveState({ in_progress: true, id, requested_at: now, last_attempt_at: now, callback_url: callbackUrl });

  const { host, port, target } = readTarget();
  if (!host) return res.status(202).json({ ok: true, id, target: null, note: 'No server target saved — set one with Connect first.' });
  const preDelay = 20000 + Math.floor(Math.random() * 70000);
  appendCmd(`revive-key ${id} -> reconnect ${target} in ${Math.round(preDelay / 1000)}s`);
  setTimeout(() => {
    hmc('disconnect');
    setTimeout(() => hmc(`connect ${host} ${port}`), 8000 + Math.floor(Math.random() * 7000));
  }, preDelay);

  watchReviveResult(id, callbackUrl, now);
  res.status(202).json({ ok: true, id, target, eta_sec: Math.round(preDelay / 1000) + 300 });
});

// ------------------------------------------------------------------ final --
app.use((_req, res) => bad(res, 404, 'Not found'));
// eslint-disable-next-line no-unused-vars
app.use((err, _req, res, _next) => {
  if (err && (err.type === 'entity.parse.failed' || err instanceof SyntaxError)) {
    return bad(res, 400, 'malformed JSON body');
  }
  warn('unhandled error', err && err.message);
  bad(res, 500, 'Internal error');
});

if (require.main === module) {
  const server = app.listen(PORT, BIND, () => log(`dashboard listening on ${BIND}:${PORT} (${VERSION_LABEL})`));
  const shutdown = () => { log('shutting down'); server.close(() => process.exit(0)); setTimeout(() => process.exit(0), 5000).unref(); };
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
} else {
  module.exports = app;
}
