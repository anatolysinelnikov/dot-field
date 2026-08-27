import fs from 'node:fs';
import { performance } from 'node:perf_hooks';
import { GeographicDotsLayer, mapDotsWeatherSummary } from '../src/engine/geographic-dots-layer.js';
import { GeographicSquaresLayer, mapSquaresWeatherSummary } from '../src/engine/geographic-squares-layer.js';
import {
  canonicalWindowFromMercatorBounds,
  canonicalWindowContains,
  GeographicLodTopology,
  MAX_GRID_LEVEL,
  MIN_GRID_LEVEL,
  lngLatToMercator,
  mercatorXForIndex,
  mercatorYForIndex,
  normalizeCanonicalWindow,
  lodRangeForStableLevel
} from '../src/engine/geographic-lod.js';
import {
  buildCenteredContributions,
  GeographicWeatherPyramid,
  resetAggregationRelationCache,
  aggregationRelationCacheStats
} from '../src/engine/geographic-weather-pyramid.js';
import { prepareGeographicFieldFrame, setActiveWeatherField, WEATHER_REGION } from '../src/engine/geography.js';
import { RealWeatherSequence } from '../src/engine/real-weather.js';

const TEMPORAL_FRAME_COUNT = 180;
const STABLE_LEVELS = [10, 11, 12, 13, 14];
const REPEATS = Number(process.env.PAN_BENCHMARK_REPEATS || 3);
const L10_STEP = 2 ** (MAX_GRID_LEVEL - MIN_GRID_LEVEL);
const now = () => performance.now();

const metadata = JSON.parse(fs.readFileSync(new URL('../data/generated/202608262200/metadata.json', import.meta.url), 'utf8'));
const binary = fs.readFileSync(new URL('../data/generated/202608262200/rain.f32', import.meta.url));
const { width, height, longitude_start: longitudeStart, latitude_start: latitudeStart, longitude_spacing: longitudeSpacing, latitude_spacing: latitudeSpacing } = metadata.spatial_grid;
const { count: frameCount, timestamps } = metadata.time;
const weather = new RealWeatherSequence({
  longitudes: Float64Array.from({ length: width }, (_, index) => longitudeStart + index * longitudeSpacing),
  latitudes: Float64Array.from({ length: height }, (_, index) => latitudeStart + index * latitudeSpacing),
  rainFramesMmh: new Float32Array(binary.buffer, binary.byteOffset, binary.byteLength / Float32Array.BYTES_PER_ELEMENT),
  frameCount,
  longitudeSpacing,
  latitudeSpacing,
  timestamps
});
setActiveWeatherField(weather);

const [centerX, centerY] = lngLatToMercator(...WEATHER_REGION.center);
const baseWindow = canonicalWindowFromMercatorBounds({
  minX: centerX - 0.004, maxX: centerX + 0.004,
  minY: centerY - 0.004, maxY: centerY + 0.004
});

function windowsForPan(window, direction) {
  const offsets = direction === 'horizontal'
    ? [[1, 0], [2, 0], [-1, 0], [-2, 0], [1, 0], [0, 0]]
    : direction === 'vertical'
      ? [[0, 1], [0, 2], [0, -1], [0, -2], [0, 1], [0, 0]]
      : [[1, 1], [2, 2], [-1, -1], [-2, -2], [1, 1], [0, 0]];
  return offsets.map(([x, y]) => normalizeCanonicalWindow({
    minX: window.minX + x * L10_STEP, maxX: window.maxX + x * L10_STEP,
    minY: window.minY + y * L10_STEP, maxY: window.maxY + y * L10_STEP
  }));
}

function rebuildFrequency(direction) {
  const samples = 96;
  const delta = 0.2 * L10_STEP / 2 ** MAX_GRID_LEVEL;
  // Keep the synthetic camera path in an interior weather window so the
  // frequency result measures pan hysteresis rather than support clamping.
  const frequencyCenterY = centerY - 0.021;
  let previous = null;
  let retained = null;
  let baselineRebuilds = 0;
  let optimizedRebuilds = 0;
  for (let sample = 0; sample <= samples; sample++) {
    const offset = (sample - samples / 2) * delta;
    const xOffset = direction === 'vertical' ? 0 : offset;
    const yOffset = direction === 'horizontal' ? 0 : offset;
    const candidate = canonicalWindowFromMercatorBounds({
      minX: centerX - 0.004 + xOffset, maxX: centerX + 0.004 + xOffset,
      minY: frequencyCenterY - 0.002 + yOffset, maxY: frequencyCenterY + 0.002 + yOffset
    });
    if (!previous || JSON.stringify(candidate) !== JSON.stringify(previous)) baselineRebuilds++;
    if (!retained || !canonicalWindowContains(retained, candidate)) {
      optimizedRebuilds++;
      retained = candidate;
    }
    previous = candidate;
  }
  return { cameraSamples: samples + 1, baselineRebuilds, optimizedRebuilds };
}

function installDenseGeometryFallback(pyramid) {
  pyramid.prepareSamplingGeometry = (level, frame) => {
    const existing = pyramid.samplingGeometries.get(level);
    if (existing && frame.isSamplingGeometryCompatible(existing)) return existing;
    const levelData = pyramid.levelDataFor(level);
    const longitudes = new Float64Array(levelData.count);
    const latitudes = new Float64Array(levelData.count);
    for (let index = 0; index < levelData.count; index++) {
      longitudes[index] = mercatorXForIndex(levelData, index) * 360 - 180;
      const mercatorY = mercatorYForIndex(levelData, index);
      latitudes[index] = Math.atan(Math.sinh(Math.PI * (1 - 2 * mercatorY))) * 180 / Math.PI;
    }
    // Reproduce the pre-optimization provider path: dense coordinates, one
    // source lookup per sample, then a separate sequence-wide active scan.
    const mask = weather.potentialWeatherMask;
    weather.potentialWeatherMask = null;
    const geometry = frame.prepareSamplingGeometry(longitudes, latitudes);
    weather.potentialWeatherMask = mask;
    const activeIndices = [];
    for (let index = 0; index < geometry.baseIndex.length; index++) {
      const baseIndex = geometry.baseIndex[index];
      if (baseIndex === 0xffffffff) continue;
      const x1y0 = baseIndex + 1;
      const x0y1 = baseIndex + geometry.sourceWidth;
      const x1y1 = x0y1 + 1;
      if (mask[baseIndex] || mask[x1y0] || mask[x0y1] || mask[x1y1]) activeIndices.push(index);
    }
    geometry.potentialActiveIndices = Uint32Array.from(activeIndices);
    geometry.potentialWeatherMask = mask;
    geometry.spatialRainCache = new Map();
    pyramid.samplingGeometries.set(level, geometry);
    return geometry;
  };
}

function installDenseAggregationReference(pyramid) {
  const range = pyramid.topology.levelRange;
  const relationStarted = now();
  const centeredRelations = new Map();
  for (let level = range.minLevel + 1; level <= Math.min(13, range.maxLevel); level++) {
    centeredRelations.set(level, buildCenteredContributions(pyramid.levels.get(level), pyramid.levels.get(level - 1)));
  }
  const relationMs = now() - relationStarted;
  const totalWeightsStarted = now();
  const totalWeights = new Map();
  if (pyramid.levels.has(13)) {
    const referenceWeights = new Float32Array(pyramid.levels.get(13).count);
    referenceWeights.fill(1);
    totalWeights.set(13, referenceWeights);
    for (let level = 12; level >= range.minLevel; level--) {
      const childWeights = totalWeights.get(level + 1);
      const relation = centeredRelations.get(level + 1);
      if (!childWeights || !relation || !pyramid.levels.has(level)) continue;
      const weights = new Float32Array(pyramid.levels.get(level).count);
      for (let childIndex = 0; childIndex < childWeights.length; childIndex++) {
        const start = relation.offsets[childIndex];
        const end = relation.offsets[childIndex + 1];
        for (let contributionIndex = start; contributionIndex < end; contributionIndex++) {
          weights[relation.parentIndices[contributionIndex]] += relation.weights[contributionIndex] * childWeights[childIndex];
        }
      }
      totalWeights.set(level, weights);
    }
  }
  pyramid.centeredRelations = centeredRelations;
  pyramid.totalWeights = totalWeights;
  pyramid.topologySetupTimings = {
    relationMs,
    totalWeightsMs: now() - totalWeightsStarted,
    totalMs: now() - relationStarted,
    relationHits: 0,
    totalWeightHits: 0
  };
}

function median(values) {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)];
}

function percentile(values, fraction) {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor((sorted.length - 1) * fraction))];
}

function sampleSummary(pyramid, level, frame) {
  return pyramid.evaluate([level], frame)[level];
}

function instancePackingMs(pyramid, level, frames, renderer) {
  const mapped0 = renderer === 'dots' ? mapDotsWeatherSummary(frames[0]) : mapSquaresWeatherSummary(frames[0]);
  const mapped1 = renderer === 'dots' ? mapDotsWeatherSummary(frames[1]) : mapSquaresWeatherSummary(frames[1]);
  const layer = renderer === 'dots' ? new GeographicDotsLayer(pyramid) : new GeographicSquaresLayer(pyramid);
  layer.active = true;
  layer.levelData = pyramid.levelDataFor(level);
  layer.temporal = { levels: new Map([[level, {
    frames0: { mapped: { [level]: mapped0 } },
    frames1: { mapped: { [level]: mapped1 } }
  }]]) };
  const started = now();
  layer.rebuildInstances();
  return now() - started;
}

function phaseBreakdown(window, stableLevel, reuse, dense) {
  const range = lodRangeForStableLevel(stableLevel);
  const topology = new GeographicLodTopology(window, range);
  const pyramid = new GeographicWeatherPyramid(Float32Array, topology, { reuse });
  if (dense) {
    installDenseAggregationReference(pyramid);
    installDenseGeometryFallback(pyramid);
  }
  pyramid.samplingGeometries.clear();
  const referenceLevel = stableLevel <= 13 ? 13 : stableLevel;
  const frame0 = weather.prepareFrame(62 / TEMPORAL_FRAME_COUNT);
  const frame1 = weather.prepareFrame(63 / TEMPORAL_FRAME_COUNT);
  const geometryStarted = now();
  const geometry = pyramid.prepareSamplingGeometry(referenceLevel, frame0);
  const providerSamplingGeometryMs = now() - geometryStarted;
  geometry.spatialRainCache?.clear();
  const sourceStarted = now();
  if (typeof frame0.preparedSourceFrame === 'function') {
    frame0.preparedSourceFrame(geometry, frame0.frame0);
    frame0.preparedSourceFrame(geometry, frame0.frame1);
  }
  const sourceFrameCacheMs = now() - sourceStarted;
  const firstStarted = now();
  const first = sampleSummary(pyramid, stableLevel, frame0);
  const firstWeatherKeyframeMs = now() - firstStarted;
  const secondStarted = now();
  const second = sampleSummary(pyramid, stableLevel, frame1);
  const secondWeatherKeyframeMs = now() - secondStarted;
  const dotsMappingStarted = now();
  const dots0 = mapDotsWeatherSummary(first);
  const dots1 = mapDotsWeatherSummary(second);
  const dotsMappingMs = now() - dotsMappingStarted;
  const squaresMappingStarted = now();
  const squares0 = mapSquaresWeatherSummary(first);
  const squares1 = mapSquaresWeatherSummary(second);
  const squaresMappingMs = now() - squaresMappingStarted;
  const dotsInstanceStarted = now();
  const dotsInstanceMs = instancePackingMs(pyramid, stableLevel, [first, second], 'dots');
  const measuredDotsInstanceMs = now() - dotsInstanceStarted;
  const squaresInstanceStarted = now();
  const squaresInstanceMs = instancePackingMs(pyramid, stableLevel, [first, second], 'squares');
  const measuredSquaresInstanceMs = now() - squaresInstanceStarted;
  void dots0; void dots1; void squares0; void squares1; void dotsInstanceMs; void squaresInstanceMs;
  return {
    topologyConstructionMs: topology.constructionTimings.totalMs,
    relationSetupMs: pyramid.topologySetupTimings.relationMs,
    totalWeightMs: pyramid.topologySetupTimings.totalWeightsMs,
    setTopologyMs: pyramid.topologySetupTimings.totalMs,
    providerSamplingGeometryMs,
    sourceFrameCacheMs,
    firstWeatherKeyframeMs,
    secondWeatherKeyframeMs,
    dotsMappingMs,
    squaresMappingMs,
    dotsInstanceMs: measuredDotsInstanceMs,
    squaresInstanceMs: measuredSquaresInstanceMs,
    sampleCount: pyramid.levelDataFor(stableLevel).count,
    activeSampleCount: geometry.potentialActiveIndices?.length ?? geometry.baseIndex.length,
    cache: aggregationRelationCacheStats()
  };
}

function replacementMs(window, nextWindow, stableLevel, reuse, dense, renderer) {
  const range = lodRangeForStableLevel(stableLevel);
  const initialPyramid = new GeographicWeatherPyramid(Float32Array, new GeographicLodTopology(window, range), { reuse });
  if (dense) {
    installDenseAggregationReference(initialPyramid);
    installDenseGeometryFallback(initialPyramid);
  }
  const layer = renderer === 'dots' ? new GeographicDotsLayer(initialPyramid) : new GeographicSquaresLayer(initialPyramid);
  layer.setActive(true);
  layer.setLevelData(initialPyramid.levelDataFor(stableLevel), 62 / TEMPORAL_FRAME_COUNT);
  const started = now();
  const topology = new GeographicLodTopology(nextWindow, range);
  initialPyramid.setTopology(topology, { reuse });
  if (dense) installDenseAggregationReference(initialPyramid);
  layer.setTopology(topology);
  layer.setLevelData(initialPyramid.levelDataFor(stableLevel), 62 / TEMPORAL_FRAME_COUNT);
  return {
    totalMs: now() - started,
    topologyConstructionMs: topology.constructionTimings.totalMs,
    setTopologyMs: initialPyramid.topologySetupTimings.totalMs,
    cache: aggregationRelationCacheStats()
  };
}

function runCase(stableLevel, direction, reuse) {
  const dense = !reuse;
  const windows = windowsForPan(baseWindow, direction);
  const phaseSamples = [];
  const dotsSamples = [];
  const squaresSamples = [];
  for (let repeat = 0; repeat < REPEATS; repeat++) {
    resetAggregationRelationCache();
    // Baseline measures an uncached replacement. Optimized phase timings use
    // the second construction after the initial window has populated the
    // bounded structural plans, matching an adjacent production pan.
    phaseBreakdown(windows[0], stableLevel, reuse, dense);
    phaseSamples.push(phaseBreakdown(windows[0], stableLevel, reuse, dense));
    for (let index = 1; index < windows.length; index++) {
      dotsSamples.push(replacementMs(windows[index - 1], windows[index], stableLevel, reuse, dense, 'dots'));
      squaresSamples.push(replacementMs(windows[index - 1], windows[index], stableLevel, reuse, dense, 'squares'));
    }
  }
  const summarize = (samples, key) => {
    const values = samples.map((sample) => sample[key]);
    return { median: median(values), p95: percentile(values, 0.95), max: Math.max(...values) };
  };
  const phaseKeys = ['topologyConstructionMs', 'relationSetupMs', 'totalWeightMs', 'setTopologyMs', 'providerSamplingGeometryMs', 'sourceFrameCacheMs', 'firstWeatherKeyframeMs', 'secondWeatherKeyframeMs', 'dotsMappingMs', 'squaresMappingMs', 'dotsInstanceMs', 'squaresInstanceMs'];
  const phase = Object.fromEntries(phaseKeys.map((key) => [key, summarize(phaseSamples, key)]));
  const replacement = {
    dots: summarize(dotsSamples, 'totalMs'),
    squares: summarize(squaresSamples, 'totalMs'),
    dotsTopology: summarize(dotsSamples, 'topologyConstructionMs'),
    squaresTopology: summarize(squaresSamples, 'setTopologyMs')
  };
  return { stableLevel, direction, mode: reuse ? 'optimized' : 'baseline', phase, replacement, sampleCount: phaseSamples[0].sampleCount, activeSampleCount: phaseSamples[0].activeSampleCount };
}

const results = [];
for (const stableLevel of STABLE_LEVELS) {
  for (const direction of ['horizontal', 'vertical', 'diagonal']) {
    results.push(runCase(stableLevel, direction, false));
    results.push(runCase(stableLevel, direction, true));
  }
}

console.log(JSON.stringify({
  metadata: { node: process.version, repeats: REPEATS, baseWindow, l10Step: L10_STEP, fixture: '202608262200' },
  rebuildFrequency: Object.fromEntries(['horizontal', 'vertical', 'diagonal'].map((direction) => [direction, rebuildFrequency(direction)])),
  results
}, null, 2));
