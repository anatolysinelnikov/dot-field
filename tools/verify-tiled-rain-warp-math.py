#!/usr/bin/env python3
"""Dependency-light CPU reference checks for the Phase 0B2 shader math."""

from __future__ import annotations

import json
import math

import numpy as np


EPSILON = 1e-6


def interpolate_motion(
    nodes: np.ndarray,
    coordinate: tuple[float, float],
    node_spacing: int,
) -> tuple[np.ndarray, float]:
    x, y = coordinate
    nodes_per_tile = nodes.shape[1]
    lower_x = min(nodes_per_tile - 2, max(0, math.floor(x / node_spacing)))
    lower_y = min(nodes_per_tile - 2, max(0, math.floor(y / node_spacing)))
    fraction_x = x / node_spacing - lower_x
    fraction_y = y / node_spacing - lower_y
    flow = np.zeros(2, dtype=np.float64)
    confidence = 0.0
    for row in range(2):
        for column in range(2):
            weight = (1.0 - fraction_x if column == 0 else fraction_x) * (1.0 - fraction_y if row == 0 else fraction_y)
            node = nodes[lower_y + row, lower_x + column]
            flow += weight * node[2] * node[:2]
            confidence += weight * node[2]
    return (flow / confidence if confidence > EPSILON else np.zeros(2), confidence)


def bilinear(values: np.ndarray, x: float, y: float) -> tuple[float, bool]:
    base_x, base_y = math.floor(x), math.floor(y)
    fraction_x, fraction_y = x - base_x, y - base_y
    result = 0.0
    total = 0.0
    for offset_y, offset_x, weight in (
        (0, 0, (1 - fraction_x) * (1 - fraction_y)),
        (0, 1, fraction_x * (1 - fraction_y)),
        (1, 0, (1 - fraction_x) * fraction_y),
        (1, 1, fraction_x * fraction_y),
    ):
        value = values[base_y + offset_y, base_x + offset_x]
        if not np.isfinite(value):
            continue
        result += float(value) * weight
        total += weight
    return (result / total, True) if total > 0 else (0.0, False)


def temporal(first: tuple[float, bool], second: tuple[float, bool], progress: float) -> tuple[float, bool]:
    if first[1] and second[1]:
        return (first[0] * (1 - progress) + second[0] * progress, True)
    return first if first[1] else second if second[1] else (0.0, False)


def warped(
    first: np.ndarray,
    second: np.ndarray,
    flow: tuple[float, float],
    confidence: float,
    progress: float,
    coordinate: tuple[float, float],
) -> tuple[float, bool]:
    x, y = coordinate
    # The explicit endpoint branch is part of the contract, not merely an
    # optimization: it makes frame endpoints bit-for-bit direct samples.
    if progress <= 0.0:
        return (float(first[int(y), int(x)]), np.isfinite(first[int(y), int(x)]))
    if progress >= 1.0:
        return (float(second[int(y), int(x)]), np.isfinite(second[int(y), int(x)]))
    direct = temporal((float(first[int(y), int(x)]), np.isfinite(first[int(y), int(x)])),
                      (float(second[int(y), int(x)]), np.isfinite(second[int(y), int(x)])), progress)
    if confidence <= EPSILON or not direct[1] and not np.isfinite(first[int(y), int(x)]) and not np.isfinite(second[int(y), int(x)]):
        return direct
    warped_first = bilinear(first, x - flow[0] * progress, y - flow[1] * progress)
    warped_second = bilinear(second, x + flow[0] * (1 - progress), y + flow[1] * (1 - progress))
    warped_value = temporal(warped_first, warped_second, progress)
    if not warped_value[1]:
        return direct
    return (direct[0] * (1 - confidence) + warped_value[0] * confidence, True)


def translated(source: np.ndarray, dx: int, dy: int) -> np.ndarray:
    result = np.full_like(source, np.nan)
    height, width = source.shape
    source_y0, source_y1 = max(0, -dy), min(height, height - dy) if dy >= 0 else height
    source_x0, source_x1 = max(0, -dx), min(width, width - dx) if dx >= 0 else width
    result[source_y0 + dy:source_y1 + dy, source_x0 + dx:source_x1 + dx] = source[source_y0:source_y1, source_x0:source_x1]
    return result


def require(condition: bool, message: str) -> None:
    if not condition:
        raise AssertionError(message)


def main() -> None:
    node_spacing = 32
    nodes = np.zeros((5, 5, 3), dtype=np.float64)
    nodes[:, :, :] = [4.0, -3.0, 1.0]
    flow, confidence = interpolate_motion(nodes, (37.25, 89.5), node_spacing)
    require(np.allclose(flow, [4, -3]) and confidence == 1.0, "uniform confidence-weighted motion failed")

    sparse = np.zeros((5, 5, 3), dtype=np.float64)
    sparse[0, 0] = [8.0, 2.0, 1.0]
    sparse[0, 1] = [0.0, 0.0, 0.0]
    flow, confidence = interpolate_motion(sparse, (16.0, 0.0), node_spacing)
    require(np.allclose(flow, [8, 2]) and confidence == 0.5, "zero-confidence node pulled known motion")

    # Every 32-sample subcell selects its own four surrounding nodes.  Keep
    # the marker values distinct so a neighboring 5x5 footprint cannot pass.
    for row in range(4):
        for column in range(4):
            coordinate = (column * node_spacing + node_spacing / 2, row * node_spacing + node_spacing / 2)
            lower_x = column
            lower_y = row
            expected = np.asarray([
                [lower_x, lower_y],
                [lower_x + 1, lower_y],
                [lower_x, lower_y + 1],
                [lower_x + 1, lower_y + 1],
            ], dtype=np.float64)
            marked = np.zeros((5, 5, 3), dtype=np.float64)
            for marker_x, marker_y in expected:
                marked[int(marker_y), int(marker_x)] = [marker_x + marker_y * 10, 0, 1]
            flow, confidence = interpolate_motion(marked, coordinate, node_spacing)
            require(confidence == 1.0, f"subcell ({column},{row}) did not use four local nodes")
            require(np.isclose(flow[0], np.mean(expected[:, 0] + expected[:, 1] * 10)), f"subcell ({column},{row}) selected the wrong nodes")

    source = np.zeros((40, 40), dtype=np.float64)
    y, x = np.mgrid[:40, :40]
    source[:] = 0.3 + x * 0.07 + y * 0.11
    translations = [(0, 0), (3, 0), (-3, 0), (0, 3), (0, -3), (3, -2), (12, -12)]
    translation_results = []
    for dx, dy in translations:
        target = translated(source, dx, dy)
        point = (20, 20)
        result = warped(source, target, (dx, dy), 1.0, 0.5, point)
        require(result[1], f"translation ({dx},{dy}) became invalid")
        expected = bilinear(source, point[0] - dx * 0.5, point[1] - dy * 0.5)[0]
        require(abs(result[0] - expected) < 1e-9, f"translation ({dx},{dy}) did not align the signal")
        translation_results.append({"dx": dx, "dy": dy, "value": result[0]})

    endpoint_target = translated(source, 4, -4)
    point = (20, 20)
    start = warped(source, endpoint_target, (4, -4), 1.0, 0.0, point)
    end = warped(source, endpoint_target, (4, -4), 1.0, 1.0, point)
    require(start[0] == source[point[1], point[0]] and end[0] == endpoint_target[point[1], point[0]], "exact endpoint contract failed")
    direct = warped(source, endpoint_target, (12, 12), 0.0, 0.5, point)
    expected_direct = temporal((source[point[1], point[0]], True), (endpoint_target[point[1], point[0]], True), 0.5)
    require(direct == expected_direct, "confidence zero did not select direct interpolation")

    dry = np.zeros((2, 2), dtype=np.float64)
    dry_value, dry_valid = bilinear(dry, 0.25, 0.25)
    require(dry_valid and dry_value == 0.0, "valid dry was treated as NoData")
    nodata = np.asarray([[np.nan, 2.0], [4.0, np.nan]])
    nodata_value, nodata_valid = bilinear(nodata, 0.5, 0.5)
    require(nodata_valid and nodata_value == 3.0, "NoData taps were not renormalized")
    unsupported = np.full((8, 8), np.nan)
    unsupported[2:6, 2:6] = 5.0
    unsupported_result = warped(unsupported, unsupported, (2, 2), 1.0, 0.5, (0, 0))
    require(not unsupported_result[1], "warp expanded unsupported rain support")

    global_field = np.arange(256 * 4, dtype=np.float64).reshape(4, 256)
    left_tile = np.full((4, 154), np.nan)
    right_tile = np.full((4, 154), np.nan)
    left_tile[:, 13:13 + 128] = global_field[:, :128]
    left_tile[:, 13 + 128:] = global_field[:, 128:141]
    right_tile[:, :13] = global_field[:, 115:128]
    right_tile[:, 13:13 + 128] = global_field[:, 128:]
    left_value = bilinear(left_tile, 13 + 127.5, 1.5)
    right_value = bilinear(right_tile, 13 - 0.5, 1.5)
    require(left_value == right_value, "tile-boundary fractional samples are discontinuous")

    result = {
        "status": "passed",
        "confidence_weighted_interpolation": True,
        "endpoint_s0_exact": True,
        "endpoint_s1_exact": True,
        "confidence_zero_direct": True,
        "translation_cases": translation_results,
        "valid_dry": True,
        "nodata_bilinear_renormalization": nodata_value,
        "no_support_expansion": True,
        "tile_boundary_fractional_continuity": True,
    }
    print(json.dumps(result, indent=2))


if __name__ == "__main__":
    main()
