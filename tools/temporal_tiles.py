"""Shared deterministic helpers for generated temporal tile assets."""

from __future__ import annotations

import math
from dataclasses import dataclass
from pathlib import Path
from typing import Any

import numpy as np


TEMPORAL_TILE_CONTRACT = "dot-field-temporal-tiles-v1"
TILE_INTERIOR = 128
RAIN_HALO = 5
MOTION_SPACING = 16
MOTION_COMPONENTS = 4


@dataclass(frozen=True)
class Tile:
    tile_x: int
    tile_y: int
    interior_x: int
    interior_y: int
    interior_width: int
    interior_height: int
    stored_x: int
    stored_y: int
    stored_width: int
    stored_height: int
    motion_x: int
    motion_y: int
    motion_width: int
    motion_height: int


def tiles_for_grid(width: int, height: int, motion_width: int, motion_height: int,
                   rain_halo: int = RAIN_HALO) -> list[Tile]:
    tiles = []
    for interior_y in range(0, height, TILE_INTERIOR):
        for interior_x in range(0, width, TILE_INTERIOR):
            interior_width = min(TILE_INTERIOR, width - interior_x)
            interior_height = min(TILE_INTERIOR, height - interior_y)
            stored_x = max(0, interior_x - rain_halo)
            stored_y = max(0, interior_y - rain_halo)
            stored_end_x = min(width, interior_x + interior_width + rain_halo)
            stored_end_y = min(height, interior_y + interior_height + rain_halo)
            motion_x = max(0, math.floor(interior_x / MOTION_SPACING))
            motion_y = max(0, math.floor(interior_y / MOTION_SPACING))
            motion_end_x = min(motion_width - 1, math.ceil((interior_x + interior_width) / MOTION_SPACING))
            motion_end_y = min(motion_height - 1, math.ceil((interior_y + interior_height) / MOTION_SPACING))
            tiles.append(Tile(
                tile_x=interior_x // TILE_INTERIOR,
                tile_y=interior_y // TILE_INTERIOR,
                interior_x=interior_x,
                interior_y=interior_y,
                interior_width=interior_width,
                interior_height=interior_height,
                stored_x=stored_x,
                stored_y=stored_y,
                stored_width=stored_end_x - stored_x,
                stored_height=stored_end_y - stored_y,
                motion_x=motion_x,
                motion_y=motion_y,
                motion_width=motion_end_x - motion_x + 1,
                motion_height=motion_end_y - motion_y + 1,
            ))
    return tiles


def tile_supports_weather(tile: Tile, support: np.ndarray) -> bool:
    """Conservative: include support anywhere a displaced interior tap can reach."""
    region = support[tile.stored_y:tile.stored_y + tile.stored_height,
                     tile.stored_x:tile.stored_x + tile.stored_width]
    return bool(np.any(region))


def float16_bytes(values: np.ndarray) -> tuple[bytes, dict[str, float]]:
    values = np.asarray(values, dtype=np.float32)
    if not np.all(np.isfinite(values)):
        raise ValueError("temporal tile rain contains non-finite values")
    if np.any(values < 0):
        raise ValueError("temporal tile rain contains negative values")
    max_float16 = np.finfo(np.float16).max
    if np.any(values > max_float16):
        raise ValueError("temporal tile rain exceeds finite Float16 range")
    encoded = values.astype("<f2")
    decoded = encoded.astype(np.float32)
    if not np.all(np.isfinite(decoded)) or np.any(decoded < 0):
        raise ValueError("decoded temporal tile Float16 values are invalid")
    error = np.abs(decoded - values)
    return encoded.tobytes(order="C"), {
        "maximum_absolute_mmh": float(np.max(error)) if error.size else 0.0,
        "mean_absolute_mmh": float(np.mean(error)) if error.size else 0.0,
        "sample_count": int(error.size),
    }


def rain_payload(frames: list[np.ndarray], tile: Tile) -> tuple[bytes, dict[str, float]]:
    planes = [frame[tile.stored_y:tile.stored_y + tile.stored_height,
                    tile.stored_x:tile.stored_x + tile.stored_width]
              for frame in frames]
    return float16_bytes(np.stack(planes, axis=0))


def motion_payload(intervals: list[np.ndarray], tile: Tile) -> bytes:
    planes = [interval[:, tile.motion_y:tile.motion_y + tile.motion_height,
                       tile.motion_x:tile.motion_x + tile.motion_width]
              for interval in intervals]
    return np.stack(planes, axis=0).astype("<f4", copy=False).tobytes(order="C")


def tile_metadata(tile: Tile, rain_asset: str, rain_byte_length: int,
                  motion_asset: str, motion_byte_length: int) -> dict[str, Any]:
    return {
        "id": f"{tile.tile_x},{tile.tile_y}",
        "tile_x": tile.tile_x,
        "tile_y": tile.tile_y,
        "interior": {
            "x_start": tile.interior_x,
            "x_end": tile.interior_x + tile.interior_width - 1,
            "y_start": tile.interior_y,
            "y_end": tile.interior_y + tile.interior_height - 1,
            "width": tile.interior_width,
            "height": tile.interior_height,
        },
        "rain": {
            "stored_x_start": tile.stored_x,
            "stored_y_start": tile.stored_y,
            "stored_width": tile.stored_width,
            "stored_height": tile.stored_height,
            "asset": rain_asset,
            "byte_length": rain_byte_length,
        },
        "motion": {
            "grid_x_start": tile.motion_x,
            "grid_y_start": tile.motion_y,
            "grid_width": tile.motion_width,
            "grid_height": tile.motion_height,
            "asset": motion_asset,
            "byte_length": motion_byte_length,
        },
    }
