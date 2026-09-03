#!/usr/bin/env python3
"""Dependency-light synthetic verification for the tiled-rain MotionField."""

from __future__ import annotations

import argparse
import hashlib
import importlib.util
import json
import sys
import tempfile
from pathlib import Path

import numpy as np


sys.dont_write_bytecode = True
MODULE_PATH = Path(__file__).with_name("generate-tiled-rain-motion.py")
SPEC = importlib.util.spec_from_file_location("tiled_rain_motion", MODULE_PATH)
if SPEC is None or SPEC.loader is None:
    raise SystemExit(f"cannot load {MODULE_PATH}")
MOTION = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(MOTION)


def sha256_bytes(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def verify_generated_assets(
    generated: Path,
    expected_generation_id: str | None = None,
    expected_source_filename: str | None = None,
) -> dict:
    manifest_path = generated / "manifest.json"
    manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    if manifest["interval_count"] != 18 or len(manifest["intervals"]) != 18:
        raise AssertionError("generated motion does not contain 18 adjacent intervals")
    if manifest["rain_tile_size"] != 128:
        raise AssertionError("generated motion has the wrong rain tile size")
    motion_grid = manifest["motion_grid"]
    node_spacing = int(motion_grid["node_spacing_l13_samples"])
    if node_spacing != 32:
        raise AssertionError("generated motion has the wrong node spacing")
    if 128 % node_spacing != 0:
        raise AssertionError("MotionField node spacing does not divide the rain tile size")
    nodes_per_tile = 128 // node_spacing + 1
    source_manifest = (generated / manifest["source_tiled_rain_manifest"]).resolve()
    source_manifest_data = json.loads(source_manifest.read_text(encoding="utf-8"))
    if source_manifest_data["source_generation_id"] != manifest["source_generation_id"]:
        raise AssertionError("motion and Phase 0A manifest generation IDs differ")
    source_metadata = (
        source_manifest.parent / source_manifest_data["source_metadata_asset"]
    ).resolve()
    source_metadata_data = json.loads(source_metadata.read_text(encoding="utf-8"))
    if source_metadata_data["generation_id"] != manifest["source_generation_id"]:
        raise AssertionError("motion, Phase 0A manifest, and normalized metadata differ")
    if expected_generation_id is not None and manifest["source_generation_id"] != expected_generation_id:
        raise AssertionError("generated motion does not match the expected generation")
    if (
        expected_source_filename is not None
        and source_metadata_data.get("source", {}).get("filename") != expected_source_filename
    ):
        raise AssertionError("generated motion does not match the expected source filename")
    if sha256_bytes(source_manifest) != manifest["source_tiled_rain_manifest_sha256"]:
        raise AssertionError("motion is not bound to the exact current Phase 0A manifest")

    tile_by_coordinate = {}
    raw_total = 0
    gzip_total = 0
    for descriptor in manifest["tiles"]:
        x = int(descriptor["x"])
        y = int(descriptor["y"])
        node_width = int(descriptor["node_width"])
        node_height = int(descriptor["node_height"])
        if (node_width, node_height) != (nodes_per_tile, nodes_per_tile):
            raise AssertionError(f"tile {x},{y} does not have the expected {nodes_per_tile}x{nodes_per_tile} node footprint")
        asset = generated / descriptor["asset"]
        payload = np.fromfile(asset, dtype="<f4")
        expected_values = manifest["interval_count"] * nodes_per_tile * nodes_per_tile * 3
        if payload.size != expected_values or descriptor["byte_length"] != payload.nbytes:
            raise AssertionError(f"tile {x},{y} has an invalid payload length")
        values = payload.reshape(manifest["interval_count"], node_height, node_width, 3)
        if np.any(~np.isfinite(values)):
            raise AssertionError(f"tile {x},{y} contains non-finite motion")
        if np.any(np.abs(values[:, :, :, :2]) > MOTION.MAX_COMPONENT_DISPLACEMENT):
            raise AssertionError(f"tile {x},{y} exceeds the component displacement bound")
        confidence = values[:, :, :, 2]
        if np.any((confidence < 0) | (confidence > 1)):
            raise AssertionError(f"tile {x},{y} contains out-of-range confidence")
        zero_confidence = confidence == 0
        if np.any(values[:, :, :, :2][zero_confidence] != 0):
            raise AssertionError(f"tile {x},{y} has nonzero displacement at zero confidence")
        gzip_asset = generated / descriptor["gzip_asset"]
        if descriptor["gzip_byte_length"] != gzip_asset.stat().st_size:
            raise AssertionError(f"tile {x},{y} has an invalid gzip length")
        tile_by_coordinate[(x, y)] = values
        raw_total += payload.nbytes
        gzip_total += gzip_asset.stat().st_size

    bounds = manifest["motion_grid"]
    expected_node_count = int(bounds["node_width"]) * int(bounds["node_height"])
    source_bounds = source_manifest_data["tile_index_bounds"]
    min_tile_x, min_tile_y = int(source_bounds["min_x"]), int(source_bounds["min_y"])
    expected_width = (int(source_bounds["max_x"]) - min_tile_x) * 128 // node_spacing + 1
    expected_height = (int(source_bounds["max_y"]) - min_tile_y) * 128 // node_spacing + 1
    if (bounds["node_x_start"], bounds["node_y_start"]) != (min_tile_x * 128, min_tile_y * 128):
        raise AssertionError("MotionField global node origin is not anchored to the Phase 0A tile envelope")
    if (int(bounds["node_width"]), int(bounds["node_height"])) != (expected_width, expected_height):
        raise AssertionError("MotionField global node dimensions are inconsistent with tile bounds")
    for descriptor in manifest["tiles"]:
        expected_x_start = (int(descriptor["x"]) - min_tile_x) * 128 // node_spacing
        expected_y_start = (int(descriptor["y"]) - min_tile_y) * 128 // node_spacing
        if (int(descriptor["node_x_start"]), int(descriptor["node_y_start"])) != (expected_x_start, expected_y_start):
            raise AssertionError(f"tile {descriptor['x']},{descriptor['y']} is not globally anchored")
    if manifest["quality_diagnostics"]["unique_global_motion_nodes"] != expected_node_count:
        raise AssertionError("manifest global motion-node count is inconsistent")
    quality = manifest["quality_diagnostics"]
    for interval in quality["intervals"]:
        relevant = int(interval["motion_relevant_node_count"])
        local_accepted = int(interval["relevant_local_accepted_count"])
        recovered = int(interval["recovered_weak_regional_proposal_count"])
        accepted_under_regional = int(
            interval["relevant_local_accepted_under_accepted_regional_prior_count"]
        )
        if accepted_under_regional + recovered != local_accepted:
            raise AssertionError(f"interval {interval['index']} local recovery classes do not add up")
        if recovered > relevant:
            raise AssertionError(f"interval {interval['index']} recovered more nodes than relevant")
        relevant_classes = (
            int(interval["relevant_local_accepted_count"])
            + int(interval["relevant_regional_fallback_count"])
            + int(interval["relevant_rejected_zero_confidence_count"])
        )
        if relevant_classes != relevant:
            raise AssertionError(f"interval {interval['index']} relevance classes do not add up")
        accepted_plus_fallback = 100.0 * (
            int(interval["relevant_local_accepted_count"])
            + int(interval["relevant_regional_fallback_count"])
        ) / max(1, relevant)
        rejected_percentage = 100.0 * int(
            interval["relevant_rejected_zero_confidence_count"]
        ) / max(1, relevant)
        if abs(interval["relevant_accepted_plus_fallback_percentage"] - accepted_plus_fallback) > 1e-9:
            raise AssertionError(f"interval {interval['index']} relevant acceptance percentage is inconsistent")
        if abs(interval["relevant_rejected_percentage"] - rejected_percentage) > 1e-9:
            raise AssertionError(f"interval {interval['index']} relevant rejection percentage is inconsistent")
    aggregate = quality["aggregate"]
    aggregate_relevant = int(aggregate["motion_relevant_node_count"])
    if int(aggregate["relevant_local_accepted_under_accepted_regional_prior_count"]) + int(
        aggregate["recovered_weak_regional_proposal_count"]
    ) != int(aggregate["relevant_local_accepted_count"]):
        raise AssertionError("aggregate local recovery classes do not add up")
    aggregate_relevant_classes = (
        int(aggregate["relevant_local_accepted_count"])
        + int(aggregate["relevant_regional_fallback_count"])
        + int(aggregate["relevant_rejected_zero_confidence_count"])
    )
    if aggregate_relevant_classes != aggregate_relevant:
        raise AssertionError("aggregate relevance classes do not add up")
    if manifest["payload_totals"] != {"raw_f32_bytes": raw_total, "gzip_bytes": gzip_total}:
        raise AssertionError("manifest payload totals are inconsistent")
    for (x, y), values in tile_by_coordinate.items():
        right = tile_by_coordinate.get((x + 1, y))
        if right is not None and not np.array_equal(values[:, :, -1, :], right[:, :, 0, :]):
            raise AssertionError(f"horizontal boundary node mismatch at {x + 1},{y}")
        below = tile_by_coordinate.get((x, y + 1))
        if below is not None and not np.array_equal(values[:, -1, :, :], below[:, 0, :, :]):
            raise AssertionError(f"vertical boundary node mismatch at {x},{y + 1}")
    return {
        "tile_count": len(tile_by_coordinate),
        "interval_count": manifest["interval_count"],
        "unique_global_motion_nodes": expected_node_count,
        "raw_motion_bytes": raw_total,
        "gzip_motion_bytes": gzip_total,
        "shared_boundary_nodes": True,
    }


def make_pattern(height: int = 320, width: int = 320) -> np.ndarray:
    """Make asymmetric rain structure with a quiet/dry area and NoData edge."""

    y, x = np.mgrid[:height, :width]
    rain = np.zeros((height, width), dtype=np.float32)
    main = ((x - 128) / 34) ** 2 + ((y - 128) / 28) ** 2 <= 1
    rain[main] = 1.0 + 0.005 * (x[main] - 90) + 0.008 * (y[main] - 100)
    lobe = ((x - 163) / 11) ** 2 + ((y - 110) / 7) ** 2 <= 1
    rain[lobe] += 8.0
    notch = ((x - 111) / 8) ** 2 + ((y - 146) / 5) ** 2 <= 1
    rain[notch] *= 0.12
    tail = (x >= 91) & (x <= 178) & (y >= 150) & (y <= 158)
    rain[tail] += (x[tail] - 90) / 40.0
    # A second distinct system lets the multi-node test prove shared global
    # identity without making the local matcher depend on one generic blob.
    second = ((x - 222) / 18) ** 2 + ((y - 224) / 23) ** 2 <= 1
    rain[second] += 2.0 + 0.01 * (x[second] - 205) + 0.02 * (y[second] - 202)
    rain[:4, :] = np.nan
    rain[:, :4] = np.nan
    return rain


def translated(source: np.ndarray, dx: int, dy: int) -> np.ndarray:
    target = np.zeros_like(source)
    source_height, source_width = source.shape
    source_x0 = max(0, -dx)
    source_x1 = min(source_width, source_width - dx) if dx >= 0 else source_width
    source_y0 = max(0, -dy)
    source_y1 = min(source_height, source_height - dy) if dy >= 0 else source_height
    target_x0 = source_x0 + dx
    target_x1 = source_x1 + dx
    target_y0 = source_y0 + dy
    target_y1 = source_y1 + dy
    target[target_y0:target_y1, target_x0:target_x1] = source[source_y0:source_y1, source_x0:source_x1]
    target[:4, :] = np.nan
    target[:, :4] = np.nan
    return target


def estimate(source: np.ndarray, dx: int, dy: int, nodes: list[tuple[int, int]] | None = None):
    target = translated(source, dx, dy)
    if nodes is None:
        nodes = [(128, 128)]
    node_x = np.asarray(sorted({x for x, _ in nodes}), dtype=np.int64)
    node_y = np.asarray(sorted({y for _, y in nodes}), dtype=np.int64)
    field, diagnostics = MOTION.estimate_interval(source, target, 0, 0, node_x, node_y)
    return field, diagnostics, node_x, node_y


def estimate_with_forced_rejected_regional_proposal(
    source: np.ndarray,
    dx: int,
    dy: int,
    proposal_dx: int,
    proposal_dy: int,
):
    """Exercise the B3A gate with an ambiguous regional result and real local matching."""

    target = translated(source, dx, dy)
    node_x = np.asarray([128], dtype=np.int64)
    node_y = np.asarray([128], dtype=np.int64)
    original_choose_hypothesis = MOTION.choose_hypothesis
    regional_calls = 0

    def forced_regional_rejection(*args, **kwargs):
        nonlocal regional_calls
        if regional_calls < 2:
            regional_calls += 1
            return {
                "state": "rejected",
                "reason": "weak-evidence",
                "dx": proposal_dx,
                "dy": proposal_dy,
                "confidence": 0.0,
                "informative_count": MOTION.MIN_REGIONAL_INFORMATIVE,
                "valid_count": args[3].size,
                "signal_sum": MOTION.MIN_SIGNAL_LOG_SUM,
            }
        return original_choose_hypothesis(*args, **kwargs)

    MOTION.choose_hypothesis = forced_regional_rejection
    try:
        field, diagnostics = MOTION.estimate_interval(
            source, target, 0, 0, node_x, node_y
        )
    finally:
        MOTION.choose_hypothesis = original_choose_hypothesis
    return field, diagnostics


def require_translation(source: np.ndarray, dx: int, dy: int) -> dict:
    field, diagnostics, node_x, node_y = estimate(source, dx, dy)
    column = int(np.where(node_x == 128)[0][0])
    row = int(np.where(node_y == 128)[0][0])
    result = field[row, column]
    if int(result[0]) != dx or int(result[1]) != dy:
        raise AssertionError(f"expected ({dx},{dy}), got ({result[0]},{result[1]})")
    if dx or dy:
        if not result[2] > 0:
            raise AssertionError(f"expected positive confidence for ({dx},{dy})")
    return {
        "expected": [dx, dy],
        "actual": [int(result[0]), int(result[1])],
        "confidence": float(result[2]),
        "accepted": diagnostics["accepted_count"],
    }


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--generated",
        type=Path,
        default=None,
        help="also validate a generated MotionField directory",
    )
    parser.add_argument("--expected-generation-id", default=None)
    parser.add_argument("--expected-source-filename", default=None)
    args = parser.parse_args()
    source = make_pattern()
    translations = [
        (0, 0),
        (5, 0),
        (-5, 0),
        (0, 5),
        (0, -5),
        (6, -7),
        (12, -12),
    ]
    translation_results = [require_translation(source, dx, dy) for dx, dy in translations]

    # A boundary-crossing system and three globally anchored nodes exercise
    # node identity independently of a 128-sample rain-tile boundary.
    boundary_source = np.zeros((320, 320), dtype=np.float32)
    boundary_source[96:160, 104:160] = source[96:160, 104:160]
    boundary_field, boundary_diag, node_x, node_y = estimate(
        boundary_source, 7, 3, [(64, 128), (128, 128), (192, 128)]
    )
    boundary_row = int(np.where(node_y == 128)[0][0])
    boundary_column = int(np.where(node_x == 128)[0][0])
    boundary_result = boundary_field[boundary_row, boundary_column]
    if tuple(boundary_result[:2].astype(int)) != (7, 3):
        raise AssertionError(f"tile boundary translation failed: {boundary_result}")

    # A fully dry node is never regional-filled, even when another node in the
    # same global region has strong rain evidence.
    dry_field, dry_diag, dry_x, dry_y = estimate(source, 5, 2, [(128, 128), (240, 64)])
    dry_row = int(np.where(dry_y == 64)[0][0])
    dry_column = int(np.where(dry_x == 240)[0][0])
    if not np.array_equal(dry_field[dry_row, dry_column], np.zeros(3, dtype=np.float32)):
        raise AssertionError("valid dry region received a motion fallback")

    # An all-NoData edge is rejected.
    nodata = np.full((96, 96), np.nan, dtype=np.float32)
    nodata_field, nodata_diag, _, _ = estimate(nodata, 0, 0, [(48, 48)])
    if not np.array_equal(nodata_field[0, 0], np.zeros(3, dtype=np.float32)):
        raise AssertionError("NoData node was not rejected")

    # A repetitive checkerboard has several equally good hypotheses and must
    # not be converted into a confident arbitrary vector.
    repetitive = np.zeros((320, 320), dtype=np.float32)
    repetitive[96:160, 96:160] = ((np.indices((64, 64)).sum(axis=0) % 2) + 1).astype(np.float32)
    repetitive_field, repetitive_diag, _, _ = estimate(repetitive, 4, 0, [(128, 128)])
    if repetitive_field[0, 0, 2] != 0.0:
        raise AssertionError("ambiguous repetitive structure was accepted")

    # A deliberately ambiguous regional result is only a proposal: a locally
    # asymmetric footprint can recover the translation independently.
    regional_ambiguous_source = np.ones((320, 320), dtype=np.float32)
    y, x = np.mgrid[:320, :320]
    local_structure = (x >= 112) & (x <= 144) & (y >= 112) & (y <= 144)
    regional_ambiguous_source[local_structure] += (
        0.17 * (x[local_structure] - 112) + 0.23 * (y[local_structure] - 112)
    )
    recovered_field, recovered_diag = estimate_with_forced_rejected_regional_proposal(
        regional_ambiguous_source, 5, 3, 4, 2
    )
    if tuple(recovered_field[0, 0, :2].astype(int)) != (5, 3):
        raise AssertionError("locally asymmetric node did not recover from rejected regional proposal")
    if recovered_diag["recovered_weak_regional_proposal_count"] != 1:
        raise AssertionError("rejected regional proposal recovery was not diagnosed")
    if recovered_diag["regional_fallback_count"] != 0:
        raise AssertionError("rejected regional result incorrectly produced fallback")

    # The same rejected proposal cannot copy a vector into an ambiguous local
    # footprint: local acceptance remains authoritative.
    ambiguous_local_source = np.ones((320, 320), dtype=np.float32)
    ambiguous_field, ambiguous_diag = estimate_with_forced_rejected_regional_proposal(
        ambiguous_local_source, 5, 3, 4, 2
    )
    if not np.array_equal(ambiguous_field[0, 0], np.zeros(3, dtype=np.float32)):
        raise AssertionError("rejected regional proposal copied into ambiguous local node")
    if ambiguous_diag["recovered_weak_regional_proposal_count"] != 0:
        raise AssertionError("ambiguous local node was incorrectly counted as recovered")

    # Package two adjacent rain tiles from one global field and compare the
    # shared x=128 node bytes.  This catches per-tile re-estimation/rounding.
    packaged_field = np.zeros((1, 9, 3), dtype="<f4")
    packaged_field[0, :, :] = np.asarray(
        [[0.0, 1.0, 0.1], [2.0, 3.0, 0.2], [4.0, 5.0, 0.3], [6.0, 7.0, 0.4], [8.0, 9.0, 0.5], [10.0, 11.0, 0.6], [12.0, 13.0, 0.7], [14.0, 15.0, 0.8], [16.0, 17.0, 0.9]],
        dtype="<f4",
    )
    package_manifest = {"tile_index_bounds": {"min_x": 0, "max_x": 1, "min_y": 0, "max_y": 0}}
    with tempfile.TemporaryDirectory(prefix="dot-field-motion-verify-") as temporary:
        assets, _, _ = MOTION.build_asset_payloads(
            [packaged_field], package_manifest, Path(temporary)
        )
        first = (Path(temporary) / assets[0]["asset"]).read_bytes()
        second = (Path(temporary) / assets[1]["asset"]).read_bytes()
        if assets[0]["node_width"] != 5 or assets[0]["node_height"] != 5:
            raise AssertionError("synthetic package did not use the 5x5 node footprint")
        # One node is 12 bytes and is the fifth node in tile 0 / first node in tile 1.
        if first[4 * 12:5 * 12] != second[:12]:
            raise AssertionError("shared boundary motion node bytes differ")

    # Deterministic estimator output is byte-identical across independent runs.
    first_bytes = estimate(source, 6, -7)[0].tobytes()
    second_bytes = estimate(source, 6, -7)[0].tobytes()
    if first_bytes != second_bytes:
        raise AssertionError("synthetic rerun is not byte deterministic")

    result = {
        "status": "passed",
        "translation_cases": translation_results,
        "boundary_crossing": {
            "expected": [7, 3],
            "actual": [int(boundary_result[0]), int(boundary_result[1])],
            "confidence": float(boundary_result[2]),
            "accepted": boundary_diag["accepted_count"],
        },
        "dry_rejected": dry_diag["rejected_zero_confidence_count"] > 0,
        "nodata_rejected": nodata_diag["rejected_zero_confidence_count"] > 0,
        "ambiguous_rejected": repetitive_diag["rejected_zero_confidence_count"] > 0,
        "rejected_regional_proposal_local_recovery": {
            "recovered": True,
            "actual": [int(recovered_field[0, 0, 0]), int(recovered_field[0, 0, 1])],
            "confidence": float(recovered_field[0, 0, 2]),
            "validation": recovered_diag["validation"],
        },
        "rejected_regional_proposal_ambiguous_local_rejected": True,
        "shared_boundary_bytes_identical": True,
        "deterministic_rerun": True,
    }
    if args.generated is not None:
        result["generated_assets"] = verify_generated_assets(
            args.generated.resolve(),
            args.expected_generation_id,
            args.expected_source_filename,
        )
    print(json.dumps(result, indent=2))


if __name__ == "__main__":
    main()
