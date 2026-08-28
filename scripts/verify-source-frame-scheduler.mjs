import { beginRealWeatherSequenceLoad } from '../src/engine/real-weather.js';

const FRAME_COUNT = 19;
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
}

function frameResponse(index) {
  return new Response(new Float32Array([index, 0, 0, 0]).buffer);
}

async function withFetch(fetchImplementation, run) {
  const original = globalThis.fetch;
  globalThis.fetch = fetchImplementation;
  try { await run(); } finally { globalThis.fetch = original; }
}

await withFetch(async () => { throw new Error('fetch is configured below'); }, async () => {
  // Construct this case manually so metadata/support and the delayed source
  // assets share the same deterministic fake transport.
  const started = [];
  let active = 0;
  let peakActive = 0;
  globalThis.fetch = async (url) => {
    if (url === 'metadata') return new Response(JSON.stringify(metadata));
    if (url === 'support') return new Response(Uint8Array.of(1));
    const index = Number(String(url).replace('frame-', ''));
    started.push(index);
    active++;
    peakActive = Math.max(peakActive, active);
    await new Promise((resolve) => setTimeout(resolve, 3));
    active--;
    return frameResponse(index);
  };
  const staged = beginRealWeatherSequenceLoad('metadata', { sourceFrameCacheLimit: 2 });
  await staged.loadSequence(0);
  const targetA = staged.requestSourceFrames([1, 2], { priority: 'high', replaceKey: 'manual', latestTargetGeneration: 1 });
  const targetB = staged.requestSourceFrames([17, 18], { priority: 'high', replaceKey: 'manual', latestTargetGeneration: 2 });
  const [resultA, resultB] = await Promise.all([targetA, targetB]);
  const diagnostics = staged.diagnostics();
  check(resultA.result.status === 'superseded', 'a newer manual target must supersede the earlier logical target');
  check(resultB.result.status === 'ready', 'the latest manual target must become ready');
  check(!started.includes(2), 'obsolete queued source frames must not start');
  check(peakActive === 1 && diagnostics.peakActiveFetches === 1, 'global source-frame fetch concurrency must remain one');
  check(diagnostics.staleQueuedRequirementsDropped >= 1, 'superseding a target must record dropped queued requirements');
  check(diagnostics.latestTargetGeneration === 2, 'the scheduler must retain the latest target identity');
});

await withFetch(async (url) => {
  if (url === 'metadata') return new Response(JSON.stringify(metadata));
  if (url === 'support') return new Response(Uint8Array.of(1));
  const index = Number(String(url).replace('frame-', ''));
  await new Promise((resolve) => setTimeout(resolve, 2));
  return frameResponse(index);
}, async () => {
  const started = [];
  const original = globalThis.fetch;
  globalThis.fetch = async (url) => {
    if (url === 'metadata') return new Response(JSON.stringify(metadata));
    if (url === 'support') return new Response(Uint8Array.of(1));
    const index = Number(String(url).replace('frame-', ''));
    started.push(index);
    await new Promise((resolve) => setTimeout(resolve, 2));
    return frameResponse(index);
  };
  const staged = beginRealWeatherSequenceLoad('metadata', { sourceFrameCacheLimit: 2 });
  await staged.loadSequence(0);
  const background = staged.prefetchFrames(Array.from({ length: 18 }, (_, index) => index + 1));
  await new Promise((resolve) => setTimeout(resolve, 1));
  await staged.requestSourceFrames([17], { priority: 'high', latestTargetGeneration: 3 });
  await background;
  const diagnostics = staged.diagnostics();
  check(started.indexOf(17) < started.indexOf(2), 'HIGH work must preempt queued LOW prefetch work');
  check(diagnostics.backgroundPrefetchPauseCount >= 1, 'background prefetch must be marked paused while HIGH work exists');
  check(diagnostics.backgroundPrefetchResumeCount >= 1, 'background prefetch must resume after HIGH work settles');
  check(diagnostics.lruEvictions > 0, 'the bounded LRU must still evict during a full sequence prefetch');
  globalThis.fetch = original;
});

await withFetch(async (url) => {
  if (url === 'metadata') return new Response(JSON.stringify(metadata));
  if (url === 'support') return new Response(Uint8Array.of(1));
  const index = Number(String(url).replace('frame-', ''));
  globalThis.__dotFieldSharedFrameStarts.push(index);
  await new Promise((resolve) => setTimeout(resolve, 2));
  return frameResponse(index);
}, async () => {
  globalThis.__dotFieldSharedFrameStarts = [];
  const staged = beginRealWeatherSequenceLoad('metadata', { sourceFrameCacheLimit: 2 });
  await staged.loadSequence(0);
  const targetA = staged.requestSourceFrames([1, 2], { priority: 'high', replaceKey: 'manual' });
  const targetB = staged.requestSourceFrames([2, 17], { priority: 'high', replaceKey: 'manual' });
  const [, resultB] = await Promise.all([targetA, targetB]);
  const diagnostics = staged.diagnostics();
  check(resultB.result.status === 'ready', 'a target sharing a frame with its predecessor must become ready');
  check(globalThis.__dotFieldSharedFrameStarts.filter((index) => index === 2).length === 1, 'a shared source frame must have one fetch owner');
  check(diagnostics.staleQueuedRequirementsDropped === 0, 'a shared queued frame must not be reported as obsolete');
});
delete globalThis.__dotFieldSharedFrameStarts;

await withFetch(async (url) => {
  if (url === 'metadata') return new Response(JSON.stringify(metadata));
  if (url === 'support') return new Response(Uint8Array.of(1));
  const index = Number(String(url).replace('frame-', ''));
  if (index === 5 && !globalThis.__dotFieldFailedSchedulerFrame) {
    globalThis.__dotFieldFailedSchedulerFrame = true;
    return new Response('', { status: 500 });
  }
  return frameResponse(index);
}, async () => {
  const staged = beginRealWeatherSequenceLoad('metadata', { sourceFrameCacheLimit: 2 });
  await staged.loadSequence(0);
  await staged.requestSourceFrame(5).then(() => {
    throw new Error('the first failed HIGH request must reject');
  }, () => {});
  await staged.requestSourceFrame(5);
  const diagnostics = staged.diagnostics();
  check(diagnostics.validationScans >= 2, 'a retry after failure must validate the later successful transport payload');
});
delete globalThis.__dotFieldFailedSchedulerFrame;

console.log('source-frame scheduler verification passed: global concurrency, latest-target coalescing, HIGH-over-LOW preemption, LRU behavior, and failed-request recovery');
