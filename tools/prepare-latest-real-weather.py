#!/usr/bin/env python3
"""Prepare the newest locally downloaded NetCDF sequence for the browser runtime.

NetCDF parsing and validation remain in convert-netcdf-weather.py. This tool
selects a source file by its filename timestamp, converts it, generates gzip
transport sidecars, validates an unpublished staging directory, and publishes
an immutable generation before atomically replacing current/metadata.json.
"""

from __future__ import annotations

import argparse
import copy
import hashlib
import json
import re
import shutil
import subprocess
import sys
import tempfile
from datetime import datetime
from pathlib import Path
from posixpath import normpath

import numpy as np

from temporal_tiles import (
    TEMPORAL_TILE_CONTRACT,
    tile_supports_weather,
    tiles_for_grid,
)


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
        help="active generated metadata directory",
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


def read_metadata(directory: Path) -> dict:
    metadata_path = directory / "metadata.json"
    try:
        with metadata_path.open("r", encoding="utf-8") as handle:
            metadata = json.load(handle)
    except (OSError, json.JSONDecodeError) as error:
        raise SystemExit(f"generated metadata is invalid: {metadata_path}: {error}") from error
    if not isinstance(metadata, dict):
        raise SystemExit(f"generated metadata must be a JSON object: {metadata_path}")
    return metadata


def map_manifest_assets(value: object, mapper) -> object:
    if isinstance(value, dict):
        mapped = {}
        for key, child in value.items():
            if (key == "asset" or key.endswith("_asset")) and isinstance(child, str):
                mapped[key] = mapper(child)
            elif key.endswith("_assets") and isinstance(child, list):
                mapped[key] = [mapper(asset) if isinstance(asset, str) else asset for asset in child]
            else:
                mapped[key] = map_manifest_assets(child, mapper)
        return mapped
    if isinstance(value, list):
        return [map_manifest_assets(child, mapper) for child in value]
    return value


def manifest_asset_references(metadata: dict) -> list[str]:
    references: list[str] = []

    def collect(value: object) -> object:
        if isinstance(value, dict):
            for key, child in value.items():
                if (key == "asset" or key.endswith("_asset")) and isinstance(child, str):
                    references.append(child)
                elif key.endswith("_assets") and isinstance(child, list):
                    references.extend(asset for asset in child if isinstance(asset, str))
                else:
                    collect(child)
        elif isinstance(value, list):
            for child in value:
                collect(child)
        return value

    collect(metadata)
    return references


def resolve_manifest_asset(
    directory: Path,
    asset: str,
    expected_generation_id: str | None = None,
) -> Path:
    path = Path(asset)
    generation_relative = (
        expected_generation_id is not None
        and len(path.parts) >= 3
        and path.parts[0] == ".."
        and path.parts[1] == expected_generation_id
    )
    if path.is_absolute() or (".." in path.parts and not generation_relative):
        raise SystemExit(f"manifest asset must be a relative path inside its generation: {asset}")
    resolved = (directory / path).resolve()
    allowed_generation_root = directory.parent.resolve() / expected_generation_id if generation_relative else directory.resolve()
    if resolved != allowed_generation_root and allowed_generation_root not in resolved.parents:
        raise SystemExit(f"manifest asset escapes its generation: {asset}")
    return resolved


def validate_temporal_tiles(directory: Path, metadata: dict, expected_generation_id: str | None) -> None:
    section = metadata.get("temporal_tiles")
    if section is None:
        return
    if section.get("contract_version") != TEMPORAL_TILE_CONTRACT:
        raise SystemExit("unsupported temporal tile contract version")
    grid = metadata.get("spatial_grid") or {}
    width, height = grid.get("width"), grid.get("height")
    frame_count = (metadata.get("time") or {}).get("count")
    if section.get("tile_interior_source_nodes") != 128:
        raise SystemExit("temporal tile interior dimensions are invalid")
    motion_descriptor = metadata.get("motion") or {}
    motion_width, motion_height = motion_descriptor.get("grid_width"), motion_descriptor.get("grid_height")
    rain_halo = section.get("rain_halo_source_nodes")
    if not isinstance(rain_halo, int) or rain_halo < 1:
        raise SystemExit("temporal tile rain halo is invalid")
    motion_assets = motion_descriptor.get("interval_assets", [])
    motion_paths_for_halo = [resolve_manifest_asset(directory, asset, expected_generation_id) for asset in motion_assets]
    maximum_motion_component = max(float(np.max(np.abs(np.fromfile(path, dtype="<f4")))) for path in motion_paths_for_halo)
    if rain_halo != int(np.ceil(maximum_motion_component)) + 1:
        raise SystemExit("temporal tile rain halo is not conservative for the motion assets")
    expected_tiles = tiles_for_grid(width, height, motion_width, motion_height, rain_halo)
    if section.get("geometric_tile_count") != len(expected_tiles):
        raise SystemExit("temporal tile geometric count is invalid")
    expected_by_id = {f"{tile.tile_x},{tile.tile_y}": tile for tile in expected_tiles}
    tile_records = section.get("tiles")
    if not isinstance(tile_records, list) or len(tile_records) != section.get("emitted_tile_count"):
        raise SystemExit("temporal tile emitted count is invalid")
    support_descriptor = metadata.get("support_mask") or {}
    support_path = resolve_manifest_asset(directory, support_descriptor["asset"], expected_generation_id)
    support_bytes = np.frombuffer(support_path.read_bytes(), dtype=np.uint8)
    support = np.unpackbits(support_bytes, bitorder="little")[:width * height].reshape(height, width).astype(bool)
    frame_paths = [resolve_manifest_asset(directory, asset, expected_generation_id) for asset in (metadata.get("rain") or {}).get("frame_assets", [])]
    frames = [np.fromfile(path, dtype="<f4").reshape(height, width) for path in frame_paths]
    motion_paths = motion_paths_for_halo
    motion_intervals = [np.fromfile(path, dtype="<f4").reshape(4, motion_descriptor["grid_height"], motion_descriptor["grid_width"]) for path in motion_paths]
    seen = set()
    for record in tile_records:
        tile_id = record.get("id")
        if tile_id in seen or tile_id not in expected_by_id:
            raise SystemExit("temporal tile identities are duplicate or outside the deterministic grid")
        seen.add(tile_id)
        tile = expected_by_id[tile_id]
        interior = record.get("interior") or {}
        rain = record.get("rain") or {}
        motion = record.get("motion") or {}
        expected_interior = {"x_start": tile.interior_x, "x_end": tile.interior_x + tile.interior_width - 1, "y_start": tile.interior_y, "y_end": tile.interior_y + tile.interior_height - 1, "width": tile.interior_width, "height": tile.interior_height}
        if interior != expected_interior:
            raise SystemExit(f"temporal tile {tile_id} has inconsistent interior bounds")
        for key, value in {"stored_x_start": tile.stored_x, "stored_y_start": tile.stored_y, "stored_width": tile.stored_width, "stored_height": tile.stored_height}.items():
            if rain.get(key) != value:
                raise SystemExit(f"temporal tile {tile_id} has inconsistent rain bounds")
        for key, value in {"grid_x_start": tile.motion_x, "grid_y_start": tile.motion_y, "grid_width": tile.motion_width, "grid_height": tile.motion_height}.items():
            if motion.get(key) != value:
                raise SystemExit(f"temporal tile {tile_id} has inconsistent motion bounds")
        if not tile_supports_weather(tile, support):
            raise SystemExit(f"temporal tile {tile_id} is emitted despite empty motion-safe support")
        rain_path = resolve_manifest_asset(directory, rain["asset"], expected_generation_id)
        rain_values = np.fromfile(rain_path, dtype="<f2")
        expected_count = frame_count * tile.stored_width * tile.stored_height
        if rain_values.size != expected_count or rain.get("byte_length") != expected_count * 2:
            raise SystemExit(f"temporal tile {tile_id} has invalid rain payload length")
        expected_rain = np.stack([frame[tile.stored_y:tile.stored_y + tile.stored_height, tile.stored_x:tile.stored_x + tile.stored_width] for frame in frames]).astype("<f2").reshape(-1)
        if not np.array_equal(rain_values, expected_rain) or not np.all(np.isfinite(rain_values)) or np.any(rain_values < 0):
            raise SystemExit(f"temporal tile {tile_id} rain payload does not match Float16 source conversion")
        motion_path = resolve_manifest_asset(directory, motion["asset"], expected_generation_id)
        motion_values = np.fromfile(motion_path, dtype="<f4")
        expected_motion = np.stack([interval[:, tile.motion_y:tile.motion_y + tile.motion_height, tile.motion_x:tile.motion_x + tile.motion_width] for interval in motion_intervals]).astype("<f4").reshape(-1)
        if motion_values.size != expected_motion.size or motion.get("byte_length") != expected_motion.size * 4 or not np.array_equal(motion_values, expected_motion):
            raise SystemExit(f"temporal tile {tile_id} motion payload does not match global motion assets")
    for tile in expected_tiles:
        if f"{tile.tile_x},{tile.tile_y}" not in seen and tile_supports_weather(tile, support):
            raise SystemExit(f"motion-relevant temporal tile {tile.tile_x},{tile.tile_y} was omitted")


def validate_generated_directory(directory: Path, expected_generation_id: str | None = None) -> dict:
    metadata = read_metadata(directory)
    generation_id = metadata.get("generation_id")
    if expected_generation_id is not None and generation_id != expected_generation_id:
        raise SystemExit(
            f"published generation metadata has the wrong generation_id: "
            f"expected {expected_generation_id!r}, received {generation_id!r}"
        )
    references = manifest_asset_references(metadata)
    if not references:
        raise SystemExit(f"generated metadata has no asset references: {directory / 'metadata.json'}")
    resolved_assets = [
        resolve_manifest_asset(directory, asset, expected_generation_id)
        for asset in references
    ]
    for asset, path in zip(references, resolved_assets):
        if not path.is_file():
            raise SystemExit(f"generated manifest asset is missing: {asset}")
        sidecar = Path(f"{path}.gz")
        if not sidecar.is_file():
            raise SystemExit(f"generated gzip sidecar is missing: {sidecar}")

    grid = metadata.get("spatial_grid") or {}
    frame_node_count = grid.get("width", 0) * grid.get("height", 0)
    support_mask = metadata.get("support_mask") or {}
    if support_mask.get("byte_length") != (frame_node_count + 7) // 8:
        raise SystemExit("generated support mask metadata has an invalid byte length")
    support_asset = support_mask.get("asset")
    if not isinstance(support_asset, str):
        raise SystemExit("generated support mask metadata has no asset")
    support_path = resolve_manifest_asset(directory, support_asset, expected_generation_id)
    if support_path.stat().st_size != support_mask["byte_length"]:
        raise SystemExit(f"generated support mask has the wrong byte length: {support_path}")

    rain = metadata.get("rain") or {}
    frame_assets = rain.get("frame_assets")
    frame_count = (metadata.get("time") or {}).get("count")
    if not isinstance(frame_assets, list) or frame_count != len(frame_assets):
        raise SystemExit("generated rain frame assets do not match the metadata frame count")
    expected_frame_bytes = rain.get("frame_byte_length")
    if expected_frame_bytes != frame_node_count * 4:
        raise SystemExit("generated rain metadata has an invalid frame byte length")
    for asset in frame_assets:
        path = resolve_manifest_asset(directory, asset, expected_generation_id)
        if path.stat().st_size != expected_frame_bytes:
            raise SystemExit(f"generated rain frame has the wrong byte length: {path}")
    validate_temporal_tiles(directory, metadata, expected_generation_id)
    return metadata


def identity_metadata(metadata: dict, generation_id: str | None = None) -> dict:
    normalized = copy.deepcopy(metadata)
    normalized.pop("generation_id", None)
    source = normalized.get("source")
    if isinstance(source, dict):
        # The source filename is provenance, not generated dataset content.
        source.pop("filename", None)

    def normalize_asset(asset: str) -> str:
        if generation_id is None:
            return asset
        parts = Path(asset).as_posix().split("/")
        if len(parts) >= 3 and parts[0] == ".." and parts[1] == generation_id:
            return "/".join(parts[2:])
        return asset

    return map_manifest_assets(normalized, normalize_asset)


def canonical_metadata(metadata: dict, generation_id: str | None = None) -> bytes:
    return json.dumps(
        identity_metadata(metadata, generation_id),
        ensure_ascii=True,
        sort_keys=True,
        separators=(",", ":"),
    ).encode("utf-8")


def logical_files(directory: Path) -> list[Path]:
    # Exclude both the new gzip sidecars and legacy Brotli sidecars from the
    # logical weather digest during the transport migration.
    return sorted(
        path for path in directory.rglob("*")
        if path.is_file()
        and path.name != "metadata.json"
        and not path.name.endswith((".gz", ".br"))
    )


def update_digest(digest, path: Path, relative_path: str) -> None:
    digest.update(relative_path.encode("utf-8"))
    digest.update(b"\0")
    with path.open("rb") as handle:
        while chunk := handle.read(1024 * 1024):
            digest.update(chunk)
    digest.update(b"\0")


def generation_digest(directory: Path, metadata: dict) -> str:
    digest = hashlib.sha256()
    digest.update(b"dot-field-generated-weather-v2\0")
    metadata_bytes = canonical_metadata(metadata)
    digest.update(b"metadata.json\0")
    digest.update(metadata_bytes)
    digest.update(b"\0")
    for path in logical_files(directory):
        update_digest(digest, path, path.relative_to(directory).as_posix())
    return digest.hexdigest()


def generation_id_for(directory: Path, metadata: dict) -> str:
    return f"generation-{generation_digest(directory, metadata)[:16]}"


def generation_asset_path(asset: str, generation_id: str) -> str:
    normalized = normpath(asset)
    if normalized.startswith("../") or normalized == ".." or Path(normalized).is_absolute():
        raise SystemExit(f"manifest asset cannot be rewritten safely: {asset}")
    return f"../{generation_id}/{normalized}"


def rewrite_generation_metadata(directory: Path, metadata: dict, generation_id: str) -> dict:
    rewritten = map_manifest_assets(metadata, lambda asset: generation_asset_path(asset, generation_id))
    rewritten["generation_id"] = generation_id
    with (directory / "metadata.json").open("w", encoding="utf-8") as handle:
        json.dump(rewritten, handle, ensure_ascii=True, indent=2, sort_keys=True)
        handle.write("\n")
    return rewritten


def file_digest(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        while chunk := handle.read(1024 * 1024):
            digest.update(chunk)
    return digest.hexdigest()


def verify_existing_generation(
    generation_dir: Path,
    generation_id: str,
    staged_metadata: dict,
    staged_dir: Path,
) -> dict:
    existing_metadata = validate_generated_directory(generation_dir, generation_id)
    if canonical_metadata(existing_metadata, generation_id) != canonical_metadata(staged_metadata):
        raise SystemExit(f"existing generation has inconsistent metadata: {generation_dir}")
    staged_references = manifest_asset_references(staged_metadata)
    existing_references = manifest_asset_references(existing_metadata)
    if len(staged_references) != len(existing_references):
        raise SystemExit(f"existing generation has inconsistent asset references: {generation_dir}")
    for staged_asset, existing_asset in zip(staged_references, existing_references):
        staged_path = resolve_manifest_asset(staged_dir, staged_asset)
        existing_path = (generation_dir / existing_asset).resolve()
        if file_digest(staged_path) != file_digest(existing_path):
            raise SystemExit(f"existing generation asset differs: {existing_asset}")
        staged_sidecar = Path(f"{staged_path}.gz")
        existing_sidecar = Path(f"{existing_path}.gz")
        if file_digest(staged_sidecar) != file_digest(existing_sidecar):
            raise SystemExit(f"existing generation gzip sidecar differs: {existing_asset}.gz")
    return existing_metadata


def main() -> int:
    repository_root = Path(__file__).resolve().parents[1]
    args = parse_arguments(repository_root)
    source = select_latest_source(args.nc_dir.resolve())
    output_dir = args.output_dir.resolve()
    generated_root = output_dir.parent
    generated_root.mkdir(parents=True, exist_ok=True)
    staging_dir: Path | None = Path(tempfile.mkdtemp(prefix=".generation-staging-", dir=generated_root))
    current_staging_dir: Path | None = None
    converter = repository_root / "tools" / "convert-netcdf-weather.py"
    gzip_generator = repository_root / "scripts" / "generate-gzip-sidecars.mjs"
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
            ["node", str(gzip_generator), "--dir", str(staging_dir)],
            cwd=repository_root,
            check=True,
        )
    except subprocess.CalledProcessError as error:
        shutil.rmtree(staging_dir, ignore_errors=True)
        raise SystemExit(
            f"weather preparation failed during gzip sidecar generation (exit {error.returncode})"
        ) from error
    except Exception:
        shutil.rmtree(staging_dir, ignore_errors=True)
        raise

    try:
        staged_metadata = validate_generated_directory(staging_dir)
        generation_id = generation_id_for(staging_dir, staged_metadata)
        generation_dir = generated_root / generation_id
        if generation_dir.exists():
            verify_existing_generation(generation_dir, generation_id, staged_metadata, staging_dir)
            shutil.rmtree(staging_dir)
            staging_dir = None
        else:
            rewrite_generation_metadata(staging_dir, staged_metadata, generation_id)
            try:
                staging_dir.rename(generation_dir)
            except FileExistsError:
                verify_existing_generation(generation_dir, generation_id, staged_metadata, staging_dir)
                shutil.rmtree(staging_dir)
            staging_dir = None
            validate_generated_directory(generation_dir, generation_id)

        current_staging_dir = Path(tempfile.mkdtemp(prefix=".current-staging-", dir=generated_root))
        shutil.copy2(generation_dir / "metadata.json", current_staging_dir / "metadata.json")
        replace_active_output(current_staging_dir, output_dir)
        current_staging_dir = None
    finally:
        if staging_dir is not None and staging_dir.exists():
            shutil.rmtree(staging_dir, ignore_errors=True)
        if current_staging_dir is not None and current_staging_dir.exists():
            shutil.rmtree(current_staging_dir, ignore_errors=True)

    print(f"immutable generation: {generation_dir}")
    print(f"active sequence: {output_dir}")
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except (OSError, ValueError) as error:
        raise SystemExit(f"weather preparation failed: {error}") from error
