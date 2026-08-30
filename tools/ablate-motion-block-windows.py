#!/usr/bin/env python3
"""Offline v1 block-window ablations for the generated motion field.

This file deliberately does not modify the converter or generated assets. It
freezes data/generated/current to one immutable generation at process start,
mirrors the current estimator, and evaluates two in-memory alternatives:

  A: nine 9x9 hypotheses centered at the same spacing-16 node, with offsets
     (-4, 0, +4)^2 and a conservative displacement-consistency rule.
  B: one 13x13 block centered at the same spacing-16 node.

The output is a diagnostic report, not a generated-data contract.
"""

from __future__ import annotations

import gzip
import json
import math
import os
import sys
import time
from datetime import datetime
from pathlib import Path

import numpy as np


ROOT = Path(__file__).resolve().parents[1]
CURRENT = ROOT / "data" / "generated" / "current"


def read_json(path: Path) -> dict:
    return json.loads(path.read_text(encoding="utf-8"))


# Freeze the active pointer once. No later read in this process follows current.
current_metadata_path = CURRENT / "metadata.json"
current_metadata = read_json(current_metadata_path)
CURRENT_POINTER_GENERATION_ID = current_metadata.get("generation_id")
GENERATION_ID = os.environ.get("DOT_FIELD_GENERATION") or CURRENT_POINTER_GENERATION_ID
if not GENERATION_ID:
    raise SystemExit("data/generated/current/metadata.json has no generation_id")
GENERATION = CURRENT.parent / GENERATION_ID
metadata_path = GENERATION / "metadata.json"
metadata = read_json(metadata_path)
if metadata.get("generation_id") != GENERATION_ID:
    raise SystemExit("immutable generation metadata does not match current generation_id")

grid = metadata["spatial_grid"]
W, H = int(grid["width"]), int(grid["height"])
N = W * H
timestamps = metadata["time"]["timestamps"]
frame_paths = [GENERATION / asset for asset in metadata["rain"]["frame_assets"]]
motion_meta = metadata["motion"]
MOTION_W = int(motion_meta["grid_width"])
MOTION_H = int(motion_meta["grid_height"])
SPACING = int(motion_meta["grid_spacing_source_nodes"])
motion_paths = [GENERATION / asset for asset in motion_meta["interval_assets"]]

frames = [np.fromfile(path, dtype="<f4").reshape(H, W) for path in frame_paths]
current_motion = [
    np.fromfile(path, dtype="<f4").reshape(4, MOTION_H, MOTION_W)
    for path in motion_paths
]


BLOCK_RADIUS = 4
SEARCH_RADIUS = 8
MIN_SIGNAL = 0.08
MIN_VARIANCE = 0.0025
MIN_IMPROVEMENT = 0.08
FILL_RADIUS = 4
STRONG_THRESHOLD = 5.0
LOCAL_RADIUS = 24
FSS_THRESHOLD = 1.0
FSS_SIZE = 5

OFFSET_HYPOTHESES = tuple(
    (dx, dy) for dy in (-4, 0, 4) for dx in (-4, 0, 4)
)


def progress(message: str) -> None:
    print(message, file=sys.stderr, flush=True)


def source_file_provenance() -> dict:
    source_name = metadata.get("source", {}).get("filename")
    source_path = ROOT / "data" / "nc" / source_name if source_name else None
    result = {"filename": source_name, "path": str(source_path) if source_path else None}
    if source_name and len(source_name) >= 15 and source_name[:12].isdigit():
        try:
            result["filenameTimestamp"] = datetime.strptime(source_name[:12], "%Y%m%d%H%M").isoformat()
        except ValueError:
            result["filenameTimestamp"] = None
    else:
        result["filenameTimestamp"] = None
    if source_path and source_path.is_file():
        stat = source_path.stat()
        result["mtime"] = datetime.fromtimestamp(stat.st_mtime).isoformat(timespec="seconds")
        result["sizeBytes"] = stat.st_size
    else:
        result["mtime"] = None
        result["sizeBytes"] = None
    return result


def frozen_generation_report() -> dict:
    return {
        "id": GENERATION_ID,
        "path": str(GENERATION),
        "currentMetadataPath": str(current_metadata_path),
        "currentPointerGenerationIdAtProcessStart": CURRENT_POINTER_GENERATION_ID,
        "generationPinnedByEnvironment": bool(os.environ.get("DOT_FIELD_GENERATION")),
        "sourceFile": source_file_provenance(),
        "sourceTimestamp": metadata.get("source", {}).get("timestamp"),
        "sequenceTimestamps": timestamps,
        "sourceGrid": {"width": W, "height": H, "nodes": N},
        "motionGrid": {
            "width": MOTION_W,
            "height": MOTION_H,
            "spacingSourceNodes": SPACING,
            "nodes": MOTION_W * MOTION_H,
        },
    }


def component_tracks() -> list[dict] | None:
    """Reuse the existing >5 mm/h corridor component trajectory method."""
    west, east, south, north = 39.5, 42.5, 50.5, 52.3
    x_min = max(0, math.floor((west - grid["longitude_start"]) / grid["longitude_spacing"]))
    x_max = min(W - 1, math.ceil((east - grid["longitude_start"]) / grid["longitude_spacing"]))
    y_min = max(0, math.floor((south - grid["latitude_start"]) / grid["latitude_spacing"]))
    y_max = min(H - 1, math.ceil((north - grid["latitude_start"]) / grid["latitude_spacing"]))
    tracks = []
    previous = None
    for frame in frames:
        seen = np.zeros((H, W), dtype=bool)
        candidates = []
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
                            if (
                                y_min <= ny <= y_max
                                and x_min <= nx <= x_max
                                and not seen[ny, nx]
                                and frame[ny, nx] > STRONG_THRESHOLD
                            ):
                                seen[ny, nx] = True
                                stack.append((ny, nx))
                weights = np.asarray([frame[cy, cx] - STRONG_THRESHOLD for cy, cx in cells])
                candidates.append(
                    {
                        "x": float(sum(cx * weight for (cy, cx), weight in zip(cells, weights)) / weights.sum()),
                        "y": float(sum(cy * weight for (cy, cx), weight in zip(cells, weights)) / weights.sum()),
                        "peak": float(max(frame[cy, cx] for cy, cx in cells)),
                        "cells": len(cells),
                    }
        )
        candidates.sort(key=lambda item: item["peak"], reverse=True)
        if not candidates:
            return None
        selected = candidates[0] if previous is None else min(
            candidates, key=lambda item: math.hypot(item["x"] - previous["x"], item["y"] - previous["y"])
        )
        tracks.append(selected)
        previous = selected
    return tracks


def one_block(source_log: np.ndarray, target_log: np.ndarray, cx: int, cy: int, radius: int) -> dict:
    """Exact current v1 block matcher for one centered hypothesis."""
    height, width = source_log.shape
    x0, x1 = max(0, cx - radius), min(width, cx + radius + 1)
    y0, y1 = max(0, cy - radius), min(height, cy + radius + 1)
    block = source_log[y0:y1, x0:x1]
    signal = float(np.mean(block))
    variance = float(np.var(block))
    result = {
        "dx": 0,
        "dy": 0,
        "signal": signal,
        "variance": variance,
        "zeroError": None,
        "bestError": None,
        "improvement": None,
        "reliable": False,
        "reason": None,
    }
    if signal < MIN_SIGNAL:
        result["reason"] = "insufficient signal"
        return result
    if variance < MIN_VARIANCE:
        result["reason"] = "insufficient variance"
        return result
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
    improvement = (zero_error - best_error) / zero_error if zero_error else None
    result.update(
        dx=best_dx,
        dy=best_dy,
        zeroError=zero_error,
        bestError=best_error,
        improvement=improvement,
    )
    if not math.isfinite(best_error):
        result["reason"] = "other explicit reliability condition"
    elif zero_error <= 0 or improvement < MIN_IMPROVEMENT:
        result["reason"] = "insufficient improvement over zero displacement"
    else:
        result["reliable"] = True
        result["reason"] = "accepted direct block match"
    return result


def consistent_offset_result(hypotheses: list[dict]) -> tuple[dict | None, int]:
    """Return a deterministic medoid from a conservative dominant cluster."""
    reliable = [item for item in hypotheses if item["reliable"]]
    if not reliable:
        return None, 0
    groups = []
    for seed_index, seed in enumerate(reliable):
        group = [
            item
            for item in reliable
            if max(abs(item["dx"] - seed["dx"]), abs(item["dy"] - seed["dy"])) <= 1
        ]
        groups.append((len(group), -seed_index, group))
    groups.sort(key=lambda item: (item[0], item[1]), reverse=True)
    _, _, group = groups[0]
    if len(group) < 3 or len(group) < math.ceil(0.6 * len(reliable)):
        return None, len(reliable)
    medoids = []
    for candidate_index, candidate in enumerate(group):
        distance = sum(
            (candidate["dx"] - item["dx"]) ** 2 + (candidate["dy"] - item["dy"]) ** 2
            for item in group
        )
        error = sum(item["bestError"] for item in group)
        medoids.append((distance, error, candidate_index, candidate))
    _, _, _, chosen = min(medoids, key=lambda item: (item[0], item[1], item[2]))
    return chosen, len(reliable)


def estimate_direction(source_log: np.ndarray, target_log: np.ndarray, kind: str) -> tuple[np.ndarray, np.ndarray, np.ndarray, np.ndarray]:
    """Estimate one direction and return vectors, state, signal, hypothesis count."""
    radius = BLOCK_RADIUS if kind != "B" else 6
    offsets = ((0, 0),) if kind != "A" else OFFSET_HYPOTHESES
    vectors = np.zeros((2, MOTION_H, MOTION_W), dtype=np.float32)
    state = np.zeros((MOTION_H, MOTION_W), dtype=np.uint8)  # 0 zero, 1 direct, 2 filled
    direct_signal = np.zeros((MOTION_H, MOTION_W), dtype=np.float32)
    hypothesis_count = np.zeros((MOTION_H, MOTION_W), dtype=np.uint8)
    reliable = np.zeros((MOTION_H, MOTION_W), dtype=bool)
    for gy in range(MOTION_H):
        cy = min(H - 1, gy * SPACING)
        for gx in range(MOTION_W):
            cx = min(W - 1, gx * SPACING)
            hypotheses = [one_block(source_log, target_log, cx + ox, cy + oy, radius) for ox, oy in offsets]
            if kind == "A":
                chosen, count = consistent_offset_result(hypotheses)
            else:
                chosen = hypotheses[0] if hypotheses[0]["reliable"] else None
                count = int(hypotheses[0]["reliable"])
            hypothesis_count[gy, gx] = count
            if chosen is not None:
                vectors[0, gy, gx] = chosen["dx"]
                vectors[1, gy, gx] = chosen["dy"]
                direct_signal[gy, gx] = float(np.mean([item["signal"] for item in hypotheses if item["reliable"]]))
                state[gy, gx] = 1
                reliable[gy, gx] = True
    # Exact current nearest reliable fill, including deterministic distance/tie order.
    for gy in range(MOTION_H):
        for gx in range(MOTION_W):
            if reliable[gy, gx]:
                continue
            candidates = []
            for oy in range(-FILL_RADIUS, FILL_RADIUS + 1):
                for ox in range(-FILL_RADIUS, FILL_RADIUS + 1):
                    ny, nx = gy + oy, gx + ox
                    distance2 = ox * ox + oy * oy
                    if distance2 == 0 or distance2 > FILL_RADIUS * FILL_RADIUS:
                        continue
                    if 0 <= ny < MOTION_H and 0 <= nx < MOTION_W and reliable[ny, nx]:
                        candidates.append((distance2, ny, nx))
            if candidates:
                _, ny, nx = min(candidates)
                vectors[:, gy, gx] = vectors[:, ny, nx]
                direct_signal[gy, gx] = direct_signal[ny, nx]
                state[gy, gx] = 2
    return vectors, state, direct_signal, hypothesis_count


def vector_at(values: np.ndarray, x: float, y: float, component: int = 0) -> float:
    _, height, width = values.shape
    mx, my = x / SPACING, y / SPACING
    x0 = min(width - 2, max(0, math.floor(mx)))
    y0 = min(height - 2, max(0, math.floor(my)))
    fx, fy = min(1, max(0, mx - x0)), min(1, max(0, my - y0))
    low = values[component, y0, x0] + (values[component, y0, x0 + 1] - values[component, y0, x0]) * fx
    high = values[component, y0 + 1, x0] + (values[component, y0 + 1, x0 + 1] - values[component, y0 + 1, x0]) * fx
    return float(low + (high - low) * fy)


def transport(source: np.ndarray, vectors: np.ndarray, scale: float = 1.0) -> np.ndarray:
    """Vectorized equivalent of runtime bilinearSourceGrid with null -> 0."""
    yy, xx = np.indices((H, W), dtype=np.float64)
    motion_x, motion_y = xx / SPACING, yy / SPACING
    motion_x0 = np.minimum(MOTION_W - 2, np.floor(motion_x).astype(np.int64))
    motion_y0 = np.minimum(MOTION_H - 2, np.floor(motion_y).astype(np.int64))
    motion_fx, motion_fy = motion_x - motion_x0, motion_y - motion_y0
    dx_low = vectors[0, motion_y0, motion_x0] + (vectors[0, motion_y0, motion_x0 + 1] - vectors[0, motion_y0, motion_x0]) * motion_fx
    dx_high = vectors[0, motion_y0 + 1, motion_x0] + (vectors[0, motion_y0 + 1, motion_x0 + 1] - vectors[0, motion_y0 + 1, motion_x0]) * motion_fx
    dy_low = vectors[1, motion_y0, motion_x0] + (vectors[1, motion_y0, motion_x0 + 1] - vectors[1, motion_y0, motion_x0]) * motion_fx
    dy_high = vectors[1, motion_y0 + 1, motion_x0] + (vectors[1, motion_y0 + 1, motion_x0 + 1] - vectors[1, motion_y0 + 1, motion_x0]) * motion_fx
    dx = dx_low + (dx_high - dx_low) * motion_fy
    dy = dy_low + (dy_high - dy_low) * motion_fy
    sample_x = xx - scale * dx
    sample_y = yy - scale * dy
    valid = (sample_x >= 0) & (sample_x <= W - 1) & (sample_y >= 0) & (sample_y <= H - 1)
    safe_x = np.clip(sample_x, 0, W - 1)
    safe_y = np.clip(sample_y, 0, H - 1)
    x0 = np.minimum(W - 2, np.floor(safe_x).astype(np.int64))
    y0 = np.minimum(H - 2, np.floor(safe_y).astype(np.int64))
    fx, fy = safe_x - x0, safe_y - y0
    low = source[y0, x0] + (source[y0, x0 + 1] - source[y0, x0]) * fx
    high = source[y0 + 1, x0] + (source[y0 + 1, x0 + 1] - source[y0 + 1, x0]) * fx
    return np.where(valid, low + (high - low) * fy, 0.0)


def fss(pred: np.ndarray, truth: np.ndarray) -> float:
    binary_pred = (pred > FSS_THRESHOLD).astype(np.int32)
    binary_truth = (truth > FSS_THRESHOLD).astype(np.int32)
    integral_pred = np.pad(binary_pred.cumsum(0).cumsum(1), ((1, 0), (1, 0)))
    integral_truth = np.pad(binary_truth.cumsum(0).cumsum(1), ((1, 0), (1, 0)))
    yy, xx = np.indices((H, W))
    radius = FSS_SIZE // 2
    x0, y0 = np.maximum(xx - radius, 0), np.maximum(yy - radius, 0)
    x1, y1 = np.minimum(xx + radius + 1, W), np.minimum(yy + radius + 1, H)
    area = (x1 - x0) * (y1 - y0)
    def window(integral):
        return (integral[y1, x1] - integral[y0, x1] - integral[y1, x0] + integral[y0, x0]) / area
    a, b = window(integral_pred), window(integral_truth)
    denominator = np.sum(a * a + b * b)
    return float(1 - np.sum((a - b) ** 2) / denominator) if denominator else 1.0


def field_state_counts(state: np.ndarray) -> dict:
    return {
        "direct": int(np.count_nonzero(state == 1)),
        "filled": int(np.count_nonzero(state == 2)),
        "zero": int(np.count_nonzero(state == 0)),
    }


def percentile(values: np.ndarray) -> dict:
    values = np.asarray(values, dtype=np.float64)
    return {
        "count": int(values.size),
        "median": float(np.percentile(values, 50)),
        "p95": float(np.percentile(values, 95)),
        "p99": float(np.percentile(values, 99)),
        "max": float(np.max(values)),
    }


def coherence_report(fields: list[dict]) -> dict:
    magnitudes = []
    variations = []
    isolated = 0
    nonzero = 0
    accepted = 0
    weak_accepted = 0
    for field in fields:
        vectors = field["vectors"]
        state = field["state"]
        mags = np.hypot(vectors[0], vectors[1])
        magnitudes.append(mags.ravel())
        nonzero_mask = mags > 0
        nonzero += int(nonzero_mask.sum())
        accepted += int(np.count_nonzero(state == 1))
        weak_accepted += int(np.count_nonzero((state == 1) & (field["signal"] < MIN_SIGNAL * 2)))
        if nonzero_mask.any():
            neighbors = np.zeros_like(nonzero_mask)
            for oy in (-1, 0, 1):
                for ox in (-1, 0, 1):
                    if not ox and not oy:
                        continue
                    source_y0 = max(0, -oy); source_y1 = min(MOTION_H, MOTION_H - oy)
                    source_x0 = max(0, -ox); source_x1 = min(MOTION_W, MOTION_W - ox)
                    target_y0 = max(0, oy); target_y1 = min(MOTION_H, MOTION_H + oy)
                    target_x0 = max(0, ox); target_x1 = min(MOTION_W, MOTION_W + ox)
                    neighbors[target_y0:target_y1, target_x0:target_x1] |= nonzero_mask[source_y0:source_y1, source_x0:source_x1]
            isolated += int(np.count_nonzero(nonzero_mask & ~neighbors))
        variations.append(np.hypot(np.diff(vectors[0], axis=1), np.diff(vectors[1], axis=1)).ravel())
        variations.append(np.hypot(np.diff(vectors[0], axis=0), np.diff(vectors[1], axis=0)).ravel())
    magnitude_values = np.concatenate(magnitudes)
    variation_values = np.concatenate(variations)
    total = len(fields) * MOTION_W * MOTION_H
    return {
        "directAcceptedVectorFraction": accepted / total,
        "filledVectorFraction": sum(int(np.count_nonzero(field["state"] == 2)) for field in fields) / total,
        "finalZeroVectorFraction": 1 - nonzero / total,
        "nonzeroVectorFraction": nonzero / total,
        "displacementMagnitude": percentile(magnitude_values),
        "neighboringVectorVariation": percentile(variation_values),
        "isolatedNonzeroVectorFraction": isolated / nonzero if nonzero else 0.0,
        "neighborVariationAbove4NodesFraction": float(np.mean(variation_values > 4.0)),
        "directSignalsBelow0.16Fraction": weak_accepted / accepted if accepted else 0.0,
        "directSignalLog1p": percentile(np.concatenate([
            field["signal"][field["state"] == 1] for field in fields if np.any(field["state"] == 1)
        ]) if accepted else np.asarray([0.0])),
    }


def relevant_nodes(state: np.ndarray, x: float, y: float) -> dict:
    gx, gy = x / SPACING, y / SPACING
    x0 = min(MOTION_W - 2, max(0, math.floor(gx)))
    y0 = min(MOTION_H - 2, max(0, math.floor(gy)))
    values = state[y0:y0 + 2, x0:x0 + 2]
    return {
        "direct": int(np.count_nonzero(values == 1)),
        "filled": int(np.count_nonzero(values == 2)),
        "zero": int(np.count_nonzero(values == 0)),
        "nodes": [[int(x0 + dx), int(y0 + dy), int(values[dy, dx])] for dy in range(2) for dx in range(2)],
    }


def local_metrics(source: np.ndarray, target: np.ndarray, transported: np.ndarray, cx: float, cy: float) -> dict:
    x0, x1 = max(0, int(cx) - LOCAL_RADIUS), min(W, int(cx) + LOCAL_RADIUS + 1)
    y0, y1 = max(0, int(cy) - LOCAL_RADIUS), min(H, int(cy) + LOCAL_RADIUS + 1)
    prediction = transported[y0:y1, x0:x1]
    truth = target[y0:y1, x0:x1]
    original = source[y0:y1, x0:x1]
    error = float(np.abs(np.log1p(prediction) - np.log1p(truth)).mean())
    baseline_error = float(np.abs(np.log1p(original) - np.log1p(truth)).mean())
    predicted_footprint = prediction > STRONG_THRESHOLD
    truth_footprint = truth > STRONG_THRESHOLD
    union = predicted_footprint | truth_footprint
    return {
        "cells": int(prediction.size),
        "transportedLog1pMae": error,
        "baselineLog1pMae": baseline_error,
        "log1pMaeImprovementPct": 100 * (baseline_error - error) / baseline_error if baseline_error else 0.0,
        "strongRainFootprintIoU": float((predicted_footprint & truth_footprint).sum() / union.sum()) if union.any() else 1.0,
    }


def trajectory_report(variants: dict, tracks: list[dict]) -> tuple[list[dict], list[int]]:
    rows = []
    baseline_zero_intervals = []
    for i in range(len(frames) - 1):
        a, b = tracks[i], tracks[i + 1]
        midpoint_x, midpoint_y = (a["x"] + b["x"]) / 2, (a["y"] + b["y"]) / 2
        observed = {"dx": b["x"] - a["x"], "dy": b["y"] - a["y"]}
        observed["magnitude"] = math.hypot(observed["dx"], observed["dy"])
        row = {"interval": i, "from": timestamps[i], "to": timestamps[i + 1], "observedDisplacement": observed}
        for name, variant in variants.items():
            f = variant["intervals"][i]["forward"]
            back = variant["intervals"][i]["backward"]
            forward_transport = variant["transport"][i]["forward"]
            backward_transport = variant["transport"][i]["backward"]
            effective_f = [vector_at(f["vectors"], a["x"], a["y"], c) for c in (0, 1)]
            effective_b = [vector_at(back["vectors"], b["x"], b["y"], c) for c in (0, 1)]
            f_nodes = relevant_nodes(f["state"], midpoint_x, midpoint_y)
            b_nodes = relevant_nodes(back["state"], midpoint_x, midpoint_y)
            row[name] = {
                "forward": {
                    "effectiveDisplacement": {"dx": effective_f[0], "dy": effective_f[1], "magnitude": math.hypot(*effective_f)},
                    "relevantNodes": {key: value for key, value in f_nodes.items() if key != "nodes"},
                    "localAlignment": local_metrics(frames[i], frames[i + 1], forward_transport, a["x"], a["y"]),
                },
                "backward": {
                    "effectiveDisplacement": {"dx": effective_b[0], "dy": effective_b[1], "magnitude": math.hypot(*effective_b)},
                    "relevantNodes": {key: value for key, value in b_nodes.items() if key != "nodes"},
                    "localAlignment": local_metrics(frames[i + 1], frames[i], backward_transport, b["x"], b["y"]),
                },
            }
        baseline = row["baseline"]
        if baseline["forward"]["relevantNodes"]["zero"] == 4 or baseline["backward"]["relevantNodes"]["zero"] == 4:
            baseline_zero_intervals.append(i)
        rows.append(row)
    return rows, baseline_zero_intervals


def aggregate_alignment(variant: dict) -> dict:
    direction_rows = {}
    for direction in ("forward", "backward"):
        rows = []
        for i in range(len(frames) - 1):
            source = frames[i] if direction == "forward" else frames[i + 1]
            target = frames[i + 1] if direction == "forward" else frames[i]
            prediction = variant["transport"][i][direction]
            error = np.abs(np.log1p(prediction) - np.log1p(target))
            baseline = np.abs(np.log1p(source) - np.log1p(target))
            row = {
                "interval": i,
                "from": timestamps[i],
                "to": timestamps[i + 1],
                "transportedLog1pMae": float(error.mean()),
                "untransportedLog1pMae": float(baseline.mean()),
                "deltaVsBaselineEstimator": None,
            }
            rows.append(row)
        direction_rows[direction] = rows
    for direction in ("forward", "backward"):
        baseline_rows = variant["baselineReference"][direction]
        for row, baseline_row in zip(direction_rows[direction], baseline_rows):
            row["deltaVsBaselineEstimator"] = row["transportedLog1pMae"] - baseline_row["transportedLog1pMae"]
    result = {}
    for direction, rows in direction_rows.items():
        transported = np.asarray([row["transportedLog1pMae"] for row in rows])
        untransported = np.asarray([row["untransportedLog1pMae"] for row in rows])
        deltas = np.asarray([row["deltaVsBaselineEstimator"] for row in rows])
        result[direction] = {
            "transportedLog1pMae": float(transported.mean()),
            "untransportedBaselineLog1pMae": float(untransported.mean()),
            "relativeImprovementPct": float(100 * (untransported.mean() - transported.mean()) / untransported.mean()),
            "winsVsBaselineEstimator": int(np.count_nonzero(deltas < -1e-12)),
            "tiesVsBaselineEstimator": int(np.count_nonzero(np.abs(deltas) <= 1e-12)),
            "lossesVsBaselineEstimator": int(np.count_nonzero(deltas > 1e-12)),
            "worstRegressionIntervals": [
                {**rows[index], "deltaVsBaselineEstimator": float(deltas[index])}
                for index in np.argsort(deltas)[-5:][::-1]
                if deltas[index] > 1e-12
            ],
            "perInterval": rows,
        }
    return result


def heldout_metrics(variant_name: str, kind: str) -> dict:
    progress(f"held-out benchmark: {variant_name}")
    triples = []
    totals = {"mmhMae": [], "log1pMae": [], "csi": {str(t): [] for t in (0.1, 1, 5)}, "fss": []}
    linear_totals = {"mmhMae": [], "log1pMae": [], "csi": {str(t): [] for t in (0.1, 1, 5)}, "fss": []}
    for i in range(len(frames) - 2):
        vectors_forward, _, _, _ = estimate_direction(np.log1p(frames[i]), np.log1p(frames[i + 2]), kind)
        vectors_backward, _, _, _ = estimate_direction(np.log1p(frames[i + 2]), np.log1p(frames[i]), kind)
        transported_a = transport(frames[i], vectors_forward, 0.5)
        transported_c = transport(frames[i + 2], vectors_backward, 0.5)
        prediction = transported_a * 0.5 + transported_c * 0.5
        linear = (frames[i] + frames[i + 2]) * 0.5
        truth = frames[i + 1]
        row = {"triple": i, "from": timestamps[i], "heldOut": timestamps[i + 1], "to": timestamps[i + 2]}
        for name, values, bucket in (("candidate", prediction, totals), ("linear", linear, linear_totals)):
            mmh_mae = float(np.abs(values - truth).mean())
            log_mae = float(np.abs(np.log1p(values) - np.log1p(truth)).mean())
            scores = {}
            for threshold in (0.1, 1, 5):
                a, b = values > threshold, truth > threshold
                union = a | b
                score = float((a & b).sum() / union.sum()) if union.any() else 1.0
                scores[str(threshold)] = score
                bucket["csi"][str(threshold)].append(score)
            fss_score = fss(values, truth)
            bucket["mmhMae"].append(mmh_mae)
            bucket["log1pMae"].append(log_mae)
            bucket["fss"].append(fss_score)
            row[name] = {"maeMmh": mmh_mae, "log1pMae": log_mae, "csiIou": scores, "fss": fss_score}
        row["deltaCandidateMinusLinear"] = {
            "maeMmh": row["candidate"]["maeMmh"] - row["linear"]["maeMmh"],
            "log1pMae": row["candidate"]["log1pMae"] - row["linear"]["log1pMae"],
            "fss": row["candidate"]["fss"] - row["linear"]["fss"],
        }
        triples.append(row)
    def summary(bucket: dict) -> dict:
        return {
            "maeMmh": float(np.mean(bucket["mmhMae"])),
            "log1pMae": float(np.mean(bucket["log1pMae"])),
            "csiIou": {key: float(np.mean(value)) for key, value in bucket["csi"].items()},
            "fss": float(np.mean(bucket["fss"])),
        }
    return {
        "method": "same A/B/C middle-frame midpoint: 0.5*transport(A, A->C, 0.5) + 0.5*transport(C, C->A, 0.5)",
        "candidate": summary(totals),
        "untransportedBaseline": summary(linear_totals),
        "perTripleWinsLossesVsUntransported": {
            "mmhMae": {"wins": sum(row["deltaCandidateMinusLinear"]["maeMmh"] < -1e-12 for row in triples), "ties": sum(abs(row["deltaCandidateMinusLinear"]["maeMmh"]) <= 1e-12 for row in triples), "losses": sum(row["deltaCandidateMinusLinear"]["maeMmh"] > 1e-12 for row in triples)},
            "log1pMae": {"wins": sum(row["deltaCandidateMinusLinear"]["log1pMae"] < -1e-12 for row in triples), "ties": sum(abs(row["deltaCandidateMinusLinear"]["log1pMae"]) <= 1e-12 for row in triples), "losses": sum(row["deltaCandidateMinusLinear"]["log1pMae"] > 1e-12 for row in triples)},
            "fss": {"wins": sum(row["deltaCandidateMinusLinear"]["fss"] > 1e-12 for row in triples), "ties": sum(abs(row["deltaCandidateMinusLinear"]["fss"]) <= 1e-12 for row in triples), "losses": sum(row["deltaCandidateMinusLinear"]["fss"] < -1e-12 for row in triples)},
        },
        "perTriple": triples,
    }


def build_variant(kind: str) -> dict:
    interval_results = []
    for i, (source, target) in enumerate(zip(frames[:-1], frames[1:])):
        progress(f"{kind}: adjacent interval {i + 1}/{len(frames) - 1}")
        source_log, target_log = np.log1p(source), np.log1p(target)
        forward, forward_state, forward_signal, forward_hypotheses = estimate_direction(source_log, target_log, kind)
        backward, backward_state, backward_signal, backward_hypotheses = estimate_direction(target_log, source_log, kind)
        interval_results.append({
            "forward": {"vectors": forward, "state": forward_state, "signal": forward_signal, "hypotheses": forward_hypotheses},
            "backward": {"vectors": backward, "state": backward_state, "signal": backward_signal, "hypotheses": backward_hypotheses},
        })
    transport_results = []
    for i, interval in enumerate(interval_results):
        progress(f"{kind}: transport interval {i + 1}/{len(interval_results)}")
        transport_results.append({
            "forward": transport(frames[i], interval["forward"]["vectors"]),
            "backward": transport(frames[i + 1], interval["backward"]["vectors"]),
        })
    return {"intervals": interval_results, "transport": transport_results}


tracks = component_tracks()
start = time.perf_counter()
progress("baseline: mirroring current v1 estimator")
baseline = build_variant("baseline")
baseline_estimation_seconds = time.perf_counter() - start
baseline_asset_agreement = []
for interval in range(len(current_motion)):
    baseline_asset_agreement.append(bool(
        np.array_equal(baseline["intervals"][interval]["forward"]["vectors"], current_motion[interval][0:2])
        and np.array_equal(baseline["intervals"][interval]["backward"]["vectors"], current_motion[interval][2:4])
    ))

start = time.perf_counter()
progress("candidate A: offset hypotheses")
candidate_a = build_variant("A")
candidate_a_estimation_seconds = time.perf_counter() - start

start = time.perf_counter()
progress("candidate B: larger evidence window")
candidate_b = build_variant("B")
candidate_b_estimation_seconds = time.perf_counter() - start

variants = {"baseline": baseline, "candidateA": candidate_a, "candidateB": candidate_b}
baseline_alignment_reference = {}
for direction in ("forward", "backward"):
    rows = []
    for i in range(len(frames) - 1):
        source = frames[i] if direction == "forward" else frames[i + 1]
        target = frames[i + 1] if direction == "forward" else frames[i]
        prediction = baseline["transport"][i][direction]
        rows.append({"transportedLog1pMae": float(np.abs(np.log1p(prediction) - np.log1p(target)).mean())})
    baseline_alignment_reference[direction] = rows
for variant in variants.values():
    variant["baselineReference"] = baseline_alignment_reference

trajectory, baseline_zero_intervals = (
    trajectory_report(variants, tracks) if tracks is not None else ([], [])
)
alignment = {name: aggregate_alignment(variant) for name, variant in variants.items()}
coherence = {
    name: coherence_report([
        {"vectors": interval[direction]["vectors"], "state": interval[direction]["state"], "signal": interval[direction]["signal"]}
        for interval in variant["intervals"] for direction in ("forward", "backward")
    ])
    for name, variant in variants.items()
}

heldout = {
    "baseline": heldout_metrics("baseline", "baseline"),
    "candidateA": heldout_metrics("candidateA", "A"),
    "candidateB": heldout_metrics("candidateB", "B"),
}

raw_motion_bytes = sum(path.stat().st_size for path in motion_paths)
gzip_motion_bytes = sum(Path(f"{path}.gz").stat().st_size for path in motion_paths)
candidate_assets = {}
for name, variant in variants.items():
    payloads = []
    for interval in variant["intervals"]:
        payload = np.concatenate((interval["forward"]["vectors"], interval["backward"]["vectors"]), axis=0).astype("<f4", copy=False)
        payloads.append(payload.tobytes())
    candidate_assets[name] = {
        "rawBytes": sum(len(payload) for payload in payloads),
        "gzipBytes": sum(len(gzip.compress(payload, compresslevel=9)) for payload in payloads),
    }

elapsed = {
    "baselineMirrorSeconds": baseline_estimation_seconds,
    "candidateASeconds": candidate_a_estimation_seconds,
    "candidateBSeconds": candidate_b_estimation_seconds,
}
field_counts = {
    name: {
        "total": {
            key: sum(field_state_counts(interval[direction]["state"])[key] for interval in variant["intervals"] for direction in ("forward", "backward"))
            for key in ("direct", "filled", "zero")
        },
    }
    for name, variant in variants.items()
}
for name, variant in variants.items():
    field_counts[name]["perInterval"] = [
        {"interval": i, "forward": field_state_counts(interval["forward"]["state"]), "backward": field_state_counts(interval["backward"]["state"])}
        for i, interval in enumerate(variant["intervals"])
    ]

report = {
    "frozenGeneration": frozen_generation_report(),
    "estimatorBaseline": {
        "spacingSourceNodes": SPACING,
        "blockSize": 9,
        "blockRadiusSourceNodes": BLOCK_RADIUS,
        "searchRadiusSourceNodes": SEARCH_RADIUS,
        "signalTransform": "log1p(rain_mmh)",
        "metric": "mean_absolute_difference",
        "minSignal": MIN_SIGNAL,
        "minVariance": MIN_VARIANCE,
        "minImprovementOverZero": MIN_IMPROVEMENT,
        "fillRadiusMotionCells": FILL_RADIUS,
        "independentForwardBackward": True,
        "baselineAssetAgreementAllIntervals": all(baseline_asset_agreement),
        "baselineAssetAgreementPerInterval": baseline_asset_agreement,
    },
    "candidateA": {
        "offsetsSourceNodes": list(OFFSET_HYPOTHESES),
        "blockSize": 9,
        "consistencyRule": "Run current reliability rules per hypothesis; accept only a dominant cluster of at least 3 reliable hypotheses, at least ceil(0.6 * reliable hypothesis count), with each cluster member within Chebyshev distance 1 of a seed. Store the deterministic minimum-distance medoid, then apply unchanged nearest-reliable fill.",
        "storedMotionGridUnchanged": True,
    },
    "candidateB": {
        "blockSize": 13,
        "blockRadiusSourceNodes": 6,
        "searchRadiusSourceNodes": SEARCH_RADIUS,
        "normalization": "unchanged mean signal, variance, and mean-absolute-error semantics; no threshold retuning",
        "storedMotionGridUnchanged": True,
    },
    "trackedCell": {
        "selection": "same corridor bounds and connected >5 mm/h component nearest-centroid trajectory as existing diagnostic",
        "available": tracks is not None,
        "unavailableReason": None if tracks is not None else "no >5 mm/h compact component exists in every source frame within the Ertil–Novokhopersk corridor",
        "trajectory": tracks,
        "intervals": trajectory,
        "baselineZeroVectorIntervals": baseline_zero_intervals,
        "baselineZeroVectorIntervalCount": len(baseline_zero_intervals),
    },
    "wholeGenerationOneStepAlignment": alignment,
    "motionFieldQuality": coherence,
    "fieldStateCounts": field_counts,
    "heldOutMiddleFrame": heldout,
    "offlinePreparationCost": elapsed,
    "runtimeAndDataImplications": {
        "motionGrid": [MOTION_W, MOTION_H],
        "componentsPerInterval": 4,
        "rawMotionBytes": candidate_assets["baseline"]["rawBytes"],
        "rawMotionBytesDelta": {name: assets["rawBytes"] - raw_motion_bytes for name, assets in candidate_assets.items()},
        "gzipMotionBytesCurrent": gzip_motion_bytes,
        "gzipMotionBytesEstimated": {name: assets["gzipBytes"] for name, assets in candidate_assets.items()},
        "browserMotionAssetMemoryBytes": {name: assets["rawBytes"] for name, assets in candidate_assets.items()},
        "runtimeMotionGridBilinearLookupsPerActiveSample": {name: 4 for name in variants},
        "runtimeSourceBilinearSamplesPerActiveSample": {name: 2 for name in variants},
        "preparedStateBytesPerActiveSample": {name: 6 * 4 for name in variants},
        "supportAndPreparedStateShapeChanged": False,
        "candidateOfflineOnly": True,
    },
    "verification": {
        "sourceFramesLoadedFromFrozenGeneration": True,
        "currentPointerReadOnlyAtStart": True,
        "currentMotionAssetByteLength": raw_motion_bytes,
        "currentMotionAssetByteLengthFromMetadata": int(motion_meta["interval_byte_length"]) * len(motion_paths),
    },
}
print(json.dumps(report, indent=2))
