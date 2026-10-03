"""look.py (NEW) — supervisor that makes dashboard Look actually turn.

The dashboard queues orientation requests to <minescript>/look_request.json
{"yaw","pitch","at"}. This script applies them with smooth sine interpolation
so turns look human instead of snapping. Run it via autorun or
POST /api/script {"name":"look"...} once implemented; until then start it
manually once per session with `\\look`.

Stale requests (>60s old) are ignored.
"""
import json
import math
import os
import time

import minescript

MS_DIR = os.environ.get("MINESCRIPT_DIR", "/data/.minecraft/minescript")
REQ_FILE = os.path.join(MS_DIR, "look_request.json")


def apply_turn(target_yaw, target_pitch):
    try:
        yaw, pitch = minescript.player_orientation()
    except Exception:
        return
    target_pitch = max(-90.0, min(90.0, float(target_pitch)))
    # Shortest-path yaw (wrap at +/-180).
    dyaw = ((float(target_yaw) - yaw + 540) % 360) - 180
    steps = max(8, min(60, int(abs(dyaw) / 3) + 10))
    for i in range(steps + 1):
        t = i / steps
        y = (1 - math.cos(math.pi * t)) / 2
        try:
            minescript.player_set_orientation(yaw + dyaw * y, pitch + (target_pitch - pitch) * y)
        except Exception:
            return
        time.sleep(0.016)


while True:
    try:
        if os.path.exists(REQ_FILE):
            with open(REQ_FILE) as f:
                req = json.load(f)
            try:
                os.unlink(REQ_FILE)
            except Exception:
                pass
            if time.time() - float(req.get("at", 0)) / 1000 < 60:
                apply_turn(req.get("yaw", 0), req.get("pitch", 0))
    except Exception:
        pass
    time.sleep(0.2)
