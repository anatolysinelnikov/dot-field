import { AREA_PRECIPITATION_BANDS, RAIN_PRESENTATION_MAX_MMH } from './config.js';
import { prepareGeographicFieldFrame, geographicPreparedIntensityAtXY, geographicToSynthetic } from './geography.js';
import { mercatorXForIndex, mercatorXToLongitude, mercatorYForIndex, mercatorYToLatitude, selectMercatorGridLevel } from './geographic-lod.js';

// Blur and Areas share one L14 lattice.  Unlike the display LOD, this grid is
// never selected from the camera: its vertices, cells, and identities persist
// for the life of the map layer.
export const SCALAR_GRID_LEVEL = 14;
export const SCALAR_SMOOTH_RADIUS = 3;
export const SCALAR_SMOOTH_PASSES = 2;
export const AREA_STORM_THRESHOLD = 0.075 * 0.45;
export const AREA_HAIL_THRESHOLD = 0.11 * 0.45;

const HISTOGRAM_BINS = 1024;
export const AREA_RAIN_THRESHOLDS = Object.freeze(AREA_PRECIPITATION_BANDS.map(({ threshold }) => threshold));

function makeChannels(length) {
  return {
    rainMmh: new Float32Array(length),
    storm: new Float32Array(length),
    hail: new Float32Array(length)
  };
}

function makeState(length) {
  return {
    raw: makeChannels(length),
    smooth: null,
    smoothReady: false,
    rainThresholds: new Float32Array(AREA_RAIN_THRESHOLDS),
    stormThreshold: AREA_STORM_THRESHOLD,
    hailThreshold: AREA_HAIL_THRESHOLD
  };
}

function blurHorizontal(source, target, width, height, radius) {
  const windowSize = radius * 2 + 1;
  for (let row = 0; row < height; row++) {
    const offset = row * width;
    let total = source[offset] * (radius + 1);
    for (let column = 1; column <= radius; column++) total += source[offset + Math.min(width - 1, column)];
    for (let column = 0; column < width; column++) {
      target[offset + column] = total / windowSize;
      total += source[offset + Math.min(width - 1, column + radius + 1)] - source[offset + Math.max(0, column - radius)];
    }
  }
}

function blurVertical(source, target, width, height, radius) {
  const windowSize = radius * 2 + 1;
  for (let column = 0; column < width; column++) {
    let total = source[column] * (radius + 1);
    for (let row = 1; row <= radius; row++) total += source[Math.min(height - 1, row) * width + column];
    for (let row = 0; row < height; row++) {
      target[row * width + column] = total / windowSize;
      total += source[Math.min(height - 1, row + radius + 1) * width + column] - source[Math.max(0, row - radius) * width + column];
    }
  }
}

function smoothChannel(source, output, scratchA, scratchB, width, height) {
  let current = source;
  for (let pass = 0; pass < SCALAR_SMOOTH_PASSES; pass++) {
    blurHorizontal(current, scratchA, width, height, SCALAR_SMOOTH_RADIUS);
    const target = pass === SCALAR_SMOOTH_PASSES - 1 ? output : scratchB;
    blurVertical(scratchA, target, width, height, SCALAR_SMOOTH_RADIUS);
    current = target;
  }
}

function coverageThresholdFromHistogram(coverage, histogram) {
  if (!coverage) return 1;
  let accumulated = 0;
  for (let bin = HISTOGRAM_BINS - 1; bin >= 0; bin--) {
    const count = histogram[bin];
    if (accumulated + count >= coverage) return (bin + 1 - (coverage - accumulated) / count) / HISTOGRAM_BINS;
    accumulated += count;
  }
  return 0;
}

function coverageThreshold(raw, generalized, threshold, histogram, valueMaximum = 1) {
  histogram.fill(0);
  let coverage = 0;
  for (let index = 0; index < raw.length; index++) {
    const value = Math.max(0, Math.min(valueMaximum, generalized[index]));
    histogram[Math.min(HISTOGRAM_BINS - 1, Math.floor(value / valueMaximum * HISTOGRAM_BINS))]++;
    if (raw[index] >= threshold) coverage++;
  }
  return coverageThresholdFromHistogram(coverage, histogram) * valueMaximum;
}

function remapThresholds(state, histogram, rainCoverage) {
  histogram.fill(0);
  rainCoverage.fill(0);
  // This presentation-domain histogram is only for Smooth coverage remapping;
  // state.smooth.rainMmh itself remains physical and unbounded.
  for (let index = 0; index < state.raw.rainMmh.length; index++) {
    const value = Math.max(0, Math.min(RAIN_PRESENTATION_MAX_MMH, state.smooth.rainMmh[index]));
    histogram[Math.min(HISTOGRAM_BINS - 1, Math.floor(value / RAIN_PRESENTATION_MAX_MMH * HISTOGRAM_BINS))]++;
    const raw = state.raw.rainMmh[index];
    for (let thresholdIndex = 0; thresholdIndex < AREA_RAIN_THRESHOLDS.length; thresholdIndex++) {
      if (raw >= AREA_RAIN_THRESHOLDS[thresholdIndex]) rainCoverage[thresholdIndex]++;
    }
  }
  let previous = 0;
  for (let index = 0; index < AREA_RAIN_THRESHOLDS.length; index++) {
    const threshold = coverageThresholdFromHistogram(rainCoverage[index], histogram) * RAIN_PRESENTATION_MAX_MMH;
    state.rainThresholds[index] = Math.max(previous + (index ? 1e-5 : 0), Math.min(RAIN_PRESENTATION_MAX_MMH, threshold));
    previous = state.rainThresholds[index];
  }
  state.stormThreshold = coverageThreshold(state.raw.storm, state.smooth.storm, AREA_STORM_THRESHOLD, histogram);
  state.hailThreshold = coverageThreshold(state.raw.hail, state.smooth.hail, AREA_HAIL_THRESHOLD, histogram);
}

export class GeographicScalarLattice {
  constructor() {
    const levelData = selectMercatorGridLevel(SCALAR_GRID_LEVEL);
    this.levelData = levelData;
    this.length = levelData.count;
    this.spacing = levelData.spacing;
    this.width = levelData.width;
    this.height = levelData.height;
    this.origin = new Float32Array(2);
    this.origin[0] = mercatorXForIndex(levelData, 0);
    this.origin[1] = mercatorYForIndex(levelData, 0);
    this.positions = new Float32Array(this.length * 2);
    this.fieldPoints = new Float32Array(this.length * 2);
    for (let index = 0; index < this.length; index++) {
      const anchorIndex = index * 2;
      const mercatorX = mercatorXForIndex(levelData, index);
      const mercatorY = mercatorYForIndex(levelData, index);
      this.positions[anchorIndex] = mercatorX;
      this.positions[anchorIndex + 1] = mercatorY;
      const point = geographicToSynthetic(
        mercatorXToLongitude(mercatorX),
        mercatorYToLatitude(mercatorY)
      );
      this.fieldPoints[index * 2] = point.x;
      this.fieldPoints[index * 2 + 1] = point.y;
    }
    const cells = (this.width - 1) * (this.height - 1);
    this.indices = new Uint32Array(cells * 6);
    let cursor = 0;
    for (let row = 0; row < this.height - 1; row++) {
      for (let column = 0; column < this.width - 1; column++) {
        const topLeft = row * this.width + column;
        const topRight = topLeft + 1;
        const bottomLeft = topLeft + this.width;
        const bottomRight = bottomLeft + 1;
        this.indices.set([topLeft, bottomLeft, topRight, topRight, bottomLeft, bottomRight], cursor);
        cursor += 6;
      }
    }
    this.scratchA = new Float32Array(this.length);
    this.scratchB = new Float32Array(this.length);
    this.histogram = new Uint32Array(HISTOGRAM_BINS);
    this.rainCoverage = new Uint32Array(AREA_RAIN_THRESHOLDS.length);
  }

  evaluate(time, reusable = null) {
    const state = reusable || makeState(this.length);
    const frame = prepareGeographicFieldFrame(time);
    const value = { rainMmh: 0, storm: 0, hail: 0 };
    for (let index = 0; index < this.length; index++) {
      geographicPreparedIntensityAtXY(frame, this.fieldPoints[index * 2], this.fieldPoints[index * 2 + 1], value);
      state.raw.rainMmh[index] = value.rainMmh;
      state.raw.storm[index] = value.storm;
      state.raw.hail[index] = value.hail;
    }
    state.smoothReady = false;
    return state;
  }

  ensureSmooth(state) {
    if (state.smoothReady) return state;
    if (!state.smooth) state.smooth = makeChannels(this.length);
    for (const channel of ['rainMmh', 'storm', 'hail']) {
      smoothChannel(state.raw[channel], state.smooth[channel], this.scratchA, this.scratchB, this.width, this.height);
    }
    remapThresholds(state, this.histogram, this.rainCoverage);
    state.smoothReady = true;
    return state;
  }
}
