#!/usr/bin/env python3
"""Generate the experimental tiled-rain MotionField.

The estimator consumes the exact physical Float32 L13 reconstruction used by
``generate-tiled-rain.py``.  Motion is estimated once on a globally anchored
64-sample grid and is only packaged into 128-sample rain tiles after all
intervals have been estimated.
"""

from __future__ import annotations

import argparse
import gzip
import hashlib
import importlib.util
import json
import math
import sys
import time
from pathlib import Path
from typing import Any, Iterable

import numpy as np


SCHEMA = "dot-field-tiled-rain-motion-v1"
VERSION = 1
LOD_LEVEL = 13
GRID_SIZE = 2**LOD_LEVEL
RAIN_TILE_SIZE = 128
MOTION_NODE_SPACING = 64
MOTION_REGION_SIZE = 512
MOTION_FOOTPRINT_RADIUS = 16
MAX_COMPONENT_DISPLACEMENT = 12
COARSE_DISPLACEMENT_STEP = 4
REGIONAL_SAMPLE_STRIDE = 8
LOCAL_SEARCH_RADIUS = 2
MIN_REGIONAL_INFORMATIVE = 48
MIN_LOCAL_INFORMATIVE = 24
MIN_SIGNAL_LOG_SUM = 3.0
MIN_IMPROVEMENT = 0.08
MIN_AMBIGUITY_MARGIN = 0.05
MATCH_RAIN_THRESHOLD_MMH = 0.05
# These are diagnostic relevance gates, not estimator acceptance thresholds.
# They answer whether a node has enough local rain evidence to be worth judging.
MOTION_RELEVANCE_MIN_INFORMATIVE_SAMPLES = 8
MOTION_RELEVANCE_MIN_SIGNAL_LOG_SUM = 1.0
REGIONAL_FALLBACK_CONFIDENCE_SCALE = 0.5


def parse_arguments() -> argparse.Namespace:
    repository_root = Path(__file__).resolve().parents[1]
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--source-metadata",
        type=Path,
        default=repository_root / "data" / "generated" / "current" / "metadata.json",
    )
    parser.add_argument(
        "--source-manifest",
        type=Path,
        default=repository_root / "data" / "generated" / "tiled-rain" / "current" / "manifest.json",
    )
    parser.add_argument(
        "--output",
        type=Path,
        default=repository_root / "data" / "generated" / "tiled-rain-motion" / "current",
    )
    parser.add_argument(
        "--benchmark-report",
        type=Path,
        default=None,
        help="optional JSON timing report written outside the deterministic manifest",
    )
    parser.add_argument(
        "--expected-generation-id",
        default=None,
        help="optional snapshot assertion for a reproducible benchmark run",
    )
    parser.add_argument(
        "--expected-source-filename",
        default=None,
        help="optional source filename assertion for a reproducible benchmark run",
    )
    return parser.parse_args()


def load_phase_0a_reconstructor() -> Any:
    """Load the Phase 0A helper without creating or changing a pycache file."""

    sys.dont_write_bytecode = True
    path = Path(__file__).with_name("generate-tiled-rain.py")
    spec = importlib.util.spec_from_file_location("phase_0a_tiled_rain", path)
    if spec is None or spec.loader is None:
        raise RuntimeError(f"cannot load Phase 0A generator at {path}")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def percentile(values: np.ndarray, quantile: float) -> float:
    return float(np.percentile(values, quantile)) if values.size else 0.0


def sha256_bytes(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def validate_source_contract(
    metadata: dict[str, Any],
    rain_manifest: dict[str, Any],
    expected_generation_id: str | None = None,
    expected_source_filename: str | None = None,
) -> None:
    generation_id = metadata.get("generation_id")
    source_filename = (metadata.get("source") or {}).get("filename")
    if not isinstance(generation_id, str) or not generation_id:
        raise SystemExit("normalized metadata must contain generation_id")
    if expected_generation_id is not None and generation_id != expected_generation_id:
        raise SystemExit(
            f"expected generation mismatch: expected {expected_generation_id}, got {generation_id}"
        )
    if expected_source_filename is not None and source_filename != expected_source_filename:
        raise SystemExit(
            f"expected source mismatch: expected {expected_source_filename}, got {source_filename}"
        )
    if rain_manifest.get("source_generation_id") != generation_id:
        raise SystemExit("Phase 0A tiled-rain manifest does not match normalized generation")
    if rain_manifest.get("lod_level") != LOD_LEVEL:
        raise SystemExit("Phase 0A tiled-rain manifest is not an L13 asset")
    if rain_manifest.get("tile_size") != RAIN_TILE_SIZE:
        raise SystemExit("Phase 0A tiled-rain tile size is not 128")
    if rain_manifest.get("grid_size") != GRID_SIZE:
        raise SystemExit("Phase 0A tiled-rain grid size is not L13")
    if rain_manifest.get("frame_count") != metadata["time"]["count"]:
        raise SystemExit("Phase 0A tiled-rain frame count does not match normalized metadata")
    if rain_manifest.get("timestamps") != metadata["time"]["timestamps"]:
        raise SystemExit("Phase 0A tiled-rain timestamps do not match normalized metadata")


def load_source_frames(
    metadata_path: Path,
    metadata: dict[str, Any],
) -> list[np.ndarray]:
    grid = metadata["spatial_grid"]
    width = int(grid["width"])
    height = int(grid["height"])
    expected_count = width * height
    frames: list[np.ndarray] = []
    for frame_index, asset in enumerate(metadata["rain"]["frame_assets"]):
        path = (metadata_path.parent / asset).resolve()
        values = np.fromfile(path, dtype="<f4")
        if values.size != expected_count:
            raise SystemExit(
                f"source frame {frame_index} has {values.size} values, expected {expected_count}"
            )
        if np.any(~np.isfinite(values)) or np.any(values < 0):
            raise SystemExit(f"source frame {frame_index} contains invalid rain values")
        frames.append(values)
    return frames


def tile_bounds(rain_manifest: dict[str, Any]) -> tuple[int, int, int, int]:
    bounds = rain_manifest["tile_index_bounds"]
    return (
        int(bounds["min_x"]),
        int(bounds["max_x"]),
        int(bounds["min_y"]),
        int(bounds["max_y"]),
    )


def reconstruct_l13_window(
    phase_0a: Any,
    metadata: dict[str, Any],
    source_frames: list[np.ndarray],
    rain_manifest: dict[str, Any],
) -> tuple[list[np.ndarray], int, int]:
    """Reconstruct one common global L13 window using the exact Phase 0A code."""

    min_tile_x, max_tile_x, min_tile_y, max_tile_y = tile_bounds(rain_manifest)
    minimum_x = min_tile_x * RAIN_TILE_SIZE
    minimum_y = min_tile_y * RAIN_TILE_SIZE
    maximum_x = (max_tile_x + 1) * RAIN_TILE_SIZE - 1
    maximum_y = (max_tile_y + 1) * RAIN_TILE_SIZE - 1

    # The Phase 0A tile envelope is the core field.  Add only the deterministic
    # matcher stencil/bound so edge nodes can be rejected from real NoData
    # rather than being silently clipped by a second field definition.
    halo = MAX_COMPONENT_DISPLACEMENT + MOTION_FOOTPRINT_RADIUS
    minimum_x = max(0, minimum_x - halo)
    minimum_y = max(0, minimum_y - halo)
    maximum_x = min(GRID_SIZE - 1, maximum_x + halo)
    maximum_y = min(GRID_SIZE - 1, maximum_y + halo)
    x_values = np.arange(minimum_x, maximum_x + 1, dtype=np.float64)
    y_values = np.arange(minimum_y, maximum_y + 1, dtype=np.float64)
    sample_x, sample_y = np.meshgrid(x_values / GRID_SIZE, y_values / GRID_SIZE)
    grid = metadata["spatial_grid"]

    reconstructed: list[np.ndarray] = []
    for source in source_frames:
        values = phase_0a.reconstruct_frame(
            source,
            int(grid["width"]),
            int(grid["height"]),
            float(grid["longitude_start"]),
            float(grid["longitude_spacing"]),
            float(grid["latitude_start"]),
            float(grid["latitude_spacing"]),
            sample_x.reshape(-1),
            sample_y.reshape(-1),
        ).reshape(sample_y.shape)
        reconstructed.append(values.astype(np.float32, copy=False))
    return reconstructed, minimum_x, minimum_y


def log_signal(frame: np.ndarray) -> np.ndarray:
    result = np.full(frame.shape, np.nan, dtype=np.float32)
    valid = np.isfinite(frame)
    result[valid] = np.log1p(frame[valid]).astype(np.float32, copy=False)
    return result


def bounded_displacements(step: int) -> list[tuple[int, int]]:
    values = list(range(-MAX_COMPONENT_DISPLACEMENT, MAX_COMPONENT_DISPLACEMENT + 1, step))
    return [(dx, dy) for dy in values for dx in values]


def clamp01(value: float) -> float:
    return max(0.0, min(1.0, float(value)))


def score_samples(
    source_log: np.ndarray,
    target_log: np.ndarray,
    xs: np.ndarray,
    ys: np.ndarray,
    dx: int,
    dy: int,
    min_informative: int,
) -> dict[str, float] | None:
    """Score one integer hypothesis using valid, rain-informative overlap."""

    target_x = xs + dx
    target_y = ys + dy
    inside = (
        (target_x >= 0)
        & (target_x < target_log.shape[1])
        & (target_y >= 0)
        & (target_y < target_log.shape[0])
        & (xs >= 0)
        & (xs < source_log.shape[1])
        & (ys >= 0)
        & (ys < source_log.shape[0])
    )
    if not np.any(inside):
        return None
    source_values = source_log[ys[inside], xs[inside]].astype(np.float64, copy=False)
    target_values = target_log[target_y[inside], target_x[inside]].astype(np.float64, copy=False)
    valid = np.isfinite(source_values) & np.isfinite(target_values)
    if not np.any(valid):
        return None
    source_values = source_values[valid]
    target_values = target_values[valid]
    informative = np.maximum(source_values, target_values) >= math.log1p(MATCH_RAIN_THRESHOLD_MMH)
    informative_count = int(np.count_nonzero(informative))
    if informative_count < min_informative:
        return None
    source_informative = source_values[informative]
    target_informative = target_values[informative]
    error = float(np.mean(np.abs(source_informative - target_informative)))
    signal_sum = float(np.sum(np.maximum(source_informative, target_informative)))
    return {
        "error": error,
        "valid_count": float(source_values.size),
        "informative_count": float(informative_count),
        "signal_sum": signal_sum,
    }


def local_motion_relevance(
    source_log: np.ndarray,
    target_log: np.ndarray,
    xs: np.ndarray,
    ys: np.ndarray,
) -> dict[str, Any]:
    """Classify local rain evidence independently of estimator acceptance."""

    source_inside = (
        (xs >= 0)
        & (xs < source_log.shape[1])
        & (ys >= 0)
        & (ys < source_log.shape[0])
    )
    target_inside = (
        (xs >= 0)
        & (xs < target_log.shape[1])
        & (ys >= 0)
        & (ys < target_log.shape[0])
    )
    source_values = np.full(xs.shape, np.nan, dtype=np.float32)
    target_values = np.full(xs.shape, np.nan, dtype=np.float32)
    source_values[source_inside] = source_log[ys[source_inside], xs[source_inside]]
    target_values[target_inside] = target_log[ys[target_inside], xs[target_inside]]
    source_valid = np.isfinite(source_values)
    target_valid = np.isfinite(target_values)
    threshold = math.log1p(MATCH_RAIN_THRESHOLD_MMH)
    meaningful = (source_valid & (source_values >= threshold)) | (
        target_valid & (target_values >= threshold)
    )
    valid = source_valid | target_valid
    signal_values = np.maximum(
        np.where(source_valid, source_values, 0.0),
        np.where(target_valid, target_values, 0.0),
    )
    informative_count = int(np.count_nonzero(meaningful))
    signal_sum = float(np.sum(signal_values[meaningful])) if informative_count else 0.0
    valid_count = int(np.count_nonzero(valid))
    relevant = (
        valid_count >= xs.size * 0.25
        and informative_count >= MOTION_RELEVANCE_MIN_INFORMATIVE_SAMPLES
        and signal_sum >= MOTION_RELEVANCE_MIN_SIGNAL_LOG_SUM
    )
    return {
        "relevant": relevant,
        "valid_count": valid_count,
        "informative_count": informative_count,
        "signal_sum": signal_sum,
    }


def choose_hypothesis(
    hypotheses: Iterable[tuple[int, int]],
    source_log: np.ndarray,
    target_log: np.ndarray,
    xs: np.ndarray,
    ys: np.ndarray,
    min_informative: int,
) -> dict[str, Any]:
    scored: list[tuple[float, int, int, dict[str, float]]] = []
    for dx, dy in hypotheses:
        score = score_samples(source_log, target_log, xs, ys, dx, dy, min_informative)
        if score is not None:
            scored.append((score["error"], dy, dx, score))
    if not scored:
        return {"state": "rejected", "reason": "insufficient-overlap"}
    scored.sort(key=lambda item: (item[0], item[1], item[2]))
    best_error, best_dy, best_dx, best = scored[0]
    zero = next((item[3] for item in scored if item[1] == 0 and item[2] == 0), None)
    if zero is None:
        # Refinement searches are intentionally narrow, but the zero-motion
        # hypothesis is always evaluated as the rejection/confidence baseline.
        zero = score_samples(
            source_log, target_log, xs, ys, 0, 0, min_informative=1
        )
    competitor = next(
        (item for item in scored if item[1] != best_dy or item[2] != best_dx),
        None,
    )
    zero_error = float(zero["error"]) if zero is not None else float("nan")
    improvement = (
        (zero_error - best_error) / max(zero_error, 1e-6)
        if math.isfinite(zero_error)
        else 0.0
    )
    ambiguity_margin = (
        (float(competitor[0]) - best_error) / max(float(competitor[0]), 1e-6)
        if competitor is not None
        else 0.0
    )
    zero_selected = best_dx == 0 and best_dy == 0
    zero_fit_quality = math.exp(-best_error / 0.15) if zero_selected else 0.0
    evidence_quality = max(improvement, zero_fit_quality)
    confidence = clamp01(
        math.sqrt(
            clamp01(best["valid_count"] / max(1.0, xs.size))
            * clamp01(best["informative_count"] / max(1.0, xs.size * 0.20))
            * clamp01(best["signal_sum"] / 24.0)
            * clamp01(evidence_quality / 0.50)
            * clamp01(ambiguity_margin / 0.25)
        )
    )
    accepted = (
        best["informative_count"] >= min_informative
        and best["valid_count"] >= xs.size * 0.25
        and best["signal_sum"] >= MIN_SIGNAL_LOG_SUM
        and (improvement >= MIN_IMPROVEMENT or (zero_selected and best_error <= 0.03))
        and ambiguity_margin >= MIN_AMBIGUITY_MARGIN
    )
    return {
        "state": "accepted" if accepted else "rejected",
        "reason": "accepted" if accepted else "weak-evidence",
        "dx": best_dx,
        "dy": best_dy,
        "confidence": confidence,
        "error": best_error,
        "valid_count": int(best["valid_count"]),
        "informative_count": int(best["informative_count"]),
        "signal_sum": best["signal_sum"],
        "improvement": clamp01(improvement),
        "zero_fit_quality": zero_fit_quality,
        "ambiguity_margin": clamp01(ambiguity_margin),
    }


def region_coordinates(
    region_x: int,
    region_y: int,
    minimum_x: int,
    minimum_y: int,
    width: int,
    height: int,
    stride: int,
) -> tuple[np.ndarray, np.ndarray]:
    global_x0 = region_x * MOTION_REGION_SIZE
    global_y0 = region_y * MOTION_REGION_SIZE
    global_x1 = global_x0 + MOTION_REGION_SIZE - 1
    global_y1 = global_y0 + MOTION_REGION_SIZE - 1
    local_x0 = max(0, global_x0 - minimum_x)
    local_y0 = max(0, global_y0 - minimum_y)
    local_x1 = min(width - 1, global_x1 - minimum_x)
    local_y1 = min(height - 1, global_y1 - minimum_y)
    if local_x0 > local_x1 or local_y0 > local_y1:
        return np.empty(0, dtype=np.int64), np.empty(0, dtype=np.int64)
    x_values = np.arange(local_x0, local_x1 + 1, stride, dtype=np.int64)
    y_values = np.arange(local_y0, local_y1 + 1, stride, dtype=np.int64)
    if x_values[-1] != local_x1:
        x_values = np.append(x_values, local_x1)
    if y_values[-1] != local_y1:
        y_values = np.append(y_values, local_y1)
    return np.meshgrid(x_values, y_values)


def validation_metrics(
    source_log: np.ndarray,
    target_log: np.ndarray,
    minimum_x: int,
    minimum_y: int,
    node_x_values: np.ndarray,
    node_y_values: np.ndarray,
    field: np.ndarray,
    include_mask: np.ndarray | None = None,
) -> dict[str, float | int]:
    """Measure selected-field alignment on the same, non-weaker node footprint."""

    zero_errors: list[float] = []
    selected_errors: list[float] = []
    improved_count = 0
    for row, global_y in enumerate(node_y_values):
        for column, global_x in enumerate(node_x_values):
            if include_mask is not None and not include_mask[row, column]:
                continue
            dx, dy, confidence = field[row, column]
            if confidence <= 0.0:
                continue
            local_x = int(global_x - minimum_x)
            local_y = int(global_y - minimum_y)
            y0 = local_y - MOTION_FOOTPRINT_RADIUS
            y1 = local_y + MOTION_FOOTPRINT_RADIUS
            x0 = local_x - MOTION_FOOTPRINT_RADIUS
            x1 = local_x + MOTION_FOOTPRINT_RADIUS
            xs, ys = np.meshgrid(
                np.arange(x0, x1 + 1, dtype=np.int64),
                np.arange(y0, y1 + 1, dtype=np.int64),
            )
            zero = score_samples(source_log, target_log, xs, ys, 0, 0, 1)
            selected = score_samples(
                source_log,
                target_log,
                xs,
                ys,
                int(round(float(dx))),
                int(round(float(dy))),
                1,
            )
            if zero is None or selected is None:
                continue
            zero_error = float(zero["error"])
            selected_error = float(selected["error"])
            zero_errors.append(zero_error)
            selected_errors.append(selected_error)
            if selected_error < zero_error:
                improved_count += 1
    evaluated_count = len(selected_errors)
    return {
        "evaluated_count": evaluated_count,
        "zero_motion_mae": float(np.mean(zero_errors)) if zero_errors else 0.0,
        "selected_motion_mae": float(np.mean(selected_errors)) if selected_errors else 0.0,
        "improved_over_zero_count": improved_count,
        "improved_over_zero_percentage": 100.0 * improved_count / max(1, evaluated_count),
    }


def estimate_interval(
    frame_a: np.ndarray,
    frame_b: np.ndarray,
    minimum_x: int,
    minimum_y: int,
    node_x_values: np.ndarray,
    node_y_values: np.ndarray,
) -> tuple[np.ndarray, dict[str, Any]]:
    """Estimate one A -> B field and deterministic quality diagnostics."""

    estimator_start = time.perf_counter()
    source_log = log_signal(frame_a)
    target_log = log_signal(frame_b)
    height, width = source_log.shape

    region_x_values = range(
        math.floor(minimum_x / MOTION_REGION_SIZE),
        math.floor((minimum_x + width - 1) / MOTION_REGION_SIZE) + 1,
    )
    region_y_values = range(
        math.floor(minimum_y / MOTION_REGION_SIZE),
        math.floor((minimum_y + height - 1) / MOTION_REGION_SIZE) + 1,
    )
    regional: dict[tuple[int, int], dict[str, Any]] = {}
    regional_fallback_count = 0
    for region_y in region_y_values:
        for region_x in region_x_values:
            xs, ys = region_coordinates(
                region_x,
                region_y,
                minimum_x,
                minimum_y,
                width,
                height,
                REGIONAL_SAMPLE_STRIDE,
            )
            if xs.size == 0:
                continue
            regional_coarse = choose_hypothesis(
                bounded_displacements(COARSE_DISPLACEMENT_STEP),
                source_log,
                target_log,
                xs,
                ys,
                MIN_REGIONAL_INFORMATIVE,
            )
            if (
                "dx" not in regional_coarse
                or regional_coarse.get("informative_count", 0) < MIN_REGIONAL_INFORMATIVE
                or regional_coarse.get("signal_sum", 0.0) < MIN_SIGNAL_LOG_SUM
                or regional_coarse.get("valid_count", 0) < xs.size * 0.25
            ):
                regional[(region_x, region_y)] = regional_coarse
                continue
            coarse_dx = int(regional_coarse["dx"])
            coarse_dy = int(regional_coarse["dy"])
            refine = [
                (dx, dy)
                for dy in range(coarse_dy - COARSE_DISPLACEMENT_STEP, coarse_dy + COARSE_DISPLACEMENT_STEP + 1)
                for dx in range(coarse_dx - COARSE_DISPLACEMENT_STEP, coarse_dx + COARSE_DISPLACEMENT_STEP + 1)
                if abs(dx) <= MAX_COMPONENT_DISPLACEMENT and abs(dy) <= MAX_COMPONENT_DISPLACEMENT
            ]
            regional_refined = choose_hypothesis(
                refine,
                source_log,
                target_log,
                xs,
                ys,
                MIN_REGIONAL_INFORMATIVE,
            )
            regional[(region_x, region_y)] = regional_refined

    field = np.zeros((node_y_values.size, node_x_values.size, 3), dtype="<f4")
    local_accepted = 0
    rejected = 0
    accepted_confidences: list[float] = []
    accepted_dx: list[float] = []
    accepted_dy: list[float] = []
    accepted_magnitudes: list[float] = []
    bound_hits = 0
    motion_relevant_node_count = 0
    relevant_local_accepted_count = 0
    relevant_regional_fallback_count = 0
    relevant_rejected_count = 0
    relevant_local_accepted_under_accepted_regional_prior_count = 0
    recovered_weak_regional_proposal_count = 0
    recovered_confidences: list[float] = []
    recovered_dx: list[float] = []
    recovered_dy: list[float] = []
    recovered_magnitudes: list[float] = []
    recovered_bound_hits = 0
    local_accepted_mask = np.zeros(field.shape[:2], dtype=bool)
    for row, global_y in enumerate(node_y_values):
        for column, global_x in enumerate(node_x_values):
            local_x = int(global_x - minimum_x)
            local_y = int(global_y - minimum_y)
            y0 = local_y - MOTION_FOOTPRINT_RADIUS
            y1 = local_y + MOTION_FOOTPRINT_RADIUS
            x0 = local_x - MOTION_FOOTPRINT_RADIUS
            x1 = local_x + MOTION_FOOTPRINT_RADIUS
            xs, ys = np.meshgrid(
                np.arange(x0, x1 + 1, dtype=np.int64),
                np.arange(y0, y1 + 1, dtype=np.int64),
            )
            relevance = local_motion_relevance(source_log, target_log, xs, ys)
            if relevance["relevant"]:
                motion_relevant_node_count += 1
            region_key = (
                math.floor(int(global_x) / MOTION_REGION_SIZE),
                math.floor(int(global_y) / MOTION_REGION_SIZE),
            )
            regional_result = regional.get(region_key, {"state": "rejected"})
            regional_accepted = regional_result.get("state") == "accepted"
            try:
                regional_dx = int(regional_result["dx"])
                regional_dy = int(regional_result["dy"])
                regional_proposal = (
                    math.isfinite(float(regional_dx))
                    and math.isfinite(float(regional_dy))
                    and abs(regional_dx) <= MAX_COMPONENT_DISPLACEMENT
                    and abs(regional_dy) <= MAX_COMPONENT_DISPLACEMENT
                )
            except (KeyError, TypeError, ValueError, OverflowError):
                regional_dx = 0
                regional_dy = 0
                regional_proposal = False
            # A rejected but scored regional match is only a local search
            # proposal.  It cannot populate the field or provide fallback.
            if not regional_accepted and (not regional_proposal or not relevance["relevant"]):
                if relevance["relevant"]:
                    relevant_rejected_count += 1
                rejected += 1
                continue
            local_hypotheses = [
                (dx, dy)
                for dy in range(regional_dy - LOCAL_SEARCH_RADIUS, regional_dy + LOCAL_SEARCH_RADIUS + 1)
                for dx in range(regional_dx - LOCAL_SEARCH_RADIUS, regional_dx + LOCAL_SEARCH_RADIUS + 1)
                if abs(dx) <= MAX_COMPONENT_DISPLACEMENT and abs(dy) <= MAX_COMPONENT_DISPLACEMENT
            ]
            # Zero is evaluated as a baseline for confidence/rejection even
            # when it is outside the small regional-prior correction window;
            # it is not a second wide local search.
            if (0, 0) not in local_hypotheses:
                local_hypotheses.append((0, 0))
            local_result = choose_hypothesis(
                local_hypotheses,
                source_log,
                target_log,
                xs,
                ys,
                MIN_LOCAL_INFORMATIVE,
            )
            local_evidence = score_samples(
                source_log,
                target_log,
                xs,
                ys,
                0,
                0,
                1,
            )
            if local_result.get("state") == "accepted":
                dx = int(local_result["dx"])
                dy = int(local_result["dy"])
                confidence = float(local_result["confidence"])
                local_accepted += 1
                local_accepted_mask[row, column] = True
                if relevance["relevant"]:
                    relevant_local_accepted_count += 1
                    if regional_accepted:
                        relevant_local_accepted_under_accepted_regional_prior_count += 1
                    else:
                        recovered_weak_regional_proposal_count += 1
                        recovered_confidences.append(confidence)
                        recovered_dx.append(float(dx))
                        recovered_dy.append(float(dy))
                        recovered_magnitudes.append(math.hypot(dx, dy))
                        if abs(dx) >= MAX_COMPONENT_DISPLACEMENT or abs(dy) >= MAX_COMPONENT_DISPLACEMENT:
                            recovered_bound_hits += 1
            elif (
                regional_accepted
                and regional_result.get("confidence", 0.0) > 0.0
                and local_result.get("informative_count", 0) < MIN_LOCAL_INFORMATIVE
                and local_evidence is not None
            ):
                dx = regional_dx
                dy = regional_dy
                confidence = float(regional_result["confidence"]) * REGIONAL_FALLBACK_CONFIDENCE_SCALE
                regional_fallback_count += 1
                if relevance["relevant"]:
                    relevant_regional_fallback_count += 1
            else:
                rejected += 1
                if relevance["relevant"]:
                    relevant_rejected_count += 1
                continue
            field[row, column] = (dx, dy, confidence)
            accepted_confidences.append(confidence)
            accepted_dx.append(float(dx))
            accepted_dy.append(float(dy))
            magnitude = math.hypot(dx, dy)
            accepted_magnitudes.append(magnitude)
            if abs(dx) >= MAX_COMPONENT_DISPLACEMENT or abs(dy) >= MAX_COMPONENT_DISPLACEMENT:
                bound_hits += 1

    nonzero = np.asarray(accepted_confidences, dtype=np.float64)
    dx_values = np.asarray(accepted_dx, dtype=np.float64)
    dy_values = np.asarray(accepted_dy, dtype=np.float64)
    magnitude_values = np.asarray(accepted_magnitudes, dtype=np.float64)
    recovered_confidence_values = np.asarray(recovered_confidences, dtype=np.float64)
    recovered_dx_values = np.asarray(recovered_dx, dtype=np.float64)
    recovered_dy_values = np.asarray(recovered_dy, dtype=np.float64)
    recovered_magnitude_values = np.asarray(recovered_magnitudes, dtype=np.float64)

    def distribution(values: np.ndarray, include_tail: bool = False) -> dict[str, float]:
        result = {
            "min": float(np.min(values)) if values.size else 0.0,
            "mean": float(np.mean(values)) if values.size else 0.0,
            "median": percentile(values, 50),
            "max": float(np.max(values)) if values.size else 0.0,
        }
        if include_tail:
            result.update({"p90": percentile(values, 90), "p99": percentile(values, 99)})
        return result

    validation_start = time.perf_counter()
    field_validation = validation_metrics(
        source_log,
        target_log,
        minimum_x,
        minimum_y,
        node_x_values,
        node_y_values,
        field,
    )
    local_validation = validation_metrics(
        source_log,
        target_log,
        minimum_x,
        minimum_y,
        node_x_values,
        node_y_values,
        field,
        local_accepted_mask,
    )
    validation_seconds = time.perf_counter() - validation_start
    diagnostics = {
        "node_count": int(field.shape[0] * field.shape[1]),
        "motion_relevant_node_count": motion_relevant_node_count,
        "local_accepted_count": local_accepted,
        "regional_fallback_count": regional_fallback_count,
        "rejected_zero_confidence_count": rejected,
        "accepted_count": local_accepted + regional_fallback_count,
        "relevant_local_accepted_count": relevant_local_accepted_count,
        "relevant_local_accepted_under_accepted_regional_prior_count": relevant_local_accepted_under_accepted_regional_prior_count,
        "recovered_weak_regional_proposal_count": recovered_weak_regional_proposal_count,
        "relevant_regional_fallback_count": relevant_regional_fallback_count,
        "relevant_rejected_zero_confidence_count": relevant_rejected_count,
        "relevant_accepted_plus_fallback_percentage": 100.0 * (
            relevant_local_accepted_count + relevant_regional_fallback_count
        ) / max(1, motion_relevant_node_count),
        "relevant_rejected_percentage": 100.0 * relevant_rejected_count / max(
            1, motion_relevant_node_count
        ),
        "confidence": {
            "min": float(np.min(nonzero)) if nonzero.size else 0.0,
            "mean": float(np.mean(nonzero)) if nonzero.size else 0.0,
            "median": percentile(nonzero, 50),
            "p90": percentile(nonzero, 90),
            "p99": percentile(nonzero, 99),
            "max": float(np.max(nonzero)) if nonzero.size else 0.0,
        },
        "dx": {
            "min": float(np.min(dx_values)) if dx_values.size else 0.0,
            "mean": float(np.mean(dx_values)) if dx_values.size else 0.0,
            "median": percentile(dx_values, 50),
            "max": float(np.max(dx_values)) if dx_values.size else 0.0,
        },
        "dy": {
            "min": float(np.min(dy_values)) if dy_values.size else 0.0,
            "mean": float(np.mean(dy_values)) if dy_values.size else 0.0,
            "median": percentile(dy_values, 50),
            "max": float(np.max(dy_values)) if dy_values.size else 0.0,
        },
        "magnitude": {
            "min": float(np.min(magnitude_values)) if magnitude_values.size else 0.0,
            "mean": float(np.mean(magnitude_values)) if magnitude_values.size else 0.0,
            "median": percentile(magnitude_values, 50),
            "p90": percentile(magnitude_values, 90),
            "p99": percentile(magnitude_values, 99),
            "max": float(np.max(magnitude_values)) if magnitude_values.size else 0.0,
        },
        "bound_hit_count": bound_hits,
        "recovered_weak_regional_proposal_percentage": 100.0 * recovered_weak_regional_proposal_count / max(1, motion_relevant_node_count),
        "recovered_confidence": distribution(recovered_confidence_values, include_tail=True),
        "recovered_dx": distribution(recovered_dx_values),
        "recovered_dy": distribution(recovered_dy_values),
        "recovered_magnitude": distribution(recovered_magnitude_values, include_tail=True),
        "recovered_bound_hit_count": recovered_bound_hits,
        "validation": field_validation,
        "local_validation": local_validation,
        "_recovered_confidences": recovered_confidences,
        "_recovered_dx": recovered_dx,
        "_recovered_dy": recovered_dy,
        "_recovered_magnitudes": recovered_magnitudes,
        "_estimator_seconds": validation_start - estimator_start,
        "_validation_seconds": validation_seconds,
    }
    return field, diagnostics


def interval_pairs(timestamps: list[str]) -> list[dict[str, Any]]:
    return [
        {"index": index, "from": timestamps[index], "to": timestamps[index + 1]}
        for index in range(len(timestamps) - 1)
    ]


def aggregate_quality(
    interval_diagnostics: list[dict[str, Any]],
    fields: list[np.ndarray],
) -> dict[str, Any]:
    node_count = int(sum(item["node_count"] for item in interval_diagnostics))
    local_accepted = int(sum(item["local_accepted_count"] for item in interval_diagnostics))
    regional_fallback = int(sum(item["regional_fallback_count"] for item in interval_diagnostics))
    rejected = int(sum(item["rejected_zero_confidence_count"] for item in interval_diagnostics))
    motion_relevant = int(sum(item["motion_relevant_node_count"] for item in interval_diagnostics))
    relevant_local_accepted = int(
        sum(item["relevant_local_accepted_count"] for item in interval_diagnostics)
    )
    relevant_local_accepted_under_accepted_regional_prior = int(
        sum(
            item["relevant_local_accepted_under_accepted_regional_prior_count"]
            for item in interval_diagnostics
        )
    )
    recovered_weak_regional_proposal = int(
        sum(item["recovered_weak_regional_proposal_count"] for item in interval_diagnostics)
    )
    relevant_regional_fallback = int(
        sum(item["relevant_regional_fallback_count"] for item in interval_diagnostics)
    )
    relevant_rejected = int(
        sum(item["relevant_rejected_zero_confidence_count"] for item in interval_diagnostics)
    )
    accepted_values = np.concatenate(
        [field[field[:, :, 2] > 0.0] for field in fields]
    ) if fields else np.empty((0, 3), dtype=np.float64)
    confidences = accepted_values[:, 2].astype(np.float64, copy=False)
    dx_values = accepted_values[:, 0].astype(np.float64, copy=False)
    dy_values = accepted_values[:, 1].astype(np.float64, copy=False)
    magnitudes = np.hypot(dx_values, dy_values)
    recovered_confidences = np.asarray(
        [value for item in interval_diagnostics for value in item["_recovered_confidences"]],
        dtype=np.float64,
    )
    recovered_dx = np.asarray(
        [value for item in interval_diagnostics for value in item["_recovered_dx"]],
        dtype=np.float64,
    )
    recovered_dy = np.asarray(
        [value for item in interval_diagnostics for value in item["_recovered_dy"]],
        dtype=np.float64,
    )
    recovered_magnitudes = np.asarray(
        [value for item in interval_diagnostics for value in item["_recovered_magnitudes"]],
        dtype=np.float64,
    )

    def distribution(values: np.ndarray, include_tail: bool = False) -> dict[str, float]:
        result = {
            "min": float(np.min(values)) if values.size else 0.0,
            "mean": float(np.mean(values)) if values.size else 0.0,
            "median": percentile(values, 50),
            "max": float(np.max(values)) if values.size else 0.0,
        }
        if include_tail:
            result.update({"p90": percentile(values, 90), "p99": percentile(values, 99)})
        return result

    def aggregate_validation(key: str) -> dict[str, float | int]:
        evaluated = int(sum(int(item[key]["evaluated_count"]) for item in interval_diagnostics))
        zero_mae = sum(
            float(item[key]["zero_motion_mae"]) * int(item[key]["evaluated_count"])
            for item in interval_diagnostics
        )
        selected_mae = sum(
            float(item[key]["selected_motion_mae"]) * int(item[key]["evaluated_count"])
            for item in interval_diagnostics
        )
        improved = int(
            sum(int(item[key]["improved_over_zero_count"]) for item in interval_diagnostics)
        )
        return {
            "evaluated_count": evaluated,
            "zero_motion_mae": zero_mae / max(1, evaluated),
            "selected_motion_mae": selected_mae / max(1, evaluated),
            "improved_over_zero_count": improved,
            "improved_over_zero_percentage": 100.0 * improved / max(1, evaluated),
        }

    return {
        "evaluated_node_intervals": node_count,
        "local_accepted_count": local_accepted,
        "regional_fallback_count": regional_fallback,
        "rejected_zero_confidence_count": rejected,
        "class_percentages": {
            "local_accepted": 100.0 * local_accepted / max(1, node_count),
            "regional_fallback": 100.0 * regional_fallback / max(1, node_count),
            "rejected_zero_confidence": 100.0 * rejected / max(1, node_count),
        },
        "motion_relevant_node_count": motion_relevant,
        "relevant_local_accepted_count": relevant_local_accepted,
        "relevant_local_accepted_under_accepted_regional_prior_count": relevant_local_accepted_under_accepted_regional_prior,
        "recovered_weak_regional_proposal_count": recovered_weak_regional_proposal,
        "relevant_regional_fallback_count": relevant_regional_fallback,
        "relevant_rejected_zero_confidence_count": relevant_rejected,
        "relevant_accepted_plus_fallback_percentage": 100.0 * (
            relevant_local_accepted + relevant_regional_fallback
        ) / max(1, motion_relevant),
        "relevant_rejected_percentage": 100.0 * relevant_rejected / max(1, motion_relevant),
        "recovered_weak_regional_proposal_percentage": 100.0 * recovered_weak_regional_proposal / max(1, motion_relevant),
        "recovered_confidence": distribution(recovered_confidences, include_tail=True),
        "recovered_dx": distribution(recovered_dx),
        "recovered_dy": distribution(recovered_dy),
        "recovered_magnitude": distribution(recovered_magnitudes, include_tail=True),
        "recovered_bound_hit_count": int(sum(item["recovered_bound_hit_count"] for item in interval_diagnostics)),
        "validation": aggregate_validation("validation"),
        "local_validation": aggregate_validation("local_validation"),
        "nonzero_confidence_count": int(confidences.size),
        "confidence": distribution(confidences, include_tail=True),
        "dx": distribution(dx_values),
        "dy": distribution(dy_values),
        "displacement_magnitude": distribution(magnitudes, include_tail=True),
        "maximum_accepted_component_displacement": float(np.max(np.abs(accepted_values[:, :2]))) if accepted_values.size else 0.0,
        "maximum_accepted_magnitude": float(np.max(magnitudes)) if magnitudes.size else 0.0,
        "bound_hit_count": int(sum(item["bound_hit_count"] for item in interval_diagnostics)),
        "bound_hit_percentage_of_accepted": 100.0 * sum(item["bound_hit_count"] for item in interval_diagnostics) / max(1, accepted_values.shape[0]),
    }


def build_asset_payloads(
    fields: list[np.ndarray],
    rain_manifest: dict[str, Any],
    output: Path,
) -> tuple[list[dict[str, Any]], int, int]:
    min_tile_x, max_tile_x, min_tile_y, max_tile_y = tile_bounds(rain_manifest)
    tile_root = output / "tiles" / f"L{LOD_LEVEL}"
    tile_root.mkdir(parents=True, exist_ok=True)
    descriptors: list[dict[str, Any]] = []
    raw_total = 0
    gzip_total = 0
    node_min_x = min_tile_x * RAIN_TILE_SIZE
    node_min_y = min_tile_y * RAIN_TILE_SIZE
    for tile_y in range(min_tile_y, max_tile_y + 1):
        for tile_x in range(min_tile_x, max_tile_x + 1):
            first_x = (tile_x * RAIN_TILE_SIZE - node_min_x) // MOTION_NODE_SPACING
            first_y = (tile_y * RAIN_TILE_SIZE - node_min_y) // MOTION_NODE_SPACING
            last_x = first_x + RAIN_TILE_SIZE // MOTION_NODE_SPACING
            last_y = first_y + RAIN_TILE_SIZE // MOTION_NODE_SPACING
            tile_fields = [
                field[first_y:last_y + 1, first_x:last_x + 1, :]
                for field in fields
            ]
            payload = np.stack(tile_fields, axis=0).astype("<f4", copy=False).tobytes(order="C")
            tile_directory = tile_root / str(tile_x) / str(tile_y)
            tile_directory.mkdir(parents=True, exist_ok=True)
            asset_path = tile_directory / "motion.f32"
            asset_path.write_bytes(payload)
            gzip_path = Path(f"{asset_path}.gz")
            gzip_path.write_bytes(gzip.compress(payload, compresslevel=9, mtime=0))
            relative_asset = str(asset_path.relative_to(output)).replace("\\", "/")
            descriptors.append(
                {
                    "x": tile_x,
                    "y": tile_y,
                    "node_x_start": first_x,
                    "node_y_start": first_y,
                    "node_width": last_x - first_x + 1,
                    "node_height": last_y - first_y + 1,
                    "asset": relative_asset,
                    "gzip_asset": f"{relative_asset}.gz",
                    "byte_length": len(payload),
                    "gzip_byte_length": gzip_path.stat().st_size,
                    "layout": "interval-major; node row-major y then x; interleaved Float32 dx,dy,confidence",
                }
            )
            raw_total += len(payload)
            gzip_total += gzip_path.stat().st_size
    return descriptors, raw_total, gzip_total


def main() -> None:
    args = parse_arguments()
    total_start = time.perf_counter()
    metadata_path = args.source_metadata.resolve()
    source_manifest_path = args.source_manifest.resolve()
    output = args.output.resolve()
    metadata = json.loads(metadata_path.read_text(encoding="utf-8"))
    rain_manifest = json.loads(source_manifest_path.read_text(encoding="utf-8"))
    validate_source_contract(
        metadata,
        rain_manifest,
        args.expected_generation_id,
        args.expected_source_filename,
    )
    source_manifest_sha256 = sha256_bytes(source_manifest_path)
    source_frames = load_source_frames(metadata_path, metadata)
    phase_0a = load_phase_0a_reconstructor()

    preparation_start = time.perf_counter()
    rain_frames, minimum_x, minimum_y = reconstruct_l13_window(
        phase_0a, metadata, source_frames, rain_manifest
    )
    preparation_seconds = time.perf_counter() - preparation_start
    min_tile_x, max_tile_x, min_tile_y, max_tile_y = tile_bounds(rain_manifest)
    node_x_values = np.arange(
        min_tile_x * RAIN_TILE_SIZE,
        (max_tile_x + 1) * RAIN_TILE_SIZE + 1,
        MOTION_NODE_SPACING,
        dtype=np.int64,
    )
    node_y_values = np.arange(
        min_tile_y * RAIN_TILE_SIZE,
        (max_tile_y + 1) * RAIN_TILE_SIZE + 1,
        MOTION_NODE_SPACING,
        dtype=np.int64,
    )
    # The core node extent is aligned to the same global integer coordinates as
    # Phase 0A.  The reconstruction window's extra halo is never an asset node.
    if node_x_values[-1] > minimum_x + rain_frames[0].shape[1] - 1 or node_y_values[-1] > minimum_y + rain_frames[0].shape[0] - 1:
        raise SystemExit("motion grid extends beyond the reconstructed L13 working window")

    interval_fields: list[np.ndarray] = []
    interval_diagnostics: list[dict[str, Any]] = []
    interval_seconds: list[float] = []
    estimator_interval_seconds: list[float] = []
    validation_interval_seconds: list[float] = []
    for interval in range(len(rain_frames) - 1):
        interval_start = time.perf_counter()
        field, diagnostics = estimate_interval(
            rain_frames[interval],
            rain_frames[interval + 1],
            minimum_x,
            minimum_y,
            node_x_values,
            node_y_values,
        )
        interval_seconds.append(time.perf_counter() - interval_start)
        estimator_interval_seconds.append(float(diagnostics["_estimator_seconds"]))
        validation_interval_seconds.append(float(diagnostics["_validation_seconds"]))
        diagnostics = {
            "index": interval,
            "from": metadata["time"]["timestamps"][interval],
            "to": metadata["time"]["timestamps"][interval + 1],
            **diagnostics,
        }
        interval_fields.append(field)
        interval_diagnostics.append(diagnostics)
        public_diagnostics = {
            key: value for key, value in diagnostics.items() if not key.startswith("_")
        }
        print(json.dumps({"interval": interval, **public_diagnostics}, separators=(",", ":")), flush=True)
    estimation_seconds = sum(estimator_interval_seconds)
    validation_seconds = sum(validation_interval_seconds)

    if output.exists() and not output.is_dir():
        raise SystemExit(f"output path is not a directory: {output}")
    output.mkdir(parents=True, exist_ok=True)
    packaging_start = time.perf_counter()
    assets, raw_total, gzip_total = build_asset_payloads(
        interval_fields, rain_manifest, output
    )
    quality_aggregate = aggregate_quality(interval_diagnostics, interval_fields)
    packaging_seconds = time.perf_counter() - packaging_start
    manifest = {
        "schema": SCHEMA,
        "version": VERSION,
        "source_generation_id": metadata["generation_id"],
        "source_tiled_rain_manifest": "../../tiled-rain/current/manifest.json",
        "source_tiled_rain_manifest_sha256": source_manifest_sha256,
        "source_rain_field": {
            "lod_level": LOD_LEVEL,
            "sample_coordinates": "x=i/2^13; y=j/2^13; global integer identity",
            "reconstruction": "Phase 0A generate-tiled-rain.py reconstruct_frame, Float32 physical mm/h before UInt16 transport quantization",
            "physical_units": "mm/h",
            "nodata": "NaN; valid dry remains 0.0",
        },
        "motion_grid": {
            "lod_level": LOD_LEVEL,
            "node_spacing_l13_samples": MOTION_NODE_SPACING,
            "anchor": "global L13 integer coordinate 0; independent of crop, tile, or viewport",
            "node_x_start": int(node_x_values[0]),
            "node_y_start": int(node_y_values[0]),
            "node_width": int(node_x_values.size),
            "node_height": int(node_y_values.size),
            "node_coordinates": "x=node_x_start + column*64; y=node_y_start + row*64",
        },
        "rain_tile_size": RAIN_TILE_SIZE,
        "displacement": {
            "units": "L13 samples per complete source interval",
            "sign": "+dx east / increasing global L13 x; +dy south / increasing global L13 y in Mercator raster coordinates",
            "maximum_absolute_component": MAX_COMPONENT_DISPLACEMENT,
        },
        "encoding": {
            "dtype": "Float32",
            "byte_order": "little-endian",
            "component_layout": "interleaved dx,dy,confidence per node",
            "confidence_range": [0.0, 1.0],
            "zero_confidence": "dx=0, dy=0, confidence=0 for NoData, dry/unsupported, weak, or ambiguous nodes",
        },
        "interval_count": len(interval_fields),
        "intervals": interval_pairs(metadata["time"]["timestamps"]),
        "estimator": {
            "provenance": "radar-derived",
            "algorithm": "deterministic hierarchical block matcher; globally anchored regional coarse search/refinement provides bounded local proposals, followed by sparse local node refinement",
            "matching_signal": "log1p(rain_mmh); stored physical rain is unchanged",
            "coarse_displacement_step": COARSE_DISPLACEMENT_STEP,
            "regional_size_l13_samples": MOTION_REGION_SIZE,
            "regional_sample_stride": REGIONAL_SAMPLE_STRIDE,
            "local_footprint_radius_l13_samples": MOTION_FOOTPRINT_RADIUS,
            "local_search_radius_l13_samples": LOCAL_SEARCH_RADIUS,
            "match_rain_threshold_mmh": MATCH_RAIN_THRESHOLD_MMH,
            "relevance_diagnostic": {
                "minimum_informative_samples": MOTION_RELEVANCE_MIN_INFORMATIVE_SAMPLES,
                "minimum_signal_log_sum": MOTION_RELEVANCE_MIN_SIGNAL_LOG_SUM,
                "valid_coverage_fraction": 0.25,
                "definition": "local node footprint has enough valid meaningful rain in frame A or B; independent of estimator acceptance",
            },
            "minimum_informative_samples": {
                "regional": MIN_REGIONAL_INFORMATIVE,
                "local": MIN_LOCAL_INFORMATIVE,
            },
            "minimum_signal_log_sum": MIN_SIGNAL_LOG_SUM,
            "minimum_improvement_over_zero": MIN_IMPROVEMENT,
            "minimum_ambiguity_margin": MIN_AMBIGUITY_MARGIN,
            "regional_fallback_confidence_scale": REGIONAL_FALLBACK_CONFIDENCE_SCALE,
            "metric": "mean absolute difference over valid overlapping informative samples; deterministic row-major candidate order with lexicographic tie-break",
            "fallback": "corresponding strong regional vector at half regional confidence only when local informative evidence is insufficient",
            "rejected_regional_proposal": "a finite scored regional candidate may seed local refinement only for a motion-relevant node; local acceptance is required and regional fallback is forbidden",
            "validation": "same 33x33 local footprint as matching; log-space MAE for each nonzero field vector and accepted local vector versus zero motion",
        },
        "quality_diagnostics": {
            "unique_global_motion_nodes": int(node_x_values.size * node_y_values.size),
            "aggregate": quality_aggregate,
            "intervals": [
                {
                    key: value for key, value in diagnostics.items() if not key.startswith("_")
                }
                for diagnostics in interval_diagnostics
            ],
        },
        "tiles": assets,
        "tile_count": len(assets),
        "payload_totals": {"raw_f32_bytes": raw_total, "gzip_bytes": gzip_total},
    }
    manifest_bytes = (json.dumps(manifest, indent=2) + "\n").encode("utf-8")
    (output / "manifest.json").write_bytes(manifest_bytes)
    (output / "diagnostics.json").write_text(
        json.dumps(manifest["quality_diagnostics"], indent=2) + "\n", encoding="utf-8"
    )

    benchmark = {
        "source_generation_id": metadata["generation_id"],
        "source_filename": metadata["source"]["filename"],
        "preparation_seconds": preparation_seconds,
        "estimation_seconds": estimation_seconds,
        "packaging_seconds": packaging_seconds,
        "total_seconds": time.perf_counter() - total_start,
        "interval_seconds": interval_seconds,
        "estimator_interval_seconds": estimator_interval_seconds,
        "validation_interval_seconds": validation_interval_seconds,
        "validation_seconds": validation_seconds,
        "interval_count": len(interval_fields),
        "unique_global_motion_nodes": int(node_x_values.size * node_y_values.size),
        "quality_aggregate": quality_aggregate,
        "raw_motion_bytes": raw_total,
        "gzip_motion_bytes": gzip_total,
        "compression_ratio": raw_total / max(1, gzip_total),
    }
    if args.benchmark_report is not None:
        report_path = args.benchmark_report.resolve()
        report_path.parent.mkdir(parents=True, exist_ok=True)
        report_path.write_text(json.dumps(benchmark, indent=2) + "\n", encoding="utf-8")
    print(json.dumps({"manifest": str(output / "manifest.json"), "benchmark": benchmark}, indent=2))


if __name__ == "__main__":
    main()
