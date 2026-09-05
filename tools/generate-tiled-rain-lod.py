#!/usr/bin/env python3
"""Generate the staged offline multi-LOD tiled weather asset set.

This generator consumes only the normalized weather boundary.  L13 and L14
are direct reconstructed physical samples; L11--L12 are recursively centered
aggregates of the unquantized Float32 L13 field.  Payloads are written a
temporal block at a time so the dense L14 level is never materialized for all
frames at once.
"""

from __future__ import annotations

import argparse
import gzip
import importlib.util
import json
import math
import os
import shutil
import sys
from pathlib import Path
from typing import Any

try:
    import numpy as np
except ImportError as error:  # pragma: no cover - depends on the local machine
    raise SystemExit(
        "This tiled-rain LOD generator requires NumPy. Install it outside the "
        "repository and retry."
    ) from error


SCHEMA = "dot-field-tiled-rain-lod-v1"
VERSION = 1
REFERENCE_LEVEL = 13
MIN_LEVEL = 11
MAX_LEVEL = 14
GRID_SIZE = 2**REFERENCE_LEVEL
TILE_SIZE = 128
TEMPORAL_BLOCK_SIZE = 4
UINT16_MAX = 65535
POSITIVE_CODE_MIN = 2
POSITIVE_QUANTIZED_RANGE = UINT16_MAX - 1
HAZARD_QUANTIZED_MAX = 255
THUNDERSTORM_LEVELS = {10: 0.2660123, 11: 0.4818750, 12: 0.6977377}
HAIL_LEVELS = {13: 0.2776807, 14: 0.4897500, 15: 0.7018193}
RAIN_COVERAGE_THRESHOLDS = (0.05, 2.5)
SUMMARY_A_COMPONENTS = (
    "rainWetMeanMmh",
    "rainMaxMmh",
    "rainCoverage",
    "strongCoverage",
)
SUMMARY_B_COMPONENTS = (
    "stormCoverage",
    "stormMaxSeverity",
    "hailCoverage",
    "hailMaxSeverity",
)


def parse_arguments() -> argparse.Namespace:
    repository_root = Path(__file__).resolve().parents[1]
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--source-metadata",
        type=Path,
        default=repository_root / "data" / "generated" / "current" / "metadata.json",
        help="normalized source metadata",
    )
    parser.add_argument(
        "--phase-0a-manifest",
        type=Path,
        default=repository_root / "data" / "generated" / "tiled-rain" / "current" / "manifest.json",
        help="optional legacy Phase 0A manifest used for L13 parity",
    )
    parser.add_argument(
        "--output",
        type=Path,
        default=repository_root / "data" / "generated" / "tiled-rain-lod" / "current",
        help="staged output directory",
    )
    return parser.parse_args()


def load_phase_0a() -> Any:
    """Import the existing numerical helpers without executing its generator."""

    sys.dont_write_bytecode = True
    path = Path(__file__).with_name("generate-tiled-rain.py")
    spec = importlib.util.spec_from_file_location("phase_0a_tiled_rain", path)
    if spec is None or spec.loader is None:
        raise RuntimeError(f"cannot load Phase 0A generator at {path}")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def gzip_payload(path: Path) -> Path:
    gzip_path = Path(f"{path}.gz")
    with path.open("rb") as source, gzip_path.open("wb") as destination:
        with gzip.GzipFile(fileobj=destination, mode="wb", compresslevel=9, mtime=0) as stream:
            shutil.copyfileobj(source, stream, length=1024 * 1024)
    return gzip_path


def relative_asset(path: Path, root: Path) -> str:
    return os.path.relpath(path, root).replace("\\", "/")


def finite(value: Any, name: str) -> float:
    result = float(value)
    if not math.isfinite(result):
        raise SystemExit(f"{name} must be finite")
    return result


def support_sample_bounds(phase: Any, support: dict[str, Any], level: int) -> dict[str, int]:
    """Mirror the browser's expanded L15 support and level selection contract."""

    west_x = (finite(support["west"], "weather_support.west") + 180.0) / 360.0
    east_x = (finite(support["east"], "weather_support.east") + 180.0) / 360.0
    south_y = (1.0 - math.log(math.tan(math.pi / 4 + math.radians(finite(support["south"], "weather_support.south")) / 2)) / math.pi) / 2
    north_y = (1.0 - math.log(math.tan(math.pi / 4 + math.radians(finite(support["north"], "weather_support.north")) / 2)) / math.pi) / 2
    canonical_min_x = math.floor(min(west_x, east_x) * (2**15)) - 1
    canonical_max_x = math.ceil(max(west_x, east_x) * (2**15)) + 1
    canonical_min_y = math.floor(min(north_y, south_y) * (2**15)) - 1
    canonical_max_y = math.ceil(max(north_y, south_y) * (2**15)) + 1
    identity_scale = 2 ** (15 - level)
    minimum_x = math.ceil(canonical_min_x / identity_scale)
    maximum_x = math.floor(canonical_max_x / identity_scale)
    minimum_y = math.ceil(canonical_min_y / identity_scale)
    maximum_y = math.floor(canonical_max_y / identity_scale)
    if minimum_x > maximum_x or minimum_y > maximum_y:
        raise SystemExit(f"empty support sample extent at L{level}")
    return {"min_i": minimum_x, "max_i": maximum_x, "min_j": minimum_y, "max_j": maximum_y}


def reference_tile_bounds(phase: Any, support: dict[str, Any]) -> dict[str, int]:
    reference = support_sample_bounds(phase, support, REFERENCE_LEVEL)
    return {
        "min_x": reference["min_i"] // TILE_SIZE,
        "max_x": reference["max_i"] // TILE_SIZE,
        "min_y": reference["min_j"] // TILE_SIZE,
        "max_y": reference["max_j"] // TILE_SIZE,
    }


def generated_bounds(level: int, reference_tiles: dict[str, int]) -> dict[str, int]:
    """Return the complete tile envelope in that level's global sample units."""

    reference_min_x = reference_tiles["min_x"] * TILE_SIZE
    reference_max_x_exclusive = (reference_tiles["max_x"] + 1) * TILE_SIZE
    reference_min_y = reference_tiles["min_y"] * TILE_SIZE
    reference_max_y_exclusive = (reference_tiles["max_y"] + 1) * TILE_SIZE
    factor = 2 ** (REFERENCE_LEVEL - level)
    minimum_x = math.ceil(reference_min_x / factor)
    maximum_x = math.ceil(reference_max_x_exclusive / factor) - 1
    minimum_y = math.ceil(reference_min_y / factor)
    maximum_y = math.ceil(reference_max_y_exclusive / factor) - 1
    return {"min_i": minimum_x, "max_i": maximum_x, "min_j": minimum_y, "max_j": maximum_y}


def tile_bounds_for_sample_extent(extent: dict[str, int]) -> dict[str, int]:
    return {
        "min_x": extent["min_i"] // TILE_SIZE,
        "max_x": extent["max_i"] // TILE_SIZE,
        "min_y": extent["min_j"] // TILE_SIZE,
        "max_y": extent["max_j"] // TILE_SIZE,
    }


def load_json(path: Path) -> dict[str, Any]:
    try:
        value = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as error:
        raise SystemExit(f"unable to read JSON {path}: {error}") from error
    if not isinstance(value, dict):
        raise SystemExit(f"JSON root is not an object: {path}")
    return value


def load_frame(metadata_path: Path, metadata: dict[str, Any], frame_index: int) -> np.ndarray:
    grid = metadata["spatial_grid"]
    count = int(grid["width"]) * int(grid["height"])
    asset = metadata["rain"]["frame_assets"][frame_index]
    path = (metadata_path.parent / asset).resolve()
    values = np.fromfile(path, dtype="<f4")
    if values.size != count:
        raise SystemExit(f"source rain frame {frame_index} has {values.size} values, expected {count}")
    if np.any(~np.isfinite(values)) or np.any(values < 0):
        raise SystemExit(f"source rain frame {frame_index} contains invalid physical values")
    return values


def load_phenomena_frame(metadata_path: Path, metadata: dict[str, Any], frame_index: int) -> np.ndarray | None:
    phenomena = metadata.get("phenomena") or {}
    if not phenomena.get("available"):
        return None
    assets = phenomena.get("frame_assets")
    if not isinstance(assets, list):
        raise SystemExit("available phenomena channel has no frame_assets")
    path = (metadata_path.parent / assets[frame_index]).resolve()
    values = np.fromfile(path, dtype="<u1")
    count = int(metadata["spatial_grid"]["width"]) * int(metadata["spatial_grid"]["height"])
    if values.size != count:
        raise SystemExit(f"source phenomena frame {frame_index} has {values.size} values, expected {count}")
    return values


def reconstruct_tile(
    phase: Any,
    source: np.ndarray,
    metadata: dict[str, Any],
    level: int,
    tile_x: int,
    tile_y: int,
) -> np.ndarray:
    grid = metadata["spatial_grid"]
    indices_x = tile_x * TILE_SIZE + np.arange(TILE_SIZE, dtype=np.float64)
    indices_y = tile_y * TILE_SIZE + np.arange(TILE_SIZE, dtype=np.float64)
    sample_x, sample_y = np.meshgrid(indices_x / (2**level), indices_y / (2**level))
    return phase.reconstruct_frame(
        source,
        int(grid["width"]),
        int(grid["height"]),
        float(grid["longitude_start"]),
        float(grid["longitude_spacing"]),
        float(grid["latitude_start"]),
        float(grid["latitude_spacing"]),
        sample_x.reshape(-1),
        sample_y.reshape(-1),
    ).reshape(TILE_SIZE, TILE_SIZE)


def reconstruct_l13_envelope(
    phase: Any,
    source: np.ndarray,
    metadata: dict[str, Any],
    tile_bounds: dict[str, int],
    hazard_source: np.ndarray | None,
) -> tuple[np.ndarray, np.ndarray | None, np.ndarray | None]:
    width = (tile_bounds["max_x"] - tile_bounds["min_x"] + 1) * TILE_SIZE
    height = (tile_bounds["max_y"] - tile_bounds["min_y"] + 1) * TILE_SIZE
    rain = np.full((height, width), np.nan, dtype=np.float32)
    storm = np.full((height, width), np.nan, dtype=np.float32) if hazard_source is not None else None
    hail = np.full((height, width), np.nan, dtype=np.float32) if hazard_source is not None else None
    storm_source = phase.severity_for_codes(hazard_source, phase.THUNDERSTORM_LEVELS) if hazard_source is not None else None
    hail_source = phase.severity_for_codes(hazard_source, phase.HAIL_LEVELS) if hazard_source is not None else None
    for tile_y in range(tile_bounds["min_y"], tile_bounds["max_y"] + 1):
        for tile_x in range(tile_bounds["min_x"], tile_bounds["max_x"] + 1):
            local_x = (tile_x - tile_bounds["min_x"]) * TILE_SIZE
            local_y = (tile_y - tile_bounds["min_y"]) * TILE_SIZE
            rain[local_y:local_y + TILE_SIZE, local_x:local_x + TILE_SIZE] = reconstruct_tile(
                phase, source, metadata, REFERENCE_LEVEL, tile_x, tile_y
            )
            if hazard_source is not None:
                storm[local_y:local_y + TILE_SIZE, local_x:local_x + TILE_SIZE] = reconstruct_tile(
                    phase, storm_source, metadata, REFERENCE_LEVEL, tile_x, tile_y
                )
                hail[local_y:local_y + TILE_SIZE, local_x:local_x + TILE_SIZE] = reconstruct_tile(
                    phase, hail_source, metadata, REFERENCE_LEVEL, tile_x, tile_y
                )
    return rain, storm, hail


def encode_direct(values: np.ndarray, maximum: float) -> np.ndarray:
    values = np.asarray(values).reshape(-1)
    encoded = np.zeros(values.size, dtype="<u2")
    valid = np.isfinite(values)
    wet = valid & (values > 0)
    encoded[valid & ~wet] = 1
    encoded[wet] = np.rint(1 + values[wet] / maximum * POSITIVE_QUANTIZED_RANGE).astype(np.uint16)
    encoded[wet] = np.clip(encoded[wet], POSITIVE_CODE_MIN, UINT16_MAX)
    return encoded


def encode_hazard(values: np.ndarray) -> np.ndarray:
    values = np.asarray(values).reshape(-1)
    encoded = np.zeros(values.size, dtype=np.uint8)
    valid = np.isfinite(values)
    encoded[valid] = np.rint(np.clip(values[valid], 0, 1) * HAZARD_QUANTIZED_MAX).astype(np.uint8)
    return encoded


def direct_descriptor(path: Path, root: Path, frame_count: int, dtype: str, components: int = 1) -> dict[str, Any]:
    gzip_path = gzip_payload(path)
    return {
        "asset": relative_asset(path, root),
        "gzip_asset": relative_asset(gzip_path, root),
        "dtype": dtype,
        "component_count": components,
        "sample_count": TILE_SIZE * TILE_SIZE,
        "frame_count": frame_count,
        "byte_length": path.stat().st_size,
        "gzip_byte_length": gzip_path.stat().st_size,
        "layout": "frame-major; each frame is row-major y then x; components interleaved within each sample",
    }


class FidelityMetrics:
    def __init__(self, names: tuple[str, ...]):
        self.values = {
            name: {"count": 0, "sum_abs": 0.0, "max_abs": 0.0, "block_p99": []}
            for name in names
        }

    def update(self, name: str, reference: np.ndarray, decoded: np.ndarray, valid: np.ndarray) -> None:
        errors = np.abs(decoded[valid].astype(np.float64) - reference[valid].astype(np.float64))
        if not errors.size:
            return
        item = self.values[name]
        item["count"] += int(errors.size)
        item["sum_abs"] += float(np.sum(errors))
        item["max_abs"] = max(item["max_abs"], float(np.max(errors)))
        item["block_p99"].append(float(np.percentile(errors, 99)))

    def report(self) -> dict[str, Any]:
        result: dict[str, Any] = {}
        for name, item in self.values.items():
            p99_values = item["block_p99"]
            result[name] = {
                "count": item["count"],
                "mean_absolute_error": item["sum_abs"] / item["count"] if item["count"] else 0.0,
                "max_absolute_error": item["max_abs"],
                "p99_absolute_error": float(np.percentile(p99_values, 99)) if p99_values else 0.0,
                "p99_method": "99th percentile of deterministic per-tile/frame samples",
            }
        return result


def candidate_indices(global_index: int, fine_level: int, coarse_level: int, minimum: int, maximum: int) -> list[int]:
    fine_scale = 2 ** (REFERENCE_LEVEL - fine_level)
    coarse_scale = 2 ** (REFERENCE_LEVEL - coarse_level)
    coordinate = global_index * fine_scale
    remainder = coordinate % coarse_scale
    if remainder not in (0, coarse_scale // 2):
        raise SystemExit("fine sample is not an aligned or centered dyadic anchor")
    if remainder == 0:
        raw = [coordinate // coarse_scale]
    else:
        raw = [(coordinate - coarse_scale // 2) // coarse_scale, (coordinate + coarse_scale // 2) // coarse_scale]
    return [value for value in raw if minimum <= value <= maximum]


def aggregate_level(child: dict[str, Any], fine_extent: dict[str, int], coarse_extent: dict[str, int], fine_level: int, coarse_level: int) -> dict[str, Any]:
    fine_height, fine_width = child["rain_sum"].shape
    coarse_width = coarse_extent["max_i"] - coarse_extent["min_i"] + 1
    coarse_height = coarse_extent["max_j"] - coarse_extent["min_j"] + 1
    total = np.zeros((coarse_height, coarse_width), dtype=np.float64)
    valid_weight = np.zeros_like(total)
    rain_sum = np.zeros_like(total)
    rain_max = np.zeros_like(total)
    rain_coverage = np.zeros((2, coarse_height, coarse_width), dtype=np.float64)
    storm_coverage = np.zeros_like(total)
    storm_max = np.zeros_like(total)
    hail_coverage = np.zeros_like(total)
    hail_max = np.zeros_like(total)
    child_additive = np.stack([
        child["total"], child["valid_weight"], child["rain_sum"],
        child["rain_coverage"][0], child["rain_coverage"][1],
        child["storm_coverage"], child["hail_coverage"],
    ], axis=-1)
    child_maxima = np.stack([child["rain_max"], child["storm_max"], child["hail_max"]], axis=-1)
    additive = np.zeros((coarse_height, coarse_width, child_additive.shape[-1]), dtype=np.float64)
    maxima = np.zeros((coarse_height, coarse_width, child_maxima.shape[-1]), dtype=np.float64)
    x_candidates_by_column = [candidate_indices(fine_extent["min_i"] + column, fine_level, coarse_level, coarse_extent["min_i"], coarse_extent["max_i"]) for column in range(fine_width)]
    x_masks = [np.fromiter((len(values) > offset for values in x_candidates_by_column), dtype=bool, count=fine_width) for offset in range(2)]
    x_indices = [np.array([values[offset] for values in x_candidates_by_column if len(values) > offset], dtype=np.int64) - coarse_extent["min_i"] for offset in range(2)]
    x_weights = [1.0 / np.array([len(values) for values in x_candidates_by_column if len(values) > offset], dtype=np.float64) for offset in range(2)]
    for row in range(fine_height):
        global_y = fine_extent["min_j"] + row
        y_candidates = candidate_indices(global_y, fine_level, coarse_level, coarse_extent["min_j"], coarse_extent["max_j"])
        if not y_candidates:
            continue
        for global_parent_y in y_candidates:
            parent_y = global_parent_y - coarse_extent["min_j"]
            y_weight = 1.0 / len(y_candidates)
            for offset in range(2):
                selected = x_indices[offset]
                mask = x_masks[offset]
                if not selected.size:
                    continue
                weights = x_weights[offset] * y_weight
                row_additive = child_additive[row][mask] * weights[:, None]
                row_maxima = np.where(child["valid_weight"][row][mask, None] > 0, child_maxima[row][mask], 0.0)
                np.add.at(additive[parent_y], selected, row_additive)
                np.maximum.at(maxima[parent_y], selected, row_maxima)
    total[:, :] = additive[..., 0]
    valid_weight[:, :] = additive[..., 1]
    rain_sum[:, :] = additive[..., 2]
    rain_coverage[0, :, :] = additive[..., 3]
    rain_coverage[1, :, :] = additive[..., 4]
    storm_coverage[:, :] = additive[..., 5]
    hail_coverage[:, :] = additive[..., 6]
    rain_max[:, :] = maxima[..., 0]
    storm_max[:, :] = maxima[..., 1]
    hail_max[:, :] = maxima[..., 2]
    return {
        "total": total,
        "valid_weight": valid_weight,
        "rain_sum": rain_sum,
        "rain_max": rain_max,
        "rain_coverage": rain_coverage,
        "storm_coverage": storm_coverage,
        "storm_max": storm_max,
        "hail_coverage": hail_coverage,
        "hail_max": hail_max,
    }


def make_direct_summary(rain: np.ndarray, storm: np.ndarray | None, hail: np.ndarray | None) -> dict[str, Any]:
    valid = np.isfinite(rain)
    rain_values = np.where(valid, rain.astype(np.float64), 0.0)
    if storm is None:
        storm_coverage = np.zeros_like(rain_values)
        storm_max = np.zeros_like(rain_values)
    else:
        storm_coverage = np.where(np.isfinite(storm) & (storm > 0), 1.0, 0.0)
        storm_max = np.where(np.isfinite(storm), storm, 0.0)
    if hail is None:
        hail_coverage = np.zeros_like(rain_values)
        hail_max = np.zeros_like(rain_values)
    else:
        hail_coverage = np.where(np.isfinite(hail) & (hail > 0), 1.0, 0.0)
        hail_max = np.where(np.isfinite(hail), hail, 0.0)
    return {
        "total": valid.astype(np.float64),
        "valid_weight": valid.astype(np.float64),
        "rain_sum": rain_values,
        "rain_max": rain_values.copy(),
        "rain_coverage": np.stack([(rain_values >= threshold).astype(np.float64) for threshold in RAIN_COVERAGE_THRESHOLDS]),
        "storm_coverage": storm_coverage,
        "storm_max": storm_max,
        "hail_coverage": hail_coverage,
        "hail_max": hail_max,
    }


def pack_summary_tile(
    summary: dict[str, Any],
    extent: dict[str, int],
    tile_x: int,
    tile_y: int,
    metrics: FidelityMetrics,
) -> tuple[bytes, bytes | None]:
    plane_a = np.zeros((TILE_SIZE, TILE_SIZE, 4), dtype=np.float64)
    plane_a[..., 2] = -1.0
    plane_b = np.zeros((TILE_SIZE, TILE_SIZE, 4), dtype=np.float64)
    global_x = tile_x * TILE_SIZE + np.arange(TILE_SIZE)
    global_y = tile_y * TILE_SIZE + np.arange(TILE_SIZE)
    x0 = max(extent["min_i"], int(global_x[0]))
    x1 = min(extent["max_i"], int(global_x[-1]))
    y0 = max(extent["min_j"], int(global_y[0]))
    y1 = min(extent["max_j"], int(global_y[-1]))
    valid = np.zeros((TILE_SIZE, TILE_SIZE), dtype=bool)
    if x0 <= x1 and y0 <= y1:
        out_x = slice(x0 - int(global_x[0]), x1 - int(global_x[0]) + 1)
        out_y = slice(y0 - int(global_y[0]), y1 - int(global_y[0]) + 1)
        in_x = slice(x0 - extent["min_i"], x1 - extent["min_i"] + 1)
        in_y = slice(y0 - extent["min_j"], y1 - extent["min_j"] + 1)
        rain_coverage_weight = summary["rain_coverage"][0][in_y, in_x]
        plane_a[out_y, out_x, 0] = np.divide(summary["rain_sum"][in_y, in_x], rain_coverage_weight, out=np.zeros_like(rain_coverage_weight), where=rain_coverage_weight > 0)
        plane_a[out_y, out_x, 1] = summary["rain_max"][in_y, in_x]
        plane_a[out_y, out_x, 2] = np.divide(rain_coverage_weight, summary["total"][in_y, in_x], out=np.zeros_like(rain_coverage_weight), where=summary["total"][in_y, in_x] > 0)
        plane_a[out_y, out_x, 3] = np.divide(summary["rain_coverage"][1][in_y, in_x], summary["total"][in_y, in_x], out=np.zeros_like(rain_coverage_weight), where=summary["total"][in_y, in_x] > 0)
        plane_b[out_y, out_x, 0] = np.divide(summary["storm_coverage"][in_y, in_x], summary["total"][in_y, in_x], out=np.zeros_like(rain_coverage_weight), where=summary["total"][in_y, in_x] > 0)
        plane_b[out_y, out_x, 1] = summary["storm_max"][in_y, in_x]
        plane_b[out_y, out_x, 2] = np.divide(summary["hail_coverage"][in_y, in_x], summary["total"][in_y, in_x], out=np.zeros_like(rain_coverage_weight), where=summary["total"][in_y, in_x] > 0)
        plane_b[out_y, out_x, 3] = summary["hail_max"][in_y, in_x]
        valid[out_y, out_x] = summary["valid_weight"][in_y, in_x] > 0
    encoded_a = plane_a.astype("<f2")
    encoded_b = plane_b.astype("<f2")
    if np.any(~np.isfinite(encoded_a)) or np.any(~np.isfinite(encoded_b)):
        raise SystemExit("aggregate summary exceeds Float16 finite range")
    decoded_a = encoded_a.astype(np.float64)
    decoded_b = encoded_b.astype(np.float64)
    metric_valid = valid
    for index, name in enumerate(SUMMARY_A_COMPONENTS):
        metrics.update(name, plane_a[..., index], decoded_a[..., index], metric_valid)
    for index, name in enumerate(SUMMARY_B_COMPONENTS):
        metrics.update(name, plane_b[..., index], decoded_b[..., index], metric_valid)
    # Plane B is omitted only after the complete temporal block is known to be
    # all-zero.  Every frame therefore contributes its fixed-size bytes here;
    # finalization can safely remove the whole block without breaking strides.
    return encoded_a.tobytes(), encoded_b.tobytes()


def payload_descriptor(path: Path, root: Path, frame_count: int, dtype: str, components: int) -> dict[str, Any]:
    return direct_descriptor(path, root, frame_count, dtype, components)


def initialize_level(level: int, support: dict[str, Any], reference_tiles: dict[str, int]) -> dict[str, Any]:
    valid_extent = support_sample_bounds(None, support, level)
    tile_extent = generated_bounds(level, reference_tiles)
    tiles = tile_bounds_for_sample_extent(tile_extent)
    return {
        "level": level,
        "kind": "direct" if level >= REFERENCE_LEVEL else "aggregate-summary",
        "grid": {
            "grid_size": 2**level,
            "sample_coordinates": f"x=i/2^{level}; y=j/2^{level}; globally anchored integer identity",
            "generated_sample_bounds": tile_extent,
            "support_sample_bounds": valid_extent,
            "width": tile_extent["max_i"] - tile_extent["min_i"] + 1,
            "height": tile_extent["max_j"] - tile_extent["min_j"] + 1,
            "count": (tile_extent["max_i"] - tile_extent["min_i"] + 1) * (tile_extent["max_j"] - tile_extent["min_j"] + 1),
        },
        "tile_size": TILE_SIZE,
        "tile_index_bounds": tiles,
        "tiles": [
            {"x": tile_x, "y": tile_y, "blocks": []}
            for tile_y in range(tiles["min_y"], tiles["max_y"] + 1)
            for tile_x in range(tiles["min_x"], tiles["max_x"] + 1)
        ],
        "tile_count": (tiles["max_x"] - tiles["min_x"] + 1) * (tiles["max_y"] - tiles["min_y"] + 1),
        "block_count": 0,
        "payload_totals": {"raw_bytes": 0, "gzip_bytes": 0, "raw_by_plane": {}, "gzip_by_plane": {}},
    }


def matching_legacy_manifest(path: Path, generation_id: str, tiles: dict[str, int]) -> dict[str, Any] | None:
    if not path.is_file():
        return None
    manifest = load_json(path)
    if manifest.get("schema") != "dot-field-tiled-rain-v0" or manifest.get("version") != 0:
        return None
    if manifest.get("source_generation_id") != generation_id or manifest.get("lod_level") != REFERENCE_LEVEL:
        return None
    if manifest.get("tile_size") != TILE_SIZE or manifest.get("tile_index_bounds") != tiles:
        return None
    return manifest


def append_payload(path: Path, payload: bytes) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("ab") as handle:
        handle.write(payload)


def make_path(output: Path, level: int, tile_x: int, tile_y: int, block: int, name: str, suffix: str) -> Path:
    return output / "tiles" / f"L{level}" / str(tile_x) / str(tile_y) / f"{name}-block-{block:03d}.{suffix}"


def main() -> None:
    args = parse_arguments()
    phase = load_phase_0a()
    source_metadata_path = args.source_metadata.resolve()
    output = args.output.resolve()
    if output == source_metadata_path.parent or (output.name == "current" and output.parent.name == "generated"):
        raise SystemExit("refusing to write the normal generated weather directory")
    metadata = load_json(source_metadata_path)
    generation_id = metadata.get("generation_id")
    if not isinstance(generation_id, str) or not generation_id:
        raise SystemExit("normalized metadata must contain generation_id")
    grid = metadata.get("spatial_grid") or {}
    time = metadata.get("time") or {}
    rain = metadata.get("rain") or {}
    frame_count = int(time.get("count", 0))
    timestamps = time.get("timestamps")
    if frame_count <= 0 or not isinstance(timestamps, list) or len(timestamps) != frame_count:
        raise SystemExit("normalized metadata has an invalid timestamp contract")
    if not isinstance(rain.get("frame_assets"), list) or len(rain["frame_assets"]) != frame_count:
        raise SystemExit("normalized rain frame assets do not match frame count")
    if int(rain.get("frame_byte_length", 0)) != int(grid["width"]) * int(grid["height"]) * 4:
        raise SystemExit("normalized rain frame byte length does not match dimensions")
    support = grid.get("weather_support")
    if not isinstance(support, dict):
        raise SystemExit("normalized metadata has no weather_support")
    reference_tiles = reference_tile_bounds(phase, support)
    levels = {level: initialize_level(level, support, reference_tiles) for level in range(MIN_LEVEL, MAX_LEVEL + 1)}
    for level in range(MIN_LEVEL, MAX_LEVEL + 1):
        if level >= REFERENCE_LEVEL:
            levels[level]["encoding"] = {
                "rain": {"dtype": "UInt16", "byte_order": "little-endian", "nodata_code": 0, "dry_code": 1, "positive_code_min": 2, "positive_code_max": UINT16_MAX, "positive_quantized_range": POSITIVE_QUANTIZED_RANGE, "physical_units": "mm/h"},
                "hazards": {"dtype": "UInt8", "byte_order": "little-endian", "decode": "code / 255", "severity_range": [0, 1]},
            }
        else:
            levels[level]["encoding"] = {
                "plane_a": {"dtype": "Float16", "byte_order": "little-endian", "components": list(SUMMARY_A_COMPONENTS), "layout": "frame-major; row-major y then x; RGBA components interleaved", "nodata_sentinel": {"component": "rainCoverage", "value": -1.0, "meaning": "unsupported/NoData"}},
                "plane_b": {"dtype": "Float16", "byte_order": "little-endian", "components": list(SUMMARY_B_COMPONENTS), "optional": True, "absent_meaning": "all hazard summary values are zero"},
            }

    legacy_path = args.phase_0a_manifest.resolve()
    legacy = matching_legacy_manifest(legacy_path, generation_id, reference_tiles)
    if legacy is not None:
        l13_max = float(legacy["encoding"]["physical_max_mmh"])
    else:
        l13_max = 0.0
    source_max = 0.0
    if l13_max <= 0:
        for frame_index in range(frame_count):
            source = load_frame(source_metadata_path, metadata, frame_index)
            source_max = max(source_max, float(np.max(source)))
            rain_values, _, _ = reconstruct_l13_envelope(phase, source, metadata, reference_tiles, None)
            finite_values = rain_values[np.isfinite(rain_values)]
            if finite_values.size:
                l13_max = max(l13_max, float(np.max(finite_values)))
    else:
        for frame_index in range(frame_count):
            source = load_frame(source_metadata_path, metadata, frame_index)
            source_max = max(source_max, float(np.max(source)))
    if l13_max <= 0 or source_max <= 0:
        raise SystemExit("source support contains no positive physical rain")
    levels[REFERENCE_LEVEL]["encoding"]["rain"]["physical_max_mmh"] = l13_max
    levels[MAX_LEVEL]["encoding"]["rain"]["physical_max_mmh"] = source_max

    output.mkdir(parents=True, exist_ok=True)
    tiles_root = output / "tiles"
    if tiles_root.exists():
        shutil.rmtree(tiles_root)
    for report_path in (output / "manifest.json", output / "fidelity-report.json"):
        if report_path.exists():
            report_path.unlink()

    metrics = {level: FidelityMetrics(SUMMARY_A_COMPONENTS + SUMMARY_B_COMPONENTS) for level in range(MIN_LEVEL, REFERENCE_LEVEL)}
    hazard_available = bool((metadata.get("phenomena") or {}).get("available"))
    block_count = math.ceil(frame_count / TEMPORAL_BLOCK_SIZE)
    l13_valid = support_sample_bounds(phase, support, REFERENCE_LEVEL)
    generated_l13 = generated_bounds(REFERENCE_LEVEL, reference_tiles)
    l13_x_offset = l13_valid["min_i"] - generated_l13["min_i"]
    l13_y_offset = l13_valid["min_j"] - generated_l13["min_j"]
    for block_index, frame_start in enumerate(range(0, frame_count, TEMPORAL_BLOCK_SIZE)):
        frame_end = min(frame_count, frame_start + TEMPORAL_BLOCK_SIZE)
        for frame_index in range(frame_start, frame_end):
            source = load_frame(source_metadata_path, metadata, frame_index)
            phenomena = load_phenomena_frame(source_metadata_path, metadata, frame_index) if hazard_available else None
            l13_rain, l13_storm, l13_hail = reconstruct_l13_envelope(phase, source, metadata, reference_tiles, phenomena)
            storm_source = phase.severity_for_codes(phenomena, phase.THUNDERSTORM_LEVELS) if hazard_available else None
            hail_source = phase.severity_for_codes(phenomena, phase.HAIL_LEVELS) if hazard_available else None
            for tile_y in range(reference_tiles["min_y"], reference_tiles["max_y"] + 1):
                for tile_x in range(reference_tiles["min_x"], reference_tiles["max_x"] + 1):
                    local_x = (tile_x - reference_tiles["min_x"]) * TILE_SIZE
                    local_y = (tile_y - reference_tiles["min_y"]) * TILE_SIZE
                    rain_payload = encode_direct(l13_rain[local_y:local_y + TILE_SIZE, local_x:local_x + TILE_SIZE], l13_max).tobytes()
                    append_payload(make_path(output, REFERENCE_LEVEL, tile_x, tile_y, block_index, "rain", "u16"), rain_payload)
                    if hazard_available:
                        append_payload(make_path(output, REFERENCE_LEVEL, tile_x, tile_y, block_index, "storm", "u8"), encode_hazard(l13_storm[local_y:local_y + TILE_SIZE, local_x:local_x + TILE_SIZE]).tobytes())
                        append_payload(make_path(output, REFERENCE_LEVEL, tile_x, tile_y, block_index, "hail", "u8"), encode_hazard(l13_hail[local_y:local_y + TILE_SIZE, local_x:local_x + TILE_SIZE]).tobytes())

            child = make_direct_summary(
                l13_rain[l13_y_offset:l13_y_offset + l13_valid["max_j"] - l13_valid["min_j"] + 1, l13_x_offset:l13_x_offset + l13_valid["max_i"] - l13_valid["min_i"] + 1],
                l13_storm[l13_y_offset:l13_y_offset + l13_valid["max_j"] - l13_valid["min_j"] + 1, l13_x_offset:l13_x_offset + l13_valid["max_i"] - l13_valid["min_i"] + 1] if hazard_available else None,
                l13_hail[l13_y_offset:l13_y_offset + l13_valid["max_j"] - l13_valid["min_j"] + 1, l13_x_offset:l13_x_offset + l13_valid["max_i"] - l13_valid["min_i"] + 1] if hazard_available else None,
            )
            for level in range(REFERENCE_LEVEL - 1, MIN_LEVEL - 1, -1):
                fine_extent = levels[level + 1]["grid"]["support_sample_bounds"]
                coarse_extent = levels[level]["grid"]["support_sample_bounds"]
                child = aggregate_level(child, fine_extent, coarse_extent, level + 1, level)
                for tile_y in range(levels[level]["tile_index_bounds"]["min_y"], levels[level]["tile_index_bounds"]["max_y"] + 1):
                    for tile_x in range(levels[level]["tile_index_bounds"]["min_x"], levels[level]["tile_index_bounds"]["max_x"] + 1):
                        plane_a, plane_b = pack_summary_tile(child, coarse_extent, tile_x, tile_y, metrics[level])
                        append_payload(make_path(output, level, tile_x, tile_y, block_index, "summary-a", "f16"), plane_a)
                        if plane_b is not None:
                            append_payload(make_path(output, level, tile_x, tile_y, block_index, "summary-b", "f16"), plane_b)

            for tile_y in range(levels[MAX_LEVEL]["tile_index_bounds"]["min_y"], levels[MAX_LEVEL]["tile_index_bounds"]["max_y"] + 1):
                for tile_x in range(levels[MAX_LEVEL]["tile_index_bounds"]["min_x"], levels[MAX_LEVEL]["tile_index_bounds"]["max_x"] + 1):
                    rain_values = reconstruct_tile(phase, source, metadata, MAX_LEVEL, tile_x, tile_y)
                    append_payload(make_path(output, MAX_LEVEL, tile_x, tile_y, block_index, "rain", "u16"), encode_direct(rain_values, source_max).tobytes())
                    if hazard_available:
                        append_payload(make_path(output, MAX_LEVEL, tile_x, tile_y, block_index, "storm", "u8"), encode_hazard(reconstruct_tile(phase, storm_source, metadata, MAX_LEVEL, tile_x, tile_y)).tobytes())
                        append_payload(make_path(output, MAX_LEVEL, tile_x, tile_y, block_index, "hail", "u8"), encode_hazard(reconstruct_tile(phase, hail_source, metadata, MAX_LEVEL, tile_x, tile_y)).tobytes())
        print(json.dumps({"block": block_index, "frame_start": frame_start, "frame_count": frame_end - frame_start}), flush=True)

    level_metrics: dict[str, Any] = {}
    for level in range(MIN_LEVEL, MAX_LEVEL + 1):
        descriptor_by_key = {(tile["x"], tile["y"]): tile for tile in levels[level]["tiles"]}
        for tile_y in range(levels[level]["tile_index_bounds"]["min_y"], levels[level]["tile_index_bounds"]["max_y"] + 1):
            for tile_x in range(levels[level]["tile_index_bounds"]["min_x"], levels[level]["tile_index_bounds"]["max_x"] + 1):
                tile_descriptor = descriptor_by_key[(tile_x, tile_y)]
                for block_index, frame_start in enumerate(range(0, frame_count, TEMPORAL_BLOCK_SIZE)):
                    current_frame_count = min(TEMPORAL_BLOCK_SIZE, frame_count - frame_start)
                    block: dict[str, Any] = {"index": block_index, "frame_start": frame_start, "frame_count": current_frame_count}
                    payload_names = [("rain", "u16", 1)] if level >= REFERENCE_LEVEL else [("summary-a", "f16", 4), ("summary-b", "f16", 4)]
                    if level >= REFERENCE_LEVEL and hazard_available:
                        payload_names.extend([("storm", "u8", 1), ("hail", "u8", 1)])
                    for name, suffix, components in payload_names:
                        path = make_path(output, level, tile_x, tile_y, block_index, name, suffix)
                        if not path.is_file() or path.stat().st_size == 0:
                            if name == "summary-b":
                                block[name.replace("-", "_")] = None
                            continue
                        if name in ("storm", "hail", "summary-b") and not any(path.read_bytes()):
                            path.unlink()
                            gzip_path = Path(f"{path}.gz")
                            if gzip_path.exists():
                                gzip_path.unlink()
                            if name == "summary-b":
                                block["summary_b"] = None
                            continue
                        descriptor = payload_descriptor(path, output, current_frame_count, "Float16" if suffix == "f16" else ("UInt16" if suffix == "u16" else "UInt8"), components)
                        block[name.replace("-", "_")] = descriptor
                        levels[level]["payload_totals"]["raw_bytes"] += descriptor["byte_length"]
                        levels[level]["payload_totals"]["gzip_bytes"] += descriptor["gzip_byte_length"]
                        plane_name = name.replace("-", "_")
                        levels[level]["payload_totals"]["raw_by_plane"][plane_name] = levels[level]["payload_totals"]["raw_by_plane"].get(plane_name, 0) + descriptor["byte_length"]
                        levels[level]["payload_totals"]["gzip_by_plane"][plane_name] = levels[level]["payload_totals"]["gzip_by_plane"].get(plane_name, 0) + descriptor["gzip_byte_length"]
                    tile_descriptor["blocks"].append(block)
        levels[level]["block_count"] = levels[level]["tile_count"] * block_count
        if level < REFERENCE_LEVEL:
            level_metrics[f"L{level}"] = metrics[level].report()

    hazards = {
        "available": hazard_available,
        "channels": ["storm", "hail"] if hazard_available else [],
        "encoding": {"dtype": "UInt8", "byte_order": "little-endian", "decode": "code / 255", "severity_range": [0, 1]},
        "severity_anchors": {"storm": {str(code): value for code, value in THUNDERSTORM_LEVELS.items()}, "hail": {str(code): value for code, value in HAIL_LEVELS.items()}},
        "source": "normalized phenomena categorical codes mapped to continuous severity before reconstruction" if hazard_available else "unavailable in normalized source",
    }
    for level in levels.values():
        level.pop("_internal", None)
    manifest = {
        "schema": SCHEMA,
        "version": VERSION,
        "reference_level": REFERENCE_LEVEL,
        "level_range": {"min": MIN_LEVEL, "max": MAX_LEVEL},
        "source_generation_id": generation_id,
        "source_metadata_asset": relative_asset(source_metadata_path, output),
        "weather_support": support,
        "frame_count": frame_count,
        "timestamps": timestamps,
        "temporal_block_size": TEMPORAL_BLOCK_SIZE,
        "tile_size": TILE_SIZE,
        "physical_units": "mm/h",
        "byte_order": "little-endian",
        "tile_ownership": "half-open global sample ranges [tile*128, (tile+1)*128)",
        "aggregation": {"relation": "centered dyadic; full support domain before output tiling", "thresholds_mmh": {"rain_coverage": RAIN_COVERAGE_THRESHOLDS[0], "strong_coverage": RAIN_COVERAGE_THRESHOLDS[1]}, "source": "unquantized Float32 L13 reconstructed physical values", "hazard_mean_omission": "For active Dots/Squares, positive hazard mean is never greater than max severity; coverage plus max is sufficient for the current monotonic max presentation."},
        "hazards": hazards,
        "levels": [levels[level] for level in range(MIN_LEVEL, MAX_LEVEL + 1)],
        "fidelity_report": "fidelity-report.json",
        "legacy_l13_parity": {"status": "available-for-verifier" if legacy is not None else "legacy-manifest-unavailable", "source_manifest": relative_asset(legacy_path, output) if legacy is not None else None},
    }
    report = {"schema": "dot-field-tiled-rain-lod-fidelity-v1", "version": 1, "float16_round_trip": level_metrics}
    (output / "fidelity-report.json").write_text(json.dumps(report, indent=2) + "\n", encoding="utf-8")
    (output / "manifest.json").write_text(json.dumps(manifest, indent=2) + "\n", encoding="utf-8")
    summary = {
        "output": str(output),
        "schema": SCHEMA,
        "source_generation_id": generation_id,
        "levels": {f"L{level}": {"tile_count": levels[level]["tile_count"], "block_count": levels[level]["block_count"], "payload_totals": levels[level]["payload_totals"]} for level in range(MIN_LEVEL, MAX_LEVEL + 1)},
        "hazards_available": hazard_available,
        "legacy_l13_manifest_used": legacy is not None,
        "fidelity_report": report,
    }
    print(json.dumps(summary, indent=2))


if __name__ == "__main__":
    main()
