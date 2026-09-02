#!/usr/bin/env python3
"""Verify the Phase 0B2 halo rain asset contract."""

from __future__ import annotations

import argparse
import gzip
import hashlib
import json
from pathlib import Path
from typing import Any

import numpy as np


SCHEMA = "dot-field-tiled-rain-warp-v1"
LOD_LEVEL = 13
GRID_SIZE = 2**LOD_LEVEL
TILE_SIZE = 128
HALO_SIZE = 13
STORED_SIZE = TILE_SIZE + 2 * HALO_SIZE
TEMPORAL_BLOCK_SIZE = 4


def sha256_bytes(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def load_json(path: Path) -> dict[str, Any]:
    value = json.loads(path.read_text(encoding="utf-8"))
    if not isinstance(value, dict):
        raise AssertionError(f"JSON root is not an object: {path}")
    return value


def source_block_map(manifest_path: Path, manifest: dict[str, Any]) -> dict[tuple[int, int, int], tuple[dict[str, Any], np.ndarray]]:
    result = {}
    for tile in manifest["tiles"]:
        x, y = int(tile["x"]), int(tile["y"])
        for block in tile["blocks"]:
            index = int(block["index"])
            path = (manifest_path.parent / block["asset"]).resolve()
            values = np.fromfile(path, dtype="<u2")
            expected = int(block["frame_count"]) * TILE_SIZE * TILE_SIZE
            if values.size != expected or values.nbytes != int(block["byte_length"]):
                raise AssertionError(f"invalid Phase 0A source block {(x, y, index)}")
            result[(x, y, index)] = (block, values.reshape(int(block["frame_count"]), TILE_SIZE, TILE_SIZE))
    return result


def verify_generated_assets(
    generated: Path,
    expected_generation_id: str | None = None,
    expected_source_filename: str | None = None,
) -> dict[str, Any]:
    manifest_path = generated / "manifest.json"
    manifest = load_json(manifest_path)
    if manifest.get("schema") != SCHEMA or manifest.get("version") != 1:
        raise AssertionError("warp manifest schema/version is invalid")
    if manifest.get("lod_level") != LOD_LEVEL or manifest.get("grid_size") != GRID_SIZE:
        raise AssertionError("warp manifest is not L13")
    if manifest.get("core_tile_size") != TILE_SIZE or manifest.get("halo_size") != HALO_SIZE:
        raise AssertionError("warp core/halo dimensions are invalid")
    if manifest.get("stored_footprint") != {"width": STORED_SIZE, "height": STORED_SIZE}:
        raise AssertionError("warp stored footprint is invalid")
    if manifest.get("temporal_block_size") != TEMPORAL_BLOCK_SIZE:
        raise AssertionError("warp temporal block size is invalid")
    if manifest.get("encoding", {}).get("dtype") != "UInt16":
        raise AssertionError("warp encoding is not UInt16")
    if manifest.get("encoding", {}).get("nodata_code") != 0 or manifest.get("encoding", {}).get("dry_code") != 1:
        raise AssertionError("warp NoData/dry encoding semantics changed")

    source_manifest_path = (manifest_path.parent / manifest["source_tiled_rain_manifest"]).resolve()
    source_manifest = load_json(source_manifest_path)
    source_sha256 = sha256_bytes(source_manifest_path)
    if source_sha256 != manifest.get("source_tiled_rain_manifest_sha256"):
        raise AssertionError("warp is not bound to the exact Phase 0A manifest")
    motion_manifest_path = (manifest_path.parent / manifest["source_motion_manifest"]).resolve()
    motion_manifest = load_json(motion_manifest_path)
    motion_sha256 = sha256_bytes(motion_manifest_path)
    if motion_sha256 != manifest.get("source_motion_manifest_sha256"):
        raise AssertionError("warp is not bound to the exact MotionField manifest")
    if motion_manifest.get("source_generation_id") != manifest.get("source_generation_id"):
        raise AssertionError("warp and MotionField generation IDs differ")
    if motion_manifest.get("source_tiled_rain_manifest_sha256") != source_sha256:
        raise AssertionError("MotionField is not bound to the warp's Phase 0A manifest")
    metadata_path = (source_manifest_path.parent / source_manifest["source_metadata_asset"]).resolve()
    metadata = load_json(metadata_path)
    generation_id = metadata.get("generation_id")
    if source_manifest.get("source_generation_id") != generation_id or manifest.get("source_generation_id") != generation_id:
        raise AssertionError("warp, Phase 0A, and normalized generation IDs differ")
    if expected_generation_id is not None and generation_id != expected_generation_id:
        raise AssertionError(f"expected generation mismatch: expected {expected_generation_id}, got {generation_id}")
    source_filename = (metadata.get("source") or {}).get("filename")
    if expected_source_filename is not None and source_filename != expected_source_filename:
        raise AssertionError(f"expected source mismatch: expected {expected_source_filename}, got {source_filename}")

    source_blocks = source_block_map(source_manifest_path, source_manifest)
    tile_values: dict[tuple[int, int], dict[int, np.ndarray]] = {}
    raw_total = 0
    gzip_total = 0
    core_checks = 0
    for tile in manifest["tiles"]:
        x, y = int(tile["x"]), int(tile["y"])
        values_by_block: dict[int, np.ndarray] = {}
        for descriptor in tile["blocks"]:
            index = int(descriptor["index"])
            source_descriptor, source_values = source_blocks[(x, y, index)]
            if descriptor["frame_start"] != source_descriptor["frame_start"] or descriptor["frame_count"] != source_descriptor["frame_count"]:
                raise AssertionError(f"warp block {(x, y, index)} changes frame ordering")
            if descriptor.get("sample_count") != STORED_SIZE * STORED_SIZE:
                raise AssertionError(f"warp block {(x, y, index)} has the wrong stored sample count")
            path = (manifest_path.parent / descriptor["asset"]).resolve()
            payload = path.read_bytes()
            expected_bytes = int(descriptor["frame_count"]) * STORED_SIZE * STORED_SIZE * 2
            if len(payload) != expected_bytes or len(payload) != int(descriptor["byte_length"]):
                raise AssertionError(f"warp block {(x, y, index)} has the wrong byte length")
            values = np.frombuffer(payload, dtype="<u2").reshape(int(descriptor["frame_count"]), STORED_SIZE, STORED_SIZE)
            if not np.array_equal(values[:, HALO_SIZE:HALO_SIZE + TILE_SIZE, HALO_SIZE:HALO_SIZE + TILE_SIZE], source_values):
                raise AssertionError(f"warp core differs from Phase 0A block {(x, y, index)}")
            gzip_path = (manifest_path.parent / descriptor["gzip_asset"]).resolve()
            gzip_payload = gzip_path.read_bytes()
            if len(gzip_payload) != int(descriptor["gzip_byte_length"]):
                raise AssertionError(f"warp gzip length mismatch at {(x, y, index)}")
            if gzip.decompress(gzip_payload) != payload:
                raise AssertionError(f"warp gzip payload differs at {(x, y, index)}")
            values_by_block[index] = values
            raw_total += len(payload)
            gzip_total += len(gzip_payload)
            core_checks += 1
        tile_values[(x, y)] = values_by_block

    coordinates = set(tile_values)
    bounds = manifest["tile_index_bounds"]
    min_x, max_x = int(bounds["min_x"]), int(bounds["max_x"])
    min_y, max_y = int(bounds["min_y"]), int(bounds["max_y"])
    if coordinates != {(x, y) for y in range(min_y, max_y + 1) for x in range(min_x, max_x + 1)}:
        raise AssertionError("warp tile coordinates do not cover the Phase 0A bounds exactly")
    horizontal_checks = vertical_checks = corner_checks = outer_nodata_checks = 0
    for (x, y), blocks in tile_values.items():
        for index, values in blocks.items():
            if x == min_x and np.any(values[:, :, :HALO_SIZE] != 0):
                raise AssertionError(f"left outer halo is not NoData at {(x, y, index)}")
            if x == max_x and np.any(values[:, :, -HALO_SIZE:] != 0):
                raise AssertionError(f"right outer halo is not NoData at {(x, y, index)}")
            if y == min_y and np.any(values[:, :HALO_SIZE, :] != 0):
                raise AssertionError(f"top outer halo is not NoData at {(x, y, index)}")
            if y == max_y and np.any(values[:, -HALO_SIZE:, :] != 0):
                raise AssertionError(f"bottom outer halo is not NoData at {(x, y, index)}")
            outer_nodata_checks += 1
            right = tile_values.get((x + 1, y), {}).get(index)
            if right is not None:
                if not np.array_equal(values[:, :, TILE_SIZE:TILE_SIZE + 2 * HALO_SIZE], right[:, :, :2 * HALO_SIZE]):
                    raise AssertionError(f"horizontal halo overlap differs at {(x, y, index)}")
                horizontal_checks += 1
            below = tile_values.get((x, y + 1), {}).get(index)
            if below is not None:
                if not np.array_equal(values[:, TILE_SIZE:TILE_SIZE + 2 * HALO_SIZE, :], below[:, :2 * HALO_SIZE, :]):
                    raise AssertionError(f"vertical halo overlap differs at {(x, y, index)}")
                vertical_checks += 1
            diagonal = tile_values.get((x + 1, y + 1), {}).get(index)
            if diagonal is not None:
                right_corner = tile_values[(x + 1, y)][index][:, TILE_SIZE:TILE_SIZE + 2 * HALO_SIZE, :2 * HALO_SIZE]
                below_corner = tile_values[(x, y + 1)][index][:, :2 * HALO_SIZE, TILE_SIZE:TILE_SIZE + 2 * HALO_SIZE]
                diagonal_corner = diagonal[:, :2 * HALO_SIZE, :2 * HALO_SIZE]
                source_corner = values[:, TILE_SIZE:TILE_SIZE + 2 * HALO_SIZE, TILE_SIZE:TILE_SIZE + 2 * HALO_SIZE]
                if not (np.array_equal(source_corner, right_corner)
                        and np.array_equal(source_corner, below_corner)
                        and np.array_equal(source_corner, diagonal_corner)):
                    raise AssertionError(f"corner halo overlap differs at {(x, y, index)}")
                corner_checks += 1
    expected_totals = {"raw_u16_bytes": raw_total, "gzip_bytes": gzip_total}
    if manifest.get("payload_totals") != expected_totals:
        raise AssertionError("warp payload totals are inconsistent")
    return {
        "status": "passed",
        "generation_id": generation_id,
        "source_filename": source_filename,
        "tile_count": len(tile_values),
        "block_count": core_checks,
        "core_checks": core_checks,
        "horizontal_overlap_checks": horizontal_checks,
        "vertical_overlap_checks": vertical_checks,
        "corner_overlap_checks": corner_checks,
        "outer_nodata_checks": outer_nodata_checks,
        "raw_u16_bytes": raw_total,
        "gzip_bytes": gzip_total,
        "source_tiled_rain_manifest_sha256": source_sha256,
        "source_motion_manifest_sha256": motion_sha256,
    }


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--generated",
        type=Path,
        default=Path(__file__).resolve().parents[1] / "data" / "generated" / "tiled-rain-warp" / "current",
    )
    parser.add_argument("--expected-generation-id", default=None)
    parser.add_argument("--expected-source-filename", default=None)
    args = parser.parse_args()
    print(json.dumps(verify_generated_assets(
        args.generated.resolve(), args.expected_generation_id, args.expected_source_filename
    ), indent=2))


if __name__ == "__main__":
    main()
