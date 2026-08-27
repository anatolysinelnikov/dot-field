import fs from 'node:fs';
import { performance } from 'node:perf_hooks';
import { geographicPreparedIntensityAtGeometry, geographicPrepareTemporalSampling, setActiveWeatherField } from '../src/engine/geography.js';
import { RealWeatherField, RealWeatherSequence } from '../src/engine/real-weather.js';
import {
  aggregateWeatherSummary,
  buildCenteredContributions,
  createWeatherSummary,
  evaluateDirectWeatherSummary,
  evaluateFusedRainAggregateSummary,
  RAIN_COVERAGE_THRESHOLDS_MMH,
  GeographicWeatherPyramid
} from '../src/engine/geographic-weather-pyramid.js';
import {
  GeographicLodTopology,
  lodRangeForStableLevel,
  mercatorXForIndex,
  mercatorYForIndex
} from '../src/engine/geographic-lod.js';
import { mapDotsWeatherSummary, GeographicDotsLayer } from '../src/engine/geographic-dots-layer.js';
import { mapSquaresWeatherSummary, GeographicSquaresLayer } from '../src/engine/geographic-squares-layer.js';

const metadata = JSON.parse(fs.readFileSync(new URL('../data/generated/202608262200/metadata.json', import.meta.url), 'utf8'));
const grid = metadata.spatial_grid;
const time = metadata.time;
const binary = fs.readFileSync(new URL('../data/generated/202608262200/rain.f32', import.meta.url));
const rainFramesMmh = new Float32Array(binary.buffer, binary.byteOffset, binary.byteLength / Float32Array.BYTES_PER_ELEMENT);
const longitudes = Float64Array.from({ length: grid.width }, (_, index) => grid.longitude_start + index * grid.longitude_spacing);
const latitudes = Float64Array.from({ length: grid.height }, (_, index) => grid.latitude_start + index * grid.latitude_spacing);
const weather = new RealWeatherSequence({
  longitudes,
  latitudes,
  rainFramesMmh,
  frameCount: time.count,
  longitudeSpacing: grid.longitude_spacing,
  latitudeSpacing: grid.latitude_spacing,
  timestamps: time.timestamps
});
setActiveWeatherField(weather);

const REPEATS = 5;
const WARMUP = 2;
const LEVELS = [10, 11, 12];
const median = (values) => [...values].sort((left, right) => left - right)[Math.floor(values.length / 2)];
const mib = (bytes) => `${(bytes / 1024 / 1024).toFixed(3)} MiB`;
const spatialCacheBytes = (geometry) => [...geometry.spatialRainCache.values()]
  .reduce((total, values) => total + values.byteLength, 0);
const measure = (callback) => {
  for (let run = 0; run < WARMUP; run++) callback();
  const values = [];
  for (let run = 0; run < REPEATS; run++) {
    const started = performance.now();
    callback();
    values.push(performance.now() - started);
  }
  return median(values);
};

const measureWithClearedCache = (geometry, callback) => {
  for (let run = 0; run < WARMUP; run++) {
    geometry.spatialRainCache.clear();
    callback();
  }
  const values = [];
  for (let run = 0; run < REPEATS; run++) {
    geometry.spatialRainCache.clear();
    const started = performance.now();
    callback();
    values.push(performance.now() - started);
  }
  return median(values);
};

function makeTopology(stableLevel) {
  return new GeographicLodTopology(undefined, lodRangeForStableLevel(stableLevel));
}

function installDenseAggregationReference(pyramid) {
  for (let level = 11; level <= 13; level++) {
    if (!pyramid.levels.has(level - 1) || !pyramid.levels.has(level)) continue;
    pyramid.centeredRelations.set(level, buildCenteredContributions(pyramid.levels.get(level), pyramid.levels.get(level - 1)));
  }
}

function denseGeometry(levelData) {
  const prepared = legacyRectangularGeometry(levelData);
  const copy = { ...prepared };
  delete copy.potentialActiveIndices;
  return copy;
}

function legacyRectangularGeometry(levelData) {
  const axisLongitudes = new Float64Array(levelData.width);
  const axisLatitudes = new Float64Array(levelData.height);
  for (let column = 0; column < levelData.width; column++) {
    axisLongitudes[column] = mercatorXForIndex(levelData, column) * 360 - 180;
  }
  for (let row = 0; row < levelData.height; row++) {
    const mercatorY = levelData.minJ + row * levelData.spacing;
    axisLatitudes[row] = Math.atan(Math.sinh(Math.PI * (1 - 2 * mercatorY))) * 180 / Math.PI;
  }
  return RealWeatherField.prototype.prepareRectangularSamplingGeometry.call(
    weather,
    axisLongitudes,
    axisLatitudes,
    levelData.width,
    levelData.height
  );
}

function benchmarkSpatialCachePattern(geometry, name, positions) {
  let misses = 0;
  let maxEntries = 0;
  let maxBytes = 0;
  const run = () => {
    geometry.spatialRainCache.clear();
    misses = 0;
    for (const position of positions) {
      const frame = weather.prepareFrame(position / (weather.frameCount - 1));
      const requiredFrames = frame.frame0 === frame.frame1
        ? [frame.frame0]
        : [frame.frame0, frame.frame1];
      for (const frameIndex of requiredFrames) {
        if (!geometry.spatialRainCache.has(frameIndex)) misses++;
      }
      geographicPrepareTemporalSampling(frame, geometry);
      maxEntries = Math.max(maxEntries, geometry.spatialRainCache.size);
      maxBytes = Math.max(maxBytes, spatialCacheBytes(geometry));
    }
  };
  const medianMs = measure(run);
  return {
    name,
    entries: geometry.spatialRainCache.size,
    bytes: spatialCacheBytes(geometry),
    maxEntries,
    maxBytes,
    misses,
    medianMs
  };
}

function evaluateChain(pyramid, frame, level, geometry, reusable = null) {
  let summary = evaluateDirectWeatherSummary(
    pyramid.levels.get(13),
    frame,
    reusable?.[13] || null,
    Float32Array,
    geometry,
    pyramid.totalWeights.get(13)
  );
  const summaries = { 13: summary };
  for (let childLevel = 12; childLevel >= level; childLevel--) {
    summary = aggregateWeatherSummary(
      pyramid.levels.get(childLevel),
      summary,
      pyramid.centeredRelations.get(childLevel + 1),
      reusable?.[childLevel] || null,
      Float32Array,
      pyramid.totalWeights.get(childLevel)
    );
    summaries[childLevel] = summary;
  }
  return summaries;
}

function benchmarkChain(pyramid, frame, level, geometry) {
  let reusable = null;
  let summaries = null;
  const keyframeMs = measure(() => {
    summaries = evaluateChain(pyramid, frame, level, geometry, reusable);
    reusable = summaries;
  });
  return { keyframeMs, summaries };
}

function benchmarkDirect(pyramid, frame, geometry, initialSummary = null) {
  let summary = initialSummary;
  return measure(() => {
    summary = evaluateDirectWeatherSummary(pyramid.levels.get(13), frame, summary, Float32Array, geometry, pyramid.totalWeights.get(13));
  });
}

function zeroLegacySummary(summary) {
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

function legacyEvaluateDirect(levelData, frame, reusable, geometry) {
  const summary = createWeatherSummary(levelData, reusable, Float32Array);
  zeroLegacySummary(summary);
  const value = { rainMmh: 0, storm: 0, hail: 0 };
  for (let index = 0; index < levelData.count; index++) {
    geographicPreparedIntensityAtGeometry(frame, geometry, index, value);
    summary.totalWeight[index] = 1;
    summary.rainWeightedSumMmh[index] = value.rainMmh;
    summary.rainMaxMmh[index] = value.rainMmh;
    for (let thresholdIndex = 0; thresholdIndex < RAIN_COVERAGE_THRESHOLDS_MMH.length; thresholdIndex++) {
      summary.rainCoverageWeight[thresholdIndex][index] = value.rainMmh >= RAIN_COVERAGE_THRESHOLDS_MMH[thresholdIndex] ? 1 : 0;
    }
    summary.stormCoverageWeight[index] = value.storm > 0 ? 1 : 0;
    summary.stormWeightedSeverity[index] = value.storm;
    summary.stormMaxSeverity[index] = value.storm;
    summary.hailCoverageWeight[index] = value.hail > 0 ? 1 : 0;
    summary.hailWeightedSeverity[index] = value.hail;
    summary.hailMaxSeverity[index] = value.hail;
  }
  return summary;
}

function sparseUncachedEvaluateDirect(levelData, frame, reusable, geometry, activeIndices) {
  const summary = createWeatherSummary(levelData, reusable, Float32Array);
  if (!summary.totalWeightInitialized) {
    summary.totalWeight.fill(1);
    summary.totalWeightInitialized = true;
  }
  summary.potentialActiveIndices = activeIndices;
  summary.potentialActiveIndicesInitialized = true;
  for (let activeIndex = 0; activeIndex < activeIndices.length; activeIndex++) {
    const index = activeIndices[activeIndex];
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
  const value = { rainMmh: 0, storm: 0, hail: 0 };
  for (let activeIndex = 0; activeIndex < activeIndices.length; activeIndex++) {
    const index = activeIndices[activeIndex];
    geographicPreparedIntensityAtGeometry(frame, geometry, index, value);
    summary.rainWeightedSumMmh[index] = value.rainMmh;
    summary.rainMaxMmh[index] = value.rainMmh;
    for (let thresholdIndex = 0; thresholdIndex < RAIN_COVERAGE_THRESHOLDS_MMH.length; thresholdIndex++) {
      summary.rainCoverageWeight[thresholdIndex][index] = value.rainMmh >= RAIN_COVERAGE_THRESHOLDS_MMH[thresholdIndex] ? 1 : 0;
    }
    summary.stormCoverageWeight[index] = value.storm > 0 ? 1 : 0;
    summary.stormWeightedSeverity[index] = value.storm;
    summary.stormMaxSeverity[index] = value.storm;
    summary.hailCoverageWeight[index] = value.hail > 0 ? 1 : 0;
    summary.hailWeightedSeverity[index] = value.hail;
    summary.hailMaxSeverity[index] = value.hail;
  }
  return summary;
}

function legacyAggregate(parentLevel, childSummary, contributions, reusable) {
  const summary = createWeatherSummary(parentLevel, reusable, Float32Array);
  zeroLegacySummary(summary);
  for (let childIndex = 0; childIndex < childSummary.levelData.count; childIndex++) {
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

function legacyChain(pyramid, frame, level, geometry, reusable = null) {
  let summary = legacyEvaluateDirect(pyramid.levels.get(13), frame, reusable?.[13] || null, geometry);
  const summaries = { 13: summary };
  for (let childLevel = 12; childLevel >= level; childLevel--) {
    summary = legacyAggregate(pyramid.levels.get(childLevel), summary, pyramid.centeredRelations.get(childLevel + 1), reusable?.[childLevel] || null);
    summaries[childLevel] = summary;
  }
  return summaries;
}

function sparseUncachedChain(pyramid, frame, level, geometry, activeIndices, reusable = null) {
  let summary = sparseUncachedEvaluateDirect(pyramid.levels.get(13), frame, reusable?.[13] || null, geometry, activeIndices);
  const summaries = { 13: summary };
  for (let childLevel = 12; childLevel >= level; childLevel--) {
    summary = aggregateWeatherSummary(
      pyramid.levels.get(childLevel),
      summary,
      pyramid.centeredRelations.get(childLevel + 1),
      reusable?.[childLevel] || null,
      Float32Array,
      pyramid.totalWeights.get(childLevel)
    );
    summaries[childLevel] = summary;
  }
  return summaries;
}

function benchmarkLegacyChain(pyramid, frame, level, geometry) {
  let reusable = null;
  let summaries = null;
  const keyframeMs = measure(() => {
    summaries = legacyChain(pyramid, frame, level, geometry, reusable);
    reusable = summaries;
  });
  return { keyframeMs, summaries };
}

function benchmarkSparseUncachedChain(pyramid, frame, level, geometry, activeIndices) {
  let reusable = null;
  let summaries = null;
  const keyframeMs = measure(() => {
    summaries = sparseUncachedChain(pyramid, frame, level, geometry, activeIndices, reusable);
    reusable = summaries;
  });
  return { keyframeMs, summaries };
}

function benchmarkAggregationOnly(pyramid, level, initialSummary, optimized) {
  let reusable = {};
  return measure(() => {
    let summary = initialSummary;
    for (let childLevel = 12; childLevel >= level; childLevel--) {
      summary = optimized
        ? aggregateWeatherSummary(pyramid.levels.get(childLevel), summary, pyramid.centeredRelations.get(childLevel + 1), reusable[childLevel] || null, Float32Array, pyramid.totalWeights.get(childLevel))
        : legacyAggregate(pyramid.levels.get(childLevel), summary, pyramid.centeredRelations.get(childLevel + 1), reusable[childLevel] || null);
      reusable[childLevel] = summary;
    }
  });
}

function benchmarkAggregationStep(pyramid, parentLevel, childSummary, optimized) {
  let reusable = null;
  return measure(() => {
    if (optimized) {
      reusable = aggregateWeatherSummary(
        pyramid.levels.get(parentLevel),
        childSummary,
        pyramid.centeredRelations.get(parentLevel + 1),
        reusable,
        Float32Array,
        pyramid.totalWeights.get(parentLevel)
      );
    } else {
      reusable = legacyAggregate(
        pyramid.levels.get(parentLevel),
        childSummary,
        pyramid.centeredRelations.get(parentLevel + 1),
        reusable
      );
    }
  });
}

function benchmarkFusedFirstStep(pyramid, frame, geometry) {
  let reusable = null;
  return measure(() => {
    reusable = evaluateFusedRainAggregateSummary(
      pyramid.levels.get(12),
      frame,
      geometry,
      pyramid.centeredRelations.get(13),
      reusable,
      Float32Array,
      pyramid.totalWeights.get(12)
    );
  });
}

function benchmarkFusedKeyframe(pyramid, frame, level) {
  let reusable = null;
  let summaries = null;
  const keyframeMs = measure(() => {
    summaries = pyramid.evaluate([level], frame, reusable);
    reusable = summaries;
  });
  return { keyframeMs, summaries };
}

function buildDotsInstances(pyramid, level, mapped) {
  const layer = new GeographicDotsLayer(pyramid);
  layer.active = true;
  layer.levelData = pyramid.levelDataFor(level);
  layer.temporal = { levels: new Map([[level, { frames0: { mapped: { [level]: mapped } }, frames1: { mapped: { [level]: mapped } } }]]) };
  layer.rebuildInstances();
  return {
    counts: { ...layer.counts },
    bytes: Object.values(layer.instances).reduce((sum, values) => sum + values.byteLength, 0)
  };
}

function buildSquaresInstances(pyramid, level, mapped) {
  const layer = new GeographicSquaresLayer(pyramid);
  layer.levelData = pyramid.levelDataFor(level);
  layer.temporal = { levels: new Map([[level, { frames0: { mapped: { [level]: mapped } }, frames1: { mapped: { [level]: mapped } } }]]) };
  layer.rebuildInstances();
  return {
    count: layer.instanceCounts[0],
    packedBytes: layer.instanceCounts[0] * 18 * Float32Array.BYTES_PER_ELEMENT,
    allocatedBytes: layer.instanceData[0].byteLength
  };
}

console.log('Full-domain weather performance benchmark');
console.log(`fixture=202608262200 frames=${weather.frameCount} source=${grid.width}x${grid.height} sourceBytes=${mib(rainFramesMmh.byteLength)}`);
console.log(`warmup=${WARMUP} repeats=${REPEATS} statistic=median; Float32 production summaries`);

const directProbeTopology = makeTopology(10);
const directProbePyramid = new GeographicWeatherPyramid(Float32Array, directProbeTopology);
const directProbeFrame = weather.prepareFrame(6.5 / 18);
const directProbeBoundaryFrame = weather.prepareFrame(7.5 / 18);
const directProbeGeometry = directProbePyramid.prepareSamplingGeometry(13, directProbeFrame);
const directProbeUncachedGeometry = denseGeometry(directProbePyramid.levels.get(13));
const directProbeActiveIndices = directProbeGeometry.potentialActiveIndices;
const directProbeSummary = { current: null };
const evaluateProbe = (frame) => {
  directProbeSummary.current = evaluateDirectWeatherSummary(
    directProbePyramid.levels.get(13),
    frame,
    directProbeSummary.current,
    Float32Array,
    directProbeGeometry,
    directProbePyramid.totalWeights.get(13)
  );
};
const sourcePairCacheBuildMs = measureWithClearedCache(directProbeGeometry, () => {
  directProbeFrame.preparedSourceFrame(directProbeGeometry, directProbeFrame.frame0);
  directProbeFrame.preparedSourceFrame(directProbeGeometry, directProbeFrame.frame1);
});
const sparseUncachedDirectMs = measure(() => {
  directProbeSummary.current = sparseUncachedEvaluateDirect(
    directProbePyramid.levels.get(13),
    directProbeFrame,
    directProbeSummary.current,
    directProbeUncachedGeometry,
    directProbeActiveIndices
  );
});
const coldDirectMs = measureWithClearedCache(directProbeGeometry, () => evaluateProbe(directProbeFrame));
directProbeGeometry.spatialRainCache.clear();
evaluateProbe(directProbeFrame);
const steadyDirectMs = measure(() => evaluateProbe(directProbeFrame));
const providerBoundaryMs = measureWithClearedCache(directProbeGeometry, () => {
  directProbeFrame.preparedSourceFrame(directProbeGeometry, directProbeFrame.frame1);
  evaluateProbe(directProbeBoundaryFrame);
});
const normalTemporalScratchBytes = directProbeGeometry.temporalRainMmh?.byteLength || 0;
const compatibilityBatchMs = measureWithClearedCache(directProbeGeometry, () => {
  directProbeFrame.samplePreparedBatch(directProbeGeometry);
});
const compatibilityBatchScratchBytes = directProbeGeometry.temporalRainMmh?.byteLength || 0;
delete directProbeGeometry.temporalRainMmh;
directProbeGeometry.spatialRainCache.clear();
for (let frameIndex = 0; frameIndex < weather.frameCount; frameIndex++) {
  const frame = weather.prepareFrame(frameIndex / (weather.frameCount - 1));
  geographicPrepareTemporalSampling(frame, directProbeGeometry);
}
const cacheBytesPerFrame = directProbeGeometry.potentialActiveIndices.length * Float64Array.BYTES_PER_ELEMENT;
console.log(`direct L13 prepared temporal probe: active=${directProbeGeometry.potentialActiveIndices.length}; sparse uncached=${sparseUncachedDirectMs.toFixed(3)}ms; spatial source-pair acquisition=${sourcePairCacheBuildMs.toFixed(3)}ms; compatibility batch materialization=${compatibilityBatchMs.toFixed(3)}ms; cold direct summary=${coldDirectMs.toFixed(3)}ms; steady direct summary=${steadyDirectMs.toFixed(3)}ms; one-new-frame boundary=${providerBoundaryMs.toFixed(3)}ms`);
console.log(`direct L13 cache memory: per-source-frame=${mib(cacheBytesPerFrame)}; representative pair=${mib(cacheBytesPerFrame * 2)}; retained=${mib(spatialCacheBytes(directProbeGeometry))} (${directProbeGeometry.spatialRainCache.size} cached frames); unbounded-reference-all-${weather.frameCount}=${mib(cacheBytesPerFrame * weather.frameCount)}`);
console.log(`direct L13 memory: provider-binary=${mib(rainFramesMmh.byteLength)}; prepared-geometry-base=${mib(weather.samplingGeometryBytes(directProbeGeometry))}; potential-active-indices=${mib(directProbeGeometry.potentialActiveIndices.byteLength)}; normal-production-temporal-scratch=${mib(normalTemporalScratchBytes)}; lazy-compatibility-batch-scratch=${mib(compatibilityBatchScratchBytes)}`);
for (const level of [10, 11, 12, 13]) {
  const levelTopology = makeTopology(10);
  const levelPyramid = new GeographicWeatherPyramid(Float32Array, levelTopology);
  const levelData = levelPyramid.levelDataFor(level);
  const preparationTimes = [];
  const legacyPreparationTimes = [];
  for (let run = 0; run < WARMUP + REPEATS; run++) {
    levelPyramid.samplingGeometries.clear();
    const started = performance.now();
    const geometry = levelPyramid.prepareSamplingGeometry(level, weather.prepareFrame(0));
    if (run >= WARMUP) preparationTimes.push(performance.now() - started);
    const legacyStarted = performance.now();
    const legacyGeometry = legacyRectangularGeometry(levelData);
    if (run >= WARMUP) legacyPreparationTimes.push(performance.now() - legacyStarted);
    if (run === WARMUP + REPEATS - 1) {
      console.log(`sampling geometry L${level}: dimensions=${geometry.width}x${geometry.height}; count=${levelData.count}; dense-reference-base=${mib(weather.samplingGeometryBytes(legacyGeometry))}; compact-base=${mib(weather.samplingGeometryBytes(geometry))}; potential-active-indices=${mib(geometry.potentialActiveIndices.byteLength)}; compact-preparation-median=${median(preparationTimes).toFixed(3)}ms; dense-reference-preparation-median=${median(legacyPreparationTimes).toFixed(3)}ms`);
    }
  }
}
const forwardPositions = [...Array.from({ length: weather.frameCount - 1 }, (_, index) => index + 0.25), weather.frameCount - 1];
const reversePositions = [...Array.from({ length: weather.frameCount - 1 }, (_, index) => weather.frameCount - 1.25 - index), 0];
const adjacentScrubPositions = [0.25, 1.25, 0.25, 1.25, 2.25, 1.25, 2.25, 3.25, 2.25, 3.25, 4.25, 3.25, 4.25, 5.25, 4.25, 5.25, 6.25, 5.25, 6.25, 7.25];
const wideJumpPositions = [0, 9, 18, 1, 17, 2, 16, 3, 15, 4, 14];
for (const result of [
  benchmarkSpatialCachePattern(directProbeGeometry, 'all-exact-forward', Array.from({ length: weather.frameCount }, (_, index) => index)),
  benchmarkSpatialCachePattern(directProbeGeometry, 'normal-forward-playback', forwardPositions),
  benchmarkSpatialCachePattern(directProbeGeometry, 'reverse-playback', reversePositions),
  benchmarkSpatialCachePattern(directProbeGeometry, 'adjacent-back-and-forth-scrub', adjacentScrubPositions),
  benchmarkSpatialCachePattern(directProbeGeometry, 'wide-jump-scrub', wideJumpPositions)
]) {
  console.log(`spatial cache ${result.name}: entries=${result.entries}; bytes=${mib(result.bytes)}; maxEntries=${result.maxEntries}; maxBytes=${mib(result.maxBytes)}; sourceFrameMisses=${result.misses}; medianPatternMs=${result.medianMs.toFixed(3)}`);
}

for (const stableLevel of LEVELS) {
  const topology = makeTopology(stableLevel);
  const pyramid = new GeographicWeatherPyramid(Float32Array, topology);
  const frame = weather.prepareFrame(0.347);
  const geometry = pyramid.prepareSamplingGeometry(13, frame);
  const dense = denseGeometry(pyramid.levels.get(13));
  const optimized = benchmarkChain(pyramid, frame, stableLevel, geometry);
  const sparseUncached = benchmarkSparseUncachedChain(pyramid, frame, stableLevel, dense, geometry.potentialActiveIndices);
  const legacyPyramid = new GeographicWeatherPyramid(Float32Array, topology);
  installDenseAggregationReference(legacyPyramid);
  const legacyGeometry = denseGeometry(legacyPyramid.levels.get(13));
  const legacyResult = benchmarkLegacyChain(legacyPyramid, frame, stableLevel, legacyGeometry);
  const optimizedSummary = optimized.summaries;
  const fusedPyramid = new GeographicWeatherPyramid(Float32Array, topology);
  const fused = benchmarkFusedKeyframe(fusedPyramid, frame, stableLevel);
  const fusedSummary = fused.summaries;
  if (fusedSummary[13] !== undefined) throw new Error(`L${stableLevel} fused benchmark unexpectedly retained an L13 summary.`);
  const denseSummary = legacyResult.summaries;
  const directOptimizedMs = benchmarkDirect(pyramid, frame, geometry, optimizedSummary[13]);
  const directDenseMs = measure(() => legacyEvaluateDirect(legacyPyramid.levels.get(13), frame, denseSummary[13], legacyGeometry));
  const aggregateOptimizedMs = benchmarkAggregationOnly(pyramid, stableLevel, optimizedSummary[13], true);
  const aggregateDenseMs = benchmarkAggregationOnly(legacyPyramid, stableLevel, denseSummary[13], false);
  const oldL13ToL12Ms = benchmarkAggregationStep(pyramid, 12, optimizedSummary[13], true);
  const oldL12ToL11Ms = stableLevel <= 11 ? benchmarkAggregationStep(pyramid, 11, optimizedSummary[12], true) : null;
  const oldL11ToL10Ms = stableLevel <= 10 ? benchmarkAggregationStep(pyramid, 10, optimizedSummary[11], true) : null;
  const fusedL13ToL12Ms = benchmarkFusedFirstStep(fusedPyramid, frame, fusedPyramid.prepareSamplingGeometry(13, frame));
  const fusedL12ToL11Ms = stableLevel <= 11 ? benchmarkAggregationStep(fusedPyramid, 11, fusedSummary[12], true) : null;
  const fusedL11ToL10Ms = stableLevel <= 10 ? benchmarkAggregationStep(fusedPyramid, 10, fusedSummary[11], true) : null;
  const oldMappedDots = mapDotsWeatherSummary(optimizedSummary[stableLevel]);
  const oldMappedSquares = mapSquaresWeatherSummary(optimizedSummary[stableLevel]);
  const fusedMappedDots = mapDotsWeatherSummary(fusedSummary[stableLevel]);
  const fusedMappedSquares = mapSquaresWeatherSummary(fusedSummary[stableLevel]);
  const denseMappedDots = mapDotsWeatherSummary(denseSummary[stableLevel]);
  const denseMappedSquares = mapSquaresWeatherSummary(denseSummary[stableLevel]);
  const legacyDotsMappingMs = measure(() => mapDotsWeatherSummary(denseSummary[stableLevel]));
  const legacySquaresMappingMs = measure(() => mapSquaresWeatherSummary(denseSummary[stableLevel]));
  const dotsMappingMs = measure(() => mapDotsWeatherSummary(optimizedSummary[stableLevel], oldMappedDots));
  const squaresMappingMs = measure(() => mapSquaresWeatherSummary(optimizedSummary[stableLevel], oldMappedSquares));
  const fusedDotsMappingMs = measure(() => mapDotsWeatherSummary(fusedSummary[stableLevel], fusedMappedDots));
  const fusedSquaresMappingMs = measure(() => mapSquaresWeatherSummary(fusedSummary[stableLevel], fusedMappedSquares));
  const legacyDotsInstanceMs = measure(() => buildDotsInstances(legacyPyramid, stableLevel, denseMappedDots));
  const legacySquaresInstanceMs = measure(() => buildSquaresInstances(legacyPyramid, stableLevel, denseMappedSquares));
  const dotsInstanceMs = measure(() => buildDotsInstances(pyramid, stableLevel, oldMappedDots));
  const squaresInstanceMs = measure(() => buildSquaresInstances(pyramid, stableLevel, oldMappedSquares));
  const fusedDotsInstanceMs = measure(() => buildDotsInstances(fusedPyramid, stableLevel, fusedMappedDots));
  const fusedSquaresInstanceMs = measure(() => buildSquaresInstances(fusedPyramid, stableLevel, fusedMappedSquares));
  const denseDotsMetrics = buildDotsInstances(legacyPyramid, stableLevel, denseMappedDots);
  const sparseDotsMetrics = buildDotsInstances(pyramid, stableLevel, oldMappedDots);
  const fusedDotsMetrics = buildDotsInstances(fusedPyramid, stableLevel, fusedMappedDots);
  const denseSquaresMetrics = buildSquaresInstances(legacyPyramid, stableLevel, denseMappedSquares);
  const sparseSquaresMetrics = buildSquaresInstances(pyramid, stableLevel, oldMappedSquares);
  const fusedSquaresMetrics = buildSquaresInstances(fusedPyramid, stableLevel, fusedMappedSquares);
  const totalSamples = [...pyramid.levels.values()].reduce((sum, levelData) => sum + levelData.count, 0);
  const genericSummaryBytes = totalSamples * pyramid.summaryMemoryBytesPerSample();
  const compactSummaryBytes = totalSamples * 4 * Float32Array.BYTES_PER_ELEMENT;
  const sharedTotalWeightBytes = totalSamples * Float32Array.BYTES_PER_ELEMENT;
  const l13CompactSummaryBytes = pyramid.levelDataFor(13).count * 4 * Float32Array.BYTES_PER_ELEMENT;
  const fusedCompactSummaryBytes = compactSummaryBytes - l13CompactSummaryBytes;
  const activeCount = geometry.potentialActiveIndices?.length ?? geometry.baseIndex.length;
  const activeSummaryIndices = optimizedSummary[stableLevel].potentialActiveIndices;
  const activeSummaryCount = activeSummaryIndices?.length ?? pyramid.levelDataFor(stableLevel).count;
  const activeIndexBytes = Object.values(optimizedSummary).filter(Boolean).reduce((sum, summary) => sum + (summary.potentialActiveIndices?.byteLength || 0), 0);
  console.log(`L${stableLevel}: topology=${[...pyramid.levels.values()].map((levelData) => `L${levelData.level}:${levelData.count}`).join(',')}`);
  console.log(`L${stableLevel}: samples canonical=${pyramid.levelDataFor(stableLevel).count} potential-active=${activeSummaryCount}; ratio=${pyramid.levelDataFor(stableLevel).count}:${activeSummaryCount}; L13 direct samples dense=${pyramid.levelDataFor(13).count} optimized=${activeCount}`);
  console.log(`L${stableLevel}: L13 direct ms dense=${directDenseMs.toFixed(3)} sparse-uncached=${sparseUncachedDirectMs.toFixed(3)} separable=${directOptimizedMs.toFixed(3)}; separable L13→L12=${oldL13ToL12Ms.toFixed(3)}; fused L13→L12=${fusedL13ToL12Ms.toFixed(3)}; separable L12→L11=${oldL12ToL11Ms === null ? 'n/a' : oldL12ToL11Ms.toFixed(3)} fused=${fusedL12ToL11Ms === null ? 'n/a' : fusedL12ToL11Ms.toFixed(3)}; separable L11→L10=${oldL11ToL10Ms === null ? 'n/a' : oldL11ToL10Ms.toFixed(3)} fused=${fusedL11ToL10Ms === null ? 'n/a' : fusedL11ToL10Ms.toFixed(3)}`);
  console.log(`L${stableLevel}: weather keyframe ms dense-reference=${legacyResult.keyframeMs.toFixed(3)} separable=${optimized.keyframeMs.toFixed(3)} fused=${fused.keyframeMs.toFixed(3)}; separable aggregate-all=${aggregateOptimizedMs.toFixed(3)} dense-reference-aggregate=${aggregateDenseMs.toFixed(3)}`);
  const denseTotalPreparationMs = legacyResult.keyframeMs + legacyDotsMappingMs + legacyDotsInstanceMs + legacySquaresMappingMs + legacySquaresInstanceMs;
  const sparseTotalPreparationMs = optimized.keyframeMs + dotsMappingMs + dotsInstanceMs + squaresMappingMs + squaresInstanceMs;
  const fusedTotalPreparationMs = fused.keyframeMs + fusedDotsMappingMs + fusedDotsInstanceMs + fusedSquaresMappingMs + fusedSquaresInstanceMs;
  console.log(`L${stableLevel}: Dots mapping ms dense-reference=${legacyDotsMappingMs.toFixed(3)} separable=${dotsMappingMs.toFixed(3)} fused=${fusedDotsMappingMs.toFixed(3)}; instances dense-reference=${legacyDotsInstanceMs.toFixed(3)} separable=${dotsInstanceMs.toFixed(3)} fused=${fusedDotsInstanceMs.toFixed(3)}; counts dense-reference=${JSON.stringify(denseDotsMetrics.counts)} separable=${JSON.stringify(sparseDotsMetrics.counts)} fused=${JSON.stringify(fusedDotsMetrics.counts)}; bytes dense-reference=${denseDotsMetrics.bytes} separable=${sparseDotsMetrics.bytes} fused=${fusedDotsMetrics.bytes}`);
  console.log(`L${stableLevel}: Squares mapping ms dense-reference=${legacySquaresMappingMs.toFixed(3)} separable=${squaresMappingMs.toFixed(3)} fused=${fusedSquaresMappingMs.toFixed(3)}; instances dense-reference=${legacySquaresInstanceMs.toFixed(3)} separable=${squaresInstanceMs.toFixed(3)} fused=${fusedSquaresInstanceMs.toFixed(3)}; count dense-reference=${denseSquaresMetrics.count} separable=${sparseSquaresMetrics.count} fused=${fusedSquaresMetrics.count}; packedBytes dense-reference=${denseSquaresMetrics.packedBytes} separable=${sparseSquaresMetrics.packedBytes} fused=${fusedSquaresMetrics.packedBytes}; allocatedBytes dense-reference=${denseSquaresMetrics.allocatedBytes} separable=${sparseSquaresMetrics.allocatedBytes} fused=${fusedSquaresMetrics.allocatedBytes}`);
  console.log(`L${stableLevel}: total weather-to-instance-preparation ms dense-reference=${denseTotalPreparationMs.toFixed(3)} separable=${sparseTotalPreparationMs.toFixed(3)} fused=${fusedTotalPreparationMs.toFixed(3)}`);
  console.log(`L${stableLevel}: summary fields bytes/sample generic=60 compact-rain-only=16; shared totalWeight=4 (reported once); one-keyframe generic=${mib(genericSummaryBytes)} compact=${mib(compactSummaryBytes)} fused-compact=${mib(fusedCompactSummaryBytes)}; normal two-keyframe generic=${mib(genericSummaryBytes * 2)} compact=${mib(compactSummaryBytes * 2)}; shared totalWeight cache=${mib(sharedTotalWeightBytes)}; fused omitted L13 compact=${mib(l13CompactSummaryBytes)}; active-index list=${mib(activeIndexBytes)} spatial-source-cache=${mib(spatialCacheBytes(geometry))} prepared-geometry=${mib(weather.samplingGeometryBytes(geometry))} renderer mapped full/compact=${mib(pyramid.levelDataFor(stableLevel).count * (4 + 8) * Float32Array.BYTES_PER_ELEMENT)}/${mib(pyramid.levelDataFor(stableLevel).count * (2 + 2) * Float32Array.BYTES_PER_ELEMENT)}`);
  if (stableLevel === 10) console.log(`L${stableLevel}: dense-vs-optimized sample check=${denseSummary[stableLevel].rainWeightedSumMmh[0] === optimizedSummary[stableLevel].rainWeightedSumMmh[0]}`);
}
