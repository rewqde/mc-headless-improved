"""afk.py (v2) — safe farm-AFK loop.

Behavior: look straight up, hold sneak + attack + use (classic farm AFK),
then stay alive with tiny human-like maintenance:
  - slow yaw drift (+/- a few degrees) every 20-60s so anti-AFK checks see input
  - optional short jump every 5-15 min (AFK_JUMP=1, default ON but harmless)
  - NO walking around by default: the bot stays on its block so it cannot
    wander off your farm. Set AFK_WANDER=1 to allow tiny steps (not recommended
    on SMPs — you can fall, trigger traps, or look botted).

All timings are jittered. Exits cleanly on disconnect so Minescript autorun
restarts it on the next join.
"""
import math
import os
import random
import time

import minescript

JITTER = os.environ.get("AFK_JITTER", "1") == "1"
ALLOW_JUMP = os.environ.get("AFK_JUMP", "1") == "1"
ALLOW_WANDER = os.environ.get("AFK_WANDER", "0") == "1"


def sleep_jitter(base, spread=0.25):
    if not JITTER:
        time.sleep(base)
        return
    time.sleep(max(0.05, base * random.uniform(1.0 - spread, 1.0 + spread)))


def smooth_look(yaw, start_pitch, target_pitch=-90.0, duration=1.0, steps=120):
    for i in range(steps + 1):
        t = i / steps
        y = (1 - math.cos(math.pi * t)) / 2  # sine ease 0 -> 1
        try:
            minescript.player_set_orientation(yaw, start_pitch + (target_pitch - start_pitch) * y)
        except Exception:
            return
        time.sleep(duration / steps)


def main():
    try:
        yaw, start_pitch = minescript.player_orientation()
    except Exception:
        yaw, start_pitch = 0.0, 0.0

    smooth_look(yaw, start_pitch, -90.0)
    sleep_jitter(0.25)

    for fn in (minescript.player_press_sneak, minescript.player_press_attack, minescript.player_press_use):
        try:
            fn(True)
        except Exception:
            pass
        sleep_jitter(0.45)

    minescript.echo("afk: holding sneak+attack+use, maintenance drift on")

    next_drift = time.time() + random.uniform(20, 60)
    next_jump = time.time() + random.uniform(300, 900)
    while True:
        time.sleep(0.5)
        now = time.time()
        if now >= next_drift:
            next_drift = now + random.uniform(20, 60)
            try:
                y, p = minescript.player_orientation()
                minescript.player_set_orientation(
                    y + random.uniform(-6, 6),
                    max(-90.0, min(90.0, -90.0 + random.uniform(-4, 4))),
                )
            except Exception:
                break  # likely disconnected; autorun restarts us on rejoin
        if ALLOW_JUMP and now >= next_jump:
            next_jump = now + random.uniform(300, 900)
            try:
                minescript.player_press_jump(True)
                sleep_jitter(0.12, 0.3)
                minescript.player_press_jump(False)
            except Exception:
                break
        if ALLOW_WANDER and random.random() < 0.002:
            # Rare single micro-step, never a sustained walk.
            try:
                key = random.choice([
                    minescript.player_press_forward,
                    minescript.player_press_backward,
                    minescript.player_press_left,
                    minescript.player_press_right,
                ])
                key(True)
                sleep_jitter(0.25, 0.4)
                key(False)
            except Exception:
                break


try:
    main()
except Exception as e:  # never spam the log; just exit for autorun retry
    try:
        minescript.echo(f"afk stopped: {e}"[:200])
    except Exception:
        pass
