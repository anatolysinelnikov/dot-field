import { mix } from './math.js';
import { intensityToStrength, resolveHazardState } from './lod.js';

export function hazardStateAppearance(value, hazardState, spacing) {
  if (hazardState <= 0) return { radius: 0, type: 'storm', color: '#FF00FF' };
  if (hazardState <= 3) {
    const strength = intensityToStrength(value.storm, 'storm');
    return {
      radius: spacing * mix(0.30, 0.72, Math.pow(strength, 0.47)),
      type: 'storm',
      color: '#FF00FF'
    };
  }

  const strength = intensityToStrength(value.hail, 'hail');
  return {
    radius: spacing * mix(0.34, 1.0, Math.pow(strength, 0.47)),
    type: 'hail',
    color: '#FFD400'
  };
}

// Geographic Dots retains independent numeric storm and hail channels, so it
// does not need the legacy Canvas appearance object or its discrete state.
// This computes the same winning glyph/radius mapping in one strength pass.
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

export function appendHazardPath(ctx, x, y, radius, type) {
  if (type === 'hail') {
    for (let point = 0; point < 6; point++) {
      const angle = -Math.PI / 2 + point * Math.PI / 3;
      const px = x + Math.cos(angle) * radius;
      const py = y + Math.sin(angle) * radius;
      if (point === 0) ctx.moveTo(px, py);
      else ctx.lineTo(px, py);
    }
    ctx.closePath();
    return;
  }

  const innerRadius = radius * 0.38;
  for (let point = 0; point < 8; point++) {
    const angle = -Math.PI / 2 + point * Math.PI / 4;
    const pointRadius = point % 2 === 0 ? radius : innerRadius;
    const px = x + Math.cos(angle) * pointRadius;
    const py = y + Math.sin(angle) * pointRadius;
    if (point === 0) ctx.moveTo(px, py);
    else ctx.lineTo(px, py);
  }
  ctx.closePath();
}

export function drawHazardLayer(ctx, samples, spacing) {
  ctx.globalAlpha = 1;
  for (const sample of samples) {
    const appearance = hazardStateAppearance(sample.value, sample.hazardState, spacing);
    if (appearance.radius <= 0) continue;
    ctx.fillStyle = appearance.color;
    ctx.beginPath();
    appendHazardPath(ctx, sample.sx, sample.sy, appearance.radius, appearance.type);
    ctx.fill();
  }
}

export function drawHazardMorph(ctx, samples, coarseSpacing, fineSpacing, progress) {
  ctx.globalAlpha = 1;
  for (const sample of samples) {
    const hazardState = resolveHazardState(sample.childValue);
    const parent = hazardStateAppearance(sample.childValue, hazardState, coarseSpacing);
    const child = hazardStateAppearance(sample.childValue, hazardState, fineSpacing);
    const radius = mix(parent.radius, child.radius, progress);
    if (radius <= 0) continue;

    const x = mix(sample.parentSx, sample.childSx, progress);
    const y = mix(sample.parentSy, sample.childSy, progress);
    ctx.fillStyle = child.color;
    ctx.beginPath();
    appendHazardPath(ctx, x, y, radius, child.type);
    ctx.fill();
  }
}
