import { smoothstep } from './math.js';

const INTENSITY_THRESHOLDS = Object.freeze({
  storm: 0.075,
  hail: 0.11,
  squall: 0.08,
  hurricane: 0.18
});

const HAIL_GRADE_INTENSITY_THRESHOLDS = Object.freeze([0.20, 0.30]);

export function hailGradeForIntensity(intensity) {
  if (intensity >= HAIL_GRADE_INTENSITY_THRESHOLDS[1]) return 2;
  if (intensity >= HAIL_GRADE_INTENSITY_THRESHOLDS[0]) return 1;
  return 0;
}

export function intensityToStrength(intensity, layer, thresholds = INTENSITY_THRESHOLDS) {
  return smoothstep(thresholds[layer] * 0.45, 0.93, intensity);
}
