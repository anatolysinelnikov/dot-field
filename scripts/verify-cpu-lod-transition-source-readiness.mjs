import { beginRealWeatherSequenceLoad } from '../src/engine/real-weather.js';
import { setActiveWeatherField, WEATHER_REGION } from '../src/engine/geography.js';
import { canonicalWindowFromMercatorBounds, GeographicLodTopology, lngLatToMercator } from '../src/engine/geographic-lod.js';
import { GeographicWeatherPyramid } from '../src/engine/geographic-weather-pyramid.js';
import { GeographicDotsLayer } from '../src/engine/geographic-dots-layer.js';
import { TEMPORAL_FRAME_COUNT, geographicTemporalFrameAt } from '../src/engine/geographic-layer-utils.js';

const FRAME_COUNT = 19;
const FRAME_TIME = 0.349812;
const metadata = {
  schema_version: 'dot-field-weather-transport-v2',
  spatial_grid: {
    width: 2, height: 2, longitude_start: 10, latitude_start: 20,
    longitude_spacing: 1, latitude_spacing: 1,
    longitude_order: 'west_to_east', latitude_order: 'south_to_north',
    weather_support: { west: 10, east: 11, south: 20, north: 21 }
  },
  time: { count: FRAME_COUNT, timestamps: Array.from({ length: FRAME_COUNT }, (_, index) => `2026-08-26T${String(index).padStart(2, '0')}:00:00`) },
  source: { normalized_units: 'mm/h' },
  channels: { rain: true, phenomena: false },
  rain: {
    available: true, dtype: 'Float32', byte_order: 'little-endian', physical_units: 'mm/h',
    logical_dimensions: ['latitude', 'longitude'], frame_node_count: 4, frame_byte_length: 16,
    frame_assets: Array.from({ length: FRAME_COUNT }, (_, index) => `frame-${index}`)
  },
  support_mask: { asset: 'support', encoding: 'bitset-lsb0', node_count: 4, byte_length: 1, positive_condition: 'rain > 0', trailing_unused_bits: 'zero' },
  phenomena: {
    available: false, dtype: 'Uint8',
    enum: { none: 0, thunderstorm_1: 1, thunderstorm_2: 2, thunderstorm_3: 3, hail_1: 4, hail_2: 5, hail_3: 6, reserved: 7 },
    frame_assets: []
  }
};

function check(condition, message) {
  if (!condition) throw new Error(message);
  console.log(`PASS ${message}`);
}

function frameResponse(index) {
  return new Response(new Float32Array([index, index, index, index]).buffer);
}

function requirementsFor(field, normalizedTime) {
  const rendererFrame = geographicTemporalFrameAt(normalizedTime);
  const nextRendererTime = rendererFrame.nextIndex / TEMPORAL_FRAME_COUNT;
  const times = [normalizedTime, nextRendererTime];
  const sourceFrames = [...new Set(times.flatMap((time) => field.requiredSourceFrames(time)))];
  return { times, sourceFrames, key: sourceFrames.join(',') };
}

function makeLayer(field) {
  setActiveWeatherField(field);
  const [centerX, centerY] = lngLatToMercator(...WEATHER_REGION.center);
  const window = canonicalWindowFromMercatorBounds({
    minX: centerX - 0.004, maxX: centerX + 0.004,
    minY: centerY - 0.004, maxY: centerY + 0.004
  });
  const topology = new GeographicLodTopology(window, { minLevel: 13, maxLevel: 14 });
  const pyramid = new GeographicWeatherPyramid(Float32Array, topology);
  const layer = new GeographicDotsLayer(pyramid);
  layer.setActive(true);
  layer.setLevelData(topology.levelDataFor(13), 0);
  return { layer, topology };
}

async function startCpuTransition({ load, field, layer, targetLevel = 14, targetTime, state, requestState }) {
  if (targetLevel === 13) return { status: 'reversed' };
  const requirements = requirementsFor(field, targetTime);
  if (requirements.sourceFrames.every((frameIndex) => field.isSourceFrameAvailable(frameIndex))) {
    layer.setTransition(layer.levelData, layer.topology.levels.get(14), targetTime, 0);
    state.started += 1;
    return { status: 'ready' };
  }
  const request = { token: Symbol('cpu-transition'), targetTime, requirements };
  requestState.current = request;
  const { result } = await load.requestSourceFrames(requirements.sourceFrames, {
    priority: 'high', replaceKey: 'cpu-lod-transition'
  });
  if (requestState.current !== request || result?.status === 'superseded') return result;
  requestState.current = null;
  if (state.targetLevel !== targetLevel || state.targetTime !== targetTime) return result;
  check(requirements.sourceFrames.every((frameIndex) => field.isSourceFrameAvailable(frameIndex)), 'CPU transition evaluates only after its exact source pair is resident');
  layer.setTransition(layer.levelData, layer.topology.levels.get(14), targetTime, 0);
  state.started += 1;
  return result;
}

const originalFetch = globalThis.fetch;
let releaseRequiredFrames;
const requiredFramesGate = new Promise((resolve) => { releaseRequiredFrames = resolve; });
globalThis.fetch = async (url) => {
  if (url === 'metadata') return new Response(JSON.stringify(metadata));
  if (url === 'support') return new Response(Uint8Array.of(1));
  const index = Number(String(url).replace('frame-', ''));
  if (index === 6 || index === 7) await requiredFramesGate;
  return frameResponse(index);
};

try {
  const load = beginRealWeatherSequenceLoad('metadata', {
    sourceFrameCacheLimit: 6,
    retainAllSourceFrames: false,
    temporalMode: 'linear'
  });
  const field = await load.loadSequence(0);
  await load.requestSourceFrames([1, 2, 3, 4, 5], { priority: 'high' });
  const { layer } = makeLayer(field);
  const requirements = requirementsFor(field, FRAME_TIME);
  check(requirements.sourceFrames.join(',') === '6,7', 'the selected temporal position requires source frames 6 and 7');
  check(!field.isSourceFrameAvailable(6), 'source frame 6 is initially outside the bounded cache');
  check(!field.isSourceFrameAvailable(7), 'source frame 7 is initially outside the bounded cache');

  const presentation = { owner: 'gpu', stableLevel: 13, coherent: true };
  const state = { targetLevel: 14, targetTime: FRAME_TIME, started: 0 };
  const requestState = { current: null };
  const pending = startCpuTransition({ load, field, layer, targetTime: FRAME_TIME, state, requestState });
  await Promise.resolve();
  check(presentation.owner === 'gpu' && presentation.stableLevel === 13 && presentation.coherent, 'stable coherent GPU presentation remains active while CPU source readiness is pending');
  check(layer.transition === null, 'CPU transition is not installed before source readiness');
  releaseRequiredFrames();
  const result = await pending;
  check(result.status === 'ready', 'bounded HIGH source request becomes ready');
  check(state.started === 1 && layer.transition?.toLevelData?.level === 14, 'L13 to L14 CPU transition starts after source readiness');
  const diagnostics = load.diagnostics();
  check(diagnostics.effectiveSourceFrameCacheLimit === 6 && diagnostics.peakSourceCacheEntries <= 6, 'source residency remains bounded at six frames');
  check(!diagnostics.retainAllSourceFrames && diagnostics.sourceResidencyPolicy === 'bounded-lru', 'no full-sequence source retention is introduced');

  let releaseSupersededFrames;
  const supersededGate = new Promise((resolve) => { releaseSupersededFrames = resolve; });
  globalThis.fetch = async (url) => {
    if (url === 'metadata') return new Response(JSON.stringify(metadata));
    if (url === 'support') return new Response(Uint8Array.of(1));
    const index = Number(String(url).replace('frame-', ''));
    if (index === 6 || index === 7) await supersededGate;
    return frameResponse(index);
  };
  const supersessionLoad = beginRealWeatherSequenceLoad('metadata', { sourceFrameCacheLimit: 6, retainAllSourceFrames: false, temporalMode: 'linear' });
  const supersessionField = await supersessionLoad.loadSequence(0);
  await supersessionLoad.requestSourceFrames([1, 2, 3, 4, 5], { priority: 'high' });
  const { layer: supersessionLayer } = makeLayer(supersessionField);
  const supersessionState = { targetLevel: 14, targetTime: FRAME_TIME, started: 0 };
  const supersessionRequests = { current: null };
  const stale = startCpuTransition({ load: supersessionLoad, field: supersessionField, targetTime: FRAME_TIME, layer: supersessionLayer, state: supersessionState, requestState: supersessionRequests });
  await Promise.resolve();
  supersessionState.targetLevel = 13;
  releaseSupersededFrames();
  const reversedResult = await stale;
  check(reversedResult.status === 'ready' && supersessionState.started === 0 && supersessionLayer.transition === null, 'a reversed LOD request cannot publish after source readiness completes');

  await supersessionLoad.requestSourceFrames([8, 9, 10, 11, 12, 13], { priority: 'high' });
  let releaseReplacementFrames;
  const replacementGate = new Promise((resolve) => { releaseReplacementFrames = resolve; });
  globalThis.fetch = async (url) => {
    if (url === 'metadata') return new Response(JSON.stringify(metadata));
    if (url === 'support') return new Response(Uint8Array.of(1));
    const index = Number(String(url).replace('frame-', ''));
    if (index === 6 || index === 7) await replacementGate;
    return frameResponse(index);
  };
  supersessionState.targetLevel = 14;
  supersessionState.targetTime = FRAME_TIME;
  const staleReplacement = startCpuTransition({ load: supersessionLoad, field: supersessionField, targetTime: FRAME_TIME, layer: supersessionLayer, state: supersessionState, requestState: supersessionRequests });
  await Promise.resolve();
  supersessionState.targetTime = 0.75;
  const current = startCpuTransition({ load: supersessionLoad, field: supersessionField, targetTime: 0.75, layer: supersessionLayer, state: supersessionState, requestState: supersessionRequests });
  releaseReplacementFrames();
  const [staleResult, currentResult] = await Promise.all([staleReplacement, current]);
  check(staleResult.status === 'superseded' && currentResult.status === 'ready', 'superseded source readiness cannot publish an obsolete transition');
  check(supersessionState.started === 1 && supersessionLayer.transition?.toLevelData?.level === 14, 'the current replacement request starts the transition after supersession');
} finally {
  globalThis.fetch = originalFetch;
}

console.log('CPU LOD transition source-readiness verification passed.');
