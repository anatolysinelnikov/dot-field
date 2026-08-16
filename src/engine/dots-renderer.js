import { BASE_GRID, GRID_OVERSCAN_CELLS, RAIN_BLUE, RAIN_MODERATE_MAX, STRONG_PRECIPITATION_BLUE } from './config.js';
import { clamp, mix, smoothstep } from './math.js';
import { sampleField, intensityToStrength, resolveHazardState, resolveLODGroupHazardState } from './lod.js';

export function intensityToRadius(intensity, spacing, layer) {
  // Adjust thresholds and radius mapping here. Rain intentionally overlaps most.
  const thresholds = { rain: 0.045, storm: 0.075, hail: 0.11 };
  // Ease through the visibility floor instead of switching a dot on abruptly.
  const normalized = intensityToStrength(intensity, layer, thresholds);
  const overlap = layer === 'rain' ? 0.86 : layer === 'storm' ? 0.72 : 0.59;
  return spacing * overlap * Math.pow(normalized, layer === 'rain' ? 0.47 : 0.56);
}
export function strongPrecipitationIntensity(rainIntensity) {
  return clamp((rainIntensity - RAIN_MODERATE_MAX) / (1 - RAIN_MODERATE_MAX));
}

function hazardStateAppearance(value, hazardState, spacing) {
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

function appendHazardPath(ctx, x, y, radius, type) {
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

function drawLayer(ctx, samples, key, color, spacing) {
  ctx.fillStyle = color;
  ctx.globalAlpha = 1;
  ctx.beginPath();
  for (const sample of samples) {
    const radius = intensityToRadius(sample.value[key], spacing, key);
    if (radius <= 0) continue;
    ctx.moveTo(sample.sx + radius, sample.sy);
    ctx.arc(sample.sx, sample.sy, radius, 0, Math.PI * 2);
  }
  ctx.fill();
}

function drawHazardLayer(ctx, samples, spacing) {
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

function drawStrongPrecipitationLayer(ctx, samples, spacing) {
  ctx.fillStyle = STRONG_PRECIPITATION_BLUE;
  ctx.globalAlpha = 1;
  ctx.beginPath();
  for (const sample of samples) {
    const intensity = strongPrecipitationIntensity(sample.value.rain);
    const radius = intensityToRadius(intensity, spacing, 'rain');
    if (radius <= 0) continue;
    ctx.moveTo(sample.sx + radius, sample.sy);
    ctx.arc(sample.sx, sample.sy, radius, 0, Math.PI * 2);
  }
  ctx.fill();
}

// Blur modes reconstruct continuous fields from fixed base-grid samples.
// Smoothing happens on scalar intensities before any color is applied; this
export function renderLOD(ctx, viewport, lod, t, travelX, fieldPixels, centerX, centerY) {
  const step = Math.pow(2, lod) / BASE_GRID;
  const spacing = step * fieldPixels * viewport.zoom;
  const bounds = viewport.bounds;

  // The lattice is unbounded and anchored to world origin; only the browser clips it.
  const startI = Math.floor(bounds.minX / step) - GRID_OVERSCAN_CELLS;
  const endI = Math.ceil(bounds.maxX / step) + GRID_OVERSCAN_CELLS;
  const startJ = Math.floor(bounds.minY / step) - GRID_OVERSCAN_CELLS;
  const endJ = Math.ceil(bounds.maxY / step) + GRID_OVERSCAN_CELLS;
  const samples = [];

  for (let j = startJ; j < endJ; j++) {
    const y = (j + 0.5) * step;
    for (let i = startI; i < endI; i++) {
      const x = (i + 0.5) * step;
      const sx = centerX + (x - 0.5) * fieldPixels * viewport.zoom;
      const sy = centerY + (y - 0.5) * fieldPixels * viewport.zoom;
      const value = sampleField(x, y, t, lod, travelX);
      const hazardState = lod > 0
        ? resolveLODGroupHazardState(x, y, t, lod, travelX)
        : resolveHazardState(value);
      samples.push({ sx, sy, value, hazardState });
    }
  }

  // Required order: rain → strong precipitation → composite hazard.
  drawLayer(ctx, samples, 'rain', RAIN_BLUE, spacing);
  drawStrongPrecipitationLayer(ctx, samples, spacing);
  drawHazardLayer(ctx, samples, spacing);
}
function drawMorphLayer(ctx, samples, key, color, coarseSpacing, fineSpacing, progress) {
  ctx.fillStyle = color;
  ctx.globalAlpha = 1;
  ctx.beginPath();

  for (const sample of samples) {
    const parentRadius = intensityToRadius(sample.parentValue[key], coarseSpacing, key);
    const childRadius = intensityToRadius(sample.childValue[key], fineSpacing, key);
    const radius = mix(parentRadius, childRadius, progress);
    if (radius <= 0) continue;

    const x = mix(sample.parentSx, sample.childSx, progress);
    const y = mix(sample.parentSy, sample.childSy, progress);
    ctx.moveTo(x + radius, y);
    ctx.arc(x, y, radius, 0, Math.PI * 2);
  }

  ctx.fill();
}

function drawHazardMorph(ctx, samples, coarseSpacing, fineSpacing, progress) {
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

function drawStrongPrecipitationMorph(ctx, samples, coarseSpacing, fineSpacing, progress) {
  ctx.fillStyle = STRONG_PRECIPITATION_BLUE;
  ctx.globalAlpha = 1;
  ctx.beginPath();

  for (const sample of samples) {
    const parentIntensity = strongPrecipitationIntensity(sample.parentValue.rain);
    const childIntensity = strongPrecipitationIntensity(sample.childValue.rain);
    const parentRadius = intensityToRadius(parentIntensity, coarseSpacing, 'rain');
    const childRadius = intensityToRadius(childIntensity, fineSpacing, 'rain');
    const radius = mix(parentRadius, childRadius, progress);
    if (radius <= 0) continue;

    const x = mix(sample.parentSx, sample.childSx, progress);
    const y = mix(sample.parentSy, sample.childSy, progress);
    ctx.moveTo(x + radius, y);
    ctx.arc(x, y, radius, 0, Math.PI * 2);
  }

  ctx.fill();
}

export function renderLODMorph(ctx, viewport, morph, t, travelX, fieldPixels, centerX, centerY) {
  const fineStep = Math.pow(2, morph.fine) / BASE_GRID;
  const coarseStep = fineStep * 2;
  const fineSpacing = fineStep * fieldPixels * viewport.zoom;
  const coarseSpacing = coarseStep * fieldPixels * viewport.zoom;
  const bounds = viewport.bounds;
  const startI = Math.floor(bounds.minX / fineStep) - GRID_OVERSCAN_CELLS * 2;
  const endI = Math.ceil(bounds.maxX / fineStep) + GRID_OVERSCAN_CELLS * 2;
  const startJ = Math.floor(bounds.minY / fineStep) - GRID_OVERSCAN_CELLS * 2;
  const endJ = Math.ceil(bounds.maxY / fineStep) + GRID_OVERSCAN_CELLS * 2;
  const samples = [];

  for (let j = startJ; j < endJ; j++) {
    const childY = (j + 0.5) * fineStep;
    const parentJ = Math.floor(j / 2);
    const parentY = (parentJ + 0.5) * coarseStep;

    for (let i = startI; i < endI; i++) {
      const childX = (i + 0.5) * fineStep;
      const parentI = Math.floor(i / 2);
      const parentX = (parentI + 0.5) * coarseStep;
      samples.push({
        childSx: centerX + (childX - 0.5) * fieldPixels * viewport.zoom,
        childSy: centerY + (childY - 0.5) * fieldPixels * viewport.zoom,
        parentSx: centerX + (parentX - 0.5) * fieldPixels * viewport.zoom,
        parentSy: centerY + (parentY - 0.5) * fieldPixels * viewport.zoom,
        childValue: sampleField(childX, childY, t, morph.fine, travelX),
        parentValue: sampleField(parentX, parentY, t, morph.coarse, travelX)
      });
    }
  }

  const progress = smoothstep(0, 1, clamp(morph.progress));
  // Required order remains rain → strong precipitation → composite hazard.
  drawMorphLayer(ctx, samples, 'rain', RAIN_BLUE, coarseSpacing, fineSpacing, progress);
  drawStrongPrecipitationMorph(ctx, samples, coarseSpacing, fineSpacing, progress);
  drawHazardMorph(ctx, samples, coarseSpacing, fineSpacing, progress);
}
