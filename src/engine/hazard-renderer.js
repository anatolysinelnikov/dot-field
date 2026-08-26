import { mix } from './math.js';
import { intensityToStrength } from './precipitation-mapping.js';

export function geographicHazardRadiusForSeverity(layer, severity, spacing) {
  const strength = intensityToStrength(severity, layer);
  if (!(strength > 0)) return 0;
  return layer === 'hail'
    ? spacing * mix(0.34, 1.0, Math.pow(strength, 0.47))
    : spacing * mix(0.30, 0.72, Math.pow(strength, 0.47));
}

// Geographic Dots retains independent numeric storm and hail channels.
// This computes the winning glyph/radius mapping in one strength pass.
export function geographicHazardRadii(value, spacing, output) {
  const hailRadius = geographicHazardRadiusForSeverity('hail', value.hail, spacing);
  if (hailRadius > 0) {
    output.stormRadius = 0;
    output.hailRadius = hailRadius;
    return output;
  }
  output.hailRadius = 0;
  output.stormRadius = geographicHazardRadiusForSeverity('storm', value.storm, spacing);
  return output;
}
