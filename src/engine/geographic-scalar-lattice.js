import { AREA_PRECIPITATION_BANDS } from './config.js';
import { prepareGeographicFieldFrame, geographicPreparedIntensityAt, geographicToSynthetic } from './geography.js';
import { MAX_DISPLAY_GRID_LEVEL, selectMercatorGridSamples } from './geographic-lod.js';

// Blur and Areas share one L14 lattice.  Unlike the display LOD, this grid is
// never selected from the camera: its vertices, cells, and identities persist
// for the life of the map layer.
export const SCALAR_GRID_LEVEL = MAX_DISPLAY_GRID_LEVEL;
export const SCALAR_SMOOTH_RADIUS = 3;
export const SCALAR_SMOOTH_PASSES = 2;
export const AREA_STORM_THRESHOLD = 0.075 * 0.45;
export const AREA_HAIL_THRESHOLD = 0.11 * 0.45;

const HISTOGRAM_BINS = 1024;
export const AREA_RAIN_THRESHOLDS = Object.freeze(AREA_PRECIPITATION_BANDS.map(({ threshold }) => threshold));

function makeChannels(length) {
  return {
    rain: new Float32Array(length),
    storm: new Float32Array(length),
    hail: new Float32Array(length)
  };
}

function makeState(length) {
  return {
    raw: makeChannels(length),
    smooth: makeChannels(length),
    rainThresholds: new Float32Array(AREA_RAIN_THRESHOLDS),
    stormThreshold: AREA_STORM_THRESHOLD,
    hailThreshold: AREA_HAIL_THRESHOLD
  };
}

function blurHorizontal(source, target, width, height, radius) {
  for (let row = 0; row < height; row++) {
    const offset = row * width;
    for (let column = 0; column < width; column++) {
      let total = 0;
      for (let k = -radius; k <= radius; k++) total += source[offset + Math.max(0, Math.min(width - 1, column + k))];
      target[offset + column] = total / (radius * 2 + 1);
    }
  }
}

function blurVertical(source, target, width, height, radius) {
  for (let row = 0; row < height; row++) {
    const offset = row * width;
    for (let column = 0; column < width; column++) {
      let total = 0;
      for (let k = -radius; k <= radius; k++) total += source[Math.max(0, Math.min(height - 1, row + k)) * width + column];
      target[offset + column] = total / (radius * 2 + 1);
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

function coverageThreshold(raw, generalized, threshold, histogram) {
  histogram.fill(0);
  let coverage = 0;
  for (let index = 0; index < raw.length; index++) {
    const value = Math.max(0, Math.min(1, generalized[index]));
    histogram[Math.min(HISTOGRAM_BINS - 1, Math.floor(value * HISTOGRAM_BINS))]++;
    if (raw[index] >= threshold) coverage++;
  }
  if (!coverage) return 1;
  let accumulated = 0;
  for (let bin = HISTOGRAM_BINS - 1; bin >= 0; bin--) {
    const count = histogram[bin];
    if (accumulated + count >= coverage) return (bin + 1 - (coverage - accumulated) / count) / HISTOGRAM_BINS;
    accumulated += count;
  }
  return 0;
}

function remapThresholds(state, histogram) {
  let previous = 0;
  for (let index = 0; index < AREA_RAIN_THRESHOLDS.length; index++) {
    const threshold = coverageThreshold(state.raw.rain, state.smooth.rain, AREA_RAIN_THRESHOLDS[index], histogram);
    state.rainThresholds[index] = Math.max(previous + (index ? 1e-5 : 0), Math.min(1, threshold));
    previous = state.rainThresholds[index];
  }
  state.stormThreshold = coverageThreshold(state.raw.storm, state.smooth.storm, AREA_STORM_THRESHOLD, histogram);
  state.hailThreshold = coverageThreshold(state.raw.hail, state.smooth.hail, AREA_HAIL_THRESHOLD, histogram);
}

export class GeographicScalarLattice {
  constructor() {
    const selection = selectMercatorGridSamples(SCALAR_GRID_LEVEL);
    this.samples = selection.samples;
    this.length = selection.samples.length;
    this.spacing = selection.spacing;
    this.width = 1;
    const firstY = selection.samples[0].canonicalY;
    while (this.width < this.length && selection.samples[this.width].canonicalY === firstY) this.width++;
    this.height = this.length / this.width;
    this.origin = new Float32Array(selection.samples[0].mercator);
    this.positions = new Float32Array(this.length * 2);
    this.fieldPoints = new Float32Array(this.length * 2);
    for (let index = 0; index < this.length; index++) {
      const sample = selection.samples[index];
      this.positions[index * 2] = sample.mercator[0];
      this.positions[index * 2 + 1] = sample.mercator[1];
      const point = geographicToSynthetic(...sample.lngLat);
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
  }

  evaluate(time, reusable = null) {
    const state = reusable || makeState(this.length);
    const frame = prepareGeographicFieldFrame(time);
    const value = { rain: 0, storm: 0, hail: 0 };
    for (let index = 0; index < this.length; index++) {
      geographicPreparedIntensityAt(frame, { x: this.fieldPoints[index * 2], y: this.fieldPoints[index * 2 + 1] }, value);
      state.raw.rain[index] = value.rain;
      state.raw.storm[index] = value.storm;
      state.raw.hail[index] = value.hail;
    }
    for (const channel of ['rain', 'storm', 'hail']) {
      smoothChannel(state.raw[channel], state.smooth[channel], this.scratchA, this.scratchB, this.width, this.height);
    }
    remapThresholds(state, this.histogram);
    return state;
  }
}
