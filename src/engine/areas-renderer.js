import { AREA_CONTOUR_SUBDIVISIONS, AREA_PRECIPITATION_BANDS } from './config.js';
import { clamp } from './math.js';
import {
  buildSmoothedWeatherGrid,
  createBoxBlurBuffers,
  fastBoxBlurScalarGrid,
  interpolateSplineScalarsOnLattice,
  prepareWorldSplineAxis
} from './scalar-reconstruction.js';

const AREA_GENERALIZATION_RADIUS = 6;
const AREA_GENERALIZATION_PASSES = 3;
const AREA_COVERAGE_HISTOGRAM_BINS = 1024;
const AREA_THRESHOLD_GAP = 1e-5;
const AREA_REFERENCE_THRESHOLDS = AREA_PRECIPITATION_BANDS.map(band => band.threshold);
// These are the lower smoothstep edges used by resolveHazardState in lod.js.
// Matching them keeps the Areas contour support aligned with existing hazards.
const STORM_PRESENCE_THRESHOLD = 0.075 * 0.45;
const HAIL_PRESENCE_THRESHOLD = 0.11 * 0.45;
let areaGeneralizationBuffers = null;
let areaGeometryCache = null;
const generalizedHistogram = new Uint32Array(AREA_COVERAGE_HISTOGRAM_BINS);
const referenceCoverage = new Uint32Array(AREA_PRECIPITATION_BANDS.length);
const effectiveThresholds = new Float32Array(AREA_PRECIPITATION_BANDS.length);

function getAreaGeneralizationBuffers(length, channel) {
  if (!areaGeneralizationBuffers || areaGeneralizationBuffers.length !== length) {
    areaGeneralizationBuffers = {
      length,
      buffers: {
        rain: createBoxBlurBuffers(length),
        storm: createBoxBlurBuffers(length),
        hail: createBoxBlurBuffers(length)
      }
    };
  }
  return areaGeneralizationBuffers.buffers[channel];
}

function histogramBin(value) {
  return Math.min(AREA_COVERAGE_HISTOGRAM_BINS - 1,
    Math.max(0, Math.floor(clamp(value, 0, 1) * AREA_COVERAGE_HISTOGRAM_BINS)));
}

function thresholdForCoverage(histogram, targetCoverage) {
  if (targetCoverage <= 0) return 1;
  let covered = 0;
  for (let bin = AREA_COVERAGE_HISTOGRAM_BINS - 1; bin >= 0; bin--) {
    const count = histogram[bin];
    if (covered + count >= targetCoverage) {
      const fraction = (targetCoverage - covered) / count;
      return (bin + 1 - fraction) / AREA_COVERAGE_HISTOGRAM_BINS;
    }
    covered += count;
  }
  return 0;
}

function getCoverageBounds(grid, bounds) {
  const minI = Math.ceil(bounds.minX / grid.step - 0.5);
  const maxI = Math.floor(bounds.maxX / grid.step - 0.5);
  const minJ = Math.ceil(bounds.minY / grid.step - 0.5);
  const maxJ = Math.floor(bounds.maxY / grid.step - 0.5);
  return {
    startColumn: Math.max(0, minI - grid.startI),
    endColumn: Math.min(grid.width - 1, maxI - grid.startI),
    startRow: Math.max(0, minJ - grid.startJ),
    endRow: Math.min(grid.height - 1, maxJ - grid.startJ)
  };
}

function remapCoverageThresholds(grid, originalRain, generalizedRain, bounds) {
  generalizedHistogram.fill(0);
  referenceCoverage.fill(0);
  const coverageBounds = getCoverageBounds(grid, bounds);

  // This fixed support lattice excludes filter padding. Areas preserves visual
  // intensity coverage after generalization; reconsider this quantile remap if
  // bands later gain absolute meteorological meaning.
  for (let row = coverageBounds.startRow; row <= coverageBounds.endRow; row++) {
    const offset = row * grid.width;
    for (let column = coverageBounds.startColumn; column <= coverageBounds.endColumn; column++) {
      const index = offset + column;
      const original = originalRain[index];
      generalizedHistogram[histogramBin(generalizedRain[index])]++;
      for (let band = 0; band < AREA_REFERENCE_THRESHOLDS.length; band++) {
        if (original >= AREA_REFERENCE_THRESHOLDS[band]) referenceCoverage[band]++;
      }
    }
  }

  for (let band = 0; band < effectiveThresholds.length; band++) {
    const lowerBound = band === 0 ? 0 : effectiveThresholds[band - 1] + AREA_THRESHOLD_GAP;
    const upperBound = 1 - (effectiveThresholds.length - 1 - band) * AREA_THRESHOLD_GAP;
    effectiveThresholds[band] = clamp(
      thresholdForCoverage(generalizedHistogram, referenceCoverage[band]),
      lowerBound,
      upperBound
    );
  }

  return effectiveThresholds;
}

function remapCoverageThreshold(grid, original, generalized, bounds, referenceThreshold) {
  generalizedHistogram.fill(0);
  let referenceCoverage = 0;
  const coverageBounds = getCoverageBounds(grid, bounds);

  for (let row = coverageBounds.startRow; row <= coverageBounds.endRow; row++) {
    const offset = row * grid.width;
    for (let column = coverageBounds.startColumn; column <= coverageBounds.endColumn; column++) {
      const index = offset + column;
      generalizedHistogram[histogramBin(generalized[index])]++;
      if (original[index] >= referenceThreshold) referenceCoverage++;
    }
  }

  return thresholdForCoverage(generalizedHistogram, referenceCoverage);
}

function appendContourSegment(segments, a, b, ax, ay, bx, by) {
  segments.push(a, b, ax, ay, bx, by);
}

function appendContourCell(segments, column, row, columns, horizontalCount, x, y, step, a, b, c, d, threshold) {
  const index = (a >= threshold ? 1 : 0)
    | (b >= threshold ? 2 : 0)
    | (c >= threshold ? 4 : 0)
    | (d >= threshold ? 8 : 0);

  if (index === 0 || index === 15) return;

  const right = x + step;
  const bottom = y + step;
  const top = row * (columns - 1) + column;
  const rightEdge = horizontalCount + row * columns + column + 1;
  const bottomEdge = (row + 1) * (columns - 1) + column;
  const left = horizontalCount + row * columns + column;

  switch (index) {
    case 1: {
      const topX = x + (threshold - a) / (b - a) * step;
      const leftY = y + (threshold - a) / (d - a) * step;
      appendContourSegment(segments, top, left, topX, y, x, leftY);
      break;
    }
    case 2: {
      const rightY = y + (threshold - b) / (c - b) * step;
      const topX = x + (threshold - a) / (b - a) * step;
      appendContourSegment(segments, rightEdge, top, right, rightY, topX, y);
      break;
    }
    case 3: {
      const rightY = y + (threshold - b) / (c - b) * step;
      const leftY = y + (threshold - a) / (d - a) * step;
      appendContourSegment(segments, rightEdge, left, right, rightY, x, leftY);
      break;
    }
    case 4: {
      const bottomX = x + (threshold - d) / (c - d) * step;
      const rightY = y + (threshold - b) / (c - b) * step;
      appendContourSegment(segments, bottomEdge, rightEdge, bottomX, bottom, right, rightY);
      break;
    }
    case 5:
      // Resolve saddle cells from the scalar value at the cell center.
      if ((a + b + c + d) * 0.25 >= threshold) {
        const topX = x + (threshold - a) / (b - a) * step;
        const rightY = y + (threshold - b) / (c - b) * step;
        const bottomX = x + (threshold - d) / (c - d) * step;
        const leftY = y + (threshold - a) / (d - a) * step;
        appendContourSegment(segments, top, rightEdge, topX, y, right, rightY);
        appendContourSegment(segments, bottomEdge, left, bottomX, bottom, x, leftY);
      } else {
        const topX = x + (threshold - a) / (b - a) * step;
        const rightY = y + (threshold - b) / (c - b) * step;
        const bottomX = x + (threshold - d) / (c - d) * step;
        const leftY = y + (threshold - a) / (d - a) * step;
        appendContourSegment(segments, top, left, topX, y, x, leftY);
        appendContourSegment(segments, rightEdge, bottomEdge, right, rightY, bottomX, bottom);
      }
      break;
    case 6: {
      const bottomX = x + (threshold - d) / (c - d) * step;
      const topX = x + (threshold - a) / (b - a) * step;
      appendContourSegment(segments, bottomEdge, top, bottomX, bottom, topX, y);
      break;
    }
    case 7: {
      const bottomX = x + (threshold - d) / (c - d) * step;
      const leftY = y + (threshold - a) / (d - a) * step;
      appendContourSegment(segments, bottomEdge, left, bottomX, bottom, x, leftY);
      break;
    }
    case 8: {
      const leftY = y + (threshold - a) / (d - a) * step;
      const bottomX = x + (threshold - d) / (c - d) * step;
      appendContourSegment(segments, left, bottomEdge, x, leftY, bottomX, bottom);
      break;
    }
    case 9: {
      const topX = x + (threshold - a) / (b - a) * step;
      const bottomX = x + (threshold - d) / (c - d) * step;
      appendContourSegment(segments, top, bottomEdge, topX, y, bottomX, bottom);
      break;
    }
    case 10:
      if ((a + b + c + d) * 0.25 >= threshold) {
        const topX = x + (threshold - a) / (b - a) * step;
        const rightY = y + (threshold - b) / (c - b) * step;
        const bottomX = x + (threshold - d) / (c - d) * step;
        const leftY = y + (threshold - a) / (d - a) * step;
        appendContourSegment(segments, top, left, topX, y, x, leftY);
        appendContourSegment(segments, rightEdge, bottomEdge, right, rightY, bottomX, bottom);
      } else {
        const topX = x + (threshold - a) / (b - a) * step;
        const rightY = y + (threshold - b) / (c - b) * step;
        const bottomX = x + (threshold - d) / (c - d) * step;
        const leftY = y + (threshold - a) / (d - a) * step;
        appendContourSegment(segments, top, rightEdge, topX, y, right, rightY);
        appendContourSegment(segments, bottomEdge, left, bottomX, bottom, x, leftY);
      }
      break;
    case 11: {
      const rightY = y + (threshold - b) / (c - b) * step;
      const bottomX = x + (threshold - d) / (c - d) * step;
      appendContourSegment(segments, rightEdge, bottomEdge, right, rightY, bottomX, bottom);
      break;
    }
    case 12: {
      const leftY = y + (threshold - a) / (d - a) * step;
      const rightY = y + (threshold - b) / (c - b) * step;
      appendContourSegment(segments, left, rightEdge, x, leftY, right, rightY);
      break;
    }
    case 13: {
      const topX = x + (threshold - a) / (b - a) * step;
      const rightY = y + (threshold - b) / (c - b) * step;
      appendContourSegment(segments, top, rightEdge, topX, y, right, rightY);
      break;
    }
    case 14: {
      const leftY = y + (threshold - a) / (d - a) * step;
      const topX = x + (threshold - a) / (b - a) * step;
      appendContourSegment(segments, left, top, x, leftY, topX, y);
      break;
    }
  }
}

function buildContourPath(segments) {
  const adjacency = new Map();
  for (let index = 0, segmentIndex = 0; index < segments.length; index += 6, segmentIndex++) {
    const a = segments[index];
    const b = segments[index + 1];
    const from = adjacency.get(a) || [];
    from.push(segmentIndex);
    adjacency.set(a, from);
    const to = adjacency.get(b) || [];
    to.push(segmentIndex);
    adjacency.set(b, to);
  }

  const used = new Uint8Array(segments.length / 6);
  const path = new Path2D();
  for (let segmentIndex = 0; segmentIndex < used.length; segmentIndex++) {
    if (used[segmentIndex]) continue;
    let offset = segmentIndex * 6;
    const start = segments[offset];
    let current = segments[offset + 1];
    path.moveTo(segments[offset + 2], segments[offset + 3]);
    path.lineTo(segments[offset + 4], segments[offset + 5]);
    used[segmentIndex] = 1;

    while (current !== start) {
      const connected = adjacency.get(current);
      let nextIndex;
      for (let candidate = 0; candidate < connected.length; candidate++) {
        if (!used[connected[candidate]]) {
          nextIndex = connected[candidate];
          break;
        }
      }
      if (nextIndex === undefined) break;
      offset = nextIndex * 6;
      used[nextIndex] = 1;
      if (segments[offset] === current) {
        path.lineTo(segments[offset + 4], segments[offset + 5]);
        current = segments[offset + 1];
      } else {
        path.lineTo(segments[offset + 2], segments[offset + 3]);
        current = segments[offset];
      }
    }
    path.closePath();
  }
  return path;
}

function buildContours(grid, contourSets, travelX) {
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
  const rows = endJ - startJ;
  let topValues = contourSets.map(() => new Float32Array(columns));
  let bottomValues = contourSets.map(() => new Float32Array(columns));
  const sources = contourSets.map(set => set.scalar);
  const bandSegments = contourSets.map(set => Array.from(set.thresholds, () => []));
  const xAxis = prepareWorldSplineAxis(startI, columns, contourStep, grid.startI, grid.step, grid.width);
  const yAxis = prepareWorldSplineAxis(startJ, rows + 1, contourStep, grid.startJ, grid.step, grid.height);
  const contourValues = interpolateSplineScalarsOnLattice(sources, grid, xAxis, yAxis, columns, rows);

  for (let column = 0; column < columns; column++) {
    for (let set = 0; set < contourSets.length; set++) topValues[set][column] = contourValues[set][column];
  }

  const horizontalCount = (rows + 1) * (columns - 1);
  for (let row = 0; row < rows; row++) {
    const valueOffset = (row + 1) * columns;
    for (let column = 0; column < columns; column++) {
      for (let set = 0; set < contourSets.length; set++) bottomValues[set][column] = contourValues[set][valueOffset + column];
    }

    for (let column = 0; column < columns - 1; column++) {
      for (let set = 0; set < contourSets.length; set++) {
        const thresholds = contourSets[set].thresholds;
        const a = topValues[set][column];
        const b = topValues[set][column + 1];
        const c = bottomValues[set][column + 1];
        const d = bottomValues[set][column];
        const minValue = Math.min(a, b, c, d);
        const maxValue = Math.max(a, b, c, d);
        const x = (startI + column) * contourStep;
        const y = (startJ + row) * contourStep;
        for (let band = 0; band < thresholds.length; band++) {
          const threshold = thresholds[band];
          if (threshold > maxValue) break;
          if (threshold <= minValue) continue;
          appendContourCell(
            bandSegments[set][band], column, row, columns, horizontalCount,
            x, y, contourStep, a, b, c, d, threshold
          );
        }
      }
    }

    const previousTop = topValues;
    topValues = bottomValues;
    bottomValues = previousTop;
  }

  return bandSegments.map(segments => segments.map(buildContourPath));
}

export function renderAreas(ctx, viewport, t, travelX, fieldPixels, centerX, centerY, smooth = false) {
  const cacheMatches = areaGeometryCache
    && areaGeometryCache.t === t
    && areaGeometryCache.travelX === travelX
    && areaGeometryCache.smooth === smooth;
  if (!cacheMatches) {
    const supportBounds = { minX: travelX - 0.92, maxX: travelX + 0.92, minY: -0.26, maxY: 1.26 };
    const grid = buildSmoothedWeatherGrid(
      supportBounds, t, travelX, undefined,
      smooth ? AREA_GENERALIZATION_RADIUS * AREA_GENERALIZATION_PASSES : 0
    );
    let rain = grid.rain;
    let storm = grid.storm;
    let hail = grid.hail;
    let rainThresholds = AREA_REFERENCE_THRESHOLDS;
    let stormThreshold = STORM_PRESENCE_THRESHOLD;
    let hailThreshold = HAIL_PRESENCE_THRESHOLD;

    if (smooth) {
      rain = fastBoxBlurScalarGrid(
        grid.rain,
        grid.width,
        grid.height,
        AREA_GENERALIZATION_RADIUS,
        AREA_GENERALIZATION_PASSES,
        getAreaGeneralizationBuffers(grid.rain.length, 'rain')
      );
      storm = fastBoxBlurScalarGrid(
        grid.storm, grid.width, grid.height, AREA_GENERALIZATION_RADIUS, AREA_GENERALIZATION_PASSES,
        getAreaGeneralizationBuffers(grid.storm.length, 'storm')
      );
      hail = fastBoxBlurScalarGrid(
        grid.hail, grid.width, grid.height, AREA_GENERALIZATION_RADIUS, AREA_GENERALIZATION_PASSES,
        getAreaGeneralizationBuffers(grid.hail.length, 'hail')
      );
      rainThresholds = remapCoverageThresholds(grid, grid.rain, rain, supportBounds);
      stormThreshold = remapCoverageThreshold(grid, grid.storm, storm, supportBounds, STORM_PRESENCE_THRESHOLD);
      hailThreshold = remapCoverageThreshold(grid, grid.hail, hail, supportBounds, HAIL_PRESENCE_THRESHOLD);
    }

    const [rainPaths, [stormPath], [hailPath]] = buildContours(grid, [
      { scalar: rain, thresholds: rainThresholds },
      { scalar: storm, thresholds: [stormThreshold] },
      { scalar: hail, thresholds: [hailThreshold] }
    ], travelX);
    areaGeometryCache = { t, travelX, smooth, rainPaths, stormPath, hailPath };
  }

  const { rainPaths, stormPath, hailPath } = areaGeometryCache;
  const worldScale = fieldPixels * viewport.zoom;

  ctx.save();
  ctx.translate(centerX - worldScale * 0.5, centerY - worldScale * 0.5);
  ctx.scale(worldScale, worldScale);
  for (let band = 0; band < AREA_PRECIPITATION_BANDS.length; band++) {
    ctx.fillStyle = AREA_PRECIPITATION_BANDS[band].color;
    ctx.fill(rainPaths[band], 'evenodd');
  }
  ctx.globalAlpha = 0.45;
  ctx.fillStyle = '#FF00FF';
  ctx.fill(stormPath, 'evenodd');
  ctx.globalAlpha = 0.35;
  ctx.fillStyle = '#FFD400';
  ctx.fill(hailPath, 'evenodd');
  ctx.globalAlpha = 1;
  ctx.lineWidth = 1.25 / worldScale;
  ctx.lineJoin = 'round';
  ctx.strokeStyle = '#FF00FF';
  ctx.stroke(stormPath);
  ctx.strokeStyle = '#FFD400';
  ctx.stroke(hailPath);
  ctx.restore();
}
