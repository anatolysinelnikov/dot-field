#!/usr/bin/env python3
"""Generate seam-safe halo rain assets for the Phase 0B2 browser experiment.

The stored samples are copied from the encoded Phase 0A UInt16 blocks.  This
tool never reconstructs, decodes, or requantizes rain; it only stitches the
globally owned core samples into a 13-sample read-only halo.
"""

from __future__ import annotations

import argparse
import gzip
import hashlib
import json
from pathlib import Path
from typing import Any

import numpy as np


SCHEMA = "dot-field-tiled-rain-warp-v1"
VERSION = 1
LOD_LEVEL = 13
GRID_SIZE = 2**LOD_LEVEL
TILE_SIZE = 128
HALO_SIZE = 13
STORED_SIZE = TILE_SIZE + 2 * HALO_SIZE
TEMPORAL_BLOCK_SIZE = 4


def parse_arguments() -> argparse.Namespace:
    repository_root = Path(__file__).resolve().parents[1]
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--source-manifest",
        type=Path,
        default=repository_root / "data" / "generated" / "tiled-rain" / "current" / "manifest.json",
    )
    parser.add_argument(
        "--motion-manifest",
        type=Path,
        default=repository_root / "data" / "generated" / "tiled-rain-motion" / "current" / "manifest.json",
    )
    parser.add_argument(
        "--output",
        type=Path,
        default=repository_root / "data" / "generated" / "tiled-rain-warp" / "current",
    )
    parser.add_argument("--expected-generation-id", default=None)
    parser.add_argument("--expected-source-filename", default=None)
    return parser.parse_args()


def sha256_bytes(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def fail(message: str) -> None:
    raise SystemExit(message)


def load_json(path: Path) -> dict[str, Any]:
    try:
        value = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as error:
        fail(f"unable to read JSON {path}: {error}")
    if not isinstance(value, dict):
        fail(f"JSON root is not an object: {path}")
    return value


def validate_source_contract(
    source_manifest_path: Path,
    source_manifest: dict[str, Any],
    motion_manifest: dict[str, Any],
    expected_generation_id: str | None,
    expected_source_filename: str | None,
) -> tuple[dict[str, Any], str]:
    if source_manifest.get("schema") != "dot-field-tiled-rain-v0":
        fail("Phase 0A manifest schema is not supported")
    if source_manifest.get("version") != 0:
        fail("Phase 0A manifest version is not supported")
    if source_manifest.get("lod_level") != LOD_LEVEL or source_manifest.get("grid_size") != GRID_SIZE:
        fail("Phase 0A manifest is not an L13 asset")
    if source_manifest.get("tile_size") != TILE_SIZE:
        fail("Phase 0A tile size is not 128")
    if source_manifest.get("temporal_block_size") != TEMPORAL_BLOCK_SIZE:
        fail("Phase 0A temporal block size is not 4")
    source_metadata_path = (source_manifest_path.parent / source_manifest["source_metadata_asset"]).resolve()
    source_metadata = load_json(source_metadata_path)
    generation_id = source_metadata.get("generation_id")
    if not isinstance(generation_id, str) or not generation_id:
        fail("normalized metadata must contain generation_id")
    if source_manifest.get("source_generation_id") != generation_id:
        fail("Phase 0A manifest does not match normalized source generation")
    if expected_generation_id is not None and generation_id != expected_generation_id:
        fail(f"expected generation mismatch: expected {expected_generation_id}, got {generation_id}")
    source_filename = (source_metadata.get("source") or {}).get("filename")
    if expected_source_filename is not None and source_filename != expected_source_filename:
        fail(f"expected source mismatch: expected {expected_source_filename}, got {source_filename}")
    if motion_manifest.get("schema") != "dot-field-tiled-rain-motion-v1":
        fail("Phase 0B1 motion manifest schema is not supported")
    if motion_manifest.get("source_generation_id") != generation_id:
        fail("MotionField does not match normalized source generation")
    source_sha256 = sha256_bytes(source_manifest_path)
    if motion_manifest.get("source_tiled_rain_manifest_sha256") != source_sha256:
        fail("MotionField is not bound to the exact Phase 0A manifest")
    if motion_manifest.get("rain_tile_size") != TILE_SIZE:
        fail("MotionField rain tile size is not 128")
    motion_bound = motion_manifest.get("displacement", {}).get("maximum_absolute_component")
    if motion_bound != 12:
        fail("MotionField displacement bound is not the required 12 samples")
    if source_manifest.get("frame_count") != motion_manifest.get("interval_count", 0) + 1:
        fail("Phase 0A and MotionField frame counts are inconsistent")
    if (source_manifest.get("timestamps", [])[:-1] != [pair["from"] for pair in motion_manifest.get("intervals", [])]
            or source_manifest.get("timestamps", [])[1:] != [pair["to"] for pair in motion_manifest.get("intervals", [])]):
        fail("Phase 0A and MotionField interval timestamps are inconsistent")
    return source_metadata, source_sha256


def source_descriptors(manifest: dict[str, Any]) -> dict[tuple[int, int, int], dict[str, Any]]:
    result: dict[tuple[int, int, int], dict[str, Any]] = {}
    for tile in manifest["tiles"]:
        x, y = int(tile["x"]), int(tile["y"])
        for block in tile["blocks"]:
            key = (x, y, int(block["index"]))
            if key in result:
                fail(f"duplicate Phase 0A block {key}")
            result[key] = block
    return result


def load_source_blocks(
    source_manifest_path: Path,
    manifest: dict[str, Any],
) -> dict[tuple[int, int, int], np.ndarray]:
    descriptors = source_descriptors(manifest)
    blocks: dict[tuple[int, int, int], np.ndarray] = {}
    for key, descriptor in sorted(descriptors.items()):
        path = (source_manifest_path.parent / descriptor["asset"]).resolve()
        try:
            values = np.fromfile(path, dtype="<u2")
        except OSError as error:
            fail(f"unable to read Phase 0A block {path}: {error}")
        expected = int(descriptor["frame_count"]) * TILE_SIZE * TILE_SIZE
        if values.size != expected or descriptor.get("byte_length") != values.nbytes:
            fail(f"Phase 0A block {key} has an invalid byte length")
        blocks[key] = values.reshape(int(descriptor["frame_count"]), TILE_SIZE, TILE_SIZE)
    return blocks


def build_halo_block(
    source_blocks: dict[tuple[int, int, int], np.ndarray],
    source_manifest: dict[str, Any],
    tile_x: int,
    tile_y: int,
    block_index: int,
) -> np.ndarray:
    source_descriptor = next(
        (
            tile_block
            for tile in source_manifest["tiles"]
            if int(tile["x"]) == tile_x and int(tile["y"]) == tile_y
            for tile_block in tile["blocks"]
            if int(tile_block["index"]) == block_index
        ),
        None,
    )
    if source_descriptor is None:
        fail(f"missing Phase 0A block {(tile_x, tile_y, block_index)}")
    frame_count = int(source_descriptor["frame_count"])
    result = np.zeros((frame_count, STORED_SIZE, STORED_SIZE), dtype="<u2")
    bounds = source_manifest["tile_index_bounds"]
    min_x, max_x = int(bounds["min_x"]), int(bounds["max_x"])
    min_y, max_y = int(bounds["min_y"]), int(bounds["max_y"])
    for stored_y in range(STORED_SIZE):
        global_y = tile_y * TILE_SIZE + stored_y - HALO_SIZE
        owner_y, local_y = divmod(global_y, TILE_SIZE)
        if owner_y < min_y or owner_y > max_y:
            continue
        for stored_x in range(STORED_SIZE):
            global_x = tile_x * TILE_SIZE + stored_x - HALO_SIZE
            owner_x, local_x = divmod(global_x, TILE_SIZE)
            if owner_x < min_x or owner_x > max_x:
                continue
            source = source_blocks.get((owner_x, owner_y, block_index))
            if source is None:
                fail(f"missing Phase 0A block {(owner_x, owner_y, block_index)} while building {(tile_x, tile_y, block_index)}")
            if source.shape[0] != frame_count:
                fail(f"Phase 0A block frame count mismatch at {(owner_x, owner_y, block_index)}")
            result[:, stored_y, stored_x] = source[:, local_y, local_x]
    return result


def main() -> None:
    args = parse_arguments()
    source_manifest_path = args.source_manifest.resolve()
    motion_manifest_path = args.motion_manifest.resolve()
    output = args.output.resolve()
    if output == source_manifest_path.parent or (output.name == "current" and output.parent.name == "generated"):
        fail("Refusing to write the normal generated weather directory")
    source_manifest = load_json(source_manifest_path)
    motion_manifest = load_json(motion_manifest_path)
    source_metadata, source_sha256 = validate_source_contract(
        source_manifest_path,
        source_manifest,
        motion_manifest,
        args.expected_generation_id,
        args.expected_source_filename,
    )
    source_blocks = load_source_blocks(source_manifest_path, source_manifest)
    if output.exists() and not output.is_dir():
        fail(f"output path is not a directory: {output}")
    output.mkdir(parents=True, exist_ok=True)
    tile_root = output / "tiles" / f"L{LOD_LEVEL}"
    tile_root.mkdir(parents=True, exist_ok=True)

    descriptors = []
    raw_total = 0
    gzip_total = 0
    for tile in sorted(source_manifest["tiles"], key=lambda item: (int(item["y"]), int(item["x"]))):
        tile_x, tile_y = int(tile["x"]), int(tile["y"])
        tile_directory = tile_root / str(tile_x) / str(tile_y)
        tile_directory.mkdir(parents=True, exist_ok=True)
        blocks = []
        for source_block in sorted(tile["blocks"], key=lambda item: int(item["index"])):
            block_index = int(source_block["index"])
            halo = build_halo_block(source_blocks, source_manifest, tile_x, tile_y, block_index)
            payload = halo.astype("<u2", copy=False).tobytes()
            asset_path = tile_directory / f"block-{block_index:03d}.u16"
            asset_path.write_bytes(payload)
            gzip_path = Path(f"{asset_path}.gz")
            gzip_path.write_bytes(gzip.compress(payload, compresslevel=9, mtime=0))
            relative_asset = str(asset_path.relative_to(output)).replace("\\", "/")
            blocks.append({
                "index": block_index,
                "frame_start": int(source_block["frame_start"]),
                "frame_count": int(source_block["frame_count"]),
                "asset": relative_asset,
                "gzip_asset": f"{relative_asset}.gz",
                "sample_count": STORED_SIZE * STORED_SIZE,
                "core_sample_count": TILE_SIZE * TILE_SIZE,
                "byte_length": len(payload),
                "gzip_byte_length": gzip_path.stat().st_size,
                "layout": "frame-major; each frame is row-major y then x; core is stored[y=13..140,x=13..140]",
            })
            raw_total += len(payload)
            gzip_total += gzip_path.stat().st_size
        descriptors.append({"x": tile_x, "y": tile_y, "blocks": blocks})

    manifest = {
        "schema": SCHEMA,
        "version": VERSION,
        "source_generation_id": source_manifest["source_generation_id"],
        "source_tiled_rain_manifest": "../../tiled-rain/current/manifest.json",
        "source_tiled_rain_manifest_sha256": source_sha256,
        "source_motion_manifest": "../../tiled-rain-motion/current/manifest.json",
        "source_motion_manifest_sha256": sha256_bytes(motion_manifest_path),
        "lod_level": LOD_LEVEL,
        "grid_size": GRID_SIZE,
        "sample_coordinates": "x=i/2^13; y=j/2^13; global integer identity",
        "tile_ownership": "half-open global sample ranges [tile*128, (tile+1)*128); halo is read-only sampling support",
        "tile_index_bounds": source_manifest["tile_index_bounds"],
        "weather_support": source_manifest.get("weather_support"),
        "core_tile_size": TILE_SIZE,
        "halo_size": HALO_SIZE,
        "stored_footprint": {"width": STORED_SIZE, "height": STORED_SIZE},
        "frame_count": source_manifest["frame_count"],
        "timestamps": source_manifest["timestamps"],
        "temporal_block_size": source_manifest["temporal_block_size"],
        "physical_units": source_manifest["physical_units"],
        "byte_order": source_manifest["byte_order"],
        "encoding": {
            **source_manifest["encoding"],
            "transport": "unchanged Phase 0A UInt16 encoded samples; no reconstruction or requantization",
        },
        "motion_displacement_bound_l13_samples": motion_manifest["displacement"]["maximum_absolute_component"],
        "tiles": descriptors,
        "tile_count": len(descriptors),
        "block_count": sum(len(tile["blocks"]) for tile in descriptors),
        "payload_totals": {"raw_u16_bytes": raw_total, "gzip_bytes": gzip_total},
    }
    (output / "manifest.json").write_text(json.dumps(manifest, indent=2) + "\n", encoding="utf-8")
    (output / "diagnostics.json").write_text(json.dumps({
        "source_generation_id": source_metadata["generation_id"],
        "source_tiled_rain_manifest_sha256": source_sha256,
        "source_motion_manifest_sha256": manifest["source_motion_manifest_sha256"],
        "core_tile_size": TILE_SIZE,
        "halo_size": HALO_SIZE,
        "stored_footprint": [STORED_SIZE, STORED_SIZE],
        "raw_u16_bytes": raw_total,
        "gzip_bytes": gzip_total,
    }, indent=2) + "\n", encoding="utf-8")
    print(json.dumps({
        "output": str(output),
        "source_generation_id": source_manifest["source_generation_id"],
        "source_tiled_rain_manifest_sha256": source_sha256,
        "source_motion_manifest_sha256": manifest["source_motion_manifest_sha256"],
        "tile_count": len(descriptors),
        "block_count": manifest["block_count"],
        "core_tile_size": TILE_SIZE,
        "halo_size": HALO_SIZE,
        "stored_footprint": [STORED_SIZE, STORED_SIZE],
        "raw_u16_bytes": raw_total,
        "gzip_bytes": gzip_total,
    }, indent=2))


if __name__ == "__main__":
    main()
