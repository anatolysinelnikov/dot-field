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
            if key == "asset" and isinstance(child, str):
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
                if key == "asset" and isinstance(child, str):
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
    if resolved != directory.resolve() and directory.resolve() not in resolved.parents:
        raise SystemExit(f"manifest asset escapes its generation: {asset}")
    return resolved


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
    phenomena = metadata.get("phenomena") or {}
    if metadata.get("channels", {}).get("phenomena") != (phenomena.get("available") is True):
        raise SystemExit("generated phenomena availability does not match channels.phenomena")
    if phenomena.get("available") is True:
        phenomenon_assets = phenomena.get("frame_assets")
        if not isinstance(phenomenon_assets, list) or frame_count != len(phenomenon_assets):
            raise SystemExit("generated phenomena frame assets do not match the metadata frame count")
        if phenomena.get("frame_byte_length") != frame_node_count:
            raise SystemExit("generated phenomena metadata has an invalid frame byte length")
        for asset in phenomenon_assets:
            path = resolve_manifest_asset(directory, asset, expected_generation_id)
            if path.stat().st_size != frame_node_count:
                raise SystemExit(f"generated phenomena frame has the wrong byte length: {path}")
    elif phenomena.get("frame_assets") not in (None, []):
        raise SystemExit("unavailable phenomena frame assets must be empty")
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
