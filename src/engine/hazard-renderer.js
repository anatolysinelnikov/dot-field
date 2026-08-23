import { mix } from './math.js';
import { intensityToStrength } from './precipitation-mapping.js';

// Geographic Dots retains independent numeric storm and hail channels.
// This computes the winning glyph/radius mapping in one strength pass.
export function geographicHazardRadii(value, spacing, output) {
  const hailStrength = intensityToStrength(value.hail, 'hail');
  if (hailStrength > 0) {
    output.stormRadius = 0;
    output.hailRadius = spacing * mix(0.34, 1.0, Math.pow(hailStrength, 0.47));
    return output;
  }

  const stormStrength = intensityToStrength(value.storm, 'storm');
  output.hailRadius = 0;
  output.stormRadius = stormStrength > 0
    ? spacing * mix(0.30, 0.72, Math.pow(stormStrength, 0.47))
    : 0;
  return output;
}
