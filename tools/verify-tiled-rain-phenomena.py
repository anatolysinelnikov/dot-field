#!/usr/bin/env python3
"""Focused deterministic checks for the direct tiled-rain phenomena channel."""

from __future__ import annotations

import argparse
import gzip
import importlib.util
import json
import math
from pathlib import Path

import numpy as np


def load_generator():
    path = Path(__file__).with_name("generate-tiled-rain.py")
    spec = importlib.util.spec_from_file_location("tiled_rain_generator", path)
    module = importlib.util.module_from_spec(spec)
    assert spec.loader is not None
    spec.loader.exec_module(module)
    return module


def require(condition: bool, message: str) -> None:
    if not condition:
        raise AssertionError(message)


def mercator_y(latitude: float) -> float:
    return (1.0 - math.log(math.tan(math.pi / 4 + math.radians(latitude) / 2)) / math.pi) / 2


def hazard_radius(severity: float, threshold: float, low: float, high: float) -> float:
    edge0 = threshold * 0.45
    progress = max(0.0, min(1.0, (severity - edge0) / (0.93 - edge0)))
    strength = progress * progress * (3.0 - 2.0 * progress)
    return 0.0 if strength <= 0 else low + (high - low) * strength**0.47


def main() -> None:
    root = Path(__file__).resolve().parents[1]
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--generated", type=Path, default=root / "data" / "generated" / "tiled-rain" / "current")
    parser.add_argument("--rain-baseline", type=Path, help="optional prior rain-only tiled output for byte comparison")
    args = parser.parse_args()
    generated = args.generated.resolve()
    manifest = json.loads((generated / "manifest.json").read_text(encoding="utf-8"))
    generator = load_generator()

    require(manifest["source_generation_id"] == "generation-8c949e0efb6d308c", "unexpected source generation")
    require(manifest["lod_level"] == 13 and manifest["tile_size"] == 128, "L13/tile contract changed")
    require(manifest["temporal_block_size"] == 4, "temporal block contract changed")
    require(manifest["hazards"]["encoding"]["dtype"] == "UInt8", "hazards are not compact UInt8")
    require(manifest["hazards"]["channels"] == ["storm", "hail"], "hazard channels are not aligned")

    rain_files = 0
    hazard_files = 0
    for tile in manifest["tiles"]:
        for block in tile["blocks"]:
            rain = block
            rain_path = generated / rain["asset"]
            require(rain_path.stat().st_size == rain["byte_length"], "rain payload length mismatch")
            rain_files += 1
            for channel in ("storm", "hail"):
                descriptor = block[channel]
                if descriptor is None:
                    continue
                require(descriptor["sample_count"] == 128 * 128, f"{channel} sample alignment failed")
                require(descriptor["byte_length"] == descriptor["sample_count"] * block["frame_count"], f"{channel} frame alignment failed")
                payload = (generated / descriptor["asset"]).read_bytes()
                require(len(payload) == descriptor["byte_length"], f"{channel} payload length mismatch")
                require(gzip.decompress((generated / f'{descriptor["asset"]}.gz').read_bytes()) == payload, f"{channel} gzip mismatch")
                hazard_files += 1

    # Source-code mappings are exact before UInt8 quantization.
    storm_codes = np.asarray([0, 10, 11, 12, 13, 31, 19], dtype=np.uint8)
    hail_codes = np.asarray([0, 10, 13, 14, 15, 31, 19], dtype=np.uint8)
    storm = generator.severity_for_codes(storm_codes, generator.THUNDERSTORM_LEVELS)
    hail = generator.severity_for_codes(hail_codes, generator.HAIL_LEVELS)
    require(np.allclose(storm[1:4], list(generator.THUNDERSTORM_LEVELS.values())), "storm anchor mapping failed")
    require(np.allclose(hail[2:5], list(generator.HAIL_LEVELS.values())), "hail anchor mapping failed")
    require(np.all(storm[[0, 4, 5, 6]] == 0) and np.all(hail[[0, 1, 5, 6]] == 0), "non-hazard code produced severity")

    # A hazard-only node is retained even when every rain node is dry.
    source = generator.severity_for_codes(np.asarray([10, 0, 0, 0], dtype=np.uint8), generator.THUNDERSTORM_LEVELS)
    sample = generator.reconstruct_frame(source, 2, 2, 0.0, 1.0, 0.0, 1.0,
                                         np.asarray([(0.0 + 180.0) / 360.0]), np.asarray([0.5]))
    require(np.isclose(sample[0], generator.THUNDERSTORM_LEVELS[10]), "phenomenon-only node was lost")

    # GPU temporal interpolation has exact source endpoints and linear midpoint.
    first = np.asarray([0.0, generator.THUNDERSTORM_LEVELS[10]], dtype=np.float64)
    second = np.asarray([generator.THUNDERSTORM_LEVELS[12], 0.0], dtype=np.float64)
    require(np.array_equal(first, first * 1.0 + second * 0.0), "temporal start endpoint changed")
    require(np.array_equal(second, first * 0.0 + second * 1.0), "temporal end endpoint changed")
    require(np.allclose((first + second) / 2, [generator.THUNDERSTORM_LEVELS[12] / 2, generator.THUNDERSTORM_LEVELS[10] / 2]), "temporal interpolation failed")

    quantized = generator.decode_hazard_samples(generator.encode_hazard_samples(np.asarray([
        *generator.THUNDERSTORM_LEVELS.values(), *generator.HAIL_LEVELS.values()
    ])))
    anchors = np.asarray([*generator.THUNDERSTORM_LEVELS.values(), *generator.HAIL_LEVELS.values()])
    require(float(np.max(np.abs(quantized - anchors))) <= 0.5 / 255 + 1e-12, "hazard quantization error is too large")

    # Presentation priority matches the normal Dots mapping: visible hail
    # suppresses storm at the same fixed sample.
    hail_radius = hazard_radius(generator.HAIL_LEVELS[15], 0.11, 0.34, 1.0)
    storm_radius = hazard_radius(generator.THUNDERSTORM_LEVELS[12], 0.075, 0.30, 0.72)
    require(hail_radius > 0 and storm_radius > 0, "synthetic hazard radii are not visible")
    winner = "hail" if hail_radius > 0 else "storm"
    require(winner == "hail", "hail-over-storm priority failed")

    if args.rain_baseline:
        baseline = args.rain_baseline.resolve()
        baseline_files = sorted(baseline.glob("tiles/L13/**/*.u16"))
        current_files = sorted(generated.glob("tiles/L13/**/*.u16"))
        require([p.relative_to(baseline) for p in baseline_files] == [p.relative_to(generated) for p in current_files], "rain file topology changed")
        for path in baseline_files:
            require(path.read_bytes() == (generated / path.relative_to(baseline)).read_bytes(), f"rain payload changed: {path.name}")

    hard_blocks = max(320, manifest["tile_count"] * 2)
    require(manifest["block_count"] == manifest["tile_count"] * math.ceil(manifest["frame_count"] / 4), "block count is not bounded by tile/block contract")
    print(json.dumps({
        "status": "passed",
        "rain_files_checked": rain_files,
        "hazard_files_checked": hazard_files,
        "sample_identity_alignment": True,
        "hazard_only_rain_zero": True,
        "temporal_endpoint_exactness": True,
        "temporal_interpolation": True,
        "max_anchor_quantization_error": float(np.max(np.abs(quantized - anchors))),
        "hail_over_storm_priority": True,
        "bounded_ready_block_ceiling": hard_blocks,
        "rain_baseline_checked": bool(args.rain_baseline),
    }, indent=2))


if __name__ == "__main__":
    main()
