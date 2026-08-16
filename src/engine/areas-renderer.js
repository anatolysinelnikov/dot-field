import { AREA_RASTER_SCALE, BASE_GRID, GRID_OVERSCAN_CELLS, RAIN_MODERATE_MAX } from './config.js';
import { clamp, smoothstep } from './math.js';
import { sampleField, resolveHazardState, resolveLODGroupHazardState } from './lod.js';
import { drawHazardLayer, drawHazardMorph } from './hazard-renderer.js';
import { buildSmoothedWeatherGrid, interpolateSplineScalar, prepareSplineAxis } from './scalar-reconstruction.js';

const RAIN_COLOR = [0, 144, 255];
const STRONG_RAIN_COLOR = [0, 0, 255];
const RAIN_LAYER = ['rain'];

export function renderPrecipitationAreas(ctx, precipitationCanvas, precipitationCtx, viewport, t, travelX, fieldPixels, centerX, centerY) {
  const grid = buildSmoothedWeatherGrid(viewport.bounds, t, travelX, RAIN_LAYER);
  const rasterWidth = Math.max(1, Math.ceil(viewport.width * AREA_RASTER_SCALE));
  const rasterHeight = Math.max(1, Math.ceil(viewport.height * AREA_RASTER_SCALE));
  if (precipitationCanvas.width !== rasterWidth || precipitationCanvas.height !== rasterHeight) {
    precipitationCanvas.width = rasterWidth;
    precipitationCanvas.height = rasterHeight;
  }

  const worldScale = fieldPixels * viewport.zoom;
  const xSpline = prepareSplineAxis(rasterWidth, viewport.width, centerX, worldScale, grid.startI, grid.step);
  const ySpline = prepareSplineAxis(rasterHeight, viewport.height, centerY, worldScale, grid.startJ, grid.step);
  const image = precipitationCtx.createImageData(rasterWidth, rasterHeight);
  const pixels = image.data;

  for (let py = 0; py < rasterHeight; py++) {
    const gridY = ySpline.indices[py];
    const wyOffset = py * 4;
    for (let px = 0; px < rasterWidth; px++) {
      const gridX = xSpline.indices[px];
      const wxOffset = px * 4;
      const rain = interpolateSplineScalar(grid.rain, grid, gridX, gridY, xSpline.weights, wxOffset, ySpline.weights, wyOffset);
      // Keep the boundary transition narrow: these are filled areas, not a
      // blurred atmosphere. The 0.02 floor matches the dot visibility support.
      const rainAlpha = smoothstep(0.020, 0.034, rain);
      const strongAlpha = smoothstep(RAIN_MODERATE_MAX - 0.012, RAIN_MODERATE_MAX + 0.018, rain);
      const pixelOffset = (py * rasterWidth + px) * 4;
      pixels[pixelOffset] = Math.round(RAIN_COLOR[0] + (STRONG_RAIN_COLOR[0] - RAIN_COLOR[0]) * strongAlpha);
      pixels[pixelOffset + 1] = Math.round(RAIN_COLOR[1] + (STRONG_RAIN_COLOR[1] - RAIN_COLOR[1]) * strongAlpha);
      pixels[pixelOffset + 2] = 255;
      pixels[pixelOffset + 3] = Math.round(rainAlpha * 255);
    }
  }

  precipitationCtx.putImageData(image, 0, 0);
  ctx.save();
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(precipitationCanvas, 0, 0, viewport.width, viewport.height);
  ctx.restore();
}

export function renderAreaHazards(ctx, viewport, lod, t, travelX, fieldPixels, centerX, centerY) {
  const step = Math.pow(2, lod) / BASE_GRID;
  const spacing = step * fieldPixels * viewport.zoom;
  const { minX, maxX, minY, maxY } = viewport.bounds;
  const startI = Math.floor(minX / step) - GRID_OVERSCAN_CELLS;
  const endI = Math.ceil(maxX / step) + GRID_OVERSCAN_CELLS;
  const startJ = Math.floor(minY / step) - GRID_OVERSCAN_CELLS;
  const endJ = Math.ceil(maxY / step) + GRID_OVERSCAN_CELLS;
  const samples = [];

  for (let j = startJ; j < endJ; j++) {
    const y = (j + 0.5) * step;
    for (let i = startI; i < endI; i++) {
      const x = (i + 0.5) * step;
      const value = sampleField(x, y, t, lod, travelX);
      samples.push({
        sx: centerX + (x - 0.5) * fieldPixels * viewport.zoom,
        sy: centerY + (y - 0.5) * fieldPixels * viewport.zoom,
        value,
        hazardState: lod > 0
          ? resolveLODGroupHazardState(x, y, t, lod, travelX)
          : resolveHazardState(value)
      });
    }
  }

  drawHazardLayer(ctx, samples, spacing);
}

export function renderAreaHazardMorph(ctx, viewport, morph, t, travelX, fieldPixels, centerX, centerY) {
  const fineStep = Math.pow(2, morph.fine) / BASE_GRID;
  const coarseStep = fineStep * 2;
  const fineSpacing = fineStep * fieldPixels * viewport.zoom;
  const coarseSpacing = coarseStep * fieldPixels * viewport.zoom;
  const { minX, maxX, minY, maxY } = viewport.bounds;
  const startI = Math.floor(minX / fineStep) - GRID_OVERSCAN_CELLS * 2;
  const endI = Math.ceil(maxX / fineStep) + GRID_OVERSCAN_CELLS * 2;
  const startJ = Math.floor(minY / fineStep) - GRID_OVERSCAN_CELLS * 2;
  const endJ = Math.ceil(maxY / fineStep) + GRID_OVERSCAN_CELLS * 2;
  const samples = [];

  for (let j = startJ; j < endJ; j++) {
    const childY = (j + 0.5) * fineStep;
    const parentY = (Math.floor(j / 2) + 0.5) * coarseStep;
    for (let i = startI; i < endI; i++) {
      const childX = (i + 0.5) * fineStep;
      const parentX = (Math.floor(i / 2) + 0.5) * coarseStep;
      samples.push({
        childSx: centerX + (childX - 0.5) * fieldPixels * viewport.zoom,
        childSy: centerY + (childY - 0.5) * fieldPixels * viewport.zoom,
        parentSx: centerX + (parentX - 0.5) * fieldPixels * viewport.zoom,
        parentSy: centerY + (parentY - 0.5) * fieldPixels * viewport.zoom,
        childValue: sampleField(childX, childY, t, morph.fine, travelX)
      });
    }
  }

  drawHazardMorph(ctx, samples, coarseSpacing, fineSpacing, smoothstep(0, 1, clamp(morph.progress)));
}
