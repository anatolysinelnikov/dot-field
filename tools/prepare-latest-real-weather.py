#!/usr/bin/env python3
"""Prepare the newest locally downloaded NetCDF sequence for the browser runtime.

NetCDF parsing and validation remain in convert-netcdf-weather.py. This tool
selects a source file by its filename timestamp, converts it, generates Brotli
transport sidecars, and publishes a complete sequence to data/generated/current/.
"""

from __future__ import annotations

import argparse
import re
import shutil
import subprocess
import sys
import tempfile
from datetime import datetime
from pathlib import Path


FILENAME_TIMESTAMP = "%Y%m%d%H%M"


def parse_arguments(repository_root: Path) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--nc-dir",
        type=Path,
        default=repository_root / "data" / "nc",
        help="directory containing manually downloaded NetCDF files",
    )
    parser.add_argument(
        "--output-dir",
        type=Path,
        default=repository_root / "data" / "generated" / "current",
        help="active generated sequence directory",
    )
    parser.add_argument(
        "--availability",
        type=Path,
        default=repository_root / "data" / "availability" / "available_region_latest.json",
        help="optional observation-coverage diagnostic GeoJSON",
    )
    parser.add_argument(
        "--assume-units",
        metavar="UNIT",
        help="pass an explicit precipitation unit assumption to the converter",
    )
    return parser.parse_args()


def select_latest_source(nc_dir: Path) -> Path:
    if not nc_dir.is_dir():
        raise SystemExit(f"NetCDF directory does not exist: {nc_dir}")
    candidates = sorted(nc_dir.glob("*.nc"))
    if not candidates:
        raise SystemExit(f"No .nc files found in {nc_dir}")

    dated: list[tuple[datetime, Path]] = []
    invalid = []
    for candidate in candidates:
        stem = candidate.name[:-3]
        if re.fullmatch(r"\d{12}", stem) is None:
            invalid.append(candidate.name)
            continue
        try:
            timestamp = datetime.strptime(stem, FILENAME_TIMESTAMP)
        except ValueError:
            invalid.append(candidate.name)
        else:
            dated.append((timestamp, candidate))
    if invalid:
        names = ", ".join(invalid)
        raise SystemExit(
            "Cannot safely select the newest NetCDF file: .nc filenames must use "
            f"YYYYMMDDHHMM.nc; invalid candidate(s): {names}"
        )
    if not dated:
        raise SystemExit(
            f"No valid YYYYMMDDHHMM.nc candidates found in {nc_dir}"
        )

    latest_timestamp = max(timestamp for timestamp, _ in dated)
    latest = [path for timestamp, path in dated if timestamp == latest_timestamp]
    if len(latest) != 1:
        names = ", ".join(path.name for path in latest)
        raise SystemExit(
            "Cannot safely select the newest NetCDF file: duplicate filename "
            f"timestamps ({names})"
        )
    return latest[0]


def replace_active_output(staging_dir: Path, output_dir: Path) -> None:
    output_dir.parent.mkdir(parents=True, exist_ok=True)
    if output_dir.exists() and not output_dir.is_dir():
        raise SystemExit(f"Active output path is not a directory: {output_dir}")

    backup_dir: Path | None = None
    try:
        if output_dir.exists():
            backup_dir = Path(tempfile.mkdtemp(prefix=".current-previous-", dir=output_dir.parent))
            backup_dir.rmdir()
            output_dir.rename(backup_dir)
        staging_dir.rename(output_dir)
    except Exception:
        if output_dir.exists() and output_dir.is_dir():
            shutil.rmtree(output_dir)
        if backup_dir is not None and backup_dir.exists():
            backup_dir.rename(output_dir)
        raise
    finally:
        if backup_dir is not None and backup_dir.exists():
            shutil.rmtree(backup_dir)


def main() -> int:
    repository_root = Path(__file__).resolve().parents[1]
    args = parse_arguments(repository_root)
    source = select_latest_source(args.nc_dir.resolve())
    output_dir = args.output_dir.resolve()
    generated_root = output_dir.parent
    generated_root.mkdir(parents=True, exist_ok=True)
    staging_dir = Path(tempfile.mkdtemp(prefix=".current-staging-", dir=generated_root))
    converter = repository_root / "tools" / "convert-netcdf-weather.py"
    brotli_generator = repository_root / "scripts" / "generate-brotli-sidecars.mjs"
    command = [
        sys.executable,
        str(converter),
        str(source),
        "--sequence",
        "--output-dir",
        str(staging_dir),
        "--availability",
        str(args.availability.resolve()),
    ]
    if args.assume_units:
        command.extend(["--assume-units", args.assume_units])

    print(f"selected source: {source.name}")
    try:
        subprocess.run(command, cwd=repository_root, check=True)
    except subprocess.CalledProcessError as error:
        shutil.rmtree(staging_dir, ignore_errors=True)
        raise SystemExit(f"weather preparation failed during conversion (exit {error.returncode})") from error
    except Exception:
        shutil.rmtree(staging_dir, ignore_errors=True)
        raise

    try:
        subprocess.run(
            ["node", str(brotli_generator), "--dir", str(staging_dir)],
            cwd=repository_root,
            check=True,
        )
    except subprocess.CalledProcessError as error:
        shutil.rmtree(staging_dir, ignore_errors=True)
        raise SystemExit(
            f"weather preparation failed during Brotli sidecar generation (exit {error.returncode})"
        ) from error
    except Exception:
        shutil.rmtree(staging_dir, ignore_errors=True)
        raise

    try:
        replace_active_output(staging_dir, output_dir)
    except Exception:
        shutil.rmtree(staging_dir, ignore_errors=True)
        raise

    print(f"active sequence: {output_dir}")
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except (OSError, ValueError) as error:
        raise SystemExit(f"weather preparation failed: {error}") from error
