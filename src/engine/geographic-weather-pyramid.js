import { geographicPreparedIntensityAt, geographicToSynthetic } from './geography.js';
import {
  MAX_DISPLAY_GRID_LEVEL,
  MAX_GRID_LEVEL,
  MIN_GRID_LEVEL,
  selectMercatorGridSamples
} from './geographic-lod.js';

export const WEATHER_REFERENCE_LEVEL = MAX_DISPLAY_GRID_LEVEL;
export const RAIN_COVERAGE_THRESHOLDS_MMH = Object.freeze([
  0.05,
  0.10,
  0.30,
  1.00,
  2.50,
  10.0,
  50.0
]);

function summaryMatchesLevel(summary, levelData, ArrayType) {
  return summary?.totalWeight?.length === levelData.samples.length
    && summary.rainCoverageWeight?.length === RAIN_COVERAGE_THRESHOLDS_MMH.length
    && summary.totalWeight.constructor === ArrayType
    && summary.rainCoverageWeight[0]?.constructor === ArrayType;
}

function zeroSummary(summary) {
  summary.totalWeight.fill(0);
  summary.rainWeightedSumMmh.fill(0);
  summary.rainMaxMmh.fill(0);
  for (const coverage of summary.rainCoverageWeight) coverage.fill(0);
  summary.stormCoverageWeight.fill(0);
  summary.stormWeightedSeverity.fill(0);
  summary.stormMaxSeverity.fill(0);
  summary.hailCoverageWeight.fill(0);
  summary.hailWeightedSeverity.fill(0);
  summary.hailMaxSeverity.fill(0);
}

export function createWeatherSummary(levelData, reusable = null, ArrayType = Float32Array) {
  if (summaryMatchesLevel(reusable, levelData, ArrayType)) {
    reusable.level = levelData.level;
    reusable.samples = levelData.samples;
    zeroSummary(reusable);
    return reusable;
  }

  const length = levelData.samples.length;
  return {
    level: levelData.level,
    samples: levelData.samples,
    totalWeight: new ArrayType(length),
    rainWeightedSumMmh: new ArrayType(length),
    rainMaxMmh: new ArrayType(length),
    rainCoverageWeight: RAIN_COVERAGE_THRESHOLDS_MMH.map(() => new ArrayType(length)),
    stormCoverageWeight: new ArrayType(length),
    stormWeightedSeverity: new ArrayType(length),
    stormMaxSeverity: new ArrayType(length),
    hailCoverageWeight: new ArrayType(length),
    hailWeightedSeverity: new ArrayType(length),
    hailMaxSeverity: new ArrayType(length)
  };
}

function centeredAxisCandidates(coordinate, parentStep) {
  const remainder = coordinate % parentStep;
  if (remainder === 0) return [[coordinate, 1]];
  if (remainder !== parentStep / 2) throw new Error('Fine sample is not centered between adjacent dyadic anchors.');
  const halfStep = parentStep / 2;
  return [[coordinate - halfStep, 0.5], [coordinate + halfStep, 0.5]];
}

export function buildCenteredContributions(fineLevel, coarseLevel) {
  const coarseIndices = new Map(coarseLevel.samples.map((sample, index) => [sample.id, index]));
  const parentStep = 2 ** (MAX_GRID_LEVEL - coarseLevel.level);
  const offsets = new Uint32Array(fineLevel.samples.length + 1);
  const parentIndices = [];
  const weights = [];

  for (let childIndex = 0; childIndex < fineLevel.samples.length; childIndex++) {
    const child = fineLevel.samples[childIndex];
    const xCandidates = centeredAxisCandidates(child.canonicalX, parentStep);
    const yCandidates = centeredAxisCandidates(child.canonicalY, parentStep);
    const candidates = [];
    for (const [x, xWeight] of xCandidates) {
      for (const [y, yWeight] of yCandidates) {
        const parentIndex = coarseIndices.get(`${x}:${y}`);
        if (parentIndex !== undefined) candidates.push([parentIndex, xWeight * yWeight]);
      }
    }
    const totalCandidateWeight = candidates.reduce((sum, [, weight]) => sum + weight, 0);
    if (!(totalCandidateWeight > 0)) throw new Error('Fine sample has no centered coarse contribution.');
    for (const [parentIndex, weight] of candidates) {
      parentIndices.push(parentIndex);
      weights.push(weight / totalCandidateWeight);
    }
    offsets[childIndex + 1] = parentIndices.length;
  }

  return {
    offsets,
    parentIndices: Uint32Array.from(parentIndices),
    weights: Float64Array.from(weights)
  };
}

export function evaluateDirectWeatherSummary(levelData, frame, reusable = null, ArrayType = Float32Array) {
  const summary = createWeatherSummary(levelData, reusable, ArrayType);
  const value = { rainMmh: 0, storm: 0, hail: 0 };
  for (let index = 0; index < levelData.samples.length; index++) {
    const point = geographicToSynthetic(...levelData.samples[index].lngLat);
    geographicPreparedIntensityAt(frame, point, value);
    const rainMmh = value.rainMmh;
    const storm = value.storm;
    const hail = value.hail;

    summary.totalWeight[index] = 1;
    summary.rainWeightedSumMmh[index] = rainMmh;
    summary.rainMaxMmh[index] = rainMmh;
    for (let thresholdIndex = 0; thresholdIndex < RAIN_COVERAGE_THRESHOLDS_MMH.length; thresholdIndex++) {
      summary.rainCoverageWeight[thresholdIndex][index] = rainMmh >= RAIN_COVERAGE_THRESHOLDS_MMH[thresholdIndex] ? 1 : 0;
    }
    summary.stormCoverageWeight[index] = storm > 0 ? 1 : 0;
    summary.stormWeightedSeverity[index] = storm;
    summary.stormMaxSeverity[index] = storm;
    summary.hailCoverageWeight[index] = hail > 0 ? 1 : 0;
    summary.hailWeightedSeverity[index] = hail;
    summary.hailMaxSeverity[index] = hail;
  }
  return summary;
}

export function aggregateWeatherSummary(parentLevel, childSummary, contributions, reusable = null, ArrayType = Float32Array) {
  const summary = createWeatherSummary(parentLevel, reusable, ArrayType);
  const childCount = childSummary.samples.length;
  for (let childIndex = 0; childIndex < childCount; childIndex++) {
    const start = contributions.offsets[childIndex];
    const end = contributions.offsets[childIndex + 1];
    for (let contributionIndex = start; contributionIndex < end; contributionIndex++) {
      const parentIndex = contributions.parentIndices[contributionIndex];
      const weight = contributions.weights[contributionIndex];
      const effectiveWeight = weight * childSummary.totalWeight[childIndex];
      summary.totalWeight[parentIndex] += effectiveWeight;
      summary.rainWeightedSumMmh[parentIndex] += weight * childSummary.rainWeightedSumMmh[childIndex];
      for (let thresholdIndex = 0; thresholdIndex < RAIN_COVERAGE_THRESHOLDS_MMH.length; thresholdIndex++) {
        summary.rainCoverageWeight[thresholdIndex][parentIndex] += weight * childSummary.rainCoverageWeight[thresholdIndex][childIndex];
      }
      summary.stormCoverageWeight[parentIndex] += weight * childSummary.stormCoverageWeight[childIndex];
      summary.stormWeightedSeverity[parentIndex] += weight * childSummary.stormWeightedSeverity[childIndex];
      summary.hailCoverageWeight[parentIndex] += weight * childSummary.hailCoverageWeight[childIndex];
      summary.hailWeightedSeverity[parentIndex] += weight * childSummary.hailWeightedSeverity[childIndex];
      if (effectiveWeight > 0) {
        summary.rainMaxMmh[parentIndex] = Math.max(summary.rainMaxMmh[parentIndex], childSummary.rainMaxMmh[childIndex]);
        summary.stormMaxSeverity[parentIndex] = Math.max(summary.stormMaxSeverity[parentIndex], childSummary.stormMaxSeverity[childIndex]);
        summary.hailMaxSeverity[parentIndex] = Math.max(summary.hailMaxSeverity[parentIndex], childSummary.hailMaxSeverity[childIndex]);
      }
    }
  }
  return summary;
}

export class GeographicWeatherPyramid {
  constructor(summaryArrayType = Float32Array) {
    this.summaryArrayType = summaryArrayType;
    this.levels = new Map();
    for (let level = MIN_GRID_LEVEL; level <= MAX_DISPLAY_GRID_LEVEL; level++) {
      const selection = selectMercatorGridSamples(level);
      this.levels.set(level, {
        level,
        samples: selection.samples,
        samplesById: new Map(selection.samples.map((sample, index) => [sample.id, index]))
      });
    }

    this.contributions = new Map();
    for (let level = MIN_GRID_LEVEL + 1; level <= MAX_DISPLAY_GRID_LEVEL; level++) {
      this.contributions.set(level, buildCenteredContributions(this.levels.get(level), this.levels.get(level - 1)));
    }
  }

  samplesFor(level) {
    return this.levels.get(level).samples;
  }

  topologyFor(level) {
    const levelData = this.levels.get(level);
    return {
      samples: levelData.samples,
      contributionsToParent: this.contributions.get(level) || null
    };
  }

  summaryMemoryBytesPerSample() {
    return (3 + RAIN_COVERAGE_THRESHOLDS_MMH.length + 6) * this.summaryArrayType.BYTES_PER_ELEMENT;
  }

  evaluate(requestedLevels, frame, reusableStates = null) {
    if (!requestedLevels.length) return [];
    const minimumRequested = Math.min(...requestedLevels);
    if (minimumRequested < MIN_GRID_LEVEL || Math.max(...requestedLevels) > WEATHER_REFERENCE_LEVEL) {
      throw new Error(`Weather summary levels must be between L${MIN_GRID_LEVEL} and L${WEATHER_REFERENCE_LEVEL}.`);
    }

    const summaries = new Array(MAX_DISPLAY_GRID_LEVEL + 1);
    let summary = evaluateDirectWeatherSummary(
      this.levels.get(WEATHER_REFERENCE_LEVEL),
      frame,
      reusableStates?.[WEATHER_REFERENCE_LEVEL],
      this.summaryArrayType
    );
    summaries[WEATHER_REFERENCE_LEVEL] = summary;
    for (let level = WEATHER_REFERENCE_LEVEL - 1; level >= minimumRequested; level--) {
      summary = aggregateWeatherSummary(
        this.levels.get(level),
        summary,
        this.contributions.get(level + 1),
        reusableStates?.[level],
        this.summaryArrayType
      );
      summaries[level] = summary;
    }
    return summaries;
  }
}
