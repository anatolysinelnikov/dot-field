#!/usr/bin/env python3
"""Report-only local alignment and held-out win/loss details for the threshold sweep."""
import contextlib
import importlib.util
import io
import json
import os
from collections import Counter
from pathlib import Path

import numpy as np

ROOT = Path(__file__).resolve().parents[1]
os.environ["DOT_FIELD_GENERATION"] = "generation-74d410c73ad39327"
spec = importlib.util.spec_from_file_location("ablation", ROOT / "tools/ablate-motion-signal-threshold.py")
mod = importlib.util.module_from_spec(spec)
with contextlib.redirect_stdout(io.StringIO()):
    spec.loader.exec_module(mod)

def local_metrics(src, target, vectors, cx, cy, radius=24):
    prediction = mod.transport(src, vectors, mod.spacing)
    dx, dy = mod.upsample(vectors, mod.spacing)
    ix, iy = min(mod.W - 1, max(0, int(round(cx)))), min(mod.H - 1, max(0, int(round(cy))))
    x0, x1 = max(0, int(round(cx)) - radius), min(mod.W, int(round(cx)) + radius + 1)
    y0, y1 = max(0, int(round(cy)) - radius), min(mod.H, int(round(cy)) + radius + 1)
    p, t, s = prediction[y0:y1, x0:x1], target[y0:y1, x0:x1], src[y0:y1, x0:x1]
    err, base = np.abs(np.log1p(p) - np.log1p(t)).mean(), np.abs(np.log1p(s) - np.log1p(t)).mean()
    pm, tm = p > mod.strong, t > mod.strong
    return {"effectiveDisplacement": [float(dx[iy, ix]), float(dy[iy, ix])],
            "transportedLogMAE": float(err), "baselineLogMAE": float(base),
            "improvementPct": float(100 * (base - err) / base) if base else 0.0,
            "strongIoU": float((pm & tm).sum() / (pm | tm).sum()) if (pm | tm).any() else 1.0}

out = {}
def relevant_nodes(detail, cx, cy):
    gx, gy = cx / mod.spacing, cy / mod.spacing
    x0, y0 = min(len(detail[0]) - 2, max(0, int(np.floor(gx)))), min(len(detail) - 2, max(0, int(np.floor(gy))))
    return [detail[y][x] for y in range(y0, y0 + 2) for x in range(x0, x0 + 2)]

for threshold in mod.thresholds:
    local = []
    linear_errors = {"mae": [], "log": [], "fss": []}
    motion_errors = {"mae": [], "log": [], "fss": []}
    for i, (a, b) in enumerate(zip(mod.frames[:-1], mod.frames[1:])):
        f, fd = mod.estimate(a, b, threshold)
        back, bd = mod.estimate(b, a, threshold)
        A, B = mod.tracks[i], mod.tracks[i + 1]
        cx, cy = (A["x"] + B["x"]) / 2, (A["y"] + B["y"]) / 2
        rf, rb = relevant_nodes(fd, cx, cy), relevant_nodes(bd, cx, cy)
        local.append({"interval": i, "from": mod.m["time"]["timestamps"][i],
                      "to": mod.m["time"]["timestamps"][i + 1],
                      "forwardReasons": dict(Counter(x["reason"] for x in rf)),
                      "backwardReasons": dict(Counter(x["reason"] for x in rb)),
                      "forward": local_metrics(a, b, f, cx, cy),
                      "backward": local_metrics(b, a, back, cx, cy)})
        if i < len(mod.frames) - 2:
            c = mod.frames[i + 2]
            ac, _ = mod.estimate(a, c, threshold)
            ca, _ = mod.estimate(c, a, threshold)
            pred = (mod.transport(a, ac, mod.spacing) + mod.transport(c, ca, mod.spacing)) / 2
            linear = (a + c) / 2
            for key, value in (("mae", np.abs(linear - b).mean()), ("log", np.abs(np.log1p(linear) - np.log1p(b)).mean()), ("fss", mod.fss(linear, b))):
                linear_errors[key].append(float(value))
            for key, value in (("mae", np.abs(pred - b).mean()), ("log", np.abs(np.log1p(pred) - np.log1p(b)).mean()), ("fss", mod.fss(pred, b))):
                motion_errors[key].append(float(value))
    out[str(threshold)] = {"local": local, "heldoutWins": {
        "maeMotionWins": sum(m < l for m, l in zip(motion_errors["mae"], linear_errors["mae"])),
        "maeLinearWins": sum(l < m for m, l in zip(motion_errors["mae"], linear_errors["mae"])),
        "logMotionWins": sum(m < l for m, l in zip(motion_errors["log"], linear_errors["log"])),
        "logLinearWins": sum(l < m for m, l in zip(motion_errors["log"], linear_errors["log"])),
        "fssMotionWins": sum(m > l for m, l in zip(motion_errors["fss"], linear_errors["fss"])),
        "fssLinearWins": sum(l > m for m, l in zip(motion_errors["fss"], linear_errors["fss"])),
        "ties": sum(m == l for m, l in zip(motion_errors["mae"], linear_errors["mae"]))
    }}
print(json.dumps(out, indent=2))
