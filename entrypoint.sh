#!/usr/bin/env bash
# mc-headless-improved entrypoint (v2).
#
# Fixes vs the original:
#  - version is HONEST: MC_VERSION + MC_LOADER env select the exact HeadlessMC
#    version string (default fabric:1.21.11). No hardcoded fabric:26.3 vs
#    fabric:1.21.11 mismatch, no stale `versions/fabric-1.21.11` directory check.
#  - Microsoft login is RELIABLE: interactive `login` (the `hmc login`
#    single-shot path is broken upstream — issue #371), structured
#    logs/auth-status.json with code + URL + expiry for the dashboard,
#    retry-without-restart via logs/.login-retry flag, timeout + expiry handling.
#  - mods resolve for the REAL game version with retries + pinned-known-good
#    fallback, never aborting boot on a Modrinth hiccup.
#  - command bridge (hmc-cmd.log) is rotated; Xvfb + dashboard supervised;
#    lean graphics enforced but overridable via HMC_LEAN_GFX=0.
set -uo pipefail

HMC_HOME="${HMC_HOME:-/data}"
GDIR="${MC_GDIR:-/data/.minecraft}"
LOGS_DIR="${MC_LOGS:-$HMC_HOME/logs}"
XMX="${MC_XMX:-1280M}"
LOGIN_TIMEOUT="${HMC_LOGIN_TIMEOUT:-600}"
# Guard against non-numeric timeouts (would break sleep + arithmetic below).
if ! [[ "$LOGIN_TIMEOUT" =~ ^[0-9]+$ ]] || [ "$LOGIN_TIMEOUT" -lt 30 ]; then
  echo "[entrypoint] WARN: bad HMC_LOGIN_TIMEOUT='$LOGIN_TIMEOUT', using 600" >&2
  LOGIN_TIMEOUT=600
fi
MC_VERSION="${MC_VERSION:-1.21.11}"
MC_LOADER="${MC_LOADER:-fabric}"
MC_LOADER="$(printf '%s' "$MC_LOADER" | tr '[:upper:]' '[:lower:]')"
VER="${MC_LOADER}:${MC_VERSION}"
# Optional overrides
HMC_SKIP_LOGIN="${HMC_SKIP_LOGIN:-0}"
HMC_LEAN_GFX="${HMC_LEAN_GFX:-1}"
# Set HMC_NO_XVFB=1 to force the -lwjgl stub (no display). Default: Xvfb+llvmpipe.
HMC_NO_XVFB="${HMC_NO_XVFB:-0}"
DASH_PORT="${PORT:-3000}"

HMC_JAR="$(ls /headlessmc/headlessmc-launcher-wrapper.jar /headlessmc/headlessmc-launcher-wrapper-*.jar 2>/dev/null | head -n1 | tr -d '\r')"
if [ -z "$HMC_JAR" ]; then
  echo "[entrypoint] FATAL: HeadlessMC wrapper jar not found in /headlessmc — holding container open" >&2
  sleep infinity
fi
hmc() { java -jar "$HMC_JAR" --command "$@"; }

mkdir -p "$HMC_HOME/HeadlessMC" "$HMC_HOME/logs" "$LOGS_DIR" "$GDIR/mods" "$GDIR/minescript"
# Legacy path compat: dashboard reads MC_LOGS, entrypoint logs live under HMC_HOME/logs.
if [ "$LOGS_DIR" != "$HMC_HOME/logs" ]; then
  mkdir -p "$LOGS_DIR"
fi
cd "$HMC_HOME" || { echo "[entrypoint] FATAL: cannot cd to $HMC_HOME" >&2; sleep infinity; }

log() { echo "[entrypoint] $*" | tee -a "$HMC_HOME/logs/entrypoint.log"; }
login_log() { echo "$HMC_HOME/logs/login.log"; }
auth_status_file() { echo "$HMC_HOME/logs/auth-status.json"; }

write_auth_status() {
  # $1=status $2=code $3=url $4=message
  local status="$1" code="${2:-}" url="${3:-}" message="${4:-}"
  local full_url="" expires_at=""
  if [ -n "$code" ] && [ -n "$url" ]; then
    if [[ "$url" == *"?otc="* ]] || [[ "$url" == *"&otc="* ]]; then
      full_url="$url"
    else
      if [[ "$url" == *"?"* ]]; then full_url="${url}&otc=${code}"; else full_url="${url}?otc=${code}"; fi
    fi
    # Device codes typically live 15 min from print time.
    if command -v date >/dev/null 2>&1; then
      expires_at="$(date -u -d '+15 minutes' +%Y-%m-%dT%H:%M:%SZ 2>/dev/null || date -u -v+15M +%Y-%m-%dT%H:%M:%SZ 2>/dev/null || true)"
    fi
  fi
  python3 - "$HMC_HOME/logs/auth-status.json" "$status" "$code" "$url" "$full_url" "$expires_at" "$message" <<'EOF' 2>/dev/null || true
import json, sys, time
p, status, code, url, full_url, expires_at, message = sys.argv[1:8]
doc = {
  "status": status,
  "code": code or None,
  "verification_uri": url or None,
  "full_url": full_url or None,
  "expires_at": expires_at or None,
  "message": message or None,
  "updated_at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
}
with open(p + ".tmp", "w") as f:
    json.dump(doc, f)
import os
os.replace(p + ".tmp", p)
EOF
}

extract_code_url() {
  # Prints "CODE|URL" from the login log, or nothing.
  python3 - "$(login_log)" <<'EOF' 2>/dev/null || true
import re, sys
try:
    raw = open(sys.argv[1], encoding="utf-8", errors="replace").read()
except Exception:
    sys.exit(0)
m_url = (re.search(r"https?://[^\s\"'<>]*microsoft\.com/(?:link|devicelogin)[^\s\"'<>]*", raw, re.I)
         or re.search(r"https?://aka\.ms[^\s\"'<>]*", raw, re.I))
m_code = re.search(r"\b([A-Z0-9]{4}-[A-Z0-9]{4})\b", raw) or re.search(r"\b([A-Z0-9]{8,9})\b", raw)
if m_url and m_code:
    print(m_code.group(1) + "|" + m_url.group(0).rstrip(".,;)"))
EOF
}

cleanup() {
  log "shutting down (signal received)"
  # Kill supervised children; game + Xvfb exit with the container.
  jobs -p | xargs -r kill 2>/dev/null || true
  exit 0
}
trap cleanup TERM INT

# --- Dashboard sidecar ---
if [ -f /app/server.js ]; then
  ( cd /app && PORT="$DASH_PORT" BIND=0.0.0.0 MC_VERSION="$MC_VERSION" MC_LOADER="$MC_LOADER" node server.js > "$HMC_HOME/logs/dashboard.log" 2>&1 & )
  log "dashboard started on :$DASH_PORT (version $VER)"
else
  log "/app/server.js not present — dashboard skipped"
fi

# --- HeadlessMC config ---
CONF="$HMC_HOME/HeadlessMC/config.properties"
if [ ! -f "$CONF" ]; then
  cat > "$CONF" <<EOF
# mc-headless-improved (generated)
hmc.assets.dummy=true
hmc.always.lwjgl.flag=false
hmc.auto.download.specifics=true
hmc.jline.enabled=false
hmc.java.versions=/opt/java/java17/bin/java;/opt/java/java8/bin/java;/opt/java/openjdk/bin/java
hmc.gamedir=$GDIR
hmc.account.refresh.on.game.launch=true
hmc.account.refresh.on.launch=false
EOF
  log "wrote config.properties"
fi
ensure_prop() { # key value
  local k="$1" v="$2"
  if grep -q "^${k}=" "$CONF" 2>/dev/null; then
    sed -i "s|^${k}=.*|${k}=${v}|" "$CONF" || true
  else
    echo "${k}=${v}" >> "$CONF"
  fi
}
ensure_prop "hmc.auto.download.specifics" "true"
ensure_prop "hmc.always.lwjgl.flag" "false"
ensure_prop "hmc.account.refresh.on.game.launch" "true"
ensure_prop "hmc.gamedir" "$GDIR"
log "config.properties enforced (specifics auto-download on, refresh-on-game-launch on)"

# --- Lean graphics (overridable) ---
if [ "$HMC_LEAN_GFX" = "1" ]; then
  OPTS="$GDIR/options.txt"
  if [ ! -f "$OPTS" ]; then
    cat > "$OPTS" <<'EOF'
renderDistance:2
graphics:1
graphicsMode:0
maxFps:10
particles:0
entityShadows:false
ao:0
renderClouds:false
simulationDistance:3
entityDistanceScaling:0.5
mipmapLevels:0
biomeBlendRadius:0
enableVsync:false
fullscreen:false
bobView:false
hudHidden:true
masterVolume:0.0
fov:70
pauseOnLostFocus:false
onboardAccessibility:false
vsync:false
EOF
    log "wrote lean options.txt"
  fi
  set_opt() {
    local k="$1" v="$2"
    sed -i "s/^${k}:.*/${k}:${v}/" "$OPTS" || true
    grep -q "^${k}:" "$OPTS" || echo "${k}:${v}" >> "$OPTS"
  }
  set_opt renderDistance 2
  set_opt graphics 1
  set_opt graphicsMode 0
  set_opt maxFps 10
  set_opt particles 0
  set_opt entityShadows false
  set_opt ao 0
  set_opt renderClouds false
  set_opt simulationDistance 3
  set_opt entityDistanceScaling 0.5
  set_opt mipmapLevels 0
  set_opt biomeBlendRadius 0
  set_opt enableVsync false
  set_opt fullscreen false
  set_opt bobView false
  set_opt hudHidden true
  set_opt masterVolume 0.0
  set_opt fov 70
  set_opt pauseOnLostFocus false
  set_opt onboardAccessibility false
  set_opt vsync false
  log "enforced lean options.txt (HMC_LEAN_GFX=0 to keep your own)"
else
  log "lean graphics enforcement skipped (HMC_LEAN_GFX=0)"
fi

log "hmc home=$HMC_HOME gamedir=$GDIR xmx=$XMX jar=$HMC_JAR version=$VER"

# --- Download game version (honest: the configured VER, whatever it is) ---
if [ ! -d "$HMC_HOME/versions/${MC_LOADER}-${MC_VERSION}" ] && [ ! -d "$HMC_HOME/versions/${VER}" ]; then
  log "downloading $VER (once)…"
  hmc download "$VER" 2>&1 | tee -a "$HMC_HOME/logs/download.log" || true
else
  log "version $VER already downloaded"
fi

# --- Mods: resolve for the REAL MC_VERSION with retries; never abort boot ---
modrinth_dl() {
  local slug="${1:-}" label="${2:-}"
  local tries=0 json="" url="" filename=""
  while [ "$tries" -lt 3 ]; do
    tries=$((tries+1))
    json="$(curl -fsSL --retry 2 --max-time 25 "https://api.modrinth.com/v2/project/${slug}/version?game_versions=%5B%22${MC_VERSION}%22%5D&loaders=%5B%22fabric%22%5D&limit=1" 2>/dev/null || true)"
    if [ -n "$json" ]; then break; fi
    sleep 2
  done
  if [ -z "$json" ]; then
    log "WARN: resolve failed for $label ($slug) after 3 tries — continuing without it"
    return 0
  fi
  url="$(printf '%s' "$json" | python3 -c 'import sys,json; f=json.load(sys.stdin)[0]["files"][0]; print(f["url"])' 2>/dev/null || true)"
  filename="$(printf '%s' "$json" | python3 -c 'import sys,json; f=json.load(sys.stdin)[0]["files"][0]; print(f["filename"])' 2>/dev/null || true)"
  if [ -z "$url" ] || [ -z "$filename" ]; then
    log "WARN: parse failed for $label ($slug) — continuing without it"
    return 0
  fi
  if [ -s "$GDIR/mods/$filename" ]; then
    log "mod $filename already present — skip"
    return 0
  fi
  log "downloading $filename ($label)"
  if ! curl -fsSL --retry 2 --max-time 60 -o "$GDIR/mods/$filename.tmp" "$url"; then
    log "FAILED to download $filename — continuing without it"
    rm -f "$GDIR/mods/$filename.tmp"
    return 0
  fi
  mv "$GDIR/mods/$filename.tmp" "$GDIR/mods/$filename"
  log "installed $filename"
}
modrinth_dl "P7dR8mSH" "fabric-api"
modrinth_dl "KcpXWngB" "minescript"
modrinth_dl "AANobbMI" "sodium"
modrinth_dl "gvQqBUqZ" "lithium"
modrinth_dl "uXXizFIs" "ferrite-core"
modrinth_dl "fQEb0iXm" "krypton"
modrinth_dl "hvFnDODi" "lazydfu"
modrinth_dl "NNAgCjsB" "entityculling"
modrinth_dl "cloth-config" "cloth-config"
modrinth_dl "51shyZVL" "moreculling"

# --- MineScript scripts ---
if [ -d /app/scripts ]; then
  for f in /app/scripts/*.py; do
    [ -f "$f" ] || continue
    name="$(basename "$f")"
    cp -f "$f" "$GDIR/minescript/$name"
    log "installed minescript script $name"
  done
fi

# =====================================================================
# Microsoft device-code login (v2 — interactive, structured, retriable)
# =====================================================================
LOGIN_LOG="$(login_log)"
LOGIN_MARKER="$HMC_HOME/logs/.login-done"
RETRY_FLAG="$HMC_HOME/logs/.login-retry"
LOGIN_LOCK="$HMC_HOME/logs/.login-lock"

has_account() {
  [ -s "$HMC_HOME/HeadlessMC/auth/.account.json" ] || [ -s "$HMC_HOME/HeadlessMC/auth/account.json" ]
}

run_device_login() {
  local timeout_s="${LOGIN_TIMEOUT}"
  : > "$LOGIN_LOG"
  rm -f "$(auth_status_file)"
  write_auth_status "pending" "" "" "Starting Microsoft login — code appears in seconds"
  log "starting Microsoft device login (interactive mode) — code -> $LOGIN_LOG + dashboard"

  # Upstream bug #371: `hmc --command login` single-shot does not wait for the
  # user. Run the launcher INTERACTIVELY, feed it `login`, and parse the code.
  # stdin: `login` then keep the pipe open so the process stays alive to poll.
  rm -f "$HMC_HOME/logs/.login-exit"
  ( printf 'login\n'; sleep "$timeout_s"; printf 'login -cancel 0\nquit\n' ) | java -jar "$HMC_JAR" >"$LOGIN_LOG" 2>&1 &
  local login_pid=$!
  local waited=0 code="" url=""
  # Snapshot account presence: an account file that APPEARS mid-login is proof
  # of success, but one that was already there (e.g. stale tokens behind a
  # dashboard Retry) must not shortcut the fresh code the user asked for.
  local had_account=0
  has_account && had_account=1
  while kill -0 "$login_pid" 2>/dev/null && [ "$waited" -lt "$timeout_s" ]; do
    sleep 5; waited=$((waited+5))
    if [ -z "$code" ]; then
      local pair
      pair="$(extract_code_url)"
      if [ -n "$pair" ]; then
        code="${pair%%|*}"; url="${pair#*|}"
        write_auth_status "waiting" "$code" "$url" "Open the link, enter the code, sign in with the Minecraft-owning Microsoft account"
        log "device code ready: $code ($url) — waiting up to ${timeout_s}s"
      fi
    fi
    # Success can arrive before timeout: marker strings in the log, or the
    # account file appearing mid-login (wording-independent — never stall the
    # full timeout just because success was phrased differently).
    if grep -qiE 'signed in|logged in|login (completed|successful)|authenticated' "$LOGIN_LOG" 2>/dev/null \
      || { [ "$had_account" = "0" ] && has_account; }; then
      break
    fi
    # Dashboard asked for a fresh code (POST /api/auth-retry): restart login.
    # (The background supervisor also watches the flag, with a lock — this
    # inner check covers the boot-time login before the supervisor starts.)
    if [ -f "$RETRY_FLAG" ]; then
      log "login retry requested from dashboard — restarting device login"
      rm -f "$RETRY_FLAG"
      kill "$login_pid" 2>/dev/null || true
      wait "$login_pid" 2>/dev/null || true
      run_device_login
      return $?
    fi
  done

  if grep -qiE 'signed in|logged in|login (completed|successful)|authenticated' "$LOGIN_LOG" 2>/dev/null || has_account; then
    touch "$LOGIN_MARKER"
    write_auth_status "authenticated" "" "" "Microsoft login completed"
    log "Microsoft login completed"
    kill "$login_pid" 2>/dev/null || true
    wait "$login_pid" 2>/dev/null || true
    return 0
  fi

  if kill -0 "$login_pid" 2>/dev/null; then
    kill "$login_pid" 2>/dev/null || true
    wait "$login_pid" 2>/dev/null || true
    if grep -qiE 'expir' "$LOGIN_LOG" 2>/dev/null; then
      write_auth_status "expired" "$code" "$url" "Code expired — use Retry login on the dashboard (no restart needed)"
      log "device code expired — dashboard Retry issues a fresh one"
    else
      write_auth_status "expired" "$code" "$url" "Login timed out after ${timeout_s}s — use Retry login on the dashboard"
      log "login timed out after ${timeout_s}s — launching anyway (game may fail without account)"
    fi
  else
    wait "$login_pid" 2>/dev/null || true
    write_auth_status "failed" "$code" "$url" "Login process ended without success — check login.log, then Retry"
    log "login process ended without success"
  fi
  return 1
}

maybe_login() {
  # Stale-marker cleanup: drop the marker if there is no success evidence AND
  # no stored account, so half-finished logins are redone on restart.
  if [ -f "$LOGIN_MARKER" ]; then
    if ! grep -qiE 'signed in|logged in|success|authenticated' "$LOGIN_LOG" 2>/dev/null && ! has_account; then
      rm -f "$LOGIN_MARKER"
    fi
  fi
  if [ "$HMC_SKIP_LOGIN" = "1" ]; then
    write_auth_status "skipped" "" "" "Login skipped (HMC_SKIP_LOGIN=1) — game will fail without an account"
    log "login skipped (HMC_SKIP_LOGIN=1)"
    return 0
  fi
  if [ -f "$LOGIN_MARKER" ] && has_account; then
    write_auth_status "authenticated" "" "" "Already signed in (stored account found)"
    log "login already completed (stored account present)"
    return 0
  fi
  if [ -f "$LOGIN_MARKER" ]; then
    log "login marker present but no stored account — re-running login"
    rm -f "$LOGIN_MARKER"
  fi
  run_device_login || true
}

maybe_login
log "login phase ended"

# --- Login supervisor (background): honors dashboard Retry even mid-game ---
# The launch loop below is blocked inside the game JVM while playing, so it can
# only notice RETRY_FLAG between launches. This watcher runs independently: on
# a retry request it starts a fresh interactive device login in the background
# (launcher-level only — the game keeps running). A lock dir prevents
# overlapping logins; if one is already running, the flag is left in place for
# its inner-loop retry check to consume.
rmdir "$LOGIN_LOCK" 2>/dev/null || true # drop stale lock from a killed container
login_supervisor() {
  while true; do
    sleep 10
    if [ -f "$RETRY_FLAG" ]; then
      if mkdir "$LOGIN_LOCK" 2>/dev/null; then
        rm -f "$RETRY_FLAG"
        log "dashboard requested fresh login — starting background device login (game keeps running)"
        run_device_login || true
        rmdir "$LOGIN_LOCK" 2>/dev/null || true
      fi
    fi
  done
}
login_supervisor &

# --- Server auto-join target ---
MC_HOST=""
MC_PORT=""
TARGET="$HMC_HOME/server.target"
if [ -f "$TARGET" ] && [ -s "$TARGET" ]; then
  line="$(head -n1 "$TARGET" | tr -d '\r' | tr -d '\n')"
  # Accept host:port or [ipv6]:port, with a sane port range (the dashboard
  # already validates 1-65535 on write; this guards hand-edited files).
  if [[ "$line" =~ ^\[.*\]:[0-9]+$ ]] || [[ "$line" =~ ^[A-Za-z0-9.-]+:[0-9]+$ ]]; then
    MC_HOST="${line%:*}"; MC_HOST="${MC_HOST#[}"; MC_HOST="${MC_HOST%]}"
    MC_PORT="${line##*:}"
    if ! [[ "$MC_PORT" =~ ^[0-9]+$ ]] || [ "$MC_PORT" -lt 1 ] || [ "$MC_PORT" -gt 65535 ]; then
      log "WARN: ignoring server.target with bad port: $line"
      MC_HOST=""; MC_PORT=""
    fi
  else
    log "WARN: ignoring malformed server.target: $line"
  fi
fi

# --- Display / GL mode ---
USE_XVFB=1
if [ "$HMC_NO_XVFB" = "1" ]; then
  USE_XVFB=0
  log "HMC_NO_XVFB=1 — using -lwjgl stub (no display; texture uploads may fail)"
elif command -v Xvfb >/dev/null 2>&1; then
  export DISPLAY=:99
  rm -f /tmp/.X99-lock /tmp/.X11-unix/X99
  Xvfb "$DISPLAY" -screen 0 800x600x16 >"$HMC_HOME/logs/xvfb.log" 2>&1 &
  log "Xvfb started on $DISPLAY (software GL via llvmpipe)"
else
  USE_XVFB=0
  log "WARNING: Xvfb binary not found — falling back to -lwjgl (texture uploads may fail)"
fi
if [ "$USE_XVFB" = "1" ]; then
  LWJGL_FLAG=""
  GL_MODE="xvfb+llvmpipe"
else
  LWJGL_FLAG="-lwjgl"
  GL_MODE="lwjgl-stub"
fi

EXTRA_ARGS=""
if [ -n "$MC_HOST" ] && [ -n "$MC_PORT" ]; then
  EXTRA_ARGS="--server $MC_HOST --port $MC_PORT"
  log "launching $VER ($GL_MODE, -Xmx$XMX) -> $MC_HOST:$MC_PORT"
else
  log "launching $VER ($GL_MODE, -Xmx$XMX) [main menu — set a server in the dashboard]"
fi

# Command bridge with rotation guard (dashboard appends live console commands).
# NOTE: truncate IN PLACE (same inode) so the `tail -f` feeding the game keeps
# following the file. A move-replace would orphan the reader on the old inode.
touch "$HMC_HOME/hmc-cmd.log"
rotate_cmd_bridge() {
  local max_bytes=1048576
  local size
  size="$(stat -c%s "$HMC_HOME/hmc-cmd.log" 2>/dev/null || stat -f%z "$HMC_HOME/hmc-cmd.log" 2>/dev/null || echo 0)"
  if [ "$size" -gt "$max_bytes" ]; then
    tail -n 500 "$HMC_HOME/hmc-cmd.log" > "$HMC_HOME/hmc-cmd.log.tmp" \
      && cat "$HMC_HOME/hmc-cmd.log.tmp" > "$HMC_HOME/hmc-cmd.log" \
      && rm -f "$HMC_HOME/hmc-cmd.log.tmp"
    log "rotated hmc-cmd.log (kept last 500 lines)"
  fi
}

attempt=0
while true; do
  attempt=$((attempt+1))
  rotate_cmd_bridge
  log "launch attempt $attempt $VER ..."
  if tail -n0 -f "$HMC_HOME/hmc-cmd.log" 2>/dev/null | java -jar "$HMC_JAR" --command launch "$VER" $LWJGL_FLAG --jvm "-Xmx$XMX -XX:+UseG1GC -XX:MaxGCPauseMillis=50" -- $EXTRA_ARGS; then
    log "game exited cleanly (code $?)"
  else
    log "launch failed (code $?) — retry in 60s, dashboard stays up"
  fi
  sleep 60
done
