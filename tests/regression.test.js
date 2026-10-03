'use strict';
// Pass-3 regression tests: stale Microsoft codes, otc-first code parsing,
// logout-all cookie clearing, malformed JSON handling. Dashboard only.
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
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mc-reg-'));
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
  return { req, cookie, password, root, port, stop };
}

test('stale waiting code is reported expired so UI prompts retry', async () => {
  const h = await boot();
  try {
    fs.mkdirSync(path.join(h.root, 'logs'), { recursive: true });
    fs.writeFileSync(path.join(h.root, 'logs', 'auth-status.json'), JSON.stringify({
      status: 'waiting', code: 'ABCDEFGH',
      verification_uri: 'https://www.microsoft.com/link',
      full_url: 'https://www.microsoft.com/link?otc=ABCDEFGH',
      expires_at: null, message: 'old',
      updated_at: new Date(Date.now() - 3600 * 1000).toISOString(),
    }));
    const st = await (await h.req('/api/auth-status', undefined, h.cookie)).json();
    assert.equal(st.status, 'expired');
    assert.equal(st.needs_login, true);
  } finally { await h.stop(); }
});

test('code is taken from otc param, not random log words', async () => {
  const h = await boot();
  try {
    fs.mkdirSync(path.join(h.root, 'logs'), { recursive: true });
    // Decoy uppercase words (DOWNLOAD etc.) must not be mistaken for the code.
    // (MC_LOGS == HMC_HOME == root here, so login.log lives at root/login.log.)
    fs.writeFileSync(path.join(h.root, 'login.log'),
      'DOWNLOAD FABRIC MINECRAFT 1.21.11 starting...\n' +
      'Go to https://www.microsoft.com/link?otc=QWERTY12 and sign in\n');
    const d = await (await h.req('/api/login-code', undefined, h.cookie)).json();
    assert.equal(d.code, 'QWERTY12');
    assert.ok(d.fullUrl.includes('otc=QWERTY12'));
  } finally { await h.stop(); }
});

test('logout-all revokes sessions and clears the cookie', async () => {
  const h = await boot();
  try {
    const r = await h.req('/api/logout-all', {}, h.cookie);
    assert.equal(r.status, 200);
    const setCookie = r.headers.get('set-cookie') || '';
    assert.ok(setCookie.includes('Max-Age=0'), 'cookie must be cleared');
    assert.equal((await h.req('/api/logs', undefined, h.cookie)).status, 401);
  } finally { await h.stop(); }
});

test('malformed JSON body returns 400, not 500', async () => {
  const h = await boot();
  try {
    // Raw malformed body (bypasses the JSON helper).
    const r = await fetch(`http://127.0.0.1:${h.port}/api/login`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{not-json',
    });
    assert.equal(r.status, 400);
  } finally { await h.stop(); }
});
