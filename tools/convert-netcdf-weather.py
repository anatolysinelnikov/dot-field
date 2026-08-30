#!/usr/bin/env python3
"""Convert NetCDF weather data to Dot Field's normalized CSV or binary sequence.

This is an offline conversion tool. It intentionally does not share code with
the browser runtime and does not write anything outside the generated-data
directory unless an explicit output directory is supplied.

The reader dependency is netCDF4 (and its local NumPy dependency). Install it
outside this repository when needed, for example:

    python3 -m pip install --target /private/tmp/dot-field-netcdf-deps netCDF4

Then run with PYTHONPATH pointing at that directory.
"""

from __future__ import annotations

import argparse
import csv
import json
import math
import re
from pathlib import Path
from tempfile import NamedTemporaryFile
from typing import Any

try:
    import numpy as np
except ImportError as error:  # pragma: no cover - depends on the local machine
    raise SystemExit("This offline converter requires NumPy.") from error
try:
    from netCDF4 import Dataset, num2date
except ImportError:  # The isolated motion verifier imports the dependency-free matcher.
    Dataset = None
    num2date = None


SCHEMA_VERSION = "dot-field-normalized-weather-v1"
CSV_COLUMNS = ("lon", "lat", "mmh", "thunderstorm", "hail")
REGULAR_SPACING_TOLERANCE = 2e-5
FLOAT_FORMAT = ".9g"
COORDINATE_FORMAT = ".17g"
SEQUENCE_SCHEMA_VERSION = "dot-field-weather-transport-v2"
SEQUENCE_HALO_CELLS = 1
DEFAULT_AVAILABILITY_PATH = Path("data/availability/available_region_latest.json")
MOTION_GRID_SPACING = 16
MOTION_BLOCK_RADIUS = 4
MOTION_SEARCH_RADIUS = 8
MOTION_MIN_SIGNAL = 0.08
MOTION_MIN_VARIANCE = 0.0025
MOTION_MIN_IMPROVEMENT = 0.08
MOTION_FILL_RADIUS_CELLS = 4
MOTION_BLOCK_OFFSETS = tuple(
    (offset_x, offset_y)
    for offset_y in (-4, 0, 4)
    for offset_x in (-4, 0, 4)
)


def motion_grid_shape(width: int, height: int) -> tuple[int, int]:
    return (math.ceil((width - 1) / MOTION_GRID_SPACING) + 1,
            math.ceil((height - 1) / MOTION_GRID_SPACING) + 1)


def match_motion_block(
    source_log: np.ndarray,
    target_log: np.ndarray,
    center_x: int,
    center_y: int,
) -> dict[str, float | int | bool]:
    """Evaluate one v1 9x9 offset-block hypothesis deterministically."""
    height, width = source_log.shape
    x0, x1 = max(0, center_x - MOTION_BLOCK_RADIUS), min(width, center_x + MOTION_BLOCK_RADIUS + 1)
    y0, y1 = max(0, center_y - MOTION_BLOCK_RADIUS), min(height, center_y + MOTION_BLOCK_RADIUS + 1)
    block = source_log[y0:y1, x0:x1]
    signal = float(np.mean(block))
    variance = float(np.var(block))
    result: dict[str, float | int | bool] = {
        "dx": 0, "dy": 0, "best_error": math.inf, "reliable": False,
    }
    if signal < MOTION_MIN_SIGNAL or variance < MOTION_MIN_VARIANCE:
        return result
    best_error = math.inf
    zero_error = math.inf
    best_dx = best_dy = 0
    for dy in range(-MOTION_SEARCH_RADIUS, MOTION_SEARCH_RADIUS + 1):
        ty0, ty1 = y0 + dy, y1 + dy
        if ty0 < 0 or ty1 > height:
            continue
        for dx in range(-MOTION_SEARCH_RADIUS, MOTION_SEARCH_RADIUS + 1):
            tx0, tx1 = x0 + dx, x1 + dx
            if tx0 < 0 or tx1 > width:
                continue
            # Mean absolute error of log1p rain limits dominance by a single
            # high-intensity cell without changing the physical rain data.
            error = float(np.mean(np.abs(block - target_log[ty0:ty1, tx0:tx1])))
            if dx == 0 and dy == 0:
                zero_error = error
            if error < best_error:
                best_error, best_dx, best_dy = error, dx, dy
    result.update(dx=best_dx, dy=best_dy, best_error=best_error)
    if (math.isfinite(best_error) and zero_error > 0
            and (zero_error - best_error) / zero_error >= MOTION_MIN_IMPROVEMENT):
        result["reliable"] = True
    return result


def dominant_offset_motion(hypotheses: list[dict[str, float | int | bool]]) -> dict[str, float | int | bool] | None:
    """Choose Candidate A's dominant Chebyshev-consistent medoid exactly."""
    reliable = [hypothesis for hypothesis in hypotheses if hypothesis["reliable"]]
    if not reliable:
        return None
    clusters = []
    for seed_index, seed in enumerate(reliable):
        cluster = [
            hypothesis for hypothesis in reliable
            if max(abs(int(hypothesis["dx"]) - int(seed["dx"])), abs(int(hypothesis["dy"]) - int(seed["dy"]))) <= 1
        ]
        # The diagnostic chooses the earliest offset hypothesis when cluster
        # sizes tie; preserve that explicit ordering rather than relying on a
        # container implementation detail.
        clusters.append((len(cluster), -seed_index, cluster))
    _, _, dominant = max(clusters, key=lambda cluster: (cluster[0], cluster[1]))
    if len(dominant) < 3 or len(dominant) < math.ceil(0.6 * len(reliable)):
        return None
    medoids = []
    for candidate_index, candidate in enumerate(dominant):
        total_distance = sum(
            (int(candidate["dx"]) - int(other["dx"])) ** 2
            + (int(candidate["dy"]) - int(other["dy"])) ** 2
            for other in dominant
        )
        # Candidate A's diagnostic records the group error sum as a secondary
        # key (equal for all medoid candidates), then preserves group order.
        group_error = sum(float(other["best_error"]) for other in dominant)
        medoids.append((total_distance, group_error, candidate_index, candidate))
    return min(medoids, key=lambda medoid: (medoid[0], medoid[1], medoid[2]))[3]


def estimate_motion_one_direction(source: np.ndarray, target: np.ndarray) -> np.ndarray:
    """Return Candidate A's deterministic coarse source->target XY field."""
    height, width = source.shape
    grid_width, grid_height = motion_grid_shape(width, height)
    result = np.zeros((4, grid_height, grid_width), dtype=np.float32)
    source_log = np.log1p(source.astype(np.float64, copy=False))
    target_log = np.log1p(target.astype(np.float64, copy=False))
    reliable = np.zeros((grid_height, grid_width), dtype=bool)
    for gy in range(grid_height):
        cy = min(height - 1, gy * MOTION_GRID_SPACING)
        for gx in range(grid_width):
            cx = min(width - 1, gx * MOTION_GRID_SPACING)
            hypotheses = [
                match_motion_block(source_log, target_log, cx + offset_x, cy + offset_y)
                for offset_x, offset_y in MOTION_BLOCK_OFFSETS
            ]
            chosen = dominant_offset_motion(hypotheses)
            if chosen is None:
                continue
            result[0, gy, gx] = int(chosen["dx"])
            result[1, gy, gx] = int(chosen["dy"])
            result[2, gy, gx] = 1.0
            reliable[gy, gx] = True
    # Fill only from nearby reliable cells; dry/unstructured regions remain
    # zero motion rather than receiving invented long-range vectors.
    for gy in range(grid_height):
        for gx in range(grid_width):
            if reliable[gy, gx]:
                continue
            candidates = []
            for oy in range(-MOTION_FILL_RADIUS_CELLS, MOTION_FILL_RADIUS_CELLS + 1):
                for ox in range(-MOTION_FILL_RADIUS_CELLS, MOTION_FILL_RADIUS_CELLS + 1):
                    ny, nx = gy + oy, gx + ox
                    distance2 = ox * ox + oy * oy
                    if distance2 == 0 or distance2 > MOTION_FILL_RADIUS_CELLS * MOTION_FILL_RADIUS_CELLS:
                        continue
                    if 0 <= ny < grid_height and 0 <= nx < grid_width and reliable[ny, nx]:
                        candidates.append((distance2, ny, nx))
            if candidates:
                _, ny, nx = min(candidates)
                result[0, gy, gx] = result[0, ny, nx]
                result[1, gy, gx] = result[1, ny, nx]
    return result


def expand_motion_support(mask: np.ndarray) -> np.ndarray:
    """Expand positive support enough for any bounded displaced bilinear tap."""
    radius = MOTION_SEARCH_RADIUS + 1
    expanded = np.zeros_like(mask, dtype=bool)
    ys, xs = np.nonzero(mask)
    for y, x in zip(ys, xs):
        expanded[max(0, y - radius):min(mask.shape[0], y + radius + 1),
                 max(0, x - radius):min(mask.shape[1], x + radius + 1)] = True
    return expanded


def parser() -> argparse.ArgumentParser:
    result = argparse.ArgumentParser(description=__doc__)
    result.add_argument("source", type=Path, help="source NetCDF4 file")
    result.add_argument(
        "--time-index",
        type=int,
        default=0,
        help="time index to export (default: 0)",
    )
    result.add_argument(
        "--output-dir",
        type=Path,
        default=Path("data/generated"),
        help="directory for generated CSV and JSON (default: data/generated)",
    )
    result.add_argument(
        "--sequence",
        action="store_true",
        help="export independently addressable exact Float32 rain frames, packed support.mask, and metadata.json",
    )
    result.add_argument(
        "--availability",
        type=Path,
        default=DEFAULT_AVAILABILITY_PATH,
        help="diagnostic observation-coverage GeoJSON for --sequence",
    )
    result.add_argument(
        "--assume-units",
        metavar="UNIT",
        help="explicitly supply missing precipitation units, e.g. mm/h",
    )
    return result


def json_value(value: Any) -> Any:
    """Convert NumPy and NetCDF attribute values to JSON-safe values."""
    if isinstance(value, np.ndarray):
        return [json_value(item) for item in value.tolist()]
    if isinstance(value, np.generic):
        return json_value(value.item())
    if isinstance(value, (list, tuple)):
        return [json_value(item) for item in value]
    if isinstance(value, float) and not math.isfinite(value):
        return "NaN" if math.isnan(value) else str(value)
    return value


def attr(variable: Any, name: str) -> Any | None:
    return getattr(variable, name) if name in variable.ncattrs() else None


def finite_attribute(value: Any | None) -> Any | None:
    if value is None:
        return None
    return json_value(value)


def coordinate_spacing(values: np.ndarray, name: str) -> tuple[float, float]:
    if values.ndim != 1 or values.size < 2:
        raise ValueError(f"{name} must be a one-dimensional coordinate with at least two values")
    if not np.all(np.isfinite(values)):
        raise ValueError(f"{name} contains non-finite coordinates")
    deltas = np.diff(values.astype(np.float64))
    if not np.all(deltas > 0):
        raise ValueError(f"{name} must be strictly increasing")
    spacing = float(np.mean(deltas))
    max_error = float(np.max(np.abs(deltas - spacing)))
    if max_error > REGULAR_SPACING_TOLERANCE:
        raise ValueError(
            f"{name} is not regular: maximum spacing error {max_error:g} "
            f"exceeds {REGULAR_SPACING_TOLERANCE:g}"
        )
    return spacing, max_error


def canonical_unit(unit: str) -> str:
    return re.sub(r"\s+", " ", unit.strip().lower().replace("−", "-").replace("·", " "))


def unit_factor_to_mmh(unit: str) -> tuple[float, str]:
    """Return a verified rate conversion factor, or reject ambiguous units."""
    normalized = canonical_unit(unit)
    compact = normalized.replace(" ", "")
    factors = {
        "mm/h": (1.0, "identity"),
        "mm/hr": (1.0, "identity"),
        "mm/hour": (1.0, "identity"),
        "mmh-1": (1.0, "identity"),
        "mmhr-1": (1.0, "identity"),
        "mmhour-1": (1.0, "identity"),
        "mm/s": (3600.0, "seconds to hours"),
        "mm/sec": (3600.0, "seconds to hours"),
        "m/s": (3_600_000.0, "metres to millimetres and seconds to hours"),
        "m/sec": (3_600_000.0, "metres to millimetres and seconds to hours"),
        "kgm-2s-1": (3600.0, "water equivalent kg/m² to mm and seconds to hours"),
        "kgm-2h-1": (1.0, "water equivalent kg/m² to mm"),
        "kgm-2hr-1": (1.0, "water equivalent kg/m² to mm"),
    }
    if compact in factors:
        return factors[compact]
    raise ValueError(
        f"precipitation units {unit!r} are not an explicitly supported rate; "
        "accumulation or ambiguous units cannot be converted safely to mm/h"
    )


def decoded_timestamp(value: Any) -> str:
    if hasattr(value, "isoformat"):
        return value.isoformat()
    return str(value)


def timestamp_filename(timestamp: str, fallback: str) -> str:
    match = re.match(r"^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})", timestamp)
    return "".join(match.groups()) if match else fallback


def source_stats(values: np.ndarray) -> dict[str, Any]:
    finite = np.isfinite(values)
    valid = values[finite]
    if valid.size == 0:
        raise ValueError("selected precipitation timestep contains no valid cells")
    zero = int(np.count_nonzero(valid == 0))
    nonzero = int(np.count_nonzero(valid != 0))
    return {
        "minimum_mmh": float(np.min(valid)),
        "maximum_mmh": float(np.max(valid)),
        "mean_mmh": float(np.mean(valid)),
        "valid_cells": int(valid.size),
        "missing_cells": int(values.size - valid.size),
        "zero_cells": zero,
        "non_zero_cells": nonzero,
        "non_zero_percent_of_valid": float(100 * nonzero / valid.size),
        "negative_cells": int(np.count_nonzero(valid < 0)),
        "representative_non_zero_mmh": [
            float(item) for item in valid[valid != 0][:8]
        ],
    }


def build_metadata(
    source: Path,
    dataset: Any,
    precipitation: Any,
    time_variable: Any,
    timestamp_values: list[str],
    time_index: int,
    timestamp: str,
    longitudes: np.ndarray,
    latitudes: np.ndarray,
    longitude_spacing: float,
    latitude_spacing: float,
    longitude_error: float,
    latitude_error: float,
    stats: dict[str, Any],
    original_units: str | None,
    normalized_units: str,
    unit_factor: float,
    unit_conversion: str,
    unit_basis: str,
) -> dict[str, Any]:
    grid_mapping = attr(precipitation, "grid_mapping")
    crs_variable = grid_mapping if grid_mapping in dataset.variables else None
    crs_attributes = None
    if crs_variable is not None:
        crs_attributes = {
            name: json_value(getattr(dataset.variables[crs_variable], name))
            for name in dataset.variables[crs_variable].ncattrs()
        }

    fill_value = attr(precipitation, "_FillValue")
    return {
        "schema_version": SCHEMA_VERSION,
        "source_filename": source.name,
        "source_format": {
            "data_model": dataset.data_model,
            "disk_format": dataset.disk_format,
            "file_format": dataset.file_format,
        },
        "source_timestamp": timestamp,
        "timestamp_interpretation": {
            "variable": "time",
            "index": time_index,
            "units": attr(time_variable, "units"),
            "calendar": attr(time_variable, "calendar") or "standard",
            "timezone": "unspecified in source metadata",
            "all_source_timestamps": timestamp_values,
        },
        "source_precipitation": {
            "variable": precipitation.name,
            "dtype": str(precipitation.dtype),
            "dimensions": list(precipitation.dimensions),
            "original_units": original_units,
            "normalized_units": normalized_units,
            "conversion_factor": unit_factor,
            "conversion": unit_conversion,
            "unit_basis": unit_basis,
            "fill_value": finite_attribute(fill_value),
            "missing_value": finite_attribute(attr(precipitation, "missing_value")),
            "valid_min": finite_attribute(attr(precipitation, "valid_min")),
            "valid_max": finite_attribute(attr(precipitation, "valid_max")),
            "valid_range": finite_attribute(attr(precipitation, "valid_range")),
            "statistics": stats,
        },
        "grid": {
            "width": int(longitudes.size),
            "height": int(latitudes.size),
            "dimensions": {"x": int(longitudes.size), "y": int(latitudes.size)},
            "coordinate_variables": {"longitude": "lon", "latitude": "lat"},
            "layout": "regular rectilinear longitude/latitude",
            "longitude_order": "west_to_east",
            "latitude_order": "south_to_north",
            "longitude_bounds": [float(longitudes[0]), float(longitudes[-1])],
            "latitude_bounds": [float(latitudes[0]), float(latitudes[-1])],
            "longitude_spacing": longitude_spacing,
            "latitude_spacing": latitude_spacing,
            "maximum_longitude_spacing_error": longitude_error,
            "maximum_latitude_spacing_error": latitude_error,
            "coordinate_semantics": "one-dimensional coordinate variables; source has no bounds or node/edge metadata",
            "crs": crs_attributes,
            "crs_variable": grid_mapping,
        },
        "hazards": {
            "thunderstorm": {"available": False, "output_value": 0},
            "hail": {"available": False, "output_value": 0},
        },
        "missing_data": {
            "source_missing_cells": stats["missing_cells"],
            "output_policy": "conversion refuses missing cells because the CSV contract has no missing sentinel",
        },
        "output": {
            "format": "CSV",
            "columns": list(CSV_COLUMNS),
            "row_order": "latitude south_to_north, longitude west_to_east",
            "row_count": int(longitudes.size * latitudes.size),
        },
    }


def validate_source_contract(dataset: Any) -> tuple[Any, Any, Any, Any]:
    required = ("time", "lon", "lat", "intensity")
    missing = [name for name in required if name not in dataset.variables]
    if missing:
        raise ValueError(f"source is missing required variable(s): {', '.join(missing)}")
    time_variable = dataset.variables["time"]
    longitude_variable = dataset.variables["lon"]
    latitude_variable = dataset.variables["lat"]
    precipitation = dataset.variables["intensity"]
    if time_variable.dimensions != ("time",):
        raise ValueError(f"time variable has unexpected dimensions {time_variable.dimensions}")
    if longitude_variable.dimensions != ("x",) or latitude_variable.dimensions != ("y",):
        raise ValueError("lon/lat must be one-dimensional x/y coordinate variables")
    if precipitation.dimensions != ("time", "y", "x"):
        raise ValueError(
            f"intensity has dimensions {precipitation.dimensions}; expected ('time', 'y', 'x')"
        )
    return time_variable, longitude_variable, latitude_variable, precipitation


def write_csv(
    output_path: Path,
    longitudes: np.ndarray,
    latitudes: np.ndarray,
    values: np.ndarray,
    factor: float,
) -> None:
    output_path.parent.mkdir(parents=True, exist_ok=True)
    with output_path.open("w", encoding="utf-8", newline="") as handle:
        writer = csv.writer(handle, lineterminator="\n")
        writer.writerow(CSV_COLUMNS)
        for latitude_index, latitude in enumerate(latitudes):
            for longitude_index, longitude in enumerate(longitudes):
                writer.writerow(
                    (
                        format(float(longitude), COORDINATE_FORMAT),
                        format(float(latitude), COORDINATE_FORMAT),
                        format(float(values[latitude_index, longitude_index]) * factor, FLOAT_FORMAT),
                        "0",
                        "0",
                    )
                )


def resolve_precipitation_units(precipitation: Any, assume_units: str | None) -> tuple[str | None, str, float, str]:
    source_units = attr(precipitation, "units")
    if source_units is None:
        if assume_units is None:
            raise SystemExit(
                "source variable intensity has no units metadata; refusing to "
                "label values as mm/h. Re-run with an explicit assumption, "
                "for example --assume-units mm/h, after verifying the source semantics."
            )
        effective_units = assume_units
        unit_basis = f"explicit command-line assumption: {assume_units}"
    else:
        if assume_units is not None:
            raise SystemExit("--assume-units may only be used when source units metadata is absent")
        effective_units = str(source_units)
        unit_basis = "source units metadata"
    factor, conversion = unit_factor_to_mmh(effective_units)
    return (str(source_units) if source_units is not None else None, unit_basis, factor, conversion)


def decode_times(time_variable: Any, time_values: np.ndarray) -> list[str]:
    timestamp_units = attr(time_variable, "units")
    if timestamp_units is None:
        raise ValueError("time variable has no units metadata; timestamp semantics are unavailable")
    calendar = attr(time_variable, "calendar") or "standard"
    timestamps = num2date(
        time_values,
        units=timestamp_units,
        calendar=calendar,
        only_use_cftime_datetimes=False,
    )
    return [decoded_timestamp(item) for item in timestamps]


def source_grid_crop(
    longitudes: np.ndarray,
    latitudes: np.ndarray,
    union_nonzero: np.ndarray,
) -> dict[str, Any]:
    wet_y, wet_x = np.nonzero(union_nonzero)
    if not len(wet_x):
        raise ValueError("the full precipitation sequence contains no positive source values")
    wet_x0 = int(wet_x.min())
    wet_x1 = int(wet_x.max())
    wet_y0 = int(wet_y.min())
    wet_y1 = int(wet_y.max())
    support_x0 = wet_x0 - SEQUENCE_HALO_CELLS
    support_x1 = wet_x1 + SEQUENCE_HALO_CELLS
    support_y0 = wet_y0 - SEQUENCE_HALO_CELLS
    support_y1 = wet_y1 + SEQUENCE_HALO_CELLS
    x0 = support_x0 - SEQUENCE_HALO_CELLS
    x1 = support_x1 + SEQUENCE_HALO_CELLS
    y0 = support_y0 - SEQUENCE_HALO_CELLS
    y1 = support_y1 + SEQUENCE_HALO_CELLS
    if min(x0, y0) < 0 or x1 >= longitudes.size or y1 >= latitudes.size:
        raise ValueError("derived weather support plus halo lies outside the source grid")
    width = x1 - x0 + 1
    height = y1 - y0 + 1
    return {
        "wet_x_start": wet_x0,
        "wet_x_end": wet_x1,
        "wet_y_start": wet_y0,
        "wet_y_end": wet_y1,
        "x_start": x0,
        "x_end": x1,
        "y_start": y0,
        "y_end": y1,
        "support_x_start": support_x0,
        "support_x_end": support_x1,
        "support_y_start": support_y0,
        "support_y_end": support_y1,
        "width": width,
        "height": height,
        "node_count": width * height,
        "longitude_start": float(longitudes[x0]),
        "longitude_end": float(longitudes[x1]),
        "latitude_start": float(latitudes[y0]),
        "latitude_end": float(latitudes[y1]),
        "longitude_spacing": float(np.mean(np.diff(longitudes))),
        "latitude_spacing": float(np.mean(np.diff(latitudes))),
    }


def read_validated_source_frame(precipitation: Any, time_index: int) -> np.ndarray:
    masked_values = np.ma.asarray(precipitation[time_index, :, :])
    values = np.asarray(masked_values.filled(np.nan), dtype=np.float64)
    stats = source_stats(values)
    if stats["missing_cells"]:
        raise SystemExit(
            f"timestep {time_index} contains {stats['missing_cells']} missing cells; "
            "rain frame cannot preserve missing cells as a separate state"
        )
    if stats["negative_cells"]:
        raise SystemExit(f"timestep {time_index} contains negative precipitation cells")
    return values


def load_observation_polygons(path: Path) -> tuple[list[list[list[float]]], dict[str, Any]]:
    document = json.loads(path.read_text(encoding="utf-8"))
    geometry = document.get("geometry")
    if document.get("type") != "Feature" or not isinstance(geometry, dict):
        raise ValueError("availability GeoJSON must have a Feature root with geometry")
    if geometry.get("type") != "GeometryCollection":
        raise ValueError("availability GeoJSON geometry must be a GeometryCollection")
    polygons = []
    for item in geometry.get("geometries", []):
        if item.get("type") != "Polygon" or len(item.get("coordinates", [])) != 1:
            raise ValueError("availability GeoJSON must contain single-ring Polygon geometries")
        ring = item["coordinates"][0]
        if len(ring) < 4 or ring[0] != ring[-1]:
            raise ValueError("availability polygon rings must be closed")
        polygons.append(ring)
    if not polygons:
        raise ValueError("availability GeoJSON contains no polygons")
    points = [point for polygon in polygons for point in polygon]
    properties = document.get("properties") or {}
    return polygons, {
        "available": True,
        "status": "available",
        "source_filename": path.name,
        "root_type": document.get("type"),
        "geometry_type": geometry.get("type"),
        "polygon_count": len(polygons),
        "radar_id_count": len(properties.get("radar_ids", [])),
        "bounds": {
            "west": min(point[0] for point in points),
            "east": max(point[0] for point in points),
            "south": min(point[1] for point in points),
            "north": max(point[1] for point in points),
        },
        "timestamp_present": "timestamp" in properties,
        "run_identifier_present": any(
            key in properties for key in ("run_id", "run_identifier", "run")
        ),
        "temporal_compatibility": "unverified; source artifact has no timestamp or run metadata",
        "applied_as_rain_mask": False,
    }


def unavailable_observation_diagnostic(path: Path) -> dict[str, Any]:
    return {
        "available": False,
        "status": "unavailable",
        "source_filename": path.name,
        "reason": "observation-coverage diagnostic file is absent; sequence generation does not require it",
        "applied_as_rain_mask": False,
    }


def points_in_polygon_union(longitudes: np.ndarray, latitudes: np.ndarray, polygons: list[list[list[float]]]) -> np.ndarray:
    xs, ys = np.meshgrid(longitudes, latitudes)
    result = np.zeros(xs.shape, dtype=bool)
    for polygon in polygons:
        coordinates = np.asarray(polygon, dtype=np.float64)
        px = coordinates[:, 0]
        py = coordinates[:, 1]
        candidate = (
            (xs >= px.min() - 1e-8)
            & (xs <= px.max() + 1e-8)
            & (ys >= py.min() - 1e-8)
            & (ys <= py.max() + 1e-8)
        )
        if not candidate.any():
            continue
        x = xs[candidate]
        y = ys[candidate]
        inside = np.zeros(x.shape, dtype=bool)
        for index in range(len(coordinates) - 1):
            x1, y1 = coordinates[index]
            x2, y2 = coordinates[index + 1]
            on_edge = (
                np.abs((x2 - x1) * (y - y1) - (y2 - y1) * (x - x1)) <= 1e-8
            ) & (
                x >= min(x1, x2) - 1e-8
            ) & (
                x <= max(x1, x2) + 1e-8
            ) & (
                y >= min(y1, y2) - 1e-8
            ) & (
                y <= max(y1, y2) + 1e-8
            )
            crosses = (y1 > y) != (y2 > y)
            edge_x = (x2 - x1) * (y - y1) / (y2 - y1) + x1 if y2 != y1 else np.full_like(x, np.inf)
            inside ^= crosses & (x <= edge_x)
            inside |= on_edge
        result[candidate] |= inside
    return result


def sequence_frame_statistics(
    values: np.ndarray,
    longitudes: np.ndarray,
    latitudes: np.ndarray,
) -> dict[str, Any]:
    stats = source_stats(values)
    nonzero = values > 0
    y, x = np.nonzero(nonzero)
    stats["non_zero_bounds"] = (
        {
            "west": float(longitudes[x].min()),
            "east": float(longitudes[x].max()),
            "south": float(latitudes[y].min()),
            "north": float(latitudes[y].max()),
        }
        if len(x)
        else None
    )
    return stats


def sequence_metadata(
    source: Path,
    dataset: Any,
    precipitation: Any,
    time_variable: Any,
    timestamps: list[str],
    crop: dict[str, Any],
    frame_statistics: list[dict[str, Any]],
    union_nonzero: np.ndarray,
    crop_longitudes: np.ndarray,
    crop_latitudes: np.ndarray,
    original_units: str | None,
    unit_basis: str,
    conversion: str,
    observation: dict[str, Any],
    support_available_nodes: int | None,
    support_node_count: int | None,
    crop_available_nodes: int | None,
    first_frame_coverage: dict[str, Any] | None,
    per_frame_coverage: list[dict[str, Any] | None],
    motion: dict[str, Any],
) -> dict[str, Any]:
    union_y, union_x = np.nonzero(union_nonzero)
    frame_node_count = crop["node_count"]
    frame_byte_length = frame_node_count * 4
    union_bounds = {
        "west": float(crop_longitudes[union_x].min()),
        "east": float(crop_longitudes[union_x].max()),
        "south": float(crop_latitudes[union_y].min()),
        "north": float(crop_latitudes[union_y].max()),
    } if len(union_x) else None
    return {
        "schema_version": SEQUENCE_SCHEMA_VERSION,
        "source": {
            "filename": source.name,
            "format": {
                "data_model": dataset.data_model,
                "disk_format": dataset.disk_format,
                "file_format": dataset.file_format,
            },
            "dimensions": {name: len(dimension) for name, dimension in dataset.dimensions.items()},
            "precipitation_variable": precipitation.name,
            "precipitation_dimensions": list(precipitation.dimensions),
            "precipitation_dtype": str(precipitation.dtype),
            "original_units": original_units,
            "normalized_units": "mm/h",
            "unit_basis": unit_basis,
            "unit_conversion": conversion,
        },
        "time": {
            "variable": time_variable.name,
            "timestamps": timestamps,
            "count": len(timestamps),
            "interval_minutes": 10,
            "units": attr(time_variable, "units"),
            "calendar": attr(time_variable, "calendar") or "standard",
            "timezone": "unspecified in source metadata",
            "sequence_start": timestamps[0],
            "sequence_end": timestamps[-1],
        },
        "spatial_grid": {
            "width": crop["width"],
            "height": crop["height"],
            "longitude_start": crop["longitude_start"],
            "latitude_start": crop["latitude_start"],
            "longitude_spacing": crop["longitude_spacing"],
            "latitude_spacing": crop["latitude_spacing"],
            "longitude_order": "west_to_east",
            "latitude_order": "south_to_north",
            "source_crop_indices": {
                "x_start": crop["x_start"],
                "x_end": crop["x_end"],
                "y_start": crop["y_start"],
                "y_end": crop["y_end"],
            },
            "support_enclosing_indices": {
                "x_start": crop["support_x_start"],
                "x_end": crop["support_x_end"],
                "y_start": crop["support_y_start"],
                "y_end": crop["support_y_end"],
            },
            "union_wet_indices": {
                "x_start": crop["wet_x_start"],
                "x_end": crop["wet_x_end"],
                "y_start": crop["wet_y_start"],
                "y_end": crop["wet_y_end"],
            },
            "crop_bounds": {
                "west": crop["longitude_start"],
                "east": crop["longitude_end"],
                "south": crop["latitude_start"],
                "north": crop["latitude_end"],
            },
            "weather_support": {
                "west": float(crop_longitudes[crop["support_x_start"] - crop["x_start"]]),
                "east": float(crop_longitudes[crop["support_x_end"] - crop["x_start"]]),
                "south": float(crop_latitudes[crop["support_y_start"] - crop["y_start"]]),
                "north": float(crop_latitudes[crop["support_y_end"] - crop["y_start"]]),
            },
            "halo_source_grid_cells": SEQUENCE_HALO_CELLS,
        },
        "support_mask": {
            "asset": "support.mask",
            "encoding": "bitset-lsb0",
            "node_count": frame_node_count,
            "byte_length": (frame_node_count + 7) // 8,
            "positive_condition": "rain > 0 expanded by motion search radius",
            "trailing_unused_bits": "zero",
        },
        "rain": {
            "available": True,
            "dtype": "Float32",
            "byte_order": "little-endian",
            "physical_units": "mm/h",
            "logical_dimensions": ["latitude", "longitude"],
            "frame_node_count": frame_node_count,
            "frame_byte_length": frame_byte_length,
            "frame_assets": [f"rain/frame-{index:03d}.f32" for index in range(len(timestamps))],
            "union_nonzero_bounds": union_bounds,
            "union_distinct_nonzero_nodes": int(union_nonzero.sum()),
            "per_frame_statistics": frame_statistics,
        },
        "motion": motion,
        "channels": {
            "rain": True,
            "phenomena": False,
        },
        "phenomena": {
            "available": False,
            "dtype": "Uint8",
            "enum": {
                "none": 0,
                "thunderstorm_1": 1,
                "thunderstorm_2": 2,
                "thunderstorm_3": 3,
                "hail_1": 4,
                "hail_2": 5,
                "hail_3": 6,
                "reserved": 7,
            },
            "frame_assets": [],
        },
        "observation_coverage_diagnostic": {
            **observation,
            "current_support_node_count": support_node_count,
            "current_support_available_nodes": support_available_nodes,
            "current_support_available_percent": (
                100 * support_available_nodes / support_node_count
                if support_available_nodes is not None and support_node_count
                else None
            ),
            "crop_available_nodes": crop_available_nodes,
            "first_frame_nonzero": first_frame_coverage,
            "per_frame_nonzero_coverage": per_frame_coverage,
            "interpretation": "observation footprint only; forecast/nowcast rain outside it remains valid source data",
        },
    }


def convert_sequence(args: argparse.Namespace) -> int:
    if Dataset is None or num2date is None:
        raise SystemExit("This offline converter requires the netCDF4 package. Install it outside this repository and retry.")
    source = args.source.resolve()
    availability_path = args.availability.resolve()
    if not source.is_file():
        raise SystemExit(f"source file does not exist: {source}")
    if availability_path.is_file():
        polygons, observation = load_observation_polygons(availability_path)
    else:
        polygons = None
        observation = unavailable_observation_diagnostic(availability_path)
    with Dataset(source, "r") as dataset:
        dataset.set_auto_mask(True)
        time_variable, longitude_variable, latitude_variable, precipitation = validate_source_contract(dataset)
        original_units, unit_basis, factor, conversion = resolve_precipitation_units(precipitation, args.assume_units)
        time_values = np.asarray(time_variable[:])
        timestamps = decode_times(time_variable, time_values)
        if len(timestamps) != 19:
            raise ValueError(f"sequence export requires 19 timesteps, received {len(timestamps)}")
        if not np.all(np.diff(time_values.astype(np.float64)) == 10):
            raise ValueError("sequence export requires uniformly spaced 10-minute timesteps")
        longitudes = np.asarray(longitude_variable[:], dtype=np.float64)
        latitudes = np.asarray(latitude_variable[:], dtype=np.float64)
        longitude_spacing, _ = coordinate_spacing(longitudes, "longitude")
        latitude_spacing, _ = coordinate_spacing(latitudes, "latitude")
        union_nonzero = np.zeros((latitudes.size, longitudes.size), dtype=bool)
        frame_statistics = []
        for time_index, timestamp in enumerate(timestamps):
            values = read_validated_source_frame(precipitation, time_index)
            normalized = values * factor
            frame_statistics.append(sequence_frame_statistics(normalized, longitudes, latitudes))
            union_nonzero |= normalized > 0

        crop = source_grid_crop(longitudes, latitudes, union_nonzero)
        crop["longitude_spacing"] = longitude_spacing
        crop["latitude_spacing"] = latitude_spacing
        crop_longitudes = longitudes[crop["x_start"]:crop["x_end"] + 1]
        crop_latitudes = latitudes[crop["y_start"]:crop["y_end"] + 1]
        crop_availability = (
            points_in_polygon_union(crop_longitudes, crop_latitudes, polygons)
            if polygons is not None else None
        )
        support_longitudes = longitudes[crop["support_x_start"]:crop["support_x_end"] + 1]
        support_latitudes = latitudes[crop["support_y_start"]:crop["support_y_end"] + 1]
        support_availability = (
            points_in_polygon_union(support_longitudes, support_latitudes, polygons)
            if polygons is not None else None
        )
        per_frame_coverage = []
        output_dir = args.output_dir
        output_dir.mkdir(parents=True, exist_ok=True)
        rain_dir = output_dir / "rain"
        motion_dir = output_dir / "motion"
        support_path = output_dir / "support.mask"
        metadata_path = output_dir / "metadata.json"
        rain_dir.mkdir(parents=True, exist_ok=True)
        motion_dir.mkdir(parents=True, exist_ok=True)
        try:
            for time_index, timestamp in enumerate(timestamps):
                values = read_validated_source_frame(precipitation, time_index)
                normalized = values * factor
                crop_values = normalized[crop["y_start"]:crop["y_end"] + 1, crop["x_start"]:crop["x_end"] + 1]
                frame_path = rain_dir / f"frame-{time_index:03d}.f32"
                with NamedTemporaryFile(dir=rain_dir, prefix=f".frame-{time_index:03d}.", suffix=".f32.tmp", delete=False) as temporary:
                    temporary_frame_path = Path(temporary.name)
                try:
                    np.asarray(crop_values, dtype="<f4", order="C").tofile(temporary_frame_path)
                    temporary_frame_path.replace(frame_path)
                finally:
                    temporary_frame_path.unlink(missing_ok=True)
                nonzero = crop_values > 0
                nonzero_y, nonzero_x = np.nonzero(nonzero)
                inside = crop_availability[nonzero_y, nonzero_x] if crop_availability is not None else None
                per_frame_coverage.append({
                    "timestamp": timestamp,
                    "non_zero_nodes": int(nonzero.sum()),
                    "inside_observation": int(inside.sum()) if inside is not None else None,
                    "outside_observation": int((~inside).sum()) if inside is not None else None,
                })

            crop_union_nonzero = union_nonzero[crop["y_start"]:crop["y_end"] + 1, crop["x_start"]:crop["x_end"] + 1]
            motion_width, motion_height = motion_grid_shape(crop["width"], crop["height"])
            interval_byte_length = motion_width * motion_height * 4 * 4
            motion_assets = []
            for interval in range(len(timestamps) - 1):
                frame_a = np.fromfile(rain_dir / f"frame-{interval:03d}.f32", dtype="<f4").reshape(crop["height"], crop["width"])
                frame_b = np.fromfile(rain_dir / f"frame-{interval + 1:03d}.f32", dtype="<f4").reshape(crop["height"], crop["width"])
                forward = estimate_motion_one_direction(frame_a, frame_b)
                backward = estimate_motion_one_direction(frame_b, frame_a)
                packed_motion = np.stack((forward[0], forward[1], backward[0], backward[1])).astype("<f4", copy=False)
                motion_path = motion_dir / f"interval-{interval:03d}.f32"
                packed_motion.tofile(motion_path)
                if motion_path.stat().st_size != interval_byte_length:
                    raise ValueError(f"motion interval {interval} has unexpected byte length")
                motion_assets.append(f"motion/interval-{interval:03d}.f32")
            motion = {
                "available": True,
                "dtype": "Float32",
                "byte_order": "little-endian",
                "units": "source_grid_nodes_per_interval",
                "component_convention": "forward_xy_then_backward_xy",
                "grid_width": motion_width,
                "grid_height": motion_height,
                "grid_spacing_source_nodes": MOTION_GRID_SPACING,
                "grid_origin_source_nodes": [0, 0],
                "grid_last_sample_source_nodes": [
                    min(crop["width"] - 1, (motion_width - 1) * MOTION_GRID_SPACING),
                    min(crop["height"] - 1, (motion_height - 1) * MOTION_GRID_SPACING),
                ],
                "interval_count": len(timestamps) - 1,
                "interval_byte_length": interval_byte_length,
                "interval_assets": motion_assets,
                "estimator": {
                    "signal_transform": "log1p(rain_mmh)",
                    "block_radius_source_nodes": MOTION_BLOCK_RADIUS,
                    "block_center_offsets_source_nodes": [list(offset) for offset in MOTION_BLOCK_OFFSETS],
                    "search_radius_source_nodes": MOTION_SEARCH_RADIUS,
                    "metric": "mean_absolute_difference",
                    "reliability": "each offset needs mean_log1p >= 0.08, variance >= 0.0025, and relative error improvement >= 0.08; accept a >=3, >=60% reliable, Chebyshev-1 dominant cluster and use its deterministic medoid",
                    "unreliable_fill": "nearest reliable motion-grid cell within four motion-grid cells; otherwise zero",
                    "maximum_displacement_source_nodes": MOTION_SEARCH_RADIUS,
                },
            }
            packed_support = np.packbits(
                np.asarray(expand_motion_support(crop_union_nonzero), dtype=np.uint8).ravel(order="C"),
                bitorder="little",
            )
            with NamedTemporaryFile(dir=output_dir, prefix=".support.", suffix=".mask.tmp", delete=False) as temporary:
                temporary_support_path = Path(temporary.name)
            try:
                packed_support.tofile(temporary_support_path)
                temporary_support_path.replace(support_path)
            finally:
                temporary_support_path.unlink(missing_ok=True)

            metadata = sequence_metadata(
                source,
                dataset,
                precipitation,
                time_variable,
                timestamps,
                crop,
                frame_statistics,
                crop_union_nonzero,
                crop_longitudes,
                crop_latitudes,
                original_units,
                unit_basis,
                conversion,
                observation,
                int(support_availability.sum()) if support_availability is not None else None,
                int(support_availability.size) if support_availability is not None else None,
                int(crop_availability.sum()) if crop_availability is not None else None,
                per_frame_coverage[0],
                per_frame_coverage,
                motion,
            )
            with metadata_path.open("w", encoding="utf-8") as handle:
                json.dump(metadata, handle, indent=2, sort_keys=True)
                handle.write("\n")
        finally:
            # The v1 aggregate file is no longer a transport artifact. Keep
            # any manually retained reference copy outside this output folder.
            (output_dir / "rain.f32").unlink(missing_ok=True)

    print(f"wrote {rain_dir} ({len(timestamps)} x {metadata['rain']['frame_byte_length']} bytes)")
    print(f"wrote {support_path} ({metadata['support_mask']['byte_length']} bytes)")
    print(f"wrote {metadata_path}")
    print(
        f"sequence {timestamps[0]}..{timestamps[-1]}: "
        f"crop={crop['width']}x{crop['height']} "
        f"union_nonzero_nodes={metadata['rain']['union_distinct_nonzero_nodes']}"
    )
    if observation["available"]:
        print(
            "observation diagnostic: "
            f"support_available={metadata['observation_coverage_diagnostic']['current_support_available_percent']:.6f}% "
            f"first_frame_outside={per_frame_coverage[0]['outside_observation']} "
            f"last_frame_outside={per_frame_coverage[-1]['outside_observation']} "
            "(not used as a rain mask)"
        )
    else:
        print("observation diagnostic: unavailable (not required and not used as a rain mask)")
    return 0


def convert_csv(args: argparse.Namespace) -> int:
    if Dataset is None or num2date is None:
        raise SystemExit("This offline converter requires the netCDF4 package. Install it outside this repository and retry.")
    source = args.source.resolve()
    if not source.is_file():
        raise SystemExit(f"source file does not exist: {source}")

    with Dataset(source, "r") as dataset:
        dataset.set_auto_mask(True)
        time_variable, longitude_variable, latitude_variable, precipitation = validate_source_contract(dataset)
        time_values = np.asarray(time_variable[:])
        if args.time_index < 0 or args.time_index >= time_values.size:
            raise SystemExit(
                f"time index {args.time_index} is outside 0..{time_values.size - 1}"
            )
        source_units, unit_basis, factor, conversion = resolve_precipitation_units(precipitation, args.assume_units)

        longitudes = np.asarray(longitude_variable[:], dtype=np.float64)
        latitudes = np.asarray(latitude_variable[:], dtype=np.float64)
        longitude_spacing, longitude_error = coordinate_spacing(longitudes, "longitude")
        latitude_spacing, latitude_error = coordinate_spacing(latitudes, "latitude")
        timestamp_values = decode_times(time_variable, time_values)
        timestamp = timestamp_values[args.time_index]
        masked_values = np.ma.asarray(precipitation[args.time_index, :, :])
        values = np.asarray(masked_values.filled(np.nan), dtype=np.float64)
        raw_stats = source_stats(values)
        stats = source_stats(values * factor)
        if stats["missing_cells"]:
            raise SystemExit(
                f"selected timestep contains {stats['missing_cells']} missing cells; "
                "the existing CSV contract cannot preserve missing values safely, so no CSV was written"
            )
        if stats["negative_cells"]:
            raise SystemExit(
                f"selected timestep contains {stats['negative_cells']} negative precipitation cells"
            )

        valid_min = attr(precipitation, "valid_min")
        valid_max = attr(precipitation, "valid_max")
        valid_range = attr(precipitation, "valid_range")
        if valid_min is not None and raw_stats["minimum_mmh"] < float(valid_min):
            raise ValueError("precipitation contains values below metadata valid_min")
        if valid_max is not None and raw_stats["maximum_mmh"] > float(valid_max):
            raise ValueError("precipitation contains values above metadata valid_max")
        if valid_range is not None and not (
            float(valid_range[0]) <= raw_stats["minimum_mmh"] <= float(valid_range[1])
            and float(valid_range[0]) <= raw_stats["maximum_mmh"] <= float(valid_range[1])
        ):
            raise ValueError("precipitation contains values outside metadata valid_range")

        output_stem = timestamp_filename(timestamp, source.stem)
        csv_path = args.output_dir / f"{output_stem}.csv"
        json_path = args.output_dir / f"{output_stem}.json"
        write_csv(csv_path, longitudes, latitudes, values, factor)
        metadata = build_metadata(
            source,
            dataset,
            precipitation,
            time_variable,
            timestamp_values,
            args.time_index,
            timestamp,
            longitudes,
            latitudes,
            longitude_spacing,
            latitude_spacing,
            longitude_error,
            latitude_error,
            stats,
            source_units,
            "mm/h",
            factor,
            conversion,
            unit_basis,
        )
        with json_path.open("w", encoding="utf-8") as handle:
            json.dump(metadata, handle, indent=2, sort_keys=True)
            handle.write("\n")

    print(f"wrote {csv_path} ({stats['valid_cells']} rows plus header)")
    print(f"wrote {json_path}")
    print(
        f"source timestep {timestamp}: min={stats['minimum_mmh']:.9g} "
        f"max={stats['maximum_mmh']:.9g} mean={stats['mean_mmh']:.9g} "
        f"non-zero={stats['non_zero_cells']}"
    )
    return 0


def main() -> int:
    args = parser().parse_args()
    return convert_sequence(args) if args.sequence else convert_csv(args)


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except (OSError, ValueError) as error:
        raise SystemExit(f"conversion failed: {error}") from error
