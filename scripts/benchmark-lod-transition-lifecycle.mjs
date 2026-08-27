import fs from 'node:fs';
import { setActiveWeatherField, WEATHER_REGION } from '../src/engine/geography.js';
import { RealWeatherSequence } from '../src/engine/real-weather.js';
import {
  canonicalWindowFromMercatorBounds,
  GeographicLodTopology,
  lngLatToMercator,
  lodRangeForStableLevel
} from '../src/engine/geographic-lod.js';
import { GeographicWeatherPyramid } from '../src/engine/geographic-weather-pyramid.js';
import { GeographicDotsLayer } from '../src/engine/geographic-dots-layer.js';
import { GeographicSquaresLayer } from '../src/engine/geographic-squares-layer.js';

const now = () => globalThis.performance?.now?.() ?? Date.now();
const repeats = Number.parseInt(process.argv.find((value) => value.startsWith('--repeats='))?.split('=')[1] || '3', 10);
const playing = process.argv.includes('--playing');
// Benchmark the active product lifecycle. Explicit L15 engine coverage remains
// available in the canonical weather/topology verifiers.
const levels = [10, 11, 12, 13, 14];
const pairCases = levels.slice(0, -1).flatMap((level) => [[level, level + 1], [level + 1, level]]);

function loadSequence() {
  const dataRoot = new URL('../data/generated/202608262200/', import.meta.url);
  const metadata = JSON.parse(fs.readFileSync(new URL('metadata.json', dataRoot), 'utf8'));
  const binary = fs.readFileSync(new URL('rain.f32', dataRoot));
  const grid = metadata.spatial_grid;
  const longitudes = Float64Array.from({ length: grid.width }, (_, index) => grid.longitude_start + index * grid.longitude_spacing);
  const latitudes = Float64Array.from({ length: grid.height }, (_, index) => grid.latitude_start + index * grid.latitude_spacing);
  return new RealWeatherSequence({
    longitudes, latitudes,
    rainFramesMmh: new Float32Array(binary.buffer, binary.byteOffset, binary.byteLength / Float32Array.BYTES_PER_ELEMENT),
    frameCount: metadata.time.count,
    longitudeSpacing: grid.longitude_spacing,
    latitudeSpacing: grid.latitude_spacing,
    timestamps: metadata.time.timestamps
  });
}

function median(values) {
  const sorted = [...values].sort((left, right) => left - right);
  return sorted.length % 2 ? sorted[sorted.length >> 1] : (sorted[(sorted.length >> 1) - 1] + sorted[sorted.length >> 1]) / 2;
}

function percentile(values, fraction) {
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.min(sorted.length - 1, Math.floor((sorted.length - 1) * fraction))];
}

function phase(started) {
  return now() - started;
}

function delta(current, previous) {
  return current - previous;
}

function resetDiagnostics(layer, pyramid) {
  for (const key of Object.keys(layer.lifecycleDiagnostics)) layer.lifecycleDiagnostics[key] = 0;
  pyramid.diagnostics.samplingGeometryPreparations = 0;
  pyramid.diagnostics.evaluateCalls = 0;
}

function runCase(sequence, window, fromLevel, toLevel, Layer, optimized) {
  const fromRange = lodRangeForStableLevel(fromLevel);
  const toRange = lodRangeForStableLevel(toLevel);
  const initialTopology = new GeographicLodTopology(window, fromRange);
  const pyramid = new GeographicWeatherPyramid(Float32Array, initialTopology);
  const layer = new Layer(pyramid);
  layer.setActive(true);
  const time = 0.37;
  layer.setLevelData(initialTopology.levelDataFor(fromLevel), time);
  resetDiagnostics(layer, pyramid);

  const evaluationRecords = [];
  const originalEvaluateKeyframe = layer.evaluateKeyframe.bind(layer);
  layer.evaluateKeyframe = (level, index, reusable) => {
    const started = now();
    const result = originalEvaluateKeyframe(level, index, reusable);
    evaluationRecords.push({ level, index, ms: now() - started });
    return result;
  };
  const geometryRecords = [];
  const originalPrepareSamplingGeometry = pyramid.prepareSamplingGeometry.bind(pyramid);
  pyramid.prepareSamplingGeometry = (level, frame) => {
    const previous = pyramid.samplingGeometries.get(level);
    const result = originalPrepareSamplingGeometry(level, frame);
    if (result !== previous) geometryRecords.push(level);
    return result;
  };

  if (playing) layer.updateWeather(time + 0.006);
  resetDiagnostics(layer, pyramid);
  evaluationRecords.length = 0;
  geometryRecords.length = 0;

  const startDiagnostics = { ...layer.lifecycleDiagnostics };
  const startPyramidDiagnostics = { ...pyramid.diagnostics };
  const startStarted = now();
  layer.setTransition(initialTopology.levelDataFor(fromLevel), initialTopology.levelDataFor(toLevel), time, 0);
  const transitionStartMs = phase(startStarted);
  const startEvalCount = delta(layer.lifecycleDiagnostics.evaluateKeyframeCalls, startDiagnostics.evaluateKeyframeCalls);
  const startJointEvalCount = delta(layer.lifecycleDiagnostics.evaluateTransitionKeyframeCalls, startDiagnostics.evaluateTransitionKeyframeCalls);
  const startPyramidEvalCount = delta(pyramid.diagnostics.evaluateCalls, startPyramidDiagnostics.evaluateCalls);
  const startWeatherEvaluationMs = delta(layer.lifecycleDiagnostics.weatherEvaluationMs, startDiagnostics.weatherEvaluationMs);
  const startMappingMs = delta(layer.lifecycleDiagnostics.mappingMs, startDiagnostics.mappingMs);
  const startGeometryCount = delta(pyramid.diagnostics.samplingGeometryPreparations, startPyramidDiagnostics.samplingGeometryPreparations);
  const startEvaluationRecords = evaluationRecords.slice();
  const startInstanceMs = delta(layer.lifecycleDiagnostics.instanceRebuildMs, startDiagnostics.instanceRebuildMs);

  const morphTimings = [];
  for (let index = 1; index <= 30; index++) {
    const started = now();
    layer.setTransitionProgress(index / 30);
    morphTimings.push(phase(started));
  }

  const completionStarted = now();
  layer.setLevelData(initialTopology.levelDataFor(toLevel), time);
  const transitionCompletionMs = phase(completionStarted);
  const afterPromotionEvalCount = layer.lifecycleDiagnostics.evaluateKeyframeCalls;

  const rangeChanged = fromRange.minLevel !== toRange.minLevel || fromRange.maxLevel !== toRange.maxLevel;
  let stableTopologyConstructionMs = 0;
  let stablePyramidReplacementMs = 0;
  let stableRendererReplacementMs = 0;
  let stableInstanceReconstructionMs = 0;
  let replacementWeatherEvaluationCount = 0;
  let replacementGeometryCount = 0;
  let replacementTopology;
  if (rangeChanged) {
    const topologyStarted = now();
    replacementTopology = optimized
      ? new GeographicLodTopology(window, toRange, pyramid.topology)
      : new GeographicLodTopology(window, toRange);
    stableTopologyConstructionMs = phase(topologyStarted);
    const beforePyramid = { ...pyramid.diagnostics };
    const beforeReplacementLayer = { ...layer.lifecycleDiagnostics };
    const pyramidStarted = now();
    pyramid.setTopology(replacementTopology, { preserveCompatibleState: optimized });
    stablePyramidReplacementMs = phase(pyramidStarted);
    const beforeRenderer = { ...layer.lifecycleDiagnostics };
    const rendererStarted = now();
    layer.setTopology(replacementTopology, { preserveCompatibleState: optimized });
    stableRendererReplacementMs = phase(rendererStarted);
    const beforeStable = { ...layer.lifecycleDiagnostics };
    const stableStarted = now();
    layer.setLevelData(replacementTopology.levelDataFor(toLevel), time);
    stableInstanceReconstructionMs = phase(stableStarted);
    replacementWeatherEvaluationCount = delta(layer.lifecycleDiagnostics.evaluateKeyframeCalls, beforeReplacementLayer.evaluateKeyframeCalls);
    replacementGeometryCount = delta(pyramid.diagnostics.samplingGeometryPreparations, beforePyramid.samplingGeometryPreparations);
    // Keep these reads explicit: they make the benchmark fail loudly if a
    // renderer changes the replacement lifecycle without accounting for it.
    void beforeRenderer;
    void beforeStable;
  }

  return {
    fromLevel, toLevel, renderer: Layer === GeographicDotsLayer ? 'Dots' : 'Squares', optimized,
    playing, rangeChanged,
    transitionStartMs,
    destinationGeometryPreparations: startGeometryCount,
    destinationGeometryLevels: geometryRecords.slice(),
    destinationFrame0: startEvaluationRecords.find((record) => record.index === Math.floor(time * 180))?.ms ?? 0,
    destinationFrame1: startEvaluationRecords.find((record) => record.index === Math.min(180, Math.floor(time * 180) + 1))?.ms ?? 0,
    destinationEvaluationCalls: startEvalCount,
    destinationJointEvaluationCalls: startJointEvalCount,
    destinationPyramidEvaluationCalls: startPyramidEvalCount,
    transitionWeatherEvaluationMs: startWeatherEvaluationMs,
    transitionMappingMs: startMappingMs,
    transitionInstancePreparationMs: startInstanceMs,
    morphFrameMedianMs: median(morphTimings),
    morphFrameP95Ms: percentile(morphTimings, 0.95),
    morphFrameMaxMs: Math.max(...morphTimings),
    transitionCompletionMs,
    stableTopologyConstructionMs,
    stablePyramidReplacementMs,
    stableRendererReplacementMs,
    replacementWeatherEvaluationCount,
    replacementGeometryPreparations: replacementGeometryCount,
    stableInstanceReconstructionMs,
    totalTransitionLifecycleMs: transitionStartMs + transitionCompletionMs + stableTopologyConstructionMs + stablePyramidReplacementMs + stableRendererReplacementMs + stableInstanceReconstructionMs,
    topologyLevelsCreated: replacementTopology?.constructionTimings.levelsCreated ?? 0,
    topologyLevelsReused: replacementTopology?.constructionTimings.levelsReused ?? 0,
    transitionParentsCreated: replacementTopology?.constructionTimings.transitionParentsCreated ?? 0,
    transitionParentsReused: replacementTopology?.constructionTimings.transitionParentsReused ?? 0,
    directTransitionRelationsCreated: replacementTopology?.constructionTimings.directTransitionRelationsCreated ?? 0,
    directTransitionRelationsReused: replacementTopology?.constructionTimings.directTransitionRelationsReused ?? 0,
    directTransitionRelationConstructionMs: replacementTopology?.constructionTimings.directTransitionRelationMs ?? 0,
    totalEvaluationCalls: layer.lifecycleDiagnostics.evaluateKeyframeCalls,
    totalSamplingGeometryPreparations: pyramid.diagnostics.samplingGeometryPreparations,
    stableRangeWeatherEvaluationCount: replacementWeatherEvaluationCount,
    stableRangeGeometryPreparations: replacementGeometryCount
  };
}

const sequence = loadSequence();
setActiveWeatherField(sequence);
const [centerX, centerY] = lngLatToMercator(...WEATHER_REGION.center);
const window = canonicalWindowFromMercatorBounds({ minX: centerX - 0.004, maxX: centerX + 0.004, minY: centerY - 0.004, maxY: centerY + 0.004 });
const rows = [];
for (const Layer of [GeographicDotsLayer, GeographicSquaresLayer]) {
  for (const [fromLevel, toLevel] of pairCases) {
    for (const optimized of [false, true]) {
      const samples = [];
      for (let repeat = 0; repeat < repeats; repeat++) samples.push(runCase(sequence, window, fromLevel, toLevel, Layer, optimized));
      const numericKeys = Object.keys(samples[0]).filter((key) => typeof samples[0][key] === 'number');
      const aggregate = Object.fromEntries(numericKeys.map((key) => [key, {
        median: median(samples.map((sample) => sample[key])),
        p95: percentile(samples.map((sample) => sample[key]), 0.95),
        max: Math.max(...samples.map((sample) => sample[key]))
      }]));
      rows.push({ ...samples[0], samples, aggregate });
    }
  }
}

console.log(JSON.stringify({
  benchmark: 'lod-transition-lifecycle',
  baseline: 'legacy topology replacement and renderer reset',
  optimized: 'overlapping levelData, relation, sampling geometry, temporal and instance reuse',
  repeats, playing, window, rows
}, null, 2));
