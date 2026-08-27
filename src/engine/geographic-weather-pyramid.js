import {
  geographicPreparedIntensityAtGeometry,
  geographicPreparedIntensityAtGeometryBatch,
  geographicPreparedIntensityAtXY,
  prepareGeographicSamplingGeometry
} from './geography.js';
import {
  MAX_DISPLAY_GRID_LEVEL,
  MIN_GRID_LEVEL,
  MAX_GRID_LEVEL,
  GeographicLodTopology,
  canonicalWindowsEqual,
  lodRangesEqual,
  normalizeCanonicalWindow,
  normalizeLodRange
} from './geographic-lod.js';

// L13 is the nearest practical dyadic Mercator scale to the current parsed
// provider grid near WEATHER_REGION.center. Levels above it are independent
// denser samples of the reconstructed field; only lower levels aggregate.
export const WEATHER_REFERENCE_LEVEL = 13;
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

function zeroWeatherFields(summary, activeIndices = null) {
  if (!activeIndices) {
    summary.rainWeightedSumMmh.fill(0);
    summary.rainMaxMmh.fill(0);
    for (const coverage of summary.rainCoverageWeight) coverage.fill(0);
    summary.stormCoverageWeight.fill(0);
    summary.stormWeightedSeverity.fill(0);
    summary.stormMaxSeverity.fill(0);
    summary.hailCoverageWeight.fill(0);
    summary.hailWeightedSeverity.fill(0);
    summary.hailMaxSeverity.fill(0);
    return;
  }
  for (const index of activeIndices) {
    summary.rainWeightedSumMmh[index] = 0;
    summary.rainMaxMmh[index] = 0;
    for (const coverage of summary.rainCoverageWeight) coverage[index] = 0;
    summary.stormCoverageWeight[index] = 0;
    summary.stormWeightedSeverity[index] = 0;
    summary.stormMaxSeverity[index] = 0;
    summary.hailCoverageWeight[index] = 0;
    summary.hailWeightedSeverity[index] = 0;
    summary.hailMaxSeverity[index] = 0;
  }
}

export function createWeatherSummary(levelData, reusable = null, ArrayType = Float32Array, totalWeight = null) {
  if (summaryMatchesLevel(reusable, levelData, ArrayType)) {
    reusable.level = levelData.level;
    reusable.samples = levelData.samples;
    if (totalWeight) {
      reusable.totalWeight = totalWeight;
      reusable.totalWeightInitialized = true;
    }
    return reusable;
  }

  const length = levelData.samples.length;
  return {
    level: levelData.level,
    samples: levelData.samples,
    totalWeight: totalWeight || new ArrayType(length),
    totalWeightInitialized: Boolean(totalWeight),
    potentialActiveIndices: undefined,
    potentialActiveIndicesInitialized: false,
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

function initializeDirectTotalWeight(summary) {
  if (summary.totalWeightInitialized) return;
  summary.totalWeight.fill(1);
  summary.totalWeightInitialized = true;
}

function initializeAggregateTotalWeight(summary, childSummary, contributions) {
  if (summary.totalWeightInitialized) return;
  summary.totalWeight.fill(0);
  for (let childIndex = 0; childIndex < childSummary.samples.length; childIndex++) {
    const start = contributions.offsets[childIndex];
    const end = contributions.offsets[childIndex + 1];
    for (let contributionIndex = start; contributionIndex < end; contributionIndex++) {
      const parentIndex = contributions.parentIndices[contributionIndex];
      summary.totalWeight[parentIndex] += contributions.weights[contributionIndex] * childSummary.totalWeight[childIndex];
    }
  }
  summary.totalWeightInitialized = true;
}

function activeIndicesForAggregate(summary, childSummary, contributions) {
  if (summary.potentialActiveIndicesInitialized) return summary.potentialActiveIndices;
  const childActiveIndices = childSummary.potentialActiveIndices;
  if (!childActiveIndices) {
    summary.potentialActiveIndices = null;
    summary.potentialActiveIndicesInitialized = true;
    return null;
  }
  const active = new Uint8Array(summary.samples.length);
  for (const childIndex of childActiveIndices) {
    const start = contributions.offsets[childIndex];
    const end = contributions.offsets[childIndex + 1];
    for (let contributionIndex = start; contributionIndex < end; contributionIndex++) {
      active[contributions.parentIndices[contributionIndex]] = 1;
    }
  }
  const activeIndices = [];
  for (let index = 0; index < active.length; index++) if (active[index]) activeIndices.push(index);
  summary.potentialActiveIndices = Uint32Array.from(activeIndices);
  summary.potentialActiveIndicesInitialized = true;
  return summary.potentialActiveIndices;
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

export function evaluateDirectWeatherSummary(levelData, frame, reusable = null, ArrayType = Float32Array, samplingGeometry = null, totalWeight = null) {
  const summary = createWeatherSummary(levelData, reusable, ArrayType, totalWeight);
  initializeDirectTotalWeight(summary);
  const activeIndices = samplingGeometry?.potentialActiveIndices ?? null;
  const previousActiveIndices = summary.potentialActiveIndices;
  if (activeIndices && previousActiveIndices !== activeIndices) {
    zeroWeatherFields(summary, previousActiveIndices || null);
  }
  summary.potentialActiveIndices = activeIndices;
  summary.potentialActiveIndicesInitialized = true;
  const batchRain = samplingGeometry && activeIndices && typeof frame.samplePreparedBatch === 'function'
    ? geographicPreparedIntensityAtGeometryBatch(frame, samplingGeometry)
    : null;
  const value = { rainMmh: 0, storm: 0, hail: 0 };
  const count = activeIndices ? activeIndices.length : levelData.samples.length;
  for (let activeIndex = 0; activeIndex < count; activeIndex++) {
    const index = activeIndices ? activeIndices[activeIndex] : activeIndex;
    if (batchRain) {
      value.rainMmh = batchRain[activeIndex];
      value.storm = 0;
      value.hail = 0;
    } else if (samplingGeometry) geographicPreparedIntensityAtGeometry(frame, samplingGeometry, index, value);
    else geographicPreparedIntensityAtXY(frame, levelData.samples[index].lngLat[0], levelData.samples[index].lngLat[1], value);
    const rainMmh = value.rainMmh;
    const storm = value.storm;
    const hail = value.hail;

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

export function aggregateWeatherSummary(parentLevel, childSummary, contributions, reusable = null, ArrayType = Float32Array, totalWeight = null) {
  const summary = createWeatherSummary(parentLevel, reusable, ArrayType, totalWeight);
  initializeAggregateTotalWeight(summary, childSummary, contributions);
  const activeIndices = activeIndicesForAggregate(summary, childSummary, contributions);
  zeroWeatherFields(summary, activeIndices);
  const childCount = childSummary.samples.length;
  const activeChildren = childSummary.potentialActiveIndices;
  for (let activeChild = 0; activeChild < (activeChildren ? activeChildren.length : childCount); activeChild++) {
    const childIndex = activeChildren ? activeChildren[activeChild] : activeChild;
    const start = contributions.offsets[childIndex];
    const end = contributions.offsets[childIndex + 1];
    for (let contributionIndex = start; contributionIndex < end; contributionIndex++) {
      const parentIndex = contributions.parentIndices[contributionIndex];
      const weight = contributions.weights[contributionIndex];
      const effectiveWeight = weight * childSummary.totalWeight[childIndex];
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
  constructor(summaryArrayType = Float32Array, topology = new GeographicLodTopology()) {
    this.summaryArrayType = summaryArrayType;
    this.setTopology(topology);
  }

  setTopology(topology) {
    this.topology = topology;
    this.levels = topology.levels;
    this.contributions = new Map();
    for (let level = Math.max(MIN_GRID_LEVEL + 1, topology.levelRange.minLevel + 1); level <= Math.min(WEATHER_REFERENCE_LEVEL, topology.levelRange.maxLevel); level++) {
      if (!this.levels.has(level - 1)) continue;
      this.contributions.set(level, buildCenteredContributions(this.levels.get(level), this.levels.get(level - 1)));
    }
    this.totalWeights = new Map();
    if (this.levels.has(WEATHER_REFERENCE_LEVEL)) {
      const referenceWeights = new this.summaryArrayType(this.levels.get(WEATHER_REFERENCE_LEVEL).samples.length);
      referenceWeights.fill(1);
      this.totalWeights.set(WEATHER_REFERENCE_LEVEL, referenceWeights);
      for (let level = WEATHER_REFERENCE_LEVEL - 1; level >= topology.levelRange.minLevel; level--) {
        const childWeights = this.totalWeights.get(level + 1);
        const contributions = this.contributions.get(level + 1);
        if (!childWeights || !contributions || !this.levels.has(level)) continue;
        const weights = new this.summaryArrayType(this.levels.get(level).samples.length);
        for (let childIndex = 0; childIndex < childWeights.length; childIndex++) {
          const start = contributions.offsets[childIndex];
          const end = contributions.offsets[childIndex + 1];
          for (let contributionIndex = start; contributionIndex < end; contributionIndex++) {
            weights[contributions.parentIndices[contributionIndex]] += contributions.weights[contributionIndex] * childWeights[childIndex];
          }
        }
        this.totalWeights.set(level, weights);
      }
    }
    this.samplingGeometries = new Map();
  }

  setCanonicalWindow(canonicalWindow) {
    return this.setConfiguration(canonicalWindow, this.topology.levelRange);
  }

  setLevelRange(levelRange) {
    return this.setConfiguration(this.topology.canonicalWindow, levelRange);
  }

  setConfiguration(canonicalWindow, levelRange) {
    const nextWindow = normalizeCanonicalWindow(canonicalWindow);
    const nextRange = normalizeLodRange(levelRange);
    if (canonicalWindowsEqual(this.topology.canonicalWindow, nextWindow) && lodRangesEqual(this.topology.levelRange, nextRange)) return false;
    this.setTopology(new GeographicLodTopology(nextWindow, nextRange));
    return true;
  }

  levelDataFor(level) {
    const levelData = this.levels.get(level);
    if (!levelData) throw new Error(`LOD L${level} is not materialized in the active topology range.`);
    return levelData;
  }

  samplesFor(level) {
    return this.levelDataFor(level).samples;
  }

  topologyFor(level) {
    const levelData = this.levelDataFor(level);
    return {
      samples: levelData.samples,
      contributionsToParent: this.contributions.get(level) || null
    };
  }

  summaryMemoryBytesPerSample() {
    return (3 + RAIN_COVERAGE_THRESHOLDS_MMH.length + 6) * this.summaryArrayType.BYTES_PER_ELEMENT;
  }

  prepareSamplingGeometry(level, frame) {
    const existing = this.samplingGeometries.get(level);
    if (existing && frame.isSamplingGeometryCompatible(existing)) return existing;
    const geometry = prepareGeographicSamplingGeometry(frame, this.samplesFor(level), existing);
    this.samplingGeometries.set(level, geometry);
    return geometry;
  }

  evaluate(requestedLevels, frame, reusableStates = null) {
    if (!requestedLevels.length) return [];
    const minimumRequested = Math.min(...requestedLevels);
    if (minimumRequested < MIN_GRID_LEVEL || Math.max(...requestedLevels) > MAX_DISPLAY_GRID_LEVEL) {
      throw new Error(`Weather summary levels must be between L${MIN_GRID_LEVEL} and L${MAX_DISPLAY_GRID_LEVEL}.`);
    }

    const summaries = new Array(MAX_DISPLAY_GRID_LEVEL + 1);
    const uniqueRequested = [...new Set(requestedLevels)];
    const aggregateRequested = uniqueRequested.filter((level) => level <= WEATHER_REFERENCE_LEVEL);
    if (aggregateRequested.length) {
      const minimumAggregateLevel = Math.min(...aggregateRequested);
      this.levelDataFor(WEATHER_REFERENCE_LEVEL);
      for (let level = minimumAggregateLevel; level <= WEATHER_REFERENCE_LEVEL; level++) this.levelDataFor(level);
      let summary = evaluateDirectWeatherSummary(
        this.levels.get(WEATHER_REFERENCE_LEVEL),
        frame,
        reusableStates?.[WEATHER_REFERENCE_LEVEL],
        this.summaryArrayType,
        this.prepareSamplingGeometry(WEATHER_REFERENCE_LEVEL, frame),
        this.totalWeights.get(WEATHER_REFERENCE_LEVEL)
      );
      summaries[WEATHER_REFERENCE_LEVEL] = summary;
      for (let level = WEATHER_REFERENCE_LEVEL - 1; level >= minimumAggregateLevel; level--) {
        const contributions = this.contributions.get(level + 1);
        if (!contributions) throw new Error(`LOD L${level} aggregation requires an unbroken L13 reference chain.`);
        summary = aggregateWeatherSummary(
          this.levels.get(level),
          summary,
          contributions,
          reusableStates?.[level],
          this.summaryArrayType,
          this.totalWeights.get(level)
        );
        summaries[level] = summary;
      }
    }
    for (const level of uniqueRequested) {
      if (level > WEATHER_REFERENCE_LEVEL) {
        this.levelDataFor(level);
        summaries[level] = evaluateDirectWeatherSummary(
          this.levels.get(level),
          frame,
          reusableStates?.[level],
          this.summaryArrayType,
          this.prepareSamplingGeometry(level, frame),
          this.totalWeights.get(level)
        );
      }
    }
    return summaries;
  }
}
