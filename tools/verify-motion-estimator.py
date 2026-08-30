#!/usr/bin/env python3
"""Deterministic fixture checks for the offline precipitation motion estimator."""

import importlib.util
from pathlib import Path

import numpy as np

module_path = Path(__file__).with_name("convert-netcdf-weather.py")
spec = importlib.util.spec_from_file_location("motion_converter", module_path)
converter = importlib.util.module_from_spec(spec)
assert spec.loader is not None
spec.loader.exec_module(converter)

height, width = 64, 80
source = np.zeros((height, width), dtype=np.float32)
source[20:32, 25:40] = 3
source[23:29, 29:36] = 12
dx, dy = 5, -3
target = np.zeros_like(source)
target[20 + dy:32 + dy, 25 + dx:40 + dx] = 3
target[23 + dy:29 + dy, 29 + dx:36 + dx] = 12

first = converter.estimate_motion_one_direction(source, target)
second = converter.estimate_motion_one_direction(source, target)
if first.tobytes() != second.tobytes():
    raise SystemExit("motion estimation is not byte deterministic")

grid_x = round(32 / converter.MOTION_GRID_SPACING)
grid_y = round(24 / converter.MOTION_GRID_SPACING)
estimated_dx = float(first[0, grid_y, grid_x])
estimated_dy = float(first[1, grid_y, grid_x])
if abs(estimated_dx - dx) > 1 or abs(estimated_dy - dy) > 1:
    raise SystemExit(f"translation recovery failed: expected ({dx}, {dy}), got ({estimated_dx}, {estimated_dy})")

print(f"Motion estimator verification passed: recovered ({estimated_dx:g}, {estimated_dy:g}) within one source node; output is byte deterministic.")
