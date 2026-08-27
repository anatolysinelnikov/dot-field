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
  canonicalIndexForCoordinates,
  canonicalXForIndex,
  canonicalYForIndex,
  mercatorXToLongitude,
  mercatorYToLatitude,
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
const now = () => globalThis.performance?.now?.() ?? Date.now();
const AGGREGATION_PLAN_CACHE_LIMIT = 12;
const centeredContributionPlanCache = new Map();
const totalWeightPlanCache = new Map();
const aggregationPlanCacheCounters = { contributionHits: 0, contributionMisses: 0, totalWeightHits: 0, totalWeightMisses: 0 };

function boundedCacheSet(cache, key, value) {
  if (cache.has(key)) cache.delete(key);
  cache.set(key, value);
  while (cache.size > AGGREGATION_PLAN_CACHE_LIMIT) cache.delete(cache.keys().next().value);
}

export function resetAggregationPlanCache() {
  centeredContributionPlanCache.clear();
  totalWeightPlanCache.clear();
  aggregationPlanCacheCounters.contributionHits = 0;
  aggregationPlanCacheCounters.contributionMisses = 0;
  aggregationPlanCacheCounters.totalWeightHits = 0;
  aggregationPlanCacheCounters.totalWeightMisses = 0;
}

export function aggregationPlanCacheStats() {
  return {
    ...aggregationPlanCacheCounters,
    contributionEntries: centeredContributionPlanCache.size,
    totalWeightEntries: totalWeightPlanCache.size
  };
}

function summaryMatchesLevel(summary, levelData, ArrayType) {
  return summary?.totalWeight?.length === levelData.count
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
    reusable.levelData = levelData;
    if (totalWeight) {
      reusable.totalWeight = totalWeight;
      reusable.totalWeightInitialized = true;
    }
    return reusable;
  }

  const length = levelData.count;
  return {
    level: levelData.level,
    levelData,
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
  for (let childIndex = 0; childIndex < childSummary.levelData.count; childIndex++) {
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
  const active = new Uint8Array(summary.levelData.count);
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

export function buildCenteredContributions(fineLevel, coarseLevel) {
  const parentStep = 2 ** (MAX_GRID_LEVEL - coarseLevel.level);
  const offsets = new Uint32Array(fineLevel.count + 1);

  for (let childIndex = 0; childIndex < fineLevel.count; childIndex++) {
    const canonicalX = canonicalXForIndex(fineLevel, childIndex);
    const canonicalY = canonicalYForIndex(fineLevel, childIndex);
    const xRemainder = canonicalX % parentStep;
    const yRemainder = canonicalY % parentStep;
    if (xRemainder !== 0 && xRemainder !== parentStep / 2) throw new Error('Fine sample is not centered between adjacent dyadic anchors.');
    if (yRemainder !== 0 && yRemainder !== parentStep / 2) throw new Error('Fine sample is not centered between adjacent dyadic anchors.');
    const xCount = xRemainder === 0 ? 1 : 2;
    const yCount = yRemainder === 0 ? 1 : 2;
    const xStart = xRemainder === 0 ? canonicalX : canonicalX - parentStep / 2;
    const yStart = yRemainder === 0 ? canonicalY : canonicalY - parentStep / 2;
    let candidateCount = 0;
    for (let xOffset = 0; xOffset < xCount; xOffset++) {
      const x = xStart + xOffset * parentStep;
      for (let yOffset = 0; yOffset < yCount; yOffset++) {
        const y = yStart + yOffset * parentStep;
        if (canonicalIndexForCoordinates(coarseLevel, x, y) >= 0) candidateCount++;
      }
    }
    if (!candidateCount) throw new Error('Fine sample has no centered coarse contribution.');
    offsets[childIndex + 1] = offsets[childIndex] + candidateCount;
  }

  const parentIndices = new Uint32Array(offsets[fineLevel.count]);
  const weights = new Float64Array(parentIndices.length);
  for (let childIndex = 0; childIndex < fineLevel.count; childIndex++) {
    const canonicalX = canonicalXForIndex(fineLevel, childIndex);
    const canonicalY = canonicalYForIndex(fineLevel, childIndex);
    const xRemainder = canonicalX % parentStep;
    const yRemainder = canonicalY % parentStep;
    const xCount = xRemainder === 0 ? 1 : 2;
    const yCount = yRemainder === 0 ? 1 : 2;
    const xStart = xRemainder === 0 ? canonicalX : canonicalX - parentStep / 2;
    const yStart = yRemainder === 0 ? canonicalY : canonicalY - parentStep / 2;
    const totalCandidateWeight = (xCount === 1 ? 1 : 0.5) * (yCount === 1 ? 1 : 0.5)
      * (offsets[childIndex + 1] - offsets[childIndex]);
    let contributionIndex = offsets[childIndex];
    for (let xOffset = 0; xOffset < xCount; xOffset++) {
      const x = xStart + xOffset * parentStep;
      for (let yOffset = 0; yOffset < yCount; yOffset++) {
        const y = yStart + yOffset * parentStep;
        const parentIndex = canonicalIndexForCoordinates(coarseLevel, x, y);
        if (parentIndex < 0) continue;
        const weight = (xCount === 1 ? 1 : 0.5) * (yCount === 1 ? 1 : 0.5);
        parentIndices[contributionIndex] = parentIndex;
        weights[contributionIndex++] = weight / totalCandidateWeight;
      }
    }
  }

  return { offsets, parentIndices, weights };
}

// For adjacent dyadic levels, local contribution indices depend only on the
// relative origins, dimensions, and edge clipping of the two rectangular
// selections. Absolute geographic position is intentionally absent. The
// origin deltas encode both parity and which side of an edge is clipped.
export function centeredContributionStructuralKey(fineLevel, coarseLevel) {
  const originX = fineLevel.minI - coarseLevel.minI * 2;
  const originY = fineLevel.minJ - coarseLevel.minJ * 2;
  const endX = fineLevel.maxI - coarseLevel.maxI * 2;
  const endY = fineLevel.maxJ - coarseLevel.maxJ * 2;
  return [
    fineLevel.level, coarseLevel.level,
    fineLevel.width, fineLevel.height,
    coarseLevel.width, coarseLevel.height,
    fineLevel.minI & 1, fineLevel.minJ & 1,
    originX, originY, endX, endY
  ].join(':');
}

// This verifier proves the cached plan against the new topology without
// allocating a second contribution graph. Every offset, local parent index,
// and Float64 weight is checked using the same canonical arithmetic as the
// uncached builder. A matching structural key then proves translation
// invariance for the plan and its derived total weights.
export function verifyCenteredContributionPlan(fineLevel, coarseLevel, contributions) {
  if (!contributions || contributions.offsets.length !== fineLevel.count + 1) return false;
  const parentStep = 2 ** (MAX_GRID_LEVEL - coarseLevel.level);
  let expectedOffset = 0;
  for (let childIndex = 0; childIndex < fineLevel.count; childIndex++) {
    const canonicalX = canonicalXForIndex(fineLevel, childIndex);
    const canonicalY = canonicalYForIndex(fineLevel, childIndex);
    const xRemainder = canonicalX % parentStep;
    const yRemainder = canonicalY % parentStep;
    if ((xRemainder !== 0 && xRemainder !== parentStep / 2)
      || (yRemainder !== 0 && yRemainder !== parentStep / 2)) return false;
    const xCount = xRemainder === 0 ? 1 : 2;
    const yCount = yRemainder === 0 ? 1 : 2;
    const xStart = xRemainder === 0 ? canonicalX : canonicalX - parentStep / 2;
    const yStart = yRemainder === 0 ? canonicalY : canonicalY - parentStep / 2;
    const totalCandidateWeight = (xCount === 1 ? 1 : 0.5) * (yCount === 1 ? 1 : 0.5);
    let candidateCount = 0;
    for (let xOffset = 0; xOffset < xCount; xOffset++) {
      for (let yOffset = 0; yOffset < yCount; yOffset++) {
        if (canonicalIndexForCoordinates(coarseLevel, xStart + xOffset * parentStep, yStart + yOffset * parentStep) >= 0) candidateCount++;
      }
    }
    if (contributions.offsets[childIndex] !== expectedOffset
      || contributions.offsets[childIndex + 1] !== expectedOffset + candidateCount) return false;
    let contributionIndex = expectedOffset;
    for (let xOffset = 0; xOffset < xCount; xOffset++) {
      for (let yOffset = 0; yOffset < yCount; yOffset++) {
        const parentIndex = canonicalIndexForCoordinates(coarseLevel, xStart + xOffset * parentStep, yStart + yOffset * parentStep);
        if (parentIndex < 0) continue;
        const weight = ((xCount === 1 ? 1 : 0.5) * (yCount === 1 ? 1 : 0.5)) / (totalCandidateWeight * candidateCount);
        if (contributions.parentIndices[contributionIndex] !== parentIndex
          || contributions.weights[contributionIndex] !== weight) return false;
        contributionIndex++;
      }
    }
    expectedOffset += candidateCount;
  }
  return contributions.parentIndices.length === expectedOffset;
}

function getCenteredContributionPlan(fineLevel, coarseLevel, reuse) {
  const key = centeredContributionStructuralKey(fineLevel, coarseLevel);
  if (reuse) {
    const cached = centeredContributionPlanCache.get(key);
    if (cached && verifyCenteredContributionPlan(fineLevel, coarseLevel, cached)) {
      aggregationPlanCacheCounters.contributionHits++;
      return { key, plan: cached, reused: true };
    }
  }
  aggregationPlanCacheCounters.contributionMisses++;
  const plan = buildCenteredContributions(fineLevel, coarseLevel);
  if (!verifyCenteredContributionPlan(fineLevel, coarseLevel, plan)) throw new Error('Centered contribution verifier rejected a freshly built plan.');
  if (reuse) boundedCacheSet(centeredContributionPlanCache, key, plan);
  return { key, plan, reused: false };
}

function totalWeightStructuralKey(level, levelData, contributionKeys) {
  return [level, levelData.width, levelData.height, ...contributionKeys].join(':');
}

function buildTotalWeight(levelData, childWeights, contributions, ArrayType) {
  const weights = new ArrayType(levelData.count);
  for (let childIndex = 0; childIndex < childWeights.length; childIndex++) {
    const start = contributions.offsets[childIndex];
    const end = contributions.offsets[childIndex + 1];
    for (let contributionIndex = start; contributionIndex < end; contributionIndex++) {
      weights[contributions.parentIndices[contributionIndex]] += contributions.weights[contributionIndex] * childWeights[childIndex];
    }
  }
  return weights;
}

export function buildAggregationSetup(topology, ArrayType = Float32Array, reuse = true) {
  const started = now();
  const contributionsStarted = now();
  const contributions = new Map();
  const contributionKeys = new Map();
  let contributionHits = 0;
  for (let level = Math.max(MIN_GRID_LEVEL + 1, topology.levelRange.minLevel + 1); level <= Math.min(WEATHER_REFERENCE_LEVEL, topology.levelRange.maxLevel); level++) {
    if (!topology.levels.has(level - 1)) continue;
    const result = getCenteredContributionPlan(topology.levels.get(level), topology.levels.get(level - 1), reuse);
    contributions.set(level, result.plan);
    contributionKeys.set(level, result.key);
    if (result.reused) contributionHits++;
  }
  const contributionsMs = now() - contributionsStarted;
  const totalWeightsStarted = now();
  const totalWeights = new Map();
  const totalWeightKeys = new Map();
  let totalWeightHits = 0;
  if (topology.levels.has(WEATHER_REFERENCE_LEVEL)) {
    const referenceLevelData = topology.levels.get(WEATHER_REFERENCE_LEVEL);
    const referenceKey = totalWeightStructuralKey(WEATHER_REFERENCE_LEVEL, referenceLevelData, []);
    let referenceWeights = reuse ? totalWeightPlanCache.get(referenceKey) : null;
    if (referenceWeights?.length === referenceLevelData.count && referenceWeights.constructor === ArrayType) {
      aggregationPlanCacheCounters.totalWeightHits++;
      totalWeightHits++;
    } else {
      aggregationPlanCacheCounters.totalWeightMisses++;
      referenceWeights = new ArrayType(referenceLevelData.count);
      referenceWeights.fill(1);
      if (reuse) boundedCacheSet(totalWeightPlanCache, referenceKey, referenceWeights);
    }
    totalWeights.set(WEATHER_REFERENCE_LEVEL, referenceWeights);
    totalWeightKeys.set(WEATHER_REFERENCE_LEVEL, referenceKey);
    for (let level = WEATHER_REFERENCE_LEVEL - 1; level >= topology.levelRange.minLevel; level--) {
      const childWeights = totalWeights.get(level + 1);
      const levelContributions = contributions.get(level + 1);
      if (!childWeights || !levelContributions || !topology.levels.has(level)) continue;
      const key = totalWeightStructuralKey(level, topology.levels.get(level), [
        contributionKeys.get(level + 1),
        totalWeightKeys.get(level + 1)
      ]);
      let weights = reuse ? totalWeightPlanCache.get(key) : null;
      if (weights?.length === topology.levels.get(level).count && weights.constructor === ArrayType) {
        aggregationPlanCacheCounters.totalWeightHits++;
        totalWeightHits++;
      } else {
        aggregationPlanCacheCounters.totalWeightMisses++;
        weights = buildTotalWeight(topology.levels.get(level), childWeights, levelContributions, ArrayType);
        if (reuse) boundedCacheSet(totalWeightPlanCache, key, weights);
      }
      totalWeights.set(level, weights);
      totalWeightKeys.set(level, key);
    }
  }
  return {
    contributions,
    totalWeights,
    timings: {
      contributionsMs,
      totalWeightsMs: now() - totalWeightsStarted,
      totalMs: now() - started,
      contributionHits,
      totalWeightHits
    }
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
  const count = activeIndices ? activeIndices.length : levelData.count;
  for (let activeIndex = 0; activeIndex < count; activeIndex++) {
    const index = activeIndices ? activeIndices[activeIndex] : activeIndex;
    if (batchRain) {
      value.rainMmh = batchRain[activeIndex];
      value.storm = 0;
      value.hail = 0;
    } else if (samplingGeometry) geographicPreparedIntensityAtGeometry(frame, samplingGeometry, index, value);
    else {
      const anchorIndex = index * 2;
      const longitude = mercatorXToLongitude(levelData.canonicalAnchors[anchorIndex]);
      const latitude = mercatorYToLatitude(levelData.canonicalAnchors[anchorIndex + 1]);
      geographicPreparedIntensityAtXY(frame, longitude, latitude, value);
    }
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
  const childCount = childSummary.levelData.count;
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

// Rain-only sequence fast path. It preserves the Float32 L13 storage boundary
// and contribution order of evaluateDirectWeatherSummary(...L13) followed by
// aggregateWeatherSummary(...L12), without retaining the intermediate L13
// summary object.
export function evaluateFusedRainAggregateSummary(parentLevel, frame, samplingGeometry, contributions, reusable = null, ArrayType = Float32Array, totalWeight = null) {
  if (frame?.supportsRainOnlyPreparedBatch !== true || typeof frame.samplePreparedBatch !== 'function') {
    throw new Error('Fused rain aggregation requires an explicit rain-only prepared batch capability.');
  }
  const activeChildren = samplingGeometry?.potentialActiveIndices;
  if (!activeChildren) throw new Error('Fused rain aggregation requires prepared potential-active indices.');
  const summary = createWeatherSummary(parentLevel, reusable, ArrayType, totalWeight);
  const childSummary = { potentialActiveIndices: activeChildren };
  const activeIndices = activeIndicesForAggregate(summary, childSummary, contributions);
  zeroWeatherFields(summary, activeIndices);
  const rainValues = geographicPreparedIntensityAtGeometryBatch(frame, samplingGeometry);
  const storedRain = ArrayType === Float32Array ? Math.fround : (value) => value;
  for (let activeChild = 0; activeChild < activeChildren.length; activeChild++) {
    const childIndex = activeChildren[activeChild];
    const rainMmh = rainValues[activeChild];
    const rainForSummary = storedRain(rainMmh);
    const start = contributions.offsets[childIndex];
    const end = contributions.offsets[childIndex + 1];
    for (let contributionIndex = start; contributionIndex < end; contributionIndex++) {
      const parentIndex = contributions.parentIndices[contributionIndex];
      const weight = contributions.weights[contributionIndex];
      summary.rainWeightedSumMmh[parentIndex] += weight * rainForSummary;
      for (let thresholdIndex = 0; thresholdIndex < RAIN_COVERAGE_THRESHOLDS_MMH.length; thresholdIndex++) {
        summary.rainCoverageWeight[thresholdIndex][parentIndex] += weight
          * (rainMmh >= RAIN_COVERAGE_THRESHOLDS_MMH[thresholdIndex] ? 1 : 0);
      }
      if (weight > 0) summary.rainMaxMmh[parentIndex] = Math.max(summary.rainMaxMmh[parentIndex], rainForSummary);
    }
  }
  return summary;
}

export class GeographicWeatherPyramid {
  constructor(summaryArrayType = Float32Array, topology = new GeographicLodTopology(), options = {}) {
    this.summaryArrayType = summaryArrayType;
    this.setTopology(topology, options);
  }

  setTopology(topology, options = {}) {
    this.topology = topology;
    this.levels = topology.levels;
    const setup = buildAggregationSetup(topology, this.summaryArrayType, options.reuse !== false);
    this.contributions = setup.contributions;
    this.totalWeights = setup.totalWeights;
    this.topologySetupTimings = setup.timings;
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

  topologyFor(level) {
    const levelData = this.levelDataFor(level);
    return {
      levelData,
      contributionsToParent: this.contributions.get(level) || null
    };
  }

  summaryMemoryBytesPerSample() {
    return (3 + RAIN_COVERAGE_THRESHOLDS_MMH.length + 6) * this.summaryArrayType.BYTES_PER_ELEMENT;
  }

  prepareSamplingGeometry(level, frame) {
    const existing = this.samplingGeometries.get(level);
    if (existing && frame.isSamplingGeometryCompatible(existing)) return existing;
    const geometry = prepareGeographicSamplingGeometry(frame, this.levelDataFor(level), existing);
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
      const samplingGeometry = this.prepareSamplingGeometry(WEATHER_REFERENCE_LEVEL, frame);
      const useFusedRainPath = uniqueRequested.every((level) => level < WEATHER_REFERENCE_LEVEL)
        && frame?.supportsRainOnlyPreparedBatch === true
        && typeof frame.samplePreparedBatch === 'function'
        && samplingGeometry?.potentialActiveIndices
        && this.contributions.has(WEATHER_REFERENCE_LEVEL);
      let summary;
      if (useFusedRainPath) {
        summary = evaluateFusedRainAggregateSummary(
          this.levels.get(WEATHER_REFERENCE_LEVEL - 1),
          frame,
          samplingGeometry,
          this.contributions.get(WEATHER_REFERENCE_LEVEL),
          reusableStates?.[WEATHER_REFERENCE_LEVEL - 1],
          this.summaryArrayType,
          this.totalWeights.get(WEATHER_REFERENCE_LEVEL - 1)
        );
        summaries[WEATHER_REFERENCE_LEVEL - 1] = summary;
      } else {
        summary = evaluateDirectWeatherSummary(
          this.levels.get(WEATHER_REFERENCE_LEVEL),
          frame,
          reusableStates?.[WEATHER_REFERENCE_LEVEL],
          this.summaryArrayType,
          samplingGeometry,
          this.totalWeights.get(WEATHER_REFERENCE_LEVEL)
        );
        summaries[WEATHER_REFERENCE_LEVEL] = summary;
      }
      for (let level = (useFusedRainPath ? WEATHER_REFERENCE_LEVEL - 2 : WEATHER_REFERENCE_LEVEL - 1); level >= minimumAggregateLevel; level--) {
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
