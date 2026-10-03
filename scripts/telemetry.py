# MineScript telemetry loop (v2).
# Contract: dashboard scrapes `TELEMETRY {json}` lines from latest.log
# (<gamedir>/logs/latest.log). One flat object per ~2s:
# {"ts","x","y","z","yaw","pitch","health","inventory":[{"name","count"}...<=12]}.
# `ts` (epoch seconds) lets the dashboard show data age / stale warnings.
import json
import time

import minescript


def call(name):
    try:
        return getattr(minescript, name)()
    except Exception:
        return None


def item_shape(it):
    try:
        return {"name": it["name"], "count": it.get("count", 1)}
    except Exception:
        pass
    for attr in ("name", "item"):
        try:
            n = getattr(it, attr)
            if n is not None:
                return {"name": str(n), "count": getattr(it, "count", 1) or 1}
        except Exception:
            pass
    if isinstance(it, (tuple, list)) and it:
        return {"name": str(it[0]), "count": it[1] if len(it) > 1 else 1}
    return {"name": str(it)[:60], "count": 1}


failures = 0
while True:
    try:
        pos = call("player_position") or []
        orient = call("player_orientation") or []
        inv = call("player_inventory") or []
        items = []
        for it in inv[:12]:
            try:
                items.append(item_shape(it))
            except Exception:
                items.append({"name": str(it)[:60], "count": 1})
        try:
            dim = call("player_dimension")
        except Exception:
            dim = None
        payload = {
            "ts": int(time.time()),
            "x": pos[0] if len(pos) > 0 else 0,
            "y": pos[1] if len(pos) > 1 else 0,
            "z": pos[2] if len(pos) > 2 else 0,
            "yaw": orient[0] if len(orient) > 0 else 0,
            "pitch": orient[1] if len(orient) > 1 else 0,
            "health": call("player_health"),
            "dimension": dim,
            "inventory": items,
        }
        minescript.echo("TELEMETRY " + json.dumps(payload, default=str))
        failures = 0
    except Exception:
        failures += 1
    # Back off when the game is unreachable (menu/disconnect) instead of spinning.
    time.sleep(2 if failures < 5 else 10)
