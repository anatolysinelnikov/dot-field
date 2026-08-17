import { BASE_GRID, GRID_OVERSCAN_CELLS, RAIN_BLUE, STRONG_PRECIPITATION_BLUE } from './config.js';
import { clamp, mix, smoothstep } from './math.js';
import { sampleField, resolveHazardState, resolveLODGroupHazardState } from './lod.js';
import { drawHazardLayer, drawHazardMorph } from './hazard-renderer.js';
import { intensityToRadius, strongPrecipitationIntensity } from './precipitation-mapping.js';


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
