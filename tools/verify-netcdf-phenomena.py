#!/usr/bin/env python3
"""Focused source-contract checks for the optional GIMET-2010 phenomena channel."""

from pathlib import Path
import importlib.util

import numpy as np
from netCDF4 import Dataset


ROOT = Path(__file__).resolve().parents[1]
CONVERTER_PATH = ROOT / "tools" / "convert-netcdf-weather.py"
spec = importlib.util.spec_from_file_location("dot_field_converter", CONVERTER_PATH)
converter = importlib.util.module_from_spec(spec)
assert spec.loader is not None
spec.loader.exec_module(converter)


def check(condition, message):
    if not condition:
        raise AssertionError(message)


class FakePhenomenaVariable:
    def __init__(self, value):
        self.value = np.ma.asarray(value)

    def __getitem__(self, index):
        return self.value


source = ROOT / "data" / "nc" / "202609040920.nc"
with Dataset(source, "r") as dataset:
    dataset.set_auto_mask(True)
    _, _, _, intensity, phenomena = converter.validate_source_contract(dataset)
    check(phenomena is not None, "source must expose phenomena")
    check(phenomena.dimensions == ("time", "y", "x"), "phenomena dimensions must be (time, y, x)")
    check(phenomena.shape == intensity.shape, "phenomena grid must align with intensity")
    normalized = converter.read_validated_phenomena_frame(phenomena, 0)
    check(normalized.dtype == np.uint8, "normalized phenomena must be Uint8")
    check(set(np.unique(normalized)).issubset(converter.PHENOMENON_VALID_CODES), "source contains an unsupported phenomenon code")

masked = FakePhenomenaVariable(np.ma.array([[0.0, np.nan, 31.0]], mask=[[False, False, True]]))
normalized = converter.read_validated_phenomena_frame(masked, 0)
check(normalized.tolist() == [[0, 31, 31]], "NaN and masked source values must normalize to code 31")

for invalid in ([[1.5]], [[20.0]]):
    try:
        converter.read_validated_phenomena_frame(FakePhenomenaVariable(invalid), 0)
    except SystemExit:
        pass
    else:
        raise AssertionError(f"invalid phenomenon value was accepted: {invalid}")

all_codes = np.array([[*range(20), 31]], dtype=np.float64)
normalized = converter.read_validated_phenomena_frame(FakePhenomenaVariable(all_codes), 0)
check(normalized.tolist() == [[*range(20), 31]], "codes 0..19 and 31 must be preserved exactly")
print("NetCDF phenomena verification passed: source dimensions/grid, NaN and mask normalization, categorical rejection, and exact code preservation.")
