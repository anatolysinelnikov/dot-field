import { BASE_GRID, GRID_OVERSCAN_CELLS, RAIN_BLUE, RAIN_MODERATE_MAX, STRONG_PRECIPITATION_BLUE } from './config.js';
import { clamp, mix, smoothstep } from './math.js';
import { intensityToStrength, resolveHazardState, resolveLODGroupHazardState, sampleField } from './lod.js';
import { intensityToRadius, strongPrecipitationIntensity } from './precipitation-mapping.js';

const BACKGROUND = [8, 11, 18];
const STORM = [255, 0, 255];
const HAIL = [255, 212, 0];
const RAIN = hexToRgb(RAIN_BLUE);
const STRONG_RAIN = hexToRgb(STRONG_PRECIPITATION_BLUE);
const RAIN_BRIGHTNESS_ANCHOR_RADIUS_PX = 0.4;
const RAIN_BOUNDARY_BRIGHTNESS = 0;
const STRONG_BOUNDARY_MIX = 0;
const STORM_BOUNDARY_MIX = 0.45;
const HAIL_BOUNDARY_MIX = 0.5;

function hexToRgb(hex) {
  return [
    Number.parseInt(hex.slice(1, 3), 16),
    Number.parseInt(hex.slice(3, 5), 16),
    Number.parseInt(hex.slice(5, 7), 16)
  ];
}

function mixColor(from, to, amount) {
  const progress = clamp(amount, 0, 1);
  return [
    Math.round(mix(from[0], to[0], progress)),
    Math.round(mix(from[1], to[1], progress)),
    Math.round(mix(from[2], to[2], progress))
  ];
}

function colorString(color) {
  return `rgb(${color[0]} ${color[1]} ${color[2]})`;
}

function precipitationColor(color, radius, spacing) {
  if (radius <= 0) return BACKGROUND;
  if (radius <= RAIN_BRIGHTNESS_ANCHOR_RADIUS_PX) {
    return mixColor(BACKGROUND, color,
      RAIN_BOUNDARY_BRIGHTNESS * radius / RAIN_BRIGHTNESS_ANCHOR_RADIUS_PX);
  }
  // RAIN_MODERATE_MAX is Dots' established upper edge for light-blue rain;
  // use its projected marker radius as the full-brightness anchor.
  const fullBrightnessRadius = intensityToRadius(RAIN_MODERATE_MAX, spacing, 'rain');
  const position = clamp(
    (radius - RAIN_BRIGHTNESS_ANCHOR_RADIUS_PX)
      / (fullBrightnessRadius - RAIN_BRIGHTNESS_ANCHOR_RADIUS_PX),
    0,
    1
  );
  const brightness = mix(RAIN_BOUNDARY_BRIGHTNESS, 1, position);
  return mixColor(BACKGROUND, color, brightness);
}

function applyPhenomenonGradient(underlyingColor, phenomenonColor, boundaryMix, progress) {
  return mixColor(underlyingColor, phenomenonColor, mix(boundaryMix, 1, progress));
}

function rainColor(intensity, spacing) {
  // Mirror Dots' base-rain layer and its normalized strong-rain overlay.
  let color = precipitationColor(RAIN, intensityToRadius(intensity, spacing, 'rain'), spacing);
  const strongIntensity = strongPrecipitationIntensity(intensity);
  const strongRadius = intensityToRadius(strongIntensity, spacing, 'rain');
  if (strongRadius > 0) {
    const strongProgress = Math.pow(intensityToStrength(strongIntensity, 'rain'), 0.47);
    color = applyPhenomenonGradient(color, STRONG_RAIN, STRONG_BOUNDARY_MIX, strongProgress);
  }
  return color;
}

function squareColor(value, hazardState, spacing) {
  let color = rainColor(value.rain, spacing);
  const stormProgress = Math.pow(intensityToStrength(value.storm, 'storm'), 0.47);
  const hasStorm = hazardState > 0 && hazardState <= 3;
  const hasHail = hazardState > 3;
  // Hail may retain sampled storm as its lower layer, but raw storm strength
  // cannot otherwise add visible storm support beyond Dots' hazard state.
  if (hasStorm || (hasHail && stormProgress > 0)) {
    color = applyPhenomenonGradient(color, STORM, STORM_BOUNDARY_MIX, stormProgress);
  }
  if (hasHail) {
    const hailProgress = Math.pow(intensityToStrength(value.hail, 'hail'), 0.47);
    color = applyPhenomenonGradient(color, HAIL, HAIL_BOUNDARY_MIX, hailProgress);
  }
  return color;
}

function hazardStateAt(x, y, t, lod, travelX, value) {
  return lod > 0
    ? resolveLODGroupHazardState(x, y, t, lod, travelX)
    : resolveHazardState(value);
}

function drawSquare(ctx, sx, sy, spacing, color) {
  if (color === BACKGROUND) return;
  ctx.fillStyle = colorString(color);
  // A tiny right/bottom overdraw prevents fractional canvas rasterization from
  // exposing hairline seams between otherwise exactly adjacent world cells.
  ctx.fillRect(sx - spacing / 2, sy - spacing / 2, spacing + 0.5, spacing + 0.5);
}

export function renderSquares(ctx, viewport, lod, t, travelX, fieldPixels, centerX, centerY) {
  const step = Math.pow(2, lod) / BASE_GRID;
  const spacing = step * fieldPixels * viewport.zoom;
  const { minX, maxX, minY, maxY } = viewport.bounds;
  const startI = Math.floor(minX / step) - GRID_OVERSCAN_CELLS;
  const endI = Math.ceil(maxX / step) + GRID_OVERSCAN_CELLS;
  const startJ = Math.floor(minY / step) - GRID_OVERSCAN_CELLS;
  const endJ = Math.ceil(maxY / step) + GRID_OVERSCAN_CELLS;

  for (let j = startJ; j < endJ; j++) {
    const y = (j + 0.5) * step;
    const sy = centerY + (y - 0.5) * fieldPixels * viewport.zoom;
    for (let i = startI; i < endI; i++) {
      const x = (i + 0.5) * step;
      const value = sampleField(x, y, t, lod, travelX);
      drawSquare(ctx, centerX + (x - 0.5) * fieldPixels * viewport.zoom, sy, spacing,
        squareColor(value, hazardStateAt(x, y, t, lod, travelX, value), spacing));
    }
  }
}

export function renderSquaresMorph(ctx, viewport, morph, t, travelX, fieldPixels, centerX, centerY) {
  const fineStep = Math.pow(2, morph.fine) / BASE_GRID;
  const coarseStep = fineStep * 2;
  const spacing = fineStep * fieldPixels * viewport.zoom;
  const coarseSpacing = coarseStep * fieldPixels * viewport.zoom;
  const { minX, maxX, minY, maxY } = viewport.bounds;
  const startI = Math.floor(minX / fineStep) - GRID_OVERSCAN_CELLS * 2;
  const endI = Math.ceil(maxX / fineStep) + GRID_OVERSCAN_CELLS * 2;
  const startJ = Math.floor(minY / fineStep) - GRID_OVERSCAN_CELLS * 2;
  const endJ = Math.ceil(maxY / fineStep) + GRID_OVERSCAN_CELLS * 2;
  const progress = smoothstep(0, 1, clamp(morph.progress));

  for (let j = startJ; j < endJ; j++) {
    const childY = (j + 0.5) * fineStep;
    const parentY = (Math.floor(j / 2) + 0.5) * coarseStep;
    const sy = centerY + (childY - 0.5) * fieldPixels * viewport.zoom;
    for (let i = startI; i < endI; i++) {
      const childX = (i + 0.5) * fineStep;
      const parentX = (Math.floor(i / 2) + 0.5) * coarseStep;
      const childValue = sampleField(childX, childY, t, morph.fine, travelX);
      const parentValue = sampleField(parentX, parentY, t, morph.coarse, travelX);
      const parentColor = squareColor(parentValue,
        hazardStateAt(parentX, parentY, t, morph.coarse, travelX, parentValue), coarseSpacing);
      const childColor = squareColor(childValue,
        hazardStateAt(childX, childY, t, morph.fine, travelX, childValue), spacing);
      drawSquare(ctx, centerX + (childX - 0.5) * fieldPixels * viewport.zoom, sy, spacing,
        mixColor(parentColor, childColor, progress));
    }
  }
}
