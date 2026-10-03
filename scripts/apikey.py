"""apikey.py (v2) - one-shot API key revival.

Fired via minescript autorun after a (re)join, but only acts when the
dashboard left a pending apikey_request.json. Behaves plausibly:
settles in-game with light movement for a while, then runs /api,
captures the server response from chat, and writes apikey_result.json.

Safety vs v1: DEFAULT IS STATIONARY (look + sneak only). Random walking can
get you killed, stuck, or flagged on SMPs. Set APIKEY_ALLOW_MOVE=1 to allow
short steps, and only where that is permitted.

MS_DIR resolves from MINESCRIPT_DIR env, then the baked default, so custom
MC_GDIR installs work instead of silently doing nothing.
"""
import json
import os
import random
import re
import time
import traceback

import minescript
from minescript import EventQueue, EventType

MS_DIR = os.environ.get(
    "MINESCRIPT_DIR",
    "/data/.minecraft/minescript",
)
if not os.path.isdir(MS_DIR):
    # Custom MC_GDIR installs: the script runs with the game dir as cwd, so a
    # ./minescript sibling is the best guess before giving up on the default.
    cwd_candidate = os.path.join(os.getcwd(), "minescript")
    if os.path.isdir(cwd_candidate):
        MS_DIR = cwd_candidate
REQ_FILE = os.path.join(MS_DIR, "apikey_request.json")
RES_FILE = os.path.join(MS_DIR, "apikey_result.json")
KEY_RE = re.compile(r"\b[0-9a-fA-F]{32}\b")
REQ_MAX_AGE = 3600  # ignore stale requests
ALLOW_MOVE = os.environ.get("APIKEY_ALLOW_MOVE", "0") == "1"


def _write_result(result):
    tmp = RES_FILE + ".tmp"
    with open(tmp, "w") as f:
        json.dump(result, f)
    os.replace(tmp, RES_FILE)


def _human_settle():
    """Idle like a person for 75-240s. Stationary unless ALLOW_MOVE."""
    settle = random.uniform(75, 240)
    end = time.time() + settle
    while time.time() < end:
        time.sleep(random.uniform(3, 11))
        r = random.random()
        try:
            if r < 0.55:
                yaw, pitch = minescript.player_orientation()
                minescript.player_set_orientation(
                    yaw + random.uniform(-40, 40),
                    max(-90.0, min(90.0, pitch + random.uniform(-18, 18))),
                )
            elif r < 0.70:
                minescript.player_press_sneak(True)
                time.sleep(random.uniform(0.4, 1.4))
                minescript.player_press_sneak(False)
            elif ALLOW_MOVE and r < 0.80:
                key = random.choice([
                    minescript.player_press_forward,
                    minescript.player_press_backward,
                    minescript.player_press_left,
                    minescript.player_press_right,
                ])
                key(True)
                time.sleep(random.uniform(0.3, 1.0))
                key(False)
            elif r < 0.84:
                minescript.player_press_jump(True)
                time.sleep(0.1)
                minescript.player_press_jump(False)
            # else: just stand there
        except Exception:
            pass


def main():
    if not os.path.exists(REQ_FILE):
        return  # autorun fired without a pending request; stay quiet
    try:
        with open(REQ_FILE) as f:
            req = json.load(f)
    except Exception:
        return
    try:
        req_age = time.time() - float(req.get("requested_at", 0))
    except (TypeError, ValueError):
        return  # malformed request file (e.g. partial write); ignore it
    if req.get("done") or req_age > REQ_MAX_AGE:
        return

    result = {
        "id": req.get("id"),
        "status": "error",
        "key": None,
        "chat": [],
        "error": None,
        "finished_at": None,
    }
    try:
        req["done"] = True
        with open(REQ_FILE, "w") as f:
            json.dump(req, f)

        _human_settle()

        lines = []
        with EventQueue() as eq:
            eq.register_chat_listener()
            time.sleep(random.uniform(1.5, 4.0))
            minescript.execute("/api")
            deadline = time.time() + 60
            while time.time() < deadline:
                try:
                    ev = eq.get(timeout=5)
                except Exception:
                    continue
                if ev is None:
                    continue
                if getattr(ev, "type", None) == EventType.CHAT:
                    lines.append(str(ev.message))
                    if KEY_RE.search(str(ev.message)):
                        break

        result["chat"] = lines[-40:]
        for line in lines:
            m = KEY_RE.search(line)
            if m:
                result["key"] = m.group(0)
                result["status"] = "ok"
                break
        if not result["key"]:
            result["error"] = "no key-shaped token in chat response"
    except Exception:
        result["error"] = traceback.format_exc()[-1500:]
    result["finished_at"] = time.time()
    try:
        _write_result(result)
    except Exception:
        pass


main()
