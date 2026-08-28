#!/usr/bin/env python3
"""Download the newest valid real-weather NetCDF object from MinIO."""

from __future__ import annotations

import argparse
import json
import os
import re
import tempfile
from dataclasses import dataclass
from datetime import datetime
from pathlib import Path
from urllib.parse import urlsplit


CONFIG_PATH = Path.home() / ".config" / "dot-field" / "minio.json"
FILENAME_PATTERN = re.compile(r"^(\d{12})\.nc$")
TIMESTAMP_FORMAT = "%Y%m%d%H%M"


@dataclass(frozen=True)
class Config:
    endpoint: str
    bucket: str
    prefix: str
    access_key: str
    secret_key: str
    host: str
    secure: bool


@dataclass(frozen=True)
class RemoteObject:
    key: str
    name: str
    timestamp: datetime
    size: int


def parse_arguments() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--config",
        type=Path,
        default=CONFIG_PATH,
        help=f"local credentials config (default: {CONFIG_PATH})",
    )
    parser.add_argument(
        "--nc-dir",
        type=Path,
        default=Path(__file__).resolve().parents[1] / "data" / "nc",
        help="local NetCDF directory",
    )
    return parser.parse_args()


def load_config(path: Path) -> Config:
    try:
        raw = json.loads(path.read_text(encoding="utf-8"))
    except FileNotFoundError as error:
        raise SystemExit(f"MinIO configuration is missing: edit {path}") from error
    except (OSError, json.JSONDecodeError) as error:
        raise SystemExit(f"Cannot read MinIO configuration {path}: {error}") from error

    if not isinstance(raw, dict):
        raise SystemExit(f"MinIO configuration must be a JSON object: {path}")
    values = {}
    for name in ("endpoint", "bucket", "prefix", "accessKey", "secretKey"):
        value = raw.get(name)
        if not isinstance(value, str):
            raise SystemExit(f"MinIO configuration field {name!r} must be a string: {path}")
        values[name] = value

    try:
        endpoint = urlsplit(values["endpoint"])
        endpoint_port = endpoint.port
    except ValueError as error:
        raise SystemExit(f"MinIO endpoint is malformed: {error}") from error
    if endpoint.scheme not in {"http", "https"} or not endpoint.hostname:
        raise SystemExit(
            "MinIO endpoint must be a complete http:// or https:// URL with a host"
        )
    if endpoint.username or endpoint.password or endpoint.path not in {"", "/"}:
        raise SystemExit("MinIO endpoint must not contain credentials or a URL path")
    if endpoint.query or endpoint.fragment:
        raise SystemExit("MinIO endpoint must not contain a query or fragment")
    if not values["bucket"]:
        raise SystemExit("MinIO bucket must not be empty")
    if not values["accessKey"]:
        raise SystemExit("MinIO accessKey must not be empty")
    if not values["secretKey"]:
        raise SystemExit(f"MinIO secretKey is empty; edit {path}")

    host = endpoint.hostname
    if endpoint_port is not None:
        host = f"{host}:{endpoint_port}"
    return Config(
        endpoint=values["endpoint"],
        bucket=values["bucket"],
        prefix=values["prefix"],
        access_key=values["accessKey"],
        secret_key=values["secretKey"],
        host=host,
        secure=endpoint.scheme == "https",
    )


def remote_candidates(objects: list[object]) -> list[RemoteObject]:
    candidates: list[RemoteObject] = []
    for item in objects:
        key = getattr(item, "object_name", "")
        name = Path(key).name
        match = FILENAME_PATTERN.fullmatch(name)
        if match is None:
            continue
        try:
            timestamp = datetime.strptime(match.group(1), TIMESTAMP_FORMAT)
        except ValueError:
            continue
        size = getattr(item, "size", None)
        if not isinstance(size, int) or size < 0:
            continue
        candidates.append(RemoteObject(key, name, timestamp, size))
    return candidates


def select_latest(objects: list[object]) -> RemoteObject:
    candidates = remote_candidates(objects)
    if not candidates:
        raise SystemExit("No valid YYYYMMDDHHMM.nc objects found in the configured bucket/prefix")
    newest_timestamp = max(item.timestamp for item in candidates)
    newest = [item for item in candidates if item.timestamp == newest_timestamp]
    if len(newest) != 1:
        keys = ", ".join(sorted(item.key for item in newest))
        raise SystemExit(f"Multiple newest NetCDF objects have the same timestamp: {keys}")
    return newest[0]


def download(client: object, bucket: str, remote: RemoteObject, nc_dir: Path) -> Path:
    nc_dir.mkdir(parents=True, exist_ok=True)
    destination = nc_dir / remote.name
    if destination.is_file() and destination.stat().st_size == remote.size:
        print(f"already local: {destination}")
        return destination

    temporary_path: Path | None = None
    response = None
    try:
        with tempfile.NamedTemporaryFile(
            mode="wb", prefix=f".{remote.name}.", suffix=".part", dir=nc_dir, delete=False
        ) as temporary:
            temporary_path = Path(temporary.name)
            response = client.get_object(bucket, remote.key)
            while True:
                chunk = response.read(1024 * 1024)
                if not chunk:
                    break
                temporary.write(chunk)
            temporary.flush()
            os.fsync(temporary.fileno())
        if temporary_path.stat().st_size != remote.size:
            raise RuntimeError(
                f"downloaded byte count does not match remote object size "
                f"({temporary_path.stat().st_size} != {remote.size})"
            )
        os.replace(temporary_path, destination)
        temporary_path = None
    finally:
        if response is not None:
            response.close()
            response.release_conn()
        if temporary_path is not None:
            temporary_path.unlink(missing_ok=True)
    print(f"downloaded: {destination}")
    return destination


def main() -> int:
    args = parse_arguments()
    config = load_config(args.config.expanduser().resolve())
    try:
        from minio import Minio
    except ImportError as error:
        raise SystemExit("MinIO client dependency is unavailable; run update.command first") from error

    client = Minio(
        config.host,
        access_key=config.access_key,
        secret_key=config.secret_key,
        secure=config.secure,
    )
    print(f"connecting to newest remote object in {config.bucket}/{config.prefix}")
    try:
        objects = list(
            client.list_objects(config.bucket, prefix=config.prefix, recursive=True)
        )
        remote = select_latest(objects)
        print(f"selected source: {remote.name}")
        download(client, config.bucket, remote, args.nc_dir.expanduser().resolve())
    except SystemExit:
        raise
    except Exception as error:
        raise SystemExit(f"real-weather download failed: {error}") from error
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
