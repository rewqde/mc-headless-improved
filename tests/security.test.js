'use strict';
// Security + Microsoft-auth regression tests (dashboard only, no game launch).
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const net = require('node:net');

async function freePort() {
  const s = net.createServer();
  await new Promise((r) => s.listen(0, '127.0.0.1', r));
  const p = s.address().port;
  await new Promise((r) => s.close(r));
  return p;
}

async function boot() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mc-sec-'));
  const port = await freePort();
  const password = require('node:crypto').randomBytes(24).toString('hex');
  const env = {
    ...process.env, PORT: String(port), BIND: '127.0.0.1',
    DASH_DATA: root, HMC_HOME: root, MC_GDIR: root, MC_LOGS: root,
    DASHBOARD_PASSWORD: '', MC_VERSION: '1.21.11', MC_LOADER: 'fabric',
  };
  const child = spawn(process.execPath, ['server.js'], { cwd: path.join(__dirname, '..'), env, stdio: 'ignore' });
  for (let n = 0; n < 100; n++) {
    try { if ((await fetch(`http://127.0.0.1:${port}/api/health`)).ok) break; } catch {}
    await new Promise((r) => setTimeout(r, 50));
  }
  const req = (route, body, cookie, extra) => fetch(`http://127.0.0.1:${port}${route}`, {
    method: body === undefined ? 'GET' : 'POST',
    headers: { 'Content-Type': 'application/json', ...(cookie ? { Cookie: cookie } : {}), ...(extra || {}) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  assert.equal((await req('/api/setup', { password })).status, 200);
  const login = await req('/api/login', { password });
  assert.equal(login.status, 200);
  const cookie = login.headers.get('set-cookie').split(';')[0];
  const stop = async () => {
    if (child.exitCode === null) await new Promise((r) => { child.once('exit', r); child.kill(); });
    fs.rmSync(root, { recursive: true, force: true });
  };
  return { req, cookie, password, root, stop };
}

test('health reports configured version; status/login-code require auth', async () => {
  const h = await boot();
  try {
    const health = await (await h.req('/api/health')).json();
    assert.equal(health.mc, '1.21.11');
    assert.equal(health.loader, 'fabric');
    // Protected in v2 (were public in v1 — code/log leak).
    assert.equal((await h.req('/api/status')).status, 401);
    assert.equal((await h.req('/api/login-code')).status, 401);
    assert.equal((await h.req('/api/auth-status')).status, 401);
    // Public minimal endpoint exposes booleans only.
    const ms = await (await h.req('/api/ms-needs-login')).json();
    assert.equal(typeof ms.needs_login, 'boolean');
    assert.ok(!('code' in ms) && !('url' in ms));
    // Authed full status works.
    const full = await (await h.req('/api/auth-status', undefined, h.cookie)).json();
    assert.equal(typeof full.needs_login, 'boolean');
  } finally { await h.stop(); }
});

test('chat newline injection cannot escape into extra HMC commands', async () => {
  const h = await boot();
  try {
    const evil = 'hi\nconnect evil.example 1234';
    const r = await h.req('/api/chat', { msg: evil }, h.cookie);
    assert.equal(r.status, 200);
    const bridge = fs.readFileSync(path.join(h.root, 'hmc-cmd.log'), 'utf8');
    // The payload must have been flattened to ONE line.
    assert.ok(!bridge.split('\n').some((l) => l.startsWith('connect evil')));
    assert.ok(bridge.includes('msg hi connect evil.example 1234'));
  } finally { await h.stop(); }
});

test('move yaw/pitch validated; look is honestly queued', async () => {
  const h = await boot();
  try {
    assert.equal((await h.req('/api/move', { yaw: 999, pitch: 0 }, h.cookie)).status, 400);
    assert.equal((await h.req('/api/move', { yaw: 0, pitch: 999 }, h.cookie)).status, 400);
    const ok = await (await h.req('/api/move', { yaw: 10, pitch: -5 }, h.cookie)).json();
    assert.equal(ok.ok, true);
    assert.equal(ok.applied, false); // honest: queued for supervisor
  } finally { await h.stop(); }
});

test('auth-retry flag works without restart; change-password revokes sessions', async () => {
  const h = await boot();
  try {
    const r = await h.req('/api/auth-retry', {}, h.cookie);
    assert.equal(r.status, 200);
    assert.ok(fs.existsSync(path.join(h.root, 'logs', '.login-retry')));
    const np = require('node:crypto').randomBytes(24).toString('hex');
    assert.equal((await h.req('/api/change-password', { current: 'wrong', password: np }, h.cookie)).status, 401);
    assert.equal((await h.req('/api/change-password', { current: h.password, password: np }, h.cookie)).status, 200);
    assert.equal((await h.req('/api/logs', undefined, h.cookie)).status, 401); // revoked
    assert.equal((await h.req('/api/login', { password: np })).status, 200);
  } finally { await h.stop(); }
});

test('security headers + CSRF origin check', async () => {
  const h = await boot();
  try {
    const r = await h.req('/api/health');
    assert.equal(r.headers.get('x-frame-options'), 'DENY');
    assert.equal(r.headers.get('x-content-type-options'), 'nosniff');
    const evilOrigin = await h.req('/api/chat', { msg: 'hi' }, h.cookie, { Origin: 'https://evil.example' });
    assert.equal(evilOrigin.status, 403);
  } finally { await h.stop(); }
});
