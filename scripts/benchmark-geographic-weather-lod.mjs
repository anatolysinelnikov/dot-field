import fs from 'node:fs';
import { performance } from 'node:perf_hooks';
import { prepareGeographicFieldFrame, setActiveWeatherField } from '../src/engine/geography.js';
import { parseRealWeatherCsv } from '../src/engine/real-weather.js';
import { GeographicLodTopology, selectMercatorGridSamples } from '../src/engine/geographic-lod.js';
import { evaluateDirectWeatherSummary, GeographicWeatherPyramid } from '../src/engine/geographic-weather-pyramid.js';
import { GeographicDotsLayer } from '../src/engine/geographic-dots-layer.js';
import { GeographicSquaresLayer } from '../src/engine/geographic-squares-layer.js';

const FRAME_TIME = 0.347;
const TRANSITIONS = [[13, 14], [14, 15]];
const weather = parseRealWeatherCsv(fs.readFileSync(new URL('../data/mrl_z3_t+40min_376x239.csv', import.meta.url), 'utf8'));
setActiveWeatherField(weather);

function median(values) {
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.floor(sorted.length / 2)];
}

function benchmarkDirectLevel(level) {
  const pyramid = new GeographicWeatherPyramid(Float32Array, new GeographicLodTopology(undefined, { minLevel: 13, maxLevel: 15 }));
  const levelData = pyramid.levels.get(level);
  const frame = prepareGeographicFieldFrame(0.347);
  const started = performance.now();
  const geometry = pyramid.prepareSamplingGeometry(level, frame);
  const stencilPreparationMs = performance.now() - started;
  const stencilBytes = frame.samplingGeometryBytes(geometry);
  let normalSummary = evaluateDirectWeatherSummary(levelData, frame, null, Float64Array);
  let preparedSummary = evaluateDirectWeatherSummary(levelData, frame, null, Float64Array, geometry);
  const normalTimes = [];
  const preparedTimes = [];
  for (let run = 0; run < 3; run++) {
    let time = performance.now();
    normalSummary = evaluateDirectWeatherSummary(levelData, frame, normalSummary, Float64Array);
    normalTimes.push(performance.now() - time);
    time = performance.now();
    preparedSummary = evaluateDirectWeatherSummary(levelData, frame, preparedSummary, Float64Array, geometry);
    preparedTimes.push(performance.now() - time);
  }
  return {
    level,
    samples: levelData.samples.length,
    stencilPreparationMs,
    stencilBytes,
    normalMs: median(normalTimes),
    preparedMs: median(preparedTimes),
    speedup: median(normalTimes) / median(preparedTimes),
    normalSummary,
    preparedSummary
  };
}

console.log('Direct physical sampling benchmark (median of 3 warmed runs; Float64 summaries)');
for (const level of [13, 14, 15]) {
  const result = benchmarkDirectLevel(level);
  console.log(`L${level}: samples=${result.samples} normal=${result.normalMs.toFixed(3)}ms prepared=${result.preparedMs.toFixed(3)}ms speedup=${result.speedup.toFixed(2)}x stencilPrep=${result.stencilPreparationMs.toFixed(3)}ms stencilBytes=${result.stencilBytes}`);
}

function metricLayer(Layer, fromLevel, toLevel) {
  const pyramid = new GeographicWeatherPyramid(Float32Array, new GeographicLodTopology(undefined, { minLevel: 13, maxLevel: 15 }));
  const layer = new Layer(pyramid);
  layer.setActive(true);
  const fromSamples = selectMercatorGridSamples(fromLevel).samples;
  const toSamples = selectMercatorGridSamples(toLevel).samples;
  const metrics = {
    evaluations: 0,
    physicalSamples: 0,
    physicalMs: 0,
    stencilPreparationMs: 0,
    keyframes: 0,
    keyframeMs: 0,
    mappedSamples: 0,
    instanceBuilds: 0,
    instanceBytes: 0,
    packingBytes: 0,
    gpuUploadBytes: 0,
    gpuAllocationBytes: 0
  };

  const evaluate = pyramid.evaluate.bind(pyramid);
  pyramid.evaluate = (...args) => {
    const started = performance.now();
    const result = evaluate(...args);
    metrics.evaluations++;
    metrics.physicalMs += performance.now() - started;
    for (const level of new Set(args[0])) metrics.physicalSamples += pyramid.samplesFor(level).length;
    return result;
  };
  const prepareSamplingGeometry = pyramid.prepareSamplingGeometry.bind(pyramid);
  pyramid.prepareSamplingGeometry = (level, frame) => {
    const previous = pyramid.samplingGeometries.get(level);
    const started = performance.now();
    const result = prepareSamplingGeometry(level, frame);
    if (result !== previous) metrics.stencilPreparationMs += performance.now() - started;
    return result;
  };
  const evaluateKeyframe = layer.evaluateKeyframe.bind(layer);
  layer.evaluateKeyframe = (...args) => {
    const started = performance.now();
    const result = evaluateKeyframe(...args);
    metrics.keyframes++;
    metrics.keyframeMs += performance.now() - started;
    metrics.mappedSamples += pyramid.samplesFor(args[0]).length;
    return result;
  };
  if (Layer === GeographicSquaresLayer) {
    const buildGroup = layer.buildGroup.bind(layer);
    layer.buildGroup = (...args) => {
      metrics.packingBytes += pyramid.samplesFor(args[1]).length * 18 * Float32Array.BYTES_PER_ELEMENT;
      return buildGroup(...args);
    };
  }
  const rebuildInstances = layer.rebuildInstances.bind(layer);
  layer.rebuildInstances = (...args) => {
    const result = rebuildInstances(...args);
    metrics.instanceBuilds++;
    if (layer instanceof GeographicDotsLayer) {
      metrics.instanceBytes += Object.values(layer.instances).reduce((sum, values) => sum + values.byteLength, 0);
    } else {
      metrics.instanceBytes += layer.instanceCounts.reduce((sum, count) => sum + count * 18 * Float32Array.BYTES_PER_ELEMENT, 0);
    }
    return result;
  };

  layer.setSamples(fromSamples, FRAME_TIME);
  layer.instanceBuffers = Layer === GeographicSquaresLayer ? [{}, {}] : { rain: {}, strong: {}, storm: {}, hail: {} };
  layer.uploadBuffers({
    ARRAY_BUFFER: 1,
    STREAM_DRAW: 2,
    DYNAMIC_DRAW: 3,
    bindBuffer() {},
    bufferData() {},
    bufferSubData() {}
  });
  metrics.evaluations = 0;
  metrics.physicalSamples = 0;
  metrics.physicalMs = 0;
  metrics.stencilPreparationMs = 0;
  metrics.keyframes = 0;
  metrics.keyframeMs = 0;
  metrics.mappedSamples = 0;
  metrics.instanceBuilds = 0;
  metrics.instanceBytes = 0;
  metrics.packingBytes = 0;
  metrics.gpuUploadBytes = 0;
  metrics.gpuAllocationBytes = 0;
  const startTime = performance.now();
  layer.setTransition(fromSamples, toSamples, FRAME_TIME, 0);
  const startMs = performance.now() - startTime;
  layer.uploadBuffers({
    ARRAY_BUFFER: 1,
    STREAM_DRAW: 2,
    DYNAMIC_DRAW: 3,
    bindBuffer() {},
    bufferData(_target, bytes) { metrics.gpuAllocationBytes += bytes; },
    bufferSubData(_target, offsetOrValues, maybeValues) { metrics.gpuUploadBytes += (maybeValues || offsetOrValues).byteLength; }
  });
  const start = { ...metrics, mappingMs: Math.max(0, metrics.keyframeMs - metrics.physicalMs), elapsedMs: startMs };

  metrics.evaluations = 0;
  metrics.physicalSamples = 0;
  metrics.physicalMs = 0;
  metrics.stencilPreparationMs = 0;
  metrics.keyframes = 0;
  metrics.keyframeMs = 0;
  metrics.mappedSamples = 0;
  metrics.instanceBuilds = 0;
  metrics.instanceBytes = 0;
  metrics.packingBytes = 0;
  metrics.gpuUploadBytes = 0;
  metrics.gpuAllocationBytes = 0;
  const completionTime = performance.now();
  layer.setSamples(toSamples, FRAME_TIME);
  layer.uploadBuffers({
    ARRAY_BUFFER: 1,
    STREAM_DRAW: 2,
    DYNAMIC_DRAW: 3,
    bindBuffer() {},
    bufferData(_target, bytes) { metrics.gpuAllocationBytes += bytes; },
    bufferSubData(_target, offsetOrValues, maybeValues) { metrics.gpuUploadBytes += (maybeValues || offsetOrValues).byteLength; }
  });
  const completion = { ...metrics, mappingMs: Math.max(0, metrics.keyframeMs - metrics.physicalMs), elapsedMs: performance.now() - completionTime };
  return { representation: Layer === GeographicDotsLayer ? 'Dots' : 'Squares', fromLevel, toLevel, start, completion };
}

for (const [fromLevel, toLevel] of TRANSITIONS) {
  for (const Layer of [GeographicDotsLayer, GeographicSquaresLayer]) {
    const forward = metricLayer(Layer, fromLevel, toLevel);
    const reverse = metricLayer(Layer, toLevel, fromLevel);
    for (const result of [forward, reverse]) {
      const start = result.start;
      const completion = result.completion;
      console.log(`${result.representation} L${result.fromLevel}->L${result.toLevel}`);
      console.log(`  start: elapsed=${start.elapsedMs.toFixed(3)}ms physical=${start.physicalMs.toFixed(3)}ms stencil=${start.stencilPreparationMs.toFixed(3)}ms mapping=${start.mappingMs.toFixed(3)}ms evaluations=${start.evaluations} physicalSamples=${start.physicalSamples} mappedSamples=${start.mappedSamples} keyframes=${start.keyframes} instanceBuilds=${start.instanceBuilds} instanceBytes=${start.instanceBytes} packingBytes=${start.packingBytes} gpuUploadBytes=${start.gpuUploadBytes} gpuAllocationBytes=${start.gpuAllocationBytes}`);
      console.log(`  completion: elapsed=${completion.elapsedMs.toFixed(3)}ms physical=${completion.physicalMs.toFixed(3)}ms stencil=${completion.stencilPreparationMs.toFixed(3)}ms mapping=${completion.mappingMs.toFixed(3)}ms evaluations=${completion.evaluations} physicalSamples=${completion.physicalSamples} mappedSamples=${completion.mappedSamples} keyframes=${completion.keyframes} instanceBuilds=${completion.instanceBuilds} instanceBytes=${completion.instanceBytes} packingBytes=${completion.packingBytes} gpuUploadBytes=${completion.gpuUploadBytes} gpuAllocationBytes=${completion.gpuAllocationBytes}`);
    }
  }
}
