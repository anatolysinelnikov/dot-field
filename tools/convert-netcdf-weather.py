#!/usr/bin/env python3
"""Convert one NetCDF weather timestep to Dot Field's normalized CSV.

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
from typing import Any

try:
    import numpy as np
    from netCDF4 import Dataset, num2date
except ImportError as error:  # pragma: no cover - depends on the local machine
    raise SystemExit(
        "This offline converter requires Python packages netCDF4 and NumPy. "
        "Install them outside the repository and retry."
    ) from error


SCHEMA_VERSION = "dot-field-normalized-weather-v1"
CSV_COLUMNS = ("lon", "lat", "mmh", "thunderstorm", "hail")
REGULAR_SPACING_TOLERANCE = 2e-5
FLOAT_FORMAT = ".9g"
COORDINATE_FORMAT = ".17g"


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


def main() -> int:
    args = parser().parse_args()
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
        source_units = attr(precipitation, "units")
        if source_units is None:
            if args.assume_units is None:
                raise SystemExit(
                    "source variable intensity has no units metadata; refusing to "
                    "label values as mm/h. Re-run with an explicit assumption, "
                    "for example --assume-units mm/h, after verifying the source semantics."
                )
            effective_units = args.assume_units
            unit_basis = f"explicit command-line assumption: {args.assume_units}"
        else:
            if args.assume_units is not None:
                raise SystemExit("--assume-units may only be used when source units metadata is absent")
            effective_units = str(source_units)
            unit_basis = "source units metadata"
        factor, conversion = unit_factor_to_mmh(effective_units)

        longitudes = np.asarray(longitude_variable[:], dtype=np.float64)
        latitudes = np.asarray(latitude_variable[:], dtype=np.float64)
        longitude_spacing, longitude_error = coordinate_spacing(longitudes, "longitude")
        latitude_spacing, latitude_error = coordinate_spacing(latitudes, "latitude")
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
        timestamp_values = [decoded_timestamp(item) for item in timestamps]
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
            str(source_units) if source_units is not None else None,
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


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except (OSError, ValueError) as error:
        raise SystemExit(f"conversion failed: {error}") from error
