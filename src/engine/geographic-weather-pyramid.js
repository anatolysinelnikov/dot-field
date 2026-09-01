import {
  geographicPreparedIntensityAtGeometry,
  geographicPreparedIntensityAtGeometryBatch,
  geographicPrepareTemporalSampling,
  geographicPreparedIntensityAtXY,
  prepareGeographicSamplingGeometry
} from './geography.js';
import {
  MIN_GRID_LEVEL,
  MAX_GRID_LEVEL,
  GeographicLodTopology,
  canonicalIndexForCoordinates,
  canonicalXForIndex,
  canonicalYForIndex,
  mercatorXForIndex,
  mercatorYForIndex,
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
export const WEATHER_SUMMARY_PROFILE_GENERIC = 'generic';
export const WEATHER_SUMMARY_PROFILE_RAIN_ONLY_DISPLAY = 'rain-only-display';
export const WEATHER_DIRECT_STATE_PACKED = 'packed-direct';
const COMPACT_RAIN_COVERAGE_THRESHOLDS_MMH = Object.freeze([0.05, 2.5]);
const now = () => globalThis.performance?.now?.() ?? Date.now();
const AGGREGATION_RELATION_CACHE_LIMIT = 12;
const centeredContributionRelationCache = new Map();
const totalWeightPlanCache = new Map();
const aggregationRelationCacheCounters = { relationHits: 0, relationMisses: 0, totalWeightHits: 0, totalWeightMisses: 0 };

function boundedCacheSet(cache, key, value) {
  if (cache.has(key)) cache.delete(key);
  cache.set(key, value);
  while (cache.size > AGGREGATION_RELATION_CACHE_LIMIT) cache.delete(cache.keys().next().value);
}

export function resetAggregationRelationCache() {
  centeredContributionRelationCache.clear();
  totalWeightPlanCache.clear();
  aggregationRelationCacheCounters.relationHits = 0;
  aggregationRelationCacheCounters.relationMisses = 0;
  aggregationRelationCacheCounters.totalWeightHits = 0;
  aggregationRelationCacheCounters.totalWeightMisses = 0;
}

export function aggregationRelationCacheStats() {
  return {
    ...aggregationRelationCacheCounters,
    relationEntries: centeredContributionRelationCache.size,
    totalWeightEntries: totalWeightPlanCache.size
  };
}

function summaryMatchesLevel(summary, levelData, ArrayType, profile) {
  return summary?.totalWeight?.length === levelData.count
    && summary.profile === profile
    && summary.rainCoverageWeight?.length === (profile === WEATHER_SUMMARY_PROFILE_RAIN_ONLY_DISPLAY
      ? COMPACT_RAIN_COVERAGE_THRESHOLDS_MMH.length : RAIN_COVERAGE_THRESHOLDS_MMH.length)
    && summary.totalWeight.constructor === ArrayType
    && summary.rainCoverageWeight[0]?.constructor === ArrayType;
}

function zeroWeatherFields(summary, activeIndices = null) {
  if (!activeIndices) {
    summary.rainWeightedSumMmh.fill(0);
    summary.rainMaxMmh.fill(0);
    for (const coverage of summary.rainCoverageWeight) coverage.fill(0);
    if (summary.profile === WEATHER_SUMMARY_PROFILE_RAIN_ONLY_DISPLAY) return;
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
    if (summary.profile === WEATHER_SUMMARY_PROFILE_RAIN_ONLY_DISPLAY) continue;
    summary.stormCoverageWeight[index] = 0;
    summary.stormWeightedSeverity[index] = 0;
    summary.stormMaxSeverity[index] = 0;
    summary.hailCoverageWeight[index] = 0;
    summary.hailWeightedSeverity[index] = 0;
    summary.hailMaxSeverity[index] = 0;
  }
}

export function createWeatherSummary(levelData, reusable = null, ArrayType = Float32Array, totalWeight = null, profile = WEATHER_SUMMARY_PROFILE_GENERIC) {
  if (summaryMatchesLevel(reusable, levelData, ArrayType, profile)) {
    reusable.level = levelData.level;
    reusable.levelData = levelData;
    if (totalWeight) {
      reusable.totalWeight = totalWeight;
      reusable.totalWeightInitialized = true;
    }
    return reusable;
  }

  const length = levelData.count;
  const summary = {
    representation: 'dense-summary',
    profile,
    level: levelData.level,
    levelData,
    totalWeight: totalWeight || new ArrayType(length),
    totalWeightInitialized: Boolean(totalWeight),
    potentialActiveIndices: undefined,
    potentialActiveIndicesInitialized: false,
    rainWeightedSumMmh: new ArrayType(length),
    rainMaxMmh: new ArrayType(length),
    rainCoverageWeight: (profile === WEATHER_SUMMARY_PROFILE_RAIN_ONLY_DISPLAY
      ? COMPACT_RAIN_COVERAGE_THRESHOLDS_MMH : RAIN_COVERAGE_THRESHOLDS_MMH).map(() => new ArrayType(length))
  };
  if (profile === WEATHER_SUMMARY_PROFILE_RAIN_ONLY_DISPLAY) return summary;
  summary.stormCoverageWeight = new ArrayType(length);
  summary.stormWeightedSeverity = new ArrayType(length);
  summary.stormMaxSeverity = new ArrayType(length);
  summary.hailCoverageWeight = new ArrayType(length);
  summary.hailWeightedSeverity = new ArrayType(length);
  summary.hailMaxSeverity = new ArrayType(length);
  return summary;
}

function packedDirectStateMatches(state, levelData, activeIndices, ArrayType, profile) {
  return state?.representation === WEATHER_DIRECT_STATE_PACKED
    && state.levelData === levelData
    && state.profile === profile
    && state.potentialActiveIndices === activeIndices
    && state.channels?.rainMmh?.length === activeIndices.length
    && state.channels.rainMmh.constructor === ArrayType
    && state.coverageMasks?.rain?.length === activeIndices.length;
}

function createPackedDirectWeatherState(levelData, activeIndices, ArrayType, profile, reusable = null) {
  if (packedDirectStateMatches(reusable, levelData, activeIndices, ArrayType, profile)) return reusable;
  const state = {
    representation: WEATHER_DIRECT_STATE_PACKED,
    profile,
    level: levelData.level,
    levelData,
    potentialActiveIndices: activeIndices,
    channels: { rainMmh: new ArrayType(activeIndices.length) },
    coverageMasks: { rain: new Uint8Array(activeIndices.length) }
  };
  if (profile !== WEATHER_SUMMARY_PROFILE_RAIN_ONLY_DISPLAY) {
    state.channels.storm = new ArrayType(activeIndices.length);
    state.channels.hail = new ArrayType(activeIndices.length);
    state.coverageMasks.storm = new Uint8Array(activeIndices.length);
    state.coverageMasks.hail = new Uint8Array(activeIndices.length);
  }
  return state;
}

export function rainCoverageWeightForThreshold(summary, threshold) {
  const thresholds = summary.profile === WEATHER_SUMMARY_PROFILE_RAIN_ONLY_DISPLAY
    ? COMPACT_RAIN_COVERAGE_THRESHOLDS_MMH : RAIN_COVERAGE_THRESHOLDS_MMH;
  const index = thresholds.indexOf(threshold);
  if (index < 0) throw new Error(`Weather summary profile ${summary.profile} does not support rain coverage threshold ${threshold}.`);
  return summary.rainCoverageWeight[index];
}

function summaryProfileForFrame(frame) {
  return frame?.weatherSummaryProfile === WEATHER_SUMMARY_PROFILE_RAIN_ONLY_DISPLAY
    ? WEATHER_SUMMARY_PROFILE_RAIN_ONLY_DISPLAY : WEATHER_SUMMARY_PROFILE_GENERIC;
}

function initializeDirectTotalWeight(summary) {
  if (summary.totalWeightInitialized) return;
  summary.totalWeight.fill(1);
  summary.totalWeightInitialized = true;
}

function initializeAggregateTotalWeight(summary, childSummary, contributions) {
  if (summary.totalWeightInitialized) return;
  summary.totalWeight.fill(0);
  if (contributions.kind !== 'separable-centered') {
    for (let childIndex = 0; childIndex < childSummary.levelData.count; childIndex++) {
      const start = contributions.offsets[childIndex];
      const end = contributions.offsets[childIndex + 1];
      for (let contributionIndex = start; contributionIndex < end; contributionIndex++) {
        const parentIndex = contributions.parentIndices[contributionIndex];
        summary.totalWeight[parentIndex] += contributions.weights[contributionIndex] * childSummary.totalWeight[childIndex];
      }
    }
    summary.totalWeightInitialized = true;
    return;
  }
  const relation = contributions;
  const fineWidth = relation.fineWidth;
  for (let row = 0; row < relation.fineHeight; row++) {
    const yCount = relation.y.candidateCounts[row];
    const yRawWeight = relation.y.rawCandidateCounts[row] === 1 ? 1 : 0.5;
    const yBase = row * 2;
    for (let column = 0; column < fineWidth; column++) {
      const childIndex = row * fineWidth + column;
      const xCount = relation.x.candidateCounts[column];
      const xRawWeight = relation.x.rawCandidateCounts[column] === 1 ? 1 : 0.5;
      const axisWeight = xRawWeight * yRawWeight;
      const totalCandidateWeight = axisWeight * xCount * yCount;
      const xBase = column * 2;
      for (let xOffset = 0; xOffset < xCount; xOffset++) {
        const parentX = relation.x.candidateIndices[xBase + xOffset];
        for (let yOffset = 0; yOffset < yCount; yOffset++) {
          const parentIndex = relation.y.candidateIndices[yBase + yOffset] * relation.coarseWidth + parentX;
          summary.totalWeight[parentIndex] += (axisWeight / totalCandidateWeight) * childSummary.totalWeight[childIndex];
        }
      }
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
  if (contributions.kind === 'separable-centered') {
    const relation = contributions;
    for (const childIndex of childActiveIndices) {
      const column = childIndex % relation.fineWidth;
      const row = Math.floor(childIndex / relation.fineWidth);
      const xCount = relation.x.candidateCounts[column];
      const yCount = relation.y.candidateCounts[row];
      const xBase = column * 2;
      const yBase = row * 2;
      for (let xOffset = 0; xOffset < xCount; xOffset++) {
        const parentX = relation.x.candidateIndices[xBase + xOffset];
        for (let yOffset = 0; yOffset < yCount; yOffset++) {
          active[relation.y.candidateIndices[yBase + yOffset] * relation.coarseWidth + parentX] = 1;
        }
      }
    }
  } else {
    for (const childIndex of childActiveIndices) {
      const start = contributions.offsets[childIndex];
      const end = contributions.offsets[childIndex + 1];
      for (let contributionIndex = start; contributionIndex < end; contributionIndex++) {
        active[contributions.parentIndices[contributionIndex]] = 1;
      }
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

function buildCenteredAxisRelation(fineLevel, coarseLevel, axis) {
  const count = axis === 'x' ? fineLevel.width : fineLevel.height;
  const fineStart = (axis === 'x' ? fineLevel.minI : fineLevel.minJ) * fineLevel.identityScale;
  const coarseStart = (axis === 'x' ? coarseLevel.minI : coarseLevel.minJ) * coarseLevel.identityScale;
  const coarseEnd = (axis === 'x' ? coarseLevel.maxI : coarseLevel.maxJ) * coarseLevel.identityScale;
  const fineStep = fineLevel.identityScale;
  const parentStep = coarseLevel.identityScale;
  const candidateCounts = new Uint8Array(count);
  const rawCandidateCounts = new Uint8Array(count);
  const candidateIndices = new Uint32Array(count * 2);

  for (let index = 0; index < count; index++) {
    const coordinate = fineStart + index * fineStep;
    const remainder = coordinate % parentStep;
    if (remainder !== 0 && remainder !== parentStep / 2) throw new Error('Fine sample is not centered between adjacent dyadic anchors.');
    const rawCount = remainder === 0 ? 1 : 2;
    const start = remainder === 0 ? coordinate : coordinate - parentStep / 2;
    rawCandidateCounts[index] = rawCount;
    let validCount = 0;
    for (let offset = 0; offset < rawCount; offset++) {
      const candidate = start + offset * parentStep;
      if (candidate < coarseStart || candidate > coarseEnd) continue;
      candidateIndices[index * 2 + validCount++] = (candidate - coarseStart) / parentStep;
    }
    if (!validCount) throw new Error('Fine sample has no centered coarse contribution.');
    candidateCounts[index] = validCount;
  }

  return { candidateCounts, rawCandidateCounts, candidateIndices };
}

// Production centered aggregation relation. The two axis tables retain only
// the valid local coarse indices for each fine column/row; 2D candidates are
// enumerated in x-outer/y-inner order at evaluation time.
export function buildCenteredContributionRelation(fineLevel, coarseLevel) {
  return {
    kind: 'separable-centered',
    fineWidth: fineLevel.width,
    fineHeight: fineLevel.height,
    coarseWidth: coarseLevel.width,
    x: buildCenteredAxisRelation(fineLevel, coarseLevel, 'x'),
    y: buildCenteredAxisRelation(fineLevel, coarseLevel, 'y')
  };
}

// Verification-only enumerator. Hot production loops access the same compact
// arrays inline to avoid callback and per-contribution allocation overhead.
export function forEachCenteredContributionRelationEntry(relation, childIndex, callback) {
  const column = childIndex % relation.fineWidth;
  const row = Math.floor(childIndex / relation.fineWidth);
  const xCount = relation.x.candidateCounts[column];
  const yCount = relation.y.candidateCounts[row];
  const xRawWeight = relation.x.rawCandidateCounts[column] === 1 ? 1 : 0.5;
  const yRawWeight = relation.y.rawCandidateCounts[row] === 1 ? 1 : 0.5;
  const axisWeight = xRawWeight * yRawWeight;
  const totalCandidateWeight = axisWeight * xCount * yCount;
  const xBase = column * 2;
  const yBase = row * 2;
  for (let xOffset = 0; xOffset < xCount; xOffset++) {
    const parentX = relation.x.candidateIndices[xBase + xOffset];
    for (let yOffset = 0; yOffset < yCount; yOffset++) {
      const parentY = relation.y.candidateIndices[yBase + yOffset];
      callback(parentY * relation.coarseWidth + parentX, axisWeight / totalCandidateWeight);
    }
  }
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

function getCenteredContributionRelation(fineLevel, coarseLevel, reuse) {
  const key = centeredContributionStructuralKey(fineLevel, coarseLevel);
  if (reuse) {
    const cached = centeredContributionRelationCache.get(key);
    if (cached) {
      aggregationRelationCacheCounters.relationHits++;
      return { key, relation: cached, reused: true };
    }
  }
  aggregationRelationCacheCounters.relationMisses++;
  const relation = buildCenteredContributionRelation(fineLevel, coarseLevel);
  if (reuse) boundedCacheSet(centeredContributionRelationCache, key, relation);
  return { key, relation, reused: false };
}

function totalWeightStructuralKey(level, levelData, contributionKeys) {
  return [level, levelData.width, levelData.height, ...contributionKeys].join(':');
}

function buildTotalWeight(levelData, childWeights, contributions, ArrayType) {
  const weights = new ArrayType(levelData.count);
  if (contributions.kind === 'separable-centered') {
    const relation = contributions;
    const fineWidth = relation.fineWidth;
    for (let row = 0; row < relation.fineHeight; row++) {
      const yCount = relation.y.candidateCounts[row];
      const yRawWeight = relation.y.rawCandidateCounts[row] === 1 ? 1 : 0.5;
      const yBase = row * 2;
      for (let column = 0; column < fineWidth; column++) {
        const childIndex = row * fineWidth + column;
        const xCount = relation.x.candidateCounts[column];
        const xRawWeight = relation.x.rawCandidateCounts[column] === 1 ? 1 : 0.5;
        const axisWeight = xRawWeight * yRawWeight;
        const totalCandidateWeight = axisWeight * xCount * yCount;
        const xBase = column * 2;
        for (let xOffset = 0; xOffset < xCount; xOffset++) {
          const parentX = relation.x.candidateIndices[xBase + xOffset];
          for (let yOffset = 0; yOffset < yCount; yOffset++) {
            const parentIndex = relation.y.candidateIndices[yBase + yOffset] * relation.coarseWidth + parentX;
            weights[parentIndex] += (axisWeight / totalCandidateWeight) * childWeights[childIndex];
          }
        }
      }
    }
    return weights;
  }
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
  const relationStarted = now();
  const relations = new Map();
  const contributionKeys = new Map();
  let relationHits = 0;
  for (let level = Math.max(MIN_GRID_LEVEL + 1, topology.levelRange.minLevel + 1); level <= Math.min(WEATHER_REFERENCE_LEVEL, topology.levelRange.maxLevel); level++) {
    if (!topology.levels.has(level - 1)) continue;
    const result = getCenteredContributionRelation(topology.levels.get(level), topology.levels.get(level - 1), reuse);
    relations.set(level, result.relation);
    contributionKeys.set(level, result.key);
    if (result.reused) relationHits++;
  }
  const relationMs = now() - relationStarted;
  const totalWeightsStarted = now();
  const totalWeights = new Map();
  const totalWeightKeys = new Map();
  let totalWeightHits = 0;
  if (topology.levels.has(WEATHER_REFERENCE_LEVEL)) {
    const referenceLevelData = topology.levels.get(WEATHER_REFERENCE_LEVEL);
    const referenceKey = totalWeightStructuralKey(WEATHER_REFERENCE_LEVEL, referenceLevelData, []);
    let referenceWeights = reuse ? totalWeightPlanCache.get(referenceKey) : null;
    if (referenceWeights?.length === referenceLevelData.count && referenceWeights.constructor === ArrayType) {
      aggregationRelationCacheCounters.totalWeightHits++;
      totalWeightHits++;
    } else {
      aggregationRelationCacheCounters.totalWeightMisses++;
      referenceWeights = new ArrayType(referenceLevelData.count);
      referenceWeights.fill(1);
      if (reuse) boundedCacheSet(totalWeightPlanCache, referenceKey, referenceWeights);
    }
    totalWeights.set(WEATHER_REFERENCE_LEVEL, referenceWeights);
    totalWeightKeys.set(WEATHER_REFERENCE_LEVEL, referenceKey);
    for (let level = WEATHER_REFERENCE_LEVEL - 1; level >= topology.levelRange.minLevel; level--) {
      const childWeights = totalWeights.get(level + 1);
      const levelRelation = relations.get(level + 1);
      if (!childWeights || !levelRelation || !topology.levels.has(level)) continue;
      const key = totalWeightStructuralKey(level, topology.levels.get(level), [
        contributionKeys.get(level + 1),
        totalWeightKeys.get(level + 1)
      ]);
      let weights = reuse ? totalWeightPlanCache.get(key) : null;
      if (weights?.length === topology.levels.get(level).count && weights.constructor === ArrayType) {
        aggregationRelationCacheCounters.totalWeightHits++;
        totalWeightHits++;
      } else {
        aggregationRelationCacheCounters.totalWeightMisses++;
        weights = buildTotalWeight(topology.levels.get(level), childWeights, levelRelation, ArrayType);
        if (reuse) boundedCacheSet(totalWeightPlanCache, key, weights);
      }
      totalWeights.set(level, weights);
      totalWeightKeys.set(level, key);
    }
  }
  return {
    relations,
    totalWeights,
    timings: {
      relationMs,
      totalWeightsMs: now() - totalWeightsStarted,
      totalMs: now() - started,
      relationHits,
      totalWeightHits
    }
  };
}

export function evaluateDirectWeatherSummary(levelData, frame, reusable = null, ArrayType = Float32Array, samplingGeometry = null, totalWeight = null) {
  const profile = summaryProfileForFrame(frame);
  const activeIndices = samplingGeometry?.potentialActiveIndices ?? null;
  if (levelData.level > WEATHER_REFERENCE_LEVEL && activeIndices) {
    const state = createPackedDirectWeatherState(levelData, activeIndices, ArrayType, profile, reusable);
    const temporalRain = frame?.supportsRainOnlyPreparedTemporalSampling === true
      ? geographicPrepareTemporalSampling(frame, samplingGeometry)
      : null;
    const batchRain = !temporalRain && samplingGeometry && typeof frame.samplePreparedBatch === 'function'
      ? geographicPreparedIntensityAtGeometryBatch(frame, samplingGeometry)
      : null;
    const value = { rainMmh: 0, storm: 0, hail: 0 };
    const storedValue = ArrayType === Float32Array ? Math.fround : (number) => number;
    for (let activeIndex = 0; activeIndex < activeIndices.length; activeIndex++) {
      const index = activeIndices[activeIndex];
      if (temporalRain) {
        value.rainMmh = temporalRain(activeIndex);
        value.storm = 0;
        value.hail = 0;
      } else if (batchRain) {
        value.rainMmh = batchRain[activeIndex];
        value.storm = 0;
        value.hail = 0;
      } else if (samplingGeometry) geographicPreparedIntensityAtGeometry(frame, samplingGeometry, index, value);
      else {
        const longitude = mercatorXToLongitude(mercatorXForIndex(levelData, index));
        const latitude = mercatorYToLatitude(mercatorYForIndex(levelData, index));
        geographicPreparedIntensityAtXY(frame, longitude, latitude, value);
      }
      const rainMmh = value.rainMmh;
      state.channels.rainMmh[activeIndex] = storedValue(rainMmh);
      let rainMask = 0;
      for (let thresholdIndex = 0; thresholdIndex < RAIN_COVERAGE_THRESHOLDS_MMH.length; thresholdIndex++) {
        if (rainMmh >= RAIN_COVERAGE_THRESHOLDS_MMH[thresholdIndex]) rainMask |= 1 << thresholdIndex;
      }
      state.coverageMasks.rain[activeIndex] = rainMask;
      if (profile === WEATHER_SUMMARY_PROFILE_RAIN_ONLY_DISPLAY) continue;
      state.channels.storm[activeIndex] = storedValue(value.storm);
      state.channels.hail[activeIndex] = storedValue(value.hail);
      state.coverageMasks.storm[activeIndex] = value.storm > 0 ? 1 : 0;
      state.coverageMasks.hail[activeIndex] = value.hail > 0 ? 1 : 0;
    }
    return state;
  }

  const summary = createWeatherSummary(levelData, reusable, ArrayType, totalWeight, profile);
  initializeDirectTotalWeight(summary);
  const previousActiveIndices = summary.potentialActiveIndices;
  if (activeIndices && previousActiveIndices !== activeIndices) {
    zeroWeatherFields(summary, previousActiveIndices || null);
  }
  summary.potentialActiveIndices = activeIndices;
  summary.potentialActiveIndicesInitialized = true;
  const temporalRain = samplingGeometry && activeIndices
    && frame?.supportsRainOnlyPreparedTemporalSampling === true
    ? geographicPrepareTemporalSampling(frame, samplingGeometry)
    : null;
  const batchRain = !temporalRain && samplingGeometry && activeIndices && typeof frame.samplePreparedBatch === 'function'
    ? geographicPreparedIntensityAtGeometryBatch(frame, samplingGeometry)
    : null;
  const value = { rainMmh: 0, storm: 0, hail: 0 };
  const count = activeIndices ? activeIndices.length : levelData.count;
  for (let activeIndex = 0; activeIndex < count; activeIndex++) {
    const index = activeIndices ? activeIndices[activeIndex] : activeIndex;
    if (temporalRain) {
      value.rainMmh = temporalRain(activeIndex);
      value.storm = 0;
      value.hail = 0;
    } else if (batchRain) {
      value.rainMmh = batchRain[activeIndex];
      value.storm = 0;
      value.hail = 0;
    } else if (samplingGeometry) geographicPreparedIntensityAtGeometry(frame, samplingGeometry, index, value);
    else {
      const longitude = mercatorXToLongitude(mercatorXForIndex(levelData, index));
      const latitude = mercatorYToLatitude(mercatorYForIndex(levelData, index));
      geographicPreparedIntensityAtXY(frame, longitude, latitude, value);
    }
    const rainMmh = value.rainMmh;
    summary.rainWeightedSumMmh[index] = rainMmh;
    summary.rainMaxMmh[index] = rainMmh;
    if (profile === WEATHER_SUMMARY_PROFILE_RAIN_ONLY_DISPLAY) {
      summary.rainCoverageWeight[0][index] = rainMmh >= 0.05 ? 1 : 0;
      summary.rainCoverageWeight[1][index] = rainMmh >= 2.5 ? 1 : 0;
      continue;
    }
    const storm = value.storm;
    const hail = value.hail;
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

function aggregateRainOnlyWeatherSummary(parentLevel, childSummary, contributions, reusable, ArrayType, totalWeight) {
  const summary = createWeatherSummary(parentLevel, reusable, ArrayType, totalWeight, WEATHER_SUMMARY_PROFILE_RAIN_ONLY_DISPLAY);
  initializeAggregateTotalWeight(summary, childSummary, contributions);
  const activeIndices = activeIndicesForAggregate(summary, childSummary, contributions);
  zeroWeatherFields(summary, activeIndices);
  const activeChildren = childSummary.potentialActiveIndices;
  const childCount = childSummary.levelData.count;
  const accumulate = (parentIndex, childIndex, weight) => {
    summary.rainWeightedSumMmh[parentIndex] += weight * childSummary.rainWeightedSumMmh[childIndex];
    summary.rainCoverageWeight[0][parentIndex] += weight * childSummary.rainCoverageWeight[0][childIndex];
    summary.rainCoverageWeight[1][parentIndex] += weight * childSummary.rainCoverageWeight[1][childIndex];
    if (weight * childSummary.totalWeight[childIndex] > 0) {
      summary.rainMaxMmh[parentIndex] = Math.max(summary.rainMaxMmh[parentIndex], childSummary.rainMaxMmh[childIndex]);
    }
  };
  for (let activeChild = 0; activeChild < (activeChildren ? activeChildren.length : childCount); activeChild++) {
    const childIndex = activeChildren ? activeChildren[activeChild] : activeChild;
    if (contributions.kind !== 'separable-centered') {
      for (let contributionIndex = contributions.offsets[childIndex]; contributionIndex < contributions.offsets[childIndex + 1]; contributionIndex++) {
        accumulate(contributions.parentIndices[contributionIndex], childIndex, contributions.weights[contributionIndex]);
      }
      continue;
    }
    const column = childIndex % contributions.fineWidth;
    const row = Math.floor(childIndex / contributions.fineWidth);
    const xCount = contributions.x.candidateCounts[column];
    const yCount = contributions.y.candidateCounts[row];
    const axisWeight = (contributions.x.rawCandidateCounts[column] === 1 ? 1 : 0.5)
      * (contributions.y.rawCandidateCounts[row] === 1 ? 1 : 0.5);
    const weight = axisWeight / (axisWeight * xCount * yCount);
    const xBase = column * 2;
    const yBase = row * 2;
    for (let xOffset = 0; xOffset < xCount; xOffset++) {
      const parentX = contributions.x.candidateIndices[xBase + xOffset];
      for (let yOffset = 0; yOffset < yCount; yOffset++) {
        accumulate(contributions.y.candidateIndices[yBase + yOffset] * contributions.coarseWidth + parentX, childIndex, weight);
      }
    }
  }
  return summary;
}

export function aggregateWeatherSummary(parentLevel, childSummary, contributions, reusable = null, ArrayType = Float32Array, totalWeight = null) {
  if (childSummary.profile === WEATHER_SUMMARY_PROFILE_RAIN_ONLY_DISPLAY) {
    return aggregateRainOnlyWeatherSummary(parentLevel, childSummary, contributions, reusable, ArrayType, totalWeight);
  }
  const summary = createWeatherSummary(parentLevel, reusable, ArrayType, totalWeight, childSummary.profile || WEATHER_SUMMARY_PROFILE_GENERIC);
  initializeAggregateTotalWeight(summary, childSummary, contributions);
  const activeIndices = activeIndicesForAggregate(summary, childSummary, contributions);
  zeroWeatherFields(summary, activeIndices);
  const childCount = childSummary.levelData.count;
  const activeChildren = childSummary.potentialActiveIndices;
  if (contributions.kind !== 'separable-centered') {
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

  const relation = contributions;
  for (let activeChild = 0; activeChild < (activeChildren ? activeChildren.length : childCount); activeChild++) {
    const childIndex = activeChildren ? activeChildren[activeChild] : activeChild;
    const column = childIndex % relation.fineWidth;
    const row = Math.floor(childIndex / relation.fineWidth);
    const xCount = relation.x.candidateCounts[column];
    const yCount = relation.y.candidateCounts[row];
    const xRawWeight = relation.x.rawCandidateCounts[column] === 1 ? 1 : 0.5;
    const yRawWeight = relation.y.rawCandidateCounts[row] === 1 ? 1 : 0.5;
    const axisWeight = xRawWeight * yRawWeight;
    const totalCandidateWeight = axisWeight * xCount * yCount;
    const xBase = column * 2;
    const yBase = row * 2;
    for (let xOffset = 0; xOffset < xCount; xOffset++) {
      const parentX = relation.x.candidateIndices[xBase + xOffset];
      for (let yOffset = 0; yOffset < yCount; yOffset++) {
        const parentIndex = relation.y.candidateIndices[yBase + yOffset] * relation.coarseWidth + parentX;
        const weight = axisWeight / totalCandidateWeight;
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
  }
  return summary;
}

// Rain-only sequence fast path. It preserves the Float32 L13 storage boundary
// and contribution order of evaluateDirectWeatherSummary(...L13) followed by
// aggregateWeatherSummary(...L12), without retaining the intermediate L13
// summary object.
export function evaluateFusedRainAggregateSummary(parentLevel, frame, samplingGeometry, contributions, reusable = null, ArrayType = Float32Array, totalWeight = null) {
  const activeChildren = samplingGeometry?.potentialActiveIndices;
  if (!activeChildren) throw new Error('Fused rain aggregation requires prepared potential-active indices.');
  if (frame?.weatherSummaryProfile !== WEATHER_SUMMARY_PROFILE_RAIN_ONLY_DISPLAY) {
    throw new Error('Fused rain aggregation requires an explicit rain-only prepared temporal capability.');
  }
  const temporalRain = geographicPrepareTemporalSampling(frame, samplingGeometry);
  if (!temporalRain) throw new Error('Fused rain aggregation requires prepared temporal sampling.');
  const summary = createWeatherSummary(parentLevel, reusable, ArrayType, totalWeight, WEATHER_SUMMARY_PROFILE_RAIN_ONLY_DISPLAY);
  const childSummary = { potentialActiveIndices: activeChildren };
  const activeIndices = activeIndicesForAggregate(summary, childSummary, contributions);
  zeroWeatherFields(summary, activeIndices);
  const storedRain = ArrayType === Float32Array ? Math.fround : (value) => value;
  for (let activeChild = 0; activeChild < activeChildren.length; activeChild++) {
    const childIndex = activeChildren[activeChild];
    const rainMmh = temporalRain(activeChild);
    const rainForSummary = storedRain(rainMmh);
    if (contributions.kind !== 'separable-centered') {
      const start = contributions.offsets[childIndex];
      const end = contributions.offsets[childIndex + 1];
      for (let contributionIndex = start; contributionIndex < end; contributionIndex++) {
        const parentIndex = contributions.parentIndices[contributionIndex];
        const weight = contributions.weights[contributionIndex];
        summary.rainWeightedSumMmh[parentIndex] += weight * rainForSummary;
        summary.rainCoverageWeight[0][parentIndex] += weight * (rainMmh >= 0.05 ? 1 : 0);
        summary.rainCoverageWeight[1][parentIndex] += weight * (rainMmh >= 2.5 ? 1 : 0);
        if (weight > 0) summary.rainMaxMmh[parentIndex] = Math.max(summary.rainMaxMmh[parentIndex], rainForSummary);
      }
      continue;
    }
    const relation = contributions;
    const column = childIndex % relation.fineWidth;
    const row = Math.floor(childIndex / relation.fineWidth);
    const xCount = relation.x.candidateCounts[column];
    const yCount = relation.y.candidateCounts[row];
    const xRawWeight = relation.x.rawCandidateCounts[column] === 1 ? 1 : 0.5;
    const yRawWeight = relation.y.rawCandidateCounts[row] === 1 ? 1 : 0.5;
    const axisWeight = xRawWeight * yRawWeight;
    const totalCandidateWeight = axisWeight * xCount * yCount;
    const xBase = column * 2;
    const yBase = row * 2;
    for (let xOffset = 0; xOffset < xCount; xOffset++) {
      const parentX = relation.x.candidateIndices[xBase + xOffset];
      for (let yOffset = 0; yOffset < yCount; yOffset++) {
        const parentIndex = relation.y.candidateIndices[yBase + yOffset] * relation.coarseWidth + parentX;
        const weight = axisWeight / totalCandidateWeight;
        summary.rainWeightedSumMmh[parentIndex] += weight * rainForSummary;
        summary.rainCoverageWeight[0][parentIndex] += weight * (rainMmh >= 0.05 ? 1 : 0);
        summary.rainCoverageWeight[1][parentIndex] += weight * (rainMmh >= 2.5 ? 1 : 0);
        if (weight > 0) summary.rainMaxMmh[parentIndex] = Math.max(summary.rainMaxMmh[parentIndex], rainForSummary);
      }
    }
  }
  return summary;
}

export class GeographicWeatherPyramid {
  constructor(summaryArrayType = Float32Array, topology = new GeographicLodTopology(), options = {}) {
    this.summaryArrayType = summaryArrayType;
    this.diagnostics = { samplingGeometryPreparations: 0, evaluateCalls: 0 };
    this.setTopology(topology, options);
  }

  setTopology(topology, options = {}) {
    const previousTopology = this.topology;
    const previousSamplingGeometries = this.samplingGeometries;
    const preserveCompatibleState = options.preserveCompatibleState !== false
      && previousTopology
      && canonicalWindowsEqual(previousTopology.canonicalWindow, topology.canonicalWindow);
    this.topology = topology;
    this.levels = topology.levels;
    const setup = buildAggregationSetup(topology, this.summaryArrayType, options.reuse !== false);
    this.centeredRelations = setup.relations;
    this.totalWeights = setup.totalWeights;
    this.topologySetupTimings = setup.timings;
    this.samplingGeometries = new Map();
    if (preserveCompatibleState && previousSamplingGeometries) {
      for (const [level, geometry] of previousSamplingGeometries) {
        if (previousTopology.levels.get(level) === topology.levels.get(level)) this.samplingGeometries.set(level, geometry);
      }
    }
  }

  setCanonicalWindow(canonicalWindow, options = {}) {
    return this.setConfiguration(canonicalWindow, this.topology.levelRange, options);
  }

  setLevelRange(levelRange) {
    return this.setConfiguration(this.topology.canonicalWindow, levelRange);
  }

  setConfiguration(canonicalWindow, levelRange, options = {}) {
    const nextWindow = normalizeCanonicalWindow(canonicalWindow);
    const nextRange = normalizeLodRange(levelRange);
    if (canonicalWindowsEqual(this.topology.canonicalWindow, nextWindow) && lodRangesEqual(this.topology.levelRange, nextRange)) return false;
    const sameWindow = canonicalWindowsEqual(this.topology.canonicalWindow, nextWindow);
    this.setTopology(new GeographicLodTopology(nextWindow, nextRange, sameWindow ? this.topology : null, {
      deferTransitionParents: options.deferTransitionParents ?? options.deferL14TransitionParents
    }), {
      preserveCompatibleState: sameWindow
    });
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
      centeredRelationToParent: this.centeredRelations.get(level) || null
    };
  }

  summaryMemoryBytesPerSample() {
    return (2 + RAIN_COVERAGE_THRESHOLDS_MMH.length + 6) * this.summaryArrayType.BYTES_PER_ELEMENT;
  }

  prepareSamplingGeometry(level, frame) {
    const existing = this.samplingGeometries.get(level);
    if (existing && frame.isSamplingGeometryCompatible(existing)) return existing;
    const geometry = prepareGeographicSamplingGeometry(frame, this.levelDataFor(level), existing);
    this.samplingGeometries.set(level, geometry);
    this.diagnostics.samplingGeometryPreparations++;
    return geometry;
  }

  // Stable GPU L14 presentation owns compact window metadata and derives its
  // canonical/source coordinates procedurally, not from this CPU-side provider
  // sampling geometry. Keep the descriptor/topology for an adjacent CPU
  // fallback transition, but discard per-sample temporal reconstruction state
  // as soon as GPU residency takes ownership.
  releaseSamplingGeometry(level) {
    const geometry = this.samplingGeometries.get(level);
    if (!geometry) return false;
    geometry.spatialRainCache?.clear?.();
    this.samplingGeometries.delete(level);
    return true;
  }

  evaluate(requestedLevels, frame, reusableStates = null) {
    if (!requestedLevels.length) return [];
    this.diagnostics.evaluateCalls++;
    const minimumRequested = Math.min(...requestedLevels);
    if (minimumRequested < MIN_GRID_LEVEL || Math.max(...requestedLevels) > MAX_GRID_LEVEL) {
      throw new Error(`Weather summary levels must be between L${MIN_GRID_LEVEL} and L${MAX_GRID_LEVEL}.`);
    }

    const summaries = new Array(MAX_GRID_LEVEL + 1);
    const uniqueRequested = [...new Set(requestedLevels)];
    const aggregateRequested = uniqueRequested.filter((level) => level <= WEATHER_REFERENCE_LEVEL);
    if (aggregateRequested.length) {
      const minimumAggregateLevel = Math.min(...aggregateRequested);
      this.levelDataFor(WEATHER_REFERENCE_LEVEL);
      for (let level = minimumAggregateLevel; level <= WEATHER_REFERENCE_LEVEL; level++) this.levelDataFor(level);
      const samplingGeometry = this.prepareSamplingGeometry(WEATHER_REFERENCE_LEVEL, frame);
      const useFusedRainPath = uniqueRequested.every((level) => level < WEATHER_REFERENCE_LEVEL)
        && frame?.weatherSummaryProfile === WEATHER_SUMMARY_PROFILE_RAIN_ONLY_DISPLAY
        && typeof frame.prepareTemporalSampling === 'function'
        && samplingGeometry?.potentialActiveIndices
        && this.centeredRelations.has(WEATHER_REFERENCE_LEVEL);
      let summary;
      if (useFusedRainPath) {
        summary = evaluateFusedRainAggregateSummary(
          this.levels.get(WEATHER_REFERENCE_LEVEL - 1),
          frame,
          samplingGeometry,
          this.centeredRelations.get(WEATHER_REFERENCE_LEVEL),
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
        const relation = this.centeredRelations.get(level + 1);
        if (!relation) throw new Error(`LOD L${level} aggregation requires an unbroken L13 reference chain.`);
        summary = aggregateWeatherSummary(
          this.levels.get(level),
          summary,
          relation,
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

  snapshot() {
    const seenBuffers = new Set();
    const bytes = (value) => {
      if (!ArrayBuffer.isView(value) || seenBuffers.has(value.buffer)) return 0;
      seenBuffers.add(value.buffer);
      return value.buffer.byteLength;
    };
    let samplingGeometryBytes = 0;
    for (const geometry of this.samplingGeometries.values()) {
      samplingGeometryBytes += [
        geometry.baseIndex,
        geometry.longitudeFraction,
        geometry.latitudeFraction,
        geometry.sourceColumn,
        geometry.sourceRowBase,
        geometry.potentialActiveIndices,
        geometry.temporalRainMmh
      ].reduce((total, value) => total + bytes(value), 0);
      if (geometry.spatialRainCache) {
        for (const values of geometry.spatialRainCache.values()) samplingGeometryBytes += bytes(values);
      }
    }
    let centeredRelationBytes = 0;
    for (const relation of this.centeredRelations.values()) {
      centeredRelationBytes += [
        relation.x?.candidateCounts,
        relation.x?.rawCandidateCounts,
        relation.x?.candidateIndices,
        relation.y?.candidateCounts,
        relation.y?.rawCandidateCounts,
        relation.y?.candidateIndices
      ].reduce((total, value) => total + bytes(value), 0);
    }
    let transitionParentBytes = 0;
    for (const relation of this.topology?.transitionParents?.values?.() || []) {
      transitionParentBytes += [relation.childOffsets, relation.childIndices, relation.parentIndexByChild]
        .reduce((total, value) => total + bytes(value), 0);
    }
    let directTransitionRelationBytes = 0;
    for (const relation of this.topology?.directTransitionRelations?.values?.() || []) {
      directTransitionRelationBytes += [relation.lowerToHigherColumns, relation.lowerToHigherRows]
        .reduce((total, value) => total + bytes(value), 0);
    }
    const relationBytes = centeredRelationBytes + transitionParentBytes + directTransitionRelationBytes;
    return {
      counters: { ...this.diagnostics },
      samplingGeometryCount: this.samplingGeometries.size,
      samplingGeometryBytes,
      knownRelationBytes: relationBytes,
      relationByteBreakdown: {
        centeredContributionRelations: centeredRelationBytes,
        transitionParents: transitionParentBytes,
        directTransitionRelations: directTransitionRelationBytes
      },
      knownTypedArrayBytes: samplingGeometryBytes + relationBytes,
      topologySetupTimings: this.topologySetupTimings ? { ...this.topologySetupTimings } : null,
      materializedLevels: [...this.levels.keys()]
    };
  }
}
