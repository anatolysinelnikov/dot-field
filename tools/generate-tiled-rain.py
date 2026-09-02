#!/usr/bin/env python3
"""Generate the experimental Phase 0A tiled-rain v0 asset set.

The input is the already-normalized generated weather sequence.  This tool
does not parse provider files and deliberately keeps the tiled format narrow:
one fixed L13 grid, 128x128 sample tiles, and four-frame UInt16 blocks.
"""

from __future__ import annotations

import argparse
import gzip
import json
import math
from pathlib import Path
from typing import Any

try:
    import numpy as np
except ImportError as error:  # pragma: no cover - depends on the local machine
    raise SystemExit(
        "This tiled-rain generator requires NumPy. Install it outside the "
        "repository and retry."
    ) from error


SCHEMA = "dot-field-tiled-rain-v0"
LOD_LEVEL = 13
GRID_SIZE = 2**LOD_LEVEL
TILE_SIZE = 128
TEMPORAL_BLOCK_SIZE = 4
UINT16_MAX = 65535
POSITIVE_CODE_MIN = 2
POSITIVE_CODE_MAX = UINT16_MAX
POSITIVE_QUANTIZED_RANGE = POSITIVE_CODE_MAX - 1


def parse_arguments() -> argparse.Namespace:
    repository_root = Path(__file__).resolve().parents[1]
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--source-metadata",
        type=Path,
        default=repository_root / "data" / "generated" / "current" / "metadata.json",
        help="normalized source metadata (default: data/generated/current/metadata.json)",
    )
    parser.add_argument(
        "--output",
        type=Path,
        default=repository_root / "data" / "generated" / "tiled-rain" / "current",
        help="experimental output directory",
    )
    return parser.parse_args()


def finite_number(value: Any, name: str) -> float:
    result = float(value)
    if not math.isfinite(result):
        raise ValueError(f"{name} must be finite")
    return result


def inverse_mercator_latitude(y: np.ndarray) -> np.ndarray:
    return np.degrees(np.arctan(np.sinh(np.pi * (1.0 - 2.0 * y))))


def source_position(axis_start: float, spacing: float, length: int, values: np.ndarray) -> tuple[np.ndarray, np.ndarray, np.ndarray]:
    position = (values - axis_start) / spacing
    inside = (position >= 0.0) & (position <= length - 1)
    lower = np.floor(np.clip(position, 0.0, max(0, length - 2))).astype(np.int64)
    fraction = position - lower
    fraction = np.clip(fraction, 0.0, 1.0)
    return lower, fraction, inside


def reconstruct_frame(
    source: np.ndarray,
    source_width: int,
    source_height: int,
    longitude_start: float,
    longitude_spacing: float,
    latitude_start: float,
    latitude_spacing: float,
    sample_x: np.ndarray,
    sample_y: np.ndarray,
) -> np.ndarray:
    longitudes = sample_x * 360.0 - 180.0
    latitudes = inverse_mercator_latitude(sample_y)
    source_x, fraction_x, inside_x = source_position(
        longitude_start, longitude_spacing, source_width, longitudes
    )
    source_y, fraction_y, inside_y = source_position(
        latitude_start, latitude_spacing, source_height, latitudes
    )
    x1 = np.minimum(source_x + 1, source_width - 1)
    y1 = np.minimum(source_y + 1, source_height - 1)
    row0 = source_y * source_width
    row1 = y1 * source_width
    v00 = source[row0 + source_x]
    v10 = source[row0 + x1]
    v01 = source[row1 + source_x]
    v11 = source[row1 + x1]
    valid = inside_x & inside_y & np.isfinite(v00) & np.isfinite(v10) & np.isfinite(v01) & np.isfinite(v11)
    lower = v00 + (v10 - v00) * fraction_x
    upper = v01 + (v11 - v01) * fraction_x
    result = lower + (upper - lower) * fraction_y
    result = np.maximum(result, 0.0).astype(np.float32, copy=False)
    result[~valid] = np.nan
    return result


def encode_samples(values: np.ndarray, maximum: float) -> np.ndarray:
    encoded = np.zeros(values.size, dtype="<u2")
    valid = np.isfinite(values)
    wet = valid & (values > 0.0)
    encoded[valid & ~wet] = 1
    encoded[wet] = np.rint(
        1 + values[wet] / maximum * POSITIVE_QUANTIZED_RANGE
    ).astype(np.uint16)
    encoded[wet] = np.clip(encoded[wet], POSITIVE_CODE_MIN, POSITIVE_CODE_MAX)
    return encoded


def decode_samples(encoded: np.ndarray, maximum: float) -> np.ndarray:
    decoded = np.full(encoded.size, np.nan, dtype=np.float64)
    dry = encoded == 1
    wet = encoded >= POSITIVE_CODE_MIN
    decoded[dry] = 0.0
    decoded[wet] = (encoded[wet].astype(np.float64) - 1.0) / POSITIVE_QUANTIZED_RANGE * maximum
    return decoded


def percentile(values: np.ndarray, quantile: float) -> float:
    return float(np.percentile(values, quantile)) if values.size else 0.0


def main() -> None:
    args = parse_arguments()
    source_metadata_path = args.source_metadata.resolve()
    output = args.output.resolve()
    if output == source_metadata_path.parent or output.name == "current" and output.parent.name == "generated":
        raise SystemExit("Refusing to write the normal generated weather directory.")

    metadata = json.loads(source_metadata_path.read_text(encoding="utf-8"))
    source_generation_id = metadata.get("generation_id")
    if not isinstance(source_generation_id, str) or not source_generation_id:
        raise SystemExit("source metadata must contain generation_id")
    grid = metadata["spatial_grid"]
    rain = metadata["rain"]
    time = metadata["time"]
    source_width = int(grid["width"])
    source_height = int(grid["height"])
    frame_count = int(time["count"])
    node_count = source_width * source_height
    frame_byte_length = int(rain["frame_byte_length"])
    if frame_byte_length != node_count * 4:
        raise SystemExit("source rain frame byte length does not match metadata dimensions")
    timestamps = list(time["timestamps"])
    if len(timestamps) != frame_count:
        raise SystemExit("source timestamp count does not match frame count")

    source_frames: list[np.ndarray] = []
    for frame_index, asset in enumerate(rain["frame_assets"]):
        frame_path = (source_metadata_path.parent / asset).resolve()
        values = np.fromfile(frame_path, dtype="<f4")
        if values.size != node_count:
            raise SystemExit(f"source frame {frame_index} has {values.size} values, expected {node_count}")
        if np.any(~np.isfinite(values)) or np.any(values < 0):
            raise SystemExit(f"source frame {frame_index} contains invalid physical rain values")
        source_frames.append(values)

    support = grid["weather_support"]
    west_x = (finite_number(support["west"], "weather_support.west") + 180.0) / 360.0
    east_x = (finite_number(support["east"], "weather_support.east") + 180.0) / 360.0
    south_y = (1.0 - math.log(math.tan(math.pi / 4 + math.radians(finite_number(support["south"], "weather_support.south")) / 2)) / math.pi) / 2
    north_y = (1.0 - math.log(math.tan(math.pi / 4 + math.radians(finite_number(support["north"], "weather_support.north")) / 2)) / math.pi) / 2
    min_sample_x = max(0, math.floor(west_x * GRID_SIZE))
    max_sample_x = min(GRID_SIZE - 1, math.ceil(east_x * GRID_SIZE))
    min_sample_y = max(0, math.floor(north_y * GRID_SIZE))
    max_sample_y = min(GRID_SIZE - 1, math.ceil(south_y * GRID_SIZE))
    min_tile_x = min_sample_x // TILE_SIZE
    max_tile_x = max_sample_x // TILE_SIZE
    min_tile_y = min_sample_y // TILE_SIZE
    max_tile_y = max_sample_y // TILE_SIZE

    tiles: dict[tuple[int, int], list[np.ndarray]] = {}
    finite_values: list[np.ndarray] = []
    for tile_y in range(min_tile_y, max_tile_y + 1):
        for tile_x in range(min_tile_x, max_tile_x + 1):
            sample_indices_x = tile_x * TILE_SIZE + np.arange(TILE_SIZE, dtype=np.float64)
            sample_indices_y = tile_y * TILE_SIZE + np.arange(TILE_SIZE, dtype=np.float64)
            sample_x, sample_y = np.meshgrid(
                sample_indices_x / GRID_SIZE,
                sample_indices_y / GRID_SIZE,
            )
            tile_frames = []
            for source in source_frames:
                values = reconstruct_frame(
                    source, source_width, source_height,
                    float(grid["longitude_start"]), float(grid["longitude_spacing"]),
                    float(grid["latitude_start"]), float(grid["latitude_spacing"]),
                    sample_x.reshape(-1), sample_y.reshape(-1),
                )
                tile_frames.append(values)
                finite_values.append(values[np.isfinite(values)])
            tiles[(tile_x, tile_y)] = tile_frames
    all_finite = np.concatenate(finite_values) if finite_values else np.empty(0, dtype=np.float32)
    if all_finite.size == 0:
        raise SystemExit("dataset support produced no valid L13 samples")
    physical_max = float(np.max(all_finite))
    if not math.isfinite(physical_max) or physical_max <= 0:
        raise SystemExit("dataset support produced no positive physical rain")

    if output.exists() and not output.is_dir():
        raise SystemExit(f"output path is not a directory: {output}")
    output.mkdir(parents=True, exist_ok=True)
    tile_root = output / "tiles" / f"L{LOD_LEVEL}"
    tile_root.mkdir(parents=True, exist_ok=True)

    blocks: list[dict[str, Any]] = []
    encoded_sample_count = 0
    nodata_sample_count = 0
    wet_sample_count = 0
    absolute_errors: list[np.ndarray] = []
    relative_errors: list[np.ndarray] = []
    raw_payload_bytes = 0
    gzip_payload_bytes = 0

    for (tile_x, tile_y), tile_frames in sorted(tiles.items()):
        tile_directory = tile_root / str(tile_x) / str(tile_y)
        tile_directory.mkdir(parents=True, exist_ok=True)
        for block_index, frame_start in enumerate(range(0, frame_count, TEMPORAL_BLOCK_SIZE)):
            block_frames = tile_frames[frame_start:frame_start + TEMPORAL_BLOCK_SIZE]
            encoded_frames = [encode_samples(frame, physical_max) for frame in block_frames]
            payload = np.concatenate(encoded_frames).astype("<u2", copy=False).tobytes()
            asset_path = tile_directory / f"block-{block_index:03d}.u16"
            asset_path.write_bytes(payload)
            encoded_path = Path(f"{asset_path}.gz")
            encoded_path.write_bytes(gzip.compress(payload, compresslevel=9, mtime=0))
            block_descriptor = {
                "index": block_index,
                "frame_start": frame_start,
                "frame_count": len(block_frames),
                "asset": str(asset_path.relative_to(output)).replace("\\", "/"),
                "sample_count": TILE_SIZE * TILE_SIZE,
                "byte_length": len(payload),
                "gzip_byte_length": encoded_path.stat().st_size,
                "layout": "frame-major; each frame is row-major y then x",
            }
            blocks.append({"tile_x": tile_x, "tile_y": tile_y, **block_descriptor})
            raw_payload_bytes += len(payload)
            gzip_payload_bytes += encoded_path.stat().st_size

            for reference, encoded in zip(block_frames, encoded_frames):
                decoded = decode_samples(encoded, physical_max)
                valid = np.isfinite(reference)
                encoded_sample_count += int(np.count_nonzero(valid))
                nodata_sample_count += int(np.count_nonzero(~valid))
                wet = valid & (reference > 0.0)
                wet_sample_count += int(np.count_nonzero(wet))
                valid_reference = reference[valid].astype(np.float64)
                error = np.abs(decoded[valid] - valid_reference)
                absolute_errors.append(error)
                meaningful = wet & (reference > 0.1)
                meaningful_valid = meaningful[valid]
                if np.any(meaningful_valid):
                    relative_errors.append(error[meaningful_valid] / valid_reference[meaningful_valid])
    abs_error = np.concatenate(absolute_errors) if absolute_errors else np.empty(0)
    rel_error = np.concatenate(relative_errors) if relative_errors else np.empty(0)
    report = {
        "encoded_sample_count": encoded_sample_count,
        "valid_sample_count": encoded_sample_count,
        "nodata_sample_count": nodata_sample_count,
        "wet_sample_count": wet_sample_count,
        "maximum_physical_rain_mmh": physical_max,
        "max_absolute_error_mmh": float(np.max(abs_error)) if abs_error.size else 0.0,
        "mean_absolute_error_mmh": float(np.mean(abs_error)) if abs_error.size else 0.0,
        "rms_absolute_error_mmh": float(math.sqrt(float(np.mean(abs_error * abs_error)))) if abs_error.size else 0.0,
        "p99_absolute_error_mmh": percentile(abs_error, 99),
        "relative_error_threshold_mmh": 0.1,
        "relative_error_sample_count": int(rel_error.size),
        "mean_relative_error": float(np.mean(rel_error)) if rel_error.size else 0.0,
        "rms_relative_error": float(math.sqrt(float(np.mean(rel_error * rel_error)))) if rel_error.size else 0.0,
        "p99_relative_error": percentile(rel_error, 99),
        "max_relative_error": float(np.max(rel_error)) if rel_error.size else 0.0,
    }

    manifest = {
        "schema": SCHEMA,
        "version": 0,
        "source_generation_id": source_generation_id,
        "source_metadata_asset": "../../current/metadata.json",
        "lod_level": LOD_LEVEL,
        "tile_size": TILE_SIZE,
        "grid_size": GRID_SIZE,
        "sample_coordinates": "x=i/2^13; y=j/2^13; global integer identity",
        "tile_ownership": "half-open global sample ranges [tile*128, (tile+1)*128)",
        "tile_index_bounds": {
            "min_x": min_tile_x, "max_x": max_tile_x,
            "min_y": min_tile_y, "max_y": max_tile_y,
        },
        "weather_support": support,
        "frame_count": frame_count,
        "timestamps": timestamps,
        "temporal_block_size": TEMPORAL_BLOCK_SIZE,
        "physical_units": "mm/h",
        "byte_order": "little-endian",
        "encoding": {
            "dtype": "UInt16",
            "nodata_code": 0,
            "dry_code": 1,
            "positive_code_min": POSITIVE_CODE_MIN,
            "positive_code_max": POSITIVE_CODE_MAX,
            "positive_quantized_range": POSITIVE_QUANTIZED_RANGE,
            "physical_max_mmh": physical_max,
            "decode_positive": "(code - 1) / 65534 * physical_max_mmh",
        },
        "tiles": [
            {
                "x": tile_x,
                "y": tile_y,
                "blocks": tile_blocks,
            }
            for (tile_x, tile_y), tile_blocks in (
                ((tile_x, tile_y), [block for block in blocks if block["tile_x"] == tile_x and block["tile_y"] == tile_y])
                for tile_x, tile_y in sorted(tiles)
            )
        ],
        "tile_count": len(tiles),
        "block_count": len(blocks),
        "payload_totals": {
            "raw_u16_bytes": raw_payload_bytes,
            "gzip_bytes": gzip_payload_bytes,
        },
        "fidelity_report": report,
    }
    (output / "manifest.json").write_text(json.dumps(manifest, indent=2) + "\n", encoding="utf-8")
    (output / "fidelity-report.json").write_text(json.dumps(report, indent=2) + "\n", encoding="utf-8")
    print(json.dumps({
        "output": str(output),
        "source_generation_id": source_generation_id,
        "tile_count": len(tiles),
        "block_count": len(blocks),
        "tile_size": TILE_SIZE,
        "temporal_block_size": TEMPORAL_BLOCK_SIZE,
        "raw_u16_bytes": raw_payload_bytes,
        "gzip_bytes": gzip_payload_bytes,
        "fidelity_report": report,
    }, indent=2))


if __name__ == "__main__":
    main()
