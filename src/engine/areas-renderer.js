import { AREA_CONTOUR_SUBDIVISIONS, AREA_PRECIPITATION_BANDS, BASE_GRID, GRID_OVERSCAN_CELLS } from './config.js';
import { clamp, smoothstep } from './math.js';
import { sampleField, resolveHazardState, resolveLODGroupHazardState } from './lod.js';
import { drawHazardLayer, drawHazardMorph } from './hazard-renderer.js';
import { buildSmoothedWeatherGrid, interpolateSplineScalarAt } from './scalar-reconstruction.js';

const RAIN_LAYER = ['rain'];

function appendContourSegment(segments, a, b, ax, ay, bx, by) {
  segments.push({ a, b, ax, ay, bx, by });
}

function appendContourCell(segments, i, j, step, a, b, c, d, threshold) {
  const index = (a >= threshold ? 1 : 0)
    | (b >= threshold ? 2 : 0)
    | (c >= threshold ? 4 : 0)
    | (d >= threshold ? 8 : 0);

  if (index === 0 || index === 15) return;

  const x = i * step;
  const y = j * step;
  const right = x + step;
  const bottom = y + step;
  const topX = x + (threshold - a) / (b - a) * step;
  const rightY = y + (threshold - b) / (c - b) * step;
  const bottomX = x + (threshold - d) / (c - d) * step;
  const leftY = y + (threshold - a) / (d - a) * step;
  const top = `h:${i}:${j}`;
  const rightEdge = `v:${i + 1}:${j}`;
  const bottomEdge = `h:${i}:${j + 1}`;
  const left = `v:${i}:${j}`;

  switch (index) {
    case 1: appendContourSegment(segments, top, left, topX, y, x, leftY); break;
    case 2: appendContourSegment(segments, rightEdge, top, right, rightY, topX, y); break;
    case 3: appendContourSegment(segments, rightEdge, left, right, rightY, x, leftY); break;
    case 4: appendContourSegment(segments, bottomEdge, rightEdge, bottomX, bottom, right, rightY); break;
    case 5:
      // Resolve saddle cells from the scalar value at the cell center.
      if ((a + b + c + d) * 0.25 >= threshold) {
        appendContourSegment(segments, top, rightEdge, topX, y, right, rightY);
        appendContourSegment(segments, bottomEdge, left, bottomX, bottom, x, leftY);
      } else {
        appendContourSegment(segments, top, left, topX, y, x, leftY);
        appendContourSegment(segments, rightEdge, bottomEdge, right, rightY, bottomX, bottom);
      }
      break;
    case 6: appendContourSegment(segments, bottomEdge, top, bottomX, bottom, topX, y); break;
    case 7: appendContourSegment(segments, bottomEdge, left, bottomX, bottom, x, leftY); break;
    case 8: appendContourSegment(segments, left, bottomEdge, x, leftY, bottomX, bottom); break;
    case 9: appendContourSegment(segments, top, bottomEdge, topX, y, bottomX, bottom); break;
    case 10:
      if ((a + b + c + d) * 0.25 >= threshold) {
        appendContourSegment(segments, top, left, topX, y, x, leftY);
        appendContourSegment(segments, rightEdge, bottomEdge, right, rightY, bottomX, bottom);
      } else {
        appendContourSegment(segments, top, rightEdge, topX, y, right, rightY);
        appendContourSegment(segments, bottomEdge, left, bottomX, bottom, x, leftY);
      }
      break;
    case 11: appendContourSegment(segments, rightEdge, bottomEdge, right, rightY, bottomX, bottom); break;
    case 12: appendContourSegment(segments, left, rightEdge, x, leftY, right, rightY); break;
    case 13: appendContourSegment(segments, top, rightEdge, topX, y, right, rightY); break;
    case 14: appendContourSegment(segments, left, top, x, leftY, topX, y); break;
  }
}

function buildContourPath(segments) {
  const adjacency = new Map();
  for (let index = 0; index < segments.length; index++) {
    const segment = segments[index];
    const from = adjacency.get(segment.a) || [];
    from.push(index);
    adjacency.set(segment.a, from);
    const to = adjacency.get(segment.b) || [];
    to.push(index);
    adjacency.set(segment.b, to);
  }

  const used = new Uint8Array(segments.length);
  const path = new Path2D();
  for (let index = 0; index < segments.length; index++) {
    if (used[index]) continue;
    const first = segments[index];
    const start = first.a;
    let current = first.b;
    path.moveTo(first.ax, first.ay);
    path.lineTo(first.bx, first.by);
    used[index] = 1;

    while (current !== start) {
      const connected = adjacency.get(current);
      const nextIndex = connected.find(candidate => !used[candidate]);
      if (nextIndex === undefined) break;
      const next = segments[nextIndex];
      used[nextIndex] = 1;
      if (next.a === current) {
        path.lineTo(next.bx, next.by);
        current = next.b;
      } else {
        path.lineTo(next.ax, next.ay);
        current = next.a;
      }
    }
    path.closePath();
  }
  return path;
}

function buildPrecipitationContours(grid, travelX) {
  const contourStep = grid.step / AREA_CONTOUR_SUBDIVISIONS;
  // Extract complete closed loops from weather support, not just the viewport.
  // This keeps fills stable when zooming into the middle of an active region.
  const overscan = contourStep * 4;
  const minX = travelX - 0.92 - overscan;
  const maxX = travelX + 0.92 + overscan;
  const minY = -0.26 - overscan;
  const maxY = 1.26 + overscan;
  const startI = Math.floor(minX / contourStep);
  const endI = Math.ceil(maxX / contourStep);
  const startJ = Math.floor(minY / contourStep);
  const endJ = Math.ceil(maxY / contourStep);
  const columns = endI - startI + 1;
  let topValues = new Float32Array(columns);
  let bottomValues = new Float32Array(columns);
  const bandSegments = AREA_PRECIPITATION_BANDS.map(() => []);

  for (let column = 0; column < columns; column++) {
    topValues[column] = interpolateSplineScalarAt(grid.rain, grid, (startI + column) * contourStep, startJ * contourStep);
  }

  for (let row = startJ; row < endJ; row++) {
    const bottomY = (row + 1) * contourStep;
    for (let column = 0; column < columns; column++) {
      bottomValues[column] = interpolateSplineScalarAt(grid.rain, grid, (startI + column) * contourStep, bottomY);
    }

    for (let column = 0; column < columns - 1; column++) {
      const i = startI + column;
      const a = topValues[column];
      const b = topValues[column + 1];
      const c = bottomValues[column + 1];
      const d = bottomValues[column];
      for (let band = 0; band < AREA_PRECIPITATION_BANDS.length; band++) {
        appendContourCell(bandSegments[band], i, row, contourStep, a, b, c, d, AREA_PRECIPITATION_BANDS[band].threshold);
      }
    }

    const previousTop = topValues;
    topValues = bottomValues;
    bottomValues = previousTop;
  }

  return bandSegments.map(buildContourPath);
}

export function renderPrecipitationAreas(ctx, viewport, t, travelX, fieldPixels, centerX, centerY) {
  const supportBounds = { minX: travelX - 0.92, maxX: travelX + 0.92, minY: -0.26, maxY: 1.26 };
  const grid = buildSmoothedWeatherGrid(supportBounds, t, travelX, RAIN_LAYER);
  const bandPaths = buildPrecipitationContours(grid, travelX);
  const worldScale = fieldPixels * viewport.zoom;
  ctx.save();
  ctx.translate(centerX - worldScale * 0.5, centerY - worldScale * 0.5);
  ctx.scale(worldScale, worldScale);
  for (let band = 0; band < AREA_PRECIPITATION_BANDS.length; band++) {
    ctx.fillStyle = AREA_PRECIPITATION_BANDS[band].color;
    ctx.fill(bandPaths[band], 'evenodd');
  }
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
