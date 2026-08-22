import { BASE_GRID, TARGET_SPACING } from './config.js';
import { intensityAt } from './field.js';
import { clamp, mix, smoothstep } from './math.js';

// Shared immutable transfer floors. Keeping this object stable is important for
// direct geographic evaluation, which applies the transfer at every sample.
export const INTENSITY_THRESHOLDS = Object.freeze({ rain: 0.045, storm: 0.075, hail: 0.11 });

export function selectLOD(zoom, fieldPixels) {
  const baseCellPixels = fieldPixels * zoom / BASE_GRID;
  const continuous = Math.log2(TARGET_SPACING / Math.max(baseCellPixels, 0.001));
  return clamp(continuous, 0, 5);
}

export function sampleField(x, y, t, lod, travelX) {
  if (lod <= 0) return intensityAt(x, y, t, travelX); // Continuous function acts as fine interpolation.

  const span = Math.pow(2, lod) / BASE_GRID;
  const offsets = [-0.34, 0, 0.34];
  let rain = 0;
  let stormAvg = 0;
  let hailAvg = 0;
  let stormMax = 0;
  let hailMax = 0;
  let count = 0;

  for (const oy of offsets) {
    for (const ox of offsets) {
      const v = intensityAt(x + ox * span, y + oy * span, t, travelX);
      rain += v.rain;
      stormAvg += v.storm;
      hailAvg += v.hail;
      stormMax = Math.max(stormMax, v.storm);
      hailMax = Math.max(hailMax, v.hail);
      count++;
    }
  }

  // Aggregation rules: average rain; max-biased blend for storm and hail.
  return {
    rain: rain / count,
    storm: mix(stormAvg / count, stormMax, 0.58),
    hail: mix(hailAvg / count, hailMax, 0.72)
  };
}

export function intensityToStrength(intensity, layer, thresholds = INTENSITY_THRESHOLDS) {
  return smoothstep(thresholds[layer] * 0.45, 0.93, intensity);
}

export function resolveHazardState(value) {
  const stormStrength = intensityToStrength(value.storm, 'storm');
  const hailStrength = intensityToStrength(value.hail, 'hail');
  if (hailStrength > 0) return 3 + Math.max(1, Math.ceil(hailStrength * 3));
  if (stormStrength > 0) return Math.max(1, Math.ceil(stormStrength * 3));
  return 0;
}

export function resolveLODGroupHazardState(x, y, t, lod, travelX) {
  if (lod <= 0) return resolveHazardState(intensityAt(x, y, t, travelX));

  const childStep = Math.pow(2, lod - 1) / BASE_GRID;
  const childOffset = childStep * 0.5;
  let hasThunder = false;

  for (const offsetY of [-childOffset, childOffset]) {
    for (const offsetX of [-childOffset, childOffset]) {
      const childValue = sampleField(x + offsetX, y + offsetY, t, lod - 1, travelX);
      const childHazardState = resolveHazardState(childValue);
      if (childHazardState > 3) return 4;
      if (childHazardState > 0) hasThunder = true;
    }
  }

  return hasThunder ? 1 : 0;
}
