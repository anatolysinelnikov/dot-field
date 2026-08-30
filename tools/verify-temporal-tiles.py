#!/usr/bin/env python3
"""Validate the additive temporal-tile contract in a generated directory."""

from __future__ import annotations

import argparse
import importlib.util
import json
import sys
from pathlib import Path

_PREPARE_PATH = Path(__file__).with_name("prepare-latest-real-weather.py")
_SPEC = importlib.util.spec_from_file_location("dot_field_prepare", _PREPARE_PATH)
if _SPEC is None or _SPEC.loader is None:
    raise SystemExit(f"unable to load {_PREPARE_PATH}")
_MODULE = importlib.util.module_from_spec(_SPEC)
sys.modules[_SPEC.name] = _MODULE
_SPEC.loader.exec_module(_MODULE)
validate_generated_directory = _MODULE.validate_generated_directory


def main() -> int:
    repository_root = Path(__file__).resolve().parents[1]
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--directory", type=Path, default=repository_root / "data" / "generated" / "current")
    args = parser.parse_args()
    directory = args.directory.resolve()
    raw_metadata = json.loads((directory / "metadata.json").read_text(encoding="utf-8"))
    metadata = validate_generated_directory(directory, raw_metadata.get("generation_id"))
    tiles = metadata.get("temporal_tiles")
    if not tiles:
        raise SystemExit("generated directory has no temporal_tiles section")
    print(json.dumps({
        "generation_id": metadata.get("generation_id"),
        "contract_version": tiles["contract_version"],
        "geometric_tile_count": tiles["geometric_tile_count"],
        "emitted_tile_count": tiles["emitted_tile_count"],
        "rain_quantization": tiles["rain"]["quantization"],
        "validated": "all temporal tile bounds, payload values, halo overlaps, motion subgrids, gzip sidecars, and omission rules",
    }, indent=2, sort_keys=True))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
