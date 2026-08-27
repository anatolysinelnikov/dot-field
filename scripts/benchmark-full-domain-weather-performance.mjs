import fs from 'node:fs';
import { performance } from 'node:perf_hooks';
import { geographicPreparedIntensityAtGeometry, setActiveWeatherField } from '../src/engine/geography.js';
import { RealWeatherSequence } from '../src/engine/real-weather.js';
import {
  aggregateWeatherSummary,
  createWeatherSummary,
  evaluateDirectWeatherSummary,
  RAIN_COVERAGE_THRESHOLDS_MMH,
  GeographicWeatherPyramid
} from '../src/engine/geographic-weather-pyramid.js';
import {
  GeographicLodTopology,
  lodRangeForStableLevel
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

function denseGeometry(geometry) {
  if (!geometry?.potentialActiveIndices) return geometry;
  const copy = { ...geometry };
  delete copy.potentialActiveIndices;
  return copy;
}

function evaluateChain(pyramid, frame, level, geometry, reusable = null) {
  let summary = evaluateDirectWeatherSummary(
    pyramid.levels.get(13),
    frame,
    reusable?.[13] || null,
    Float32Array,
    geometry
  );
  const summaries = { 13: summary };
  for (let childLevel = 12; childLevel >= level; childLevel--) {
    summary = aggregateWeatherSummary(
      pyramid.levels.get(childLevel),
      summary,
      pyramid.contributions.get(childLevel + 1),
      reusable?.[childLevel] || null,
      Float32Array
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
  for (let index = 0; index < levelData.samples.length; index++) {
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
  for (let childIndex = 0; childIndex < childSummary.samples.length; childIndex++) {
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
    summary = legacyAggregate(pyramid.levels.get(childLevel), summary, pyramid.contributions.get(childLevel + 1), reusable?.[childLevel] || null);
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
      pyramid.contributions.get(childLevel + 1),
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
        ? aggregateWeatherSummary(pyramid.levels.get(childLevel), summary, pyramid.contributions.get(childLevel + 1), reusable[childLevel] || null, Float32Array, pyramid.totalWeights.get(childLevel))
        : legacyAggregate(pyramid.levels.get(childLevel), summary, pyramid.contributions.get(childLevel + 1), reusable[childLevel] || null);
      reusable[childLevel] = summary;
    }
  });
}

function buildDotsInstances(pyramid, level, mapped) {
  const layer = new GeographicDotsLayer(pyramid);
  layer.active = true;
  layer.samples = pyramid.samplesFor(level);
  layer.temporal = { levels: new Map([[level, { frames0: { mapped: { [level]: mapped } }, frames1: { mapped: { [level]: mapped } } }]]) };
  layer.rebuildInstances();
  return Object.values(layer.instances).reduce((sum, values) => sum + values.byteLength, 0);
}

function buildSquaresInstances(pyramid, level, mapped) {
  const layer = new GeographicSquaresLayer(pyramid);
  layer.samples = pyramid.samplesFor(level);
  layer.temporal = { levels: new Map([[level, { frames0: { mapped: { [level]: mapped } }, frames1: { mapped: { [level]: mapped } } }]]) };
  layer.rebuildInstances();
  return layer.instanceData[0].byteLength;
}

console.log('Full-domain weather performance benchmark');
console.log(`fixture=202608262200 frames=${weather.frameCount} source=${grid.width}x${grid.height} sourceBytes=${mib(rainFramesMmh.byteLength)}`);
console.log(`warmup=${WARMUP} repeats=${REPEATS} statistic=median; Float32 production summaries`);

const directProbeTopology = makeTopology(10);
const directProbePyramid = new GeographicWeatherPyramid(Float32Array, directProbeTopology);
const directProbeFrame = weather.prepareFrame(6.5 / 18);
const directProbeBoundaryFrame = weather.prepareFrame(7.5 / 18);
const directProbeGeometry = directProbePyramid.prepareSamplingGeometry(13, directProbeFrame);
const directProbeUncachedGeometry = denseGeometry(directProbeGeometry);
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
directProbeGeometry.spatialRainCache.clear();
for (let frameIndex = 0; frameIndex < weather.frameCount; frameIndex++) {
  const frame = weather.prepareFrame(frameIndex / (weather.frameCount - 1));
  frame.samplePreparedBatch(directProbeGeometry);
}
const cacheBytesPerFrame = directProbeGeometry.potentialActiveIndices.length * Float64Array.BYTES_PER_ELEMENT;
console.log(`direct L13 cache probe: active=${directProbeGeometry.potentialActiveIndices.length}; sparse uncached=${sparseUncachedDirectMs.toFixed(3)}ms; source-pair cache build=${sourcePairCacheBuildMs.toFixed(3)}ms; cold direct=${coldDirectMs.toFixed(3)}ms; steady cached direct=${steadyDirectMs.toFixed(3)}ms; one-new-frame boundary=${providerBoundaryMs.toFixed(3)}ms`);
console.log(`direct L13 cache memory: per-source-frame=${mib(cacheBytesPerFrame)}; representative pair=${mib(cacheBytesPerFrame * 2)}; all ${weather.frameCount} source frames=${mib(cacheBytesPerFrame * weather.frameCount)} (${directProbeGeometry.spatialRainCache.size} cached frames)`);

for (const stableLevel of LEVELS) {
  const topology = makeTopology(stableLevel);
  const pyramid = new GeographicWeatherPyramid(Float32Array, topology);
  const frame = weather.prepareFrame(0.347);
  const geometry = pyramid.prepareSamplingGeometry(13, frame);
  const dense = denseGeometry(geometry);
  const optimized = benchmarkChain(pyramid, frame, stableLevel, geometry);
  const sparseUncached = benchmarkSparseUncachedChain(pyramid, frame, stableLevel, dense, geometry.potentialActiveIndices);
  const legacyPyramid = new GeographicWeatherPyramid(Float32Array, topology);
  const legacyGeometry = denseGeometry(legacyPyramid.prepareSamplingGeometry(13, frame));
  const legacyResult = benchmarkLegacyChain(legacyPyramid, frame, stableLevel, legacyGeometry);
  const optimizedSummary = optimized.summaries;
  const denseSummary = legacyResult.summaries;
  const directOptimizedMs = benchmarkDirect(pyramid, frame, geometry, optimizedSummary[13]);
  const directDenseMs = measure(() => legacyEvaluateDirect(legacyPyramid.levels.get(13), frame, denseSummary[13], legacyGeometry));
  const aggregateOptimizedMs = benchmarkAggregationOnly(pyramid, stableLevel, optimizedSummary[13], true);
  const aggregateDenseMs = benchmarkAggregationOnly(legacyPyramid, stableLevel, denseSummary[13], false);
  const mapped = optimizedSummary[stableLevel];
  const legacyDotsMappingMs = measure(() => mapDotsWeatherSummary(denseSummary[stableLevel]));
  const legacySquaresMappingMs = measure(() => mapSquaresWeatherSummary(denseSummary[stableLevel]));
  const legacyDotsInstanceMs = measure(() => buildDotsInstances(legacyPyramid, stableLevel, mapDotsWeatherSummary(denseSummary[stableLevel])));
  const legacySquaresInstanceMs = measure(() => buildSquaresInstances(legacyPyramid, stableLevel, mapSquaresWeatherSummary(denseSummary[stableLevel])));
  const dotsMappingMs = measure(() => mapDotsWeatherSummary(optimizedSummary[stableLevel], mapped));
  const squaresMappingMs = measure(() => mapSquaresWeatherSummary(optimizedSummary[stableLevel]));
  const dotsInstanceMs = measure(() => buildDotsInstances(pyramid, stableLevel, mapDotsWeatherSummary(optimizedSummary[stableLevel])));
  const squaresInstanceMs = measure(() => buildSquaresInstances(pyramid, stableLevel, mapSquaresWeatherSummary(optimizedSummary[stableLevel])));
  const totalSamples = [...pyramid.levels.values()].reduce((sum, levelData) => sum + levelData.samples.length, 0);
  const summaryBytes = totalSamples * pyramid.summaryMemoryBytesPerSample();
  const activeCount = geometry.potentialActiveIndices?.length ?? geometry.baseIndex.length;
  const activeIndexBytes = Object.values(optimizedSummary).filter(Boolean).reduce((sum, summary) => sum + (summary.potentialActiveIndices?.byteLength || 0), 0);
  console.log(`L${stableLevel}: topology=${[...pyramid.levels.values()].map((levelData) => `L${levelData.level}:${levelData.samples.length}`).join(',')}`);
  console.log(`L${stableLevel}: L13 direct samples dense=${pyramid.samplesFor(13).length} optimized=${activeCount}`);
  console.log(`L${stableLevel}: L13 direct ms dense=${directDenseMs.toFixed(3)} sparse-uncached=${sparseUncachedDirectMs.toFixed(3)} optimized=${directOptimizedMs.toFixed(3)}; aggregation ms dense=${aggregateDenseMs.toFixed(3)} optimized=${aggregateOptimizedMs.toFixed(3)}; total keyframe ms dense=${legacyResult.keyframeMs.toFixed(3)} sparse-uncached=${sparseUncached.keyframeMs.toFixed(3)} optimized=${optimized.keyframeMs.toFixed(3)}`);
  console.log(`L${stableLevel}: Dots mapping ms dense=${legacyDotsMappingMs.toFixed(3)} optimized=${dotsMappingMs.toFixed(3)}; instances dense=${legacyDotsInstanceMs.toFixed(3)} optimized=${dotsInstanceMs.toFixed(3)}; Squares mapping ms dense=${legacySquaresMappingMs.toFixed(3)} optimized=${squaresMappingMs.toFixed(3)}; instances dense=${legacySquaresInstanceMs.toFixed(3)} optimized=${squaresInstanceMs.toFixed(3)}`);
  console.log(`L${stableLevel}: reusable summary arrays=${mib(summaryBytes)} active-index list=${mib(activeIndexBytes)} source union mask=${mib(weather.potentialWeatherMask?.byteLength || 0)} Dots/Squares mapped=${mib(pyramid.samplesFor(stableLevel).length * (4 + 8) * Float32Array.BYTES_PER_ELEMENT)}`);
  if (stableLevel === 10) console.log(`L${stableLevel}: dense-vs-optimized sample check=${denseSummary[stableLevel].rainWeightedSumMmh[0] === optimizedSummary[stableLevel].rainWeightedSumMmh[0]}`);
}
