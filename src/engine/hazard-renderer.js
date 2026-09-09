import { mix } from './math.js';
import { intensityToStrength, SQUALL_GRADE_THRESHOLDS, squallGradeForIntensity } from './precipitation-mapping.js';

export const DEFAULT_DOTS_HAZARD_SIZE_MAPPING = Object.freeze({
  storm: Object.freeze({ min: 0.30, max: 0.50 }),
  hail: Object.freeze({ min: 0.30, max: 0.60 }),
  squall: Object.freeze({ min: 0.40, max: 0.50 })
});

function threeGradeSize(min, max, progress) {
  const midpoint = (min + max) * 0.5;
  if (progress <= 0.5) return mix(min, midpoint, progress * 2);
  return mix(midpoint, max, (progress - 0.5) * 2);
}

// Dots keeps the weather channels independent until this presentation pass.
// The returned radii are mutually exclusive and follow the prototype's
// danger order: hurricane > squall > hail > storm.
export function geographicHazardRadii(value, spacing, output, mapping = DEFAULT_DOTS_HAZARD_SIZE_MAPPING) {
  output.stormRadius = 0;
  output.hailRadius = 0;
  output.squall1Radius = 0;
  output.squall2Radius = 0;
  output.squall3Radius = 0;
  output.hurricaneRadius = 0;

  const hurricaneStrength = intensityToStrength(value.hurricane, 'hurricane');
  if (hurricaneStrength > 0) {
    output.hurricaneRadius = spacing * 0.5;
    return output;
  }

  const squallStrength = intensityToStrength(value.squall, 'squall');
  if (squallStrength > 0) {
    const grade = squallGradeForIntensity(value.squall);
    const gradeStart = SQUALL_GRADE_THRESHOLDS[grade - 1];
    const gradeEnd = SQUALL_GRADE_THRESHOLDS[grade] ?? 1;
    const gradeProgress = Math.max(0, Math.min(1, (value.squall - gradeStart) / (gradeEnd - gradeStart)));
    const gradeProgression = (grade - 1 + Math.pow(gradeProgress, 0.45)) / 2;
    const radius = spacing * threeGradeSize(mapping.squall.min, mapping.squall.max, gradeProgression);
    output[`squall${grade}Radius`] = radius;
    return output;
  }

  const hailStrength = intensityToStrength(value.hail, 'hail');
  if (hailStrength > 0) {
    output.hailRadius = spacing * mix(mapping.hail.min, mapping.hail.max, Math.pow(hailStrength, 0.47));
    return output;
  }

  const stormStrength = intensityToStrength(value.storm, 'storm');
  output.stormRadius = stormStrength > 0
    ? spacing * threeGradeSize(mapping.storm.min, mapping.storm.max, Math.pow(stormStrength, 0.47))
    : 0;
  return output;
}
