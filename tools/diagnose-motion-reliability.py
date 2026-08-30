#!/usr/bin/env python3
"""Offline reliability instrumentation for the existing v1 motion estimator.

The production converter exposes no per-node diagnostic hook. This script is
an exact diagnostic mirror of estimate_motion_one_direction in
convert-netcdf-weather.py: same log1p transform, block/search loops, thresholds,
tie order, and nearest-reliable fill. It never writes generated data.
"""
from __future__ import annotations

import gzip
import json
import math
import sys
from pathlib import Path

import numpy as np

ROOT = Path(__file__).resolve().parents[1]
CURRENT = ROOT / "data" / "generated" / "current"
meta_current = json.loads((CURRENT / "metadata.json").read_text())
GENERATION_ID = meta_current["generation_id"]
GENERATION = CURRENT.parent / GENERATION_ID
meta_path = GENERATION / "metadata.json"
metadata = json.loads(meta_path.read_text())
if metadata.get("generation_id") != GENERATION_ID:
    raise SystemExit("immutable generation metadata mismatch")
g = metadata["spatial_grid"]
W, H = g["width"], g["height"]
frames = [np.fromfile(GENERATION / asset, dtype="<f4").reshape(H, W) for asset in metadata["rain"]["frame_assets"]]
motion_assets = [GENERATION / asset for asset in metadata["motion"]["interval_assets"]]
motions = [np.fromfile(path, dtype="<f4").reshape(4, metadata["motion"]["grid_height"], metadata["motion"]["grid_width"]) for path in motion_assets]

BLOCK_RADIUS = 4
SEARCH_RADIUS = 8
MIN_SIGNAL = 0.08
MIN_VARIANCE = 0.0025
MIN_IMPROVEMENT = 0.08
FILL_RADIUS = 4
STRONG_THRESHOLD = 5.0
BOUNDS = (39.5, 42.5, 50.5, 52.3)
x_min = max(0, math.floor((BOUNDS[0] - g["longitude_start"]) / g["longitude_spacing"]))
x_max = min(W - 1, math.ceil((BOUNDS[1] - g["longitude_start"]) / g["longitude_spacing"]))
y_min = max(0, math.floor((BOUNDS[2] - g["latitude_start"]) / g["latitude_spacing"]))
y_max = min(H - 1, math.ceil((BOUNDS[3] - g["latitude_start"]) / g["latitude_spacing"]))


def components(frame):
    seen = np.zeros((H, W), dtype=bool)
    result = []
    for y in range(y_min, y_max + 1):
        for x in range(x_min, x_max + 1):
            if seen[y, x] or frame[y, x] <= STRONG_THRESHOLD:
                continue
            stack = [(y, x)]
            seen[y, x] = True
            cells = []
            while stack:
                cy, cx = stack.pop()
                cells.append((cy, cx))
                for dy in (-1, 0, 1):
                    for dx in (-1, 0, 1):
                        if not dx and not dy:
                            continue
                        ny, nx = cy + dy, cx + dx
                        if y_min <= ny <= y_max and x_min <= nx <= x_max and not seen[ny, nx] and frame[ny, nx] > STRONG_THRESHOLD:
                            seen[ny, nx] = True
                            stack.append((ny, nx))
            weights = np.array([frame[cy, cx] - STRONG_THRESHOLD for cy, cx in cells])
            result.append({
                "cells": cells,
                "count": len(cells),
                "x": float(sum(cx * w for (cy, cx), w in zip(cells, weights)) / weights.sum()),
                "y": float(sum(cy * w for (cy, cx), w in zip(cells, weights)) / weights.sum()),
                "peak": float(max(frame[cy, cx] for cy, cx in cells)),
            })
    return sorted(result, key=lambda item: item["peak"], reverse=True)


tracks = []
previous = None
for frame in frames:
    candidates = components(frame)
    if not candidates:
        raise SystemExit("strong cell disappeared from corridor")
    selected = candidates[0] if previous is None else min(candidates, key=lambda c: math.hypot(c["x"] - previous["x"], c["y"] - previous["y"]))
    tracks.append(selected)
    previous = selected


def diagnostic_estimate(source, target, spacing=16):
    """Exact estimator mirror with per-node gate/fallback diagnostics."""
    height, width = source.shape
    gw = math.ceil((width - 1) / spacing) + 1
    gh = math.ceil((height - 1) / spacing) + 1
    result = np.zeros((4, gh, gw), dtype=np.float32)
    source_log = np.log1p(source.astype(np.float64, copy=False))
    target_log = np.log1p(target.astype(np.float64, copy=False))
    reliable = np.zeros((gh, gw), dtype=bool)
    details = [[None for _ in range(gw)] for _ in range(gh)]
    for gy in range(gh):
        cy = min(height - 1, gy * spacing)
        for gx in range(gw):
            cx = min(width - 1, gx * spacing)
            x0, x1 = max(0, cx - BLOCK_RADIUS), min(width, cx + BLOCK_RADIUS + 1)
            y0, y1 = max(0, cy - BLOCK_RADIUS), min(height, cy + BLOCK_RADIUS + 1)
            block = source_log[y0:y1, x0:x1]
            signal = float(np.mean(block))
            variance = float(np.var(block))
            detail = {"gridX": gx, "gridY": gy, "centerX": cx, "centerY": cy, "signal": signal, "variance": variance, "bestDx": 0, "bestDy": 0, "zeroError": None, "bestError": None, "relativeImprovement": None, "reason": None, "state": "zero"}
            if signal < MIN_SIGNAL:
                detail["reason"] = "insufficient signal"
                details[gy][gx] = detail
                continue
            if variance < MIN_VARIANCE:
                detail["reason"] = "insufficient variance"
                details[gy][gx] = detail
                continue
            best_error = math.inf
            zero_error = math.inf
            best_dx = best_dy = 0
            for dy in range(-SEARCH_RADIUS, SEARCH_RADIUS + 1):
                ty0, ty1 = y0 + dy, y1 + dy
                if ty0 < 0 or ty1 > height:
                    continue
                for dx in range(-SEARCH_RADIUS, SEARCH_RADIUS + 1):
                    tx0, tx1 = x0 + dx, x1 + dx
                    if tx0 < 0 or tx1 > width:
                        continue
                    error = float(np.mean(np.abs(block - target_log[ty0:ty1, tx0:tx1])))
                    if dx == 0 and dy == 0:
                        zero_error = error
                    if error < best_error:
                        best_error, best_dx, best_dy = error, dx, dy
            detail.update(bestDx=best_dx, bestDy=best_dy, zeroError=zero_error, bestError=best_error,
                          relativeImprovement=(zero_error - best_error) / zero_error if zero_error else None)
            if not math.isfinite(best_error):
                detail["reason"] = "other explicit reliability condition"
            elif zero_error <= 0:
                detail["reason"] = "insufficient improvement over zero displacement"
            elif (zero_error - best_error) / zero_error < MIN_IMPROVEMENT:
                detail["reason"] = "insufficient improvement over zero displacement"
            else:
                result[0, gy, gx] = best_dx
                result[1, gy, gx] = best_dy
                result[2, gy, gx] = 1.0
                reliable[gy, gx] = True
                detail["reason"] = "accepted direct block match"
                detail["state"] = "direct"
            details[gy][gx] = detail
    for gy in range(gh):
        for gx in range(gw):
            if reliable[gy, gx]:
                continue
            candidates = []
            for oy in range(-FILL_RADIUS, FILL_RADIUS + 1):
                for ox in range(-FILL_RADIUS, FILL_RADIUS + 1):
                    ny, nx = gy + oy, gx + ox
                    distance2 = ox * ox + oy * oy
                    if distance2 == 0 or distance2 > FILL_RADIUS * FILL_RADIUS:
                        continue
                    if 0 <= ny < gh and 0 <= nx < gw and reliable[ny, nx]:
                        candidates.append((distance2, ny, nx))
            if candidates:
                _, ny, nx = min(candidates)
                result[0, gy, gx] = result[0, ny, nx]
                result[1, gy, gx] = result[1, ny, nx]
                details[gy][gx]["state"] = "filled"
                details[gy][gx]["reason"] = "filled from nearby reliable estimate"
            else:
                details[gy][gx]["state"] = "zero fallback"
    return result, details


def vector_at(values, x, y, component):
    gh, gw = values.shape[1:]
    mx, my = x / metadata["motion"]["grid_spacing_source_nodes"], y / metadata["motion"]["grid_spacing_source_nodes"]
    x0, y0 = min(gw - 2, max(0, math.floor(mx))), min(gh - 2, max(0, math.floor(my)))
    fx, fy = min(1, max(0, mx - x0)), min(1, max(0, my - y0))
    return float((values[component, y0, x0] + (values[component, y0, x0 + 1] - values[component, y0, x0]) * fx) * (1 - fy) + (values[component, y0 + 1, x0] + (values[component, y0 + 1, x0 + 1] - values[component, y0 + 1, x0]) * fx) * fy)


def bilinear(frame, x, y):
    if x < 0 or y < 0 or x > W - 1 or y > H - 1:
        return None
    x0, y0 = min(W - 2, math.floor(x)), min(H - 2, math.floor(y))
    fx, fy = x - x0, y - y0
    low = frame[y0, x0] + (frame[y0, x0 + 1] - frame[y0, x0]) * fx
    high = frame[y0 + 1, x0] + (frame[y0 + 1, x0 + 1] - frame[y0 + 1, x0]) * fx
    return float(low + (high - low) * fy)


def local_alignment(source, target, cx, cy, vectors, components):
    x0, x1 = max(0, int(cx) - 24), min(W - 1, int(cx) + 24)
    y0, y1 = max(0, int(cy) - 24), min(H - 1, int(cy) + 24)
    errors = []; log_errors = []; base = []; base_log = []; intersection = union = 0
    for y in range(y0, y1 + 1):
        for x in range(x0, x1 + 1):
            pred = bilinear(source, x - vector_at(vectors, x, y, components[0]), y - vector_at(vectors, x, y, components[1])) or 0.0
            truth = float(target[y, x]); errors.append(abs(pred - truth)); log_errors.append(abs(math.log1p(pred) - math.log1p(truth)))
            base.append(abs(float(source[y, x]) - truth)); base_log.append(abs(math.log1p(float(source[y, x])) - math.log1p(truth)))
            pa, ta = pred > STRONG_THRESHOLD, truth > STRONG_THRESHOLD
            intersection += pa and ta; union += pa or ta
    return {"mae": float(np.mean(errors)), "logMae": float(np.mean(log_errors)), "baselineMae": float(np.mean(base)), "baselineLogMae": float(np.mean(base_log)), "logImprovementPct": 100 * (np.mean(base_log) - np.mean(log_errors)) / np.mean(base_log) if np.mean(base_log) else 0, "iou": intersection / union if union else 1}


def relevant_details(details, x, y, spacing):
    gx, gy = x / spacing, y / spacing
    x0, y0 = min(len(details[0]) - 2, max(0, math.floor(gx))), min(len(details) - 2, max(0, math.floor(gy)))
    return [details[yy][xx] for yy in range(y0, y0 + 2) for xx in range(x0, x0 + 2)]


current_diag = []; all_diag = []
for i, (source, target) in enumerate(zip(frames[:-1], frames[1:])):
    f, fd = diagnostic_estimate(source, target, 16); b, bd = diagnostic_estimate(target, source, 16)
    a, z = tracks[i], tracks[i + 1]
    relevant_f = relevant_details(fd, (a["x"] + z["x"]) / 2, (a["y"] + z["y"]) / 2, 16)
    relevant_b = relevant_details(bd, (a["x"] + z["x"]) / 2, (a["y"] + z["y"]) / 2, 16)
    current_diag.append({"interval": i, "from": metadata["time"]["timestamps"][i], "to": metadata["time"]["timestamps"][i + 1], "observed": {"dx": z["x"] - a["x"], "dy": z["y"] - a["y"], "magnitude": math.hypot(z["x"] - a["x"], z["y"] - a["y"])}, "forward": {"effective": [vector_at(f, a["x"], a["y"], 0), vector_at(f, a["x"], a["y"], 1)], "relevant": relevant_f, "alignment": local_alignment(source, target, a["x"], a["y"], f, (0, 1))}, "backward": {"effective": [vector_at(b, z["x"], z["y"], 0), vector_at(b, z["x"], z["y"], 1)], "relevant": relevant_b, "alignment": local_alignment(target, source, z["x"], z["y"], b, (0, 1))}})
    all_diag.append((f, b))


def summary_for_spacing(spacing):
    accepted = zero = 0; magnitudes = []; variations = []
    for source, target in zip(frames[:-1], frames[1:]):
        f, fd = diagnostic_estimate(source, target, spacing); b, bd = diagnostic_estimate(target, source, spacing)
        for values, details in ((f, fd), (b, bd)):
            accepted += sum(d["state"] == "direct" for row in details for d in row)
            zero += sum(np.hypot(values[0], values[1]).ravel() > 0)
            magnitudes.extend(np.hypot(values[0], values[1]).ravel())
            variations.extend(np.hypot(np.diff(values[0], axis=1), np.diff(values[1], axis=1)).ravel())
    return {"grid": [math.ceil((W - 1) / spacing) + 1, math.ceil((H - 1) / spacing) + 1], "acceptedDirectFraction": accepted / (2 * len(motions) * (math.ceil((W - 1) / spacing) + 1) * (math.ceil((H - 1) / spacing) + 1)), "nonzeroFraction": zero / len(magnitudes), "magnitudeMean": float(np.mean(magnitudes)), "magnitudeP95": float(np.percentile(magnitudes, 95)), "neighborVariationP95": float(np.percentile(variations, 95)), "rawBytes": len(motions) * 4 * (math.ceil((W - 1) / spacing) + 1) * (math.ceil((H - 1) / spacing) + 1) * 4}


raw_current = sum(path.stat().st_size for path in motion_assets)
gzip_current = sum(len(gzip.compress(path.read_bytes(), compresslevel=9)) for path in motion_assets)
print(json.dumps({"frozenGeneration": {"id": GENERATION_ID, "path": str(GENERATION), "sourceNetcdf": metadata["source"].get("filename"), "timestamps": metadata["time"]["timestamps"], "sourceGrid": [W, H], "motionGrid": [metadata["motion"]["grid_width"], metadata["motion"]["grid_height"]]}, "thresholds": {"blockRadius": BLOCK_RADIUS, "searchRadius": SEARCH_RADIUS, "minSignal": MIN_SIGNAL, "minVariance": MIN_VARIANCE, "minImprovement": MIN_IMPROVEMENT, "fillRadius": FILL_RADIUS}, "trajectory": [{"timestamp": metadata["time"]["timestamps"][i], "x": t["x"], "y": t["y"], "lon": g["longitude_start"] + t["x"] * g["longitude_spacing"], "lat": g["latitude_start"] + t["y"] * g["latitude_spacing"], "peak": t["peak"], "cells": t["count"]} for i, t in enumerate(tracks)], "intervals": current_diag, "sensitivity": {"spacing16": summary_for_spacing(16), "spacing8": summary_for_spacing(8), "spacing8RawPayloadIncreasePct": 100 * (summary_for_spacing(8)["rawBytes"] - raw_current) / raw_current}, "currentAssets": {"rawBytes": raw_current, "gzipBytes": gzip_current}}, indent=2))
