# mc-headless-improved (v2)

A hardened, easy-setup rewrite of [mc-headless](https://github.com/GoatTech-42/mc-headless):
headless Minecraft (Fabric) + MineScript + web dashboard in one container.

One shared dashboard password per installation (not user accounts). Each friend
runs their own instance with their own volumes.

## 30-second setup

```bash
cp .env.example .env        # optional: pick MC_VERSION
bash setup.sh               # (./setup.sh also works once the exec bit is set)
# open http://localhost:4202
```

Or manually:

```bash
docker compose up -d --build
```

1. Open `http://localhost:4202` → **Create password** (12+ chars). You are logged in immediately.
2. **Microsoft login:** open the shown `microsoft.com/link` URL, enter the code, sign in with the Minecraft-owning account. Codes expire (~15 min) — **Retry login** issues a fresh one with no restart.
3. **Connect** to a server you control or one whose rules allow this automation.

Remote host? Keep the loopback port binding and tunnel:

```bash
ssh -N -L 4202:127.0.0.1:4202 you@your-host
```

## What changed vs v1 (reviewed twice)

**Easy setup**
- `docker-compose.yml` + `.env.example` + `setup.sh`/`setup.bat` — one command, one config file (`MC_VERSION`/`MC_LOADER` are the single source of truth; no hidden `fabric:26.3` vs `fabric:1.21.11` mismatch).
- Pinned base image, reproducible `npm ci`, `tini` init, `HEALTHCHECK`, `.dockerignore`.
- `GET /api/doctor` diagnostics + honest version reporting (`/api/health` → `{mc, loader}`).

**Microsoft auth (the big one)**
- Upstream bug worked around: `hmc login` single-shot does not wait for input — the entrypoint now runs login **interactively**, parses the device code robustly (link/devicelogin/aka.ms, `XXXX-XXXX` or 8-char codes), and writes structured `logs/auth-status.json` (status/code/URL/expiry).
- Dashboard shows a **countdown**, **Copy code**, and **Retry login** (`POST /api/auth-retry` → `logs/.login-retry` flag; the entrypoint issues a fresh code in ~10s — no container restart).
- Detects stored accounts (`HeadlessMC/auth/.account.json`), cleans stale `.login-done` markers, refresh-on-game-launch enabled, clear expired/failed states.
- **No code leak:** `/api/login-code` + `/api/auth-status` + `/api/status` require dashboard login. A public `/api/ms-needs-login` exposes booleans only.

**Security hardening**
- Safe log tailing (last 128 KB window — `latest.log` can be huge), bounded command bridge with rotation.
- Chat/host inputs flattened to single lines (newline command-injection closed), host/port validated, `/api/logs` capped at 500 lines and never returns `login.log`.
- `X-Frame-Options: DENY`, `nosniff`, CSRF origin check, `TRUST_PROXY` gating for `X-Forwarded-For` (lockout bypass closed), `Secure` cookies behind HTTPS, per-IP rate limits + 5-fail/15-min login lockout.
- Frontend XSS fix (inventory names escaped), logout + change-password (revokes all sessions) + logout-all.

**Honest controls**
- Look no longer pretends to turn: it validates yaw/pitch ranges, queues `look_request.json`, and returns `{applied:false}` until the new `scripts/look.py` supervisor applies it smoothly.
- `scripts/afk.py` stays on its block (no wandering by default), jittered drift + optional jumps; `telemetry.py` adds `ts` so the UI shows data age; `apikey.py` is stationary by default and honors `MINESCRIPT_DIR`.

## Configuration

| Var | Default | Notes |
|---|---|---|
| `MC_VERSION` | `1.21.11` | Exact game version launched AND used for Modrinth resolution |
| `MC_LOADER` | `fabric` | Loader prefix for the HeadlessMC version string |
| `MC_XMX` | `1280M` | Game heap (keep under container limit) |
| `HMC_LOGIN_TIMEOUT` | `600` | Seconds to wait for device login |
| `HMC_SKIP_LOGIN` | `0` | `1` = dashboard-only testing (game will fail without account) |
| `HMC_LEAN_GFX` | `1` | `0` keeps your own `options.txt` |
| `HMC_NO_XVFB` | `0` | `1` forces `-lwjgl` stub (breaks textures) |
| `TRUST_PROXY` | unset | `1` only behind a trusted HTTPS/auth gateway |
| `DASHBOARD_PASSWORD` | unset | First-boot seed only; existing hash always wins |

Volumes: `mc-data` (`/data`: game/account/logs) and `mc-dashboard` (`/app/data`: password/sessions). Back both up before updates.

## Local dashboard-only testing (no game, no Docker)

```bash
npm ci --omit=dev
mkdir -p .local-test/home/logs .local-test/game .local-test/dashboard
HMC_HOME="$PWD/.local-test/home" MC_GDIR="$PWD/.local-test/game" \
  MC_LOGS="$PWD/.local-test/home/logs" DASH_DATA="$PWD/.local-test/dashboard" \
  PORT=3000 BIND=127.0.0.1 npm start
```

Then `npm test` (spawns the server on ephemeral ports; never touches Minecraft).

## Troubleshooting

| Symptom | Check |
|---|---|
| Code expired | Dashboard **Retry login** (≈10s for a fresh code) |
| `already configured` | Instance has a password — log in; friends need their own instance |
| `429 locked out` | Wait out the shown `retry_after_sec`; check you hit the right instance |
| Game won't join | `docker exec mc-headless tail -n 100 /data/logs/entrypoint.log`, `.../login.log`, `/data/.minecraft/logs/latest.log`; `GET /api/doctor` |
| High CPU | `docker stats`; keep the 2-CPU cap; lean gfx on; stop when unused |
| Telemetry stale | `age` shown in UI; world + `\telemetry` job must be running |

Redact passwords, tokens, login codes, and account names before sharing logs.
Automation is never ban-safe — server rules apply.
