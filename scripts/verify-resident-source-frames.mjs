import { beginRealWeatherSequenceLoad } from '../src/engine/real-weather.js';

const FRAME_COUNT = 19;
const FRAME_BYTE_LENGTH = 16;
const metadata = {
  schema_version: 'dot-field-weather-transport-v2',
  spatial_grid: {
    width: 2, height: 2, longitude_start: 10, latitude_start: 20,
    longitude_spacing: 1, latitude_spacing: 1,
    longitude_order: 'west_to_east', latitude_order: 'south_to_north'
  },
  time: { count: FRAME_COUNT, timestamps: Array.from({ length: FRAME_COUNT }, (_, index) => `2026-08-26T${String(index).padStart(2, '0')}:00:00`) },
  source: { normalized_units: 'mm/h' },
  channels: { rain: true, phenomena: false },
  rain: {
    available: true, dtype: 'Float32', byte_order: 'little-endian', physical_units: 'mm/h',
    logical_dimensions: ['latitude', 'longitude'], frame_node_count: 4,
    frame_byte_length: FRAME_BYTE_LENGTH,
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

function wideScrubSequence() {
  return [0, 9, 18, 4, 14, 2, 16, 6, 12, 1, 17, 5, 13, 3, 15, 8, 10, 7, 11];
}

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function withFetch(fetchImplementation, run) {
  const original = globalThis.fetch;
  globalThis.fetch = fetchImplementation;
  try { await run(); } finally { globalThis.fetch = original; }
}

function fixtureFetch(starts, { delayMs = 0 } = {}) {
  return async (url) => {
    if (url === 'metadata') return new Response(JSON.stringify(metadata));
    if (url === 'support') return new Response(Uint8Array.of(1));
    const index = Number(String(url).replace('frame-', ''));
    starts.push(index);
    if (delayMs) await delay(delayMs);
    return frameResponse(index);
  };
}

const scrubSequence = wideScrubSequence();

const baseStarts = [];
await withFetch(fixtureFetch(baseStarts), async () => {
  const starts = baseStarts;
  const base = beginRealWeatherSequenceLoad('metadata', { sourceFrameCacheLimit: 6 });
  const sequence = await base.loadSequence(0);
  await base.requestSourceFrames([1, 2], { priority: 'high' });
  const initial = base.diagnostics();
  check(starts.join(',') === '0,1,2', 'startup must fetch frame 0, then only the initial playback frames');
  check(initial.residentSourceFrameCount === 3 && !initial.fullSequenceResidencyCompleted, 'Play readiness must not wait for full source residency');
  for (const frameIndex of scrubSequence) await base.requestSourceFrame(frameIndex, { priority: 'high' });
  const baseDiagnostics = base.diagnostics();
  check(baseDiagnostics.lruEvictions > 0, 'the base six-frame LRU must evict during a wide scrub');
  check(baseDiagnostics.validationScans === baseDiagnostics.sourceFetchesStarted, 'base validation scans must match source fetches');
  check(baseDiagnostics.logicalSourceBytesRequested > FRAME_COUNT * FRAME_BYTE_LENGTH, 'base wide scrub must transfer more than one sequence payload');
  check(sequence.sourceFrames.size === 6, 'base source residency must remain bounded at six frames');
});

const residentStarts = [];
await withFetch(fixtureFetch(residentStarts), async () => {
  const starts = residentStarts;
  const resident = beginRealWeatherSequenceLoad('metadata', {
    sourceFrameCacheLimit: 6,
    retainAllSourceFrames: true
  });
  const sequence = await resident.loadSequence(0);
  await resident.requestSourceFrames([1, 2], { priority: 'high' });
  const initial = resident.diagnostics();
  check(initial.residentSourceFrameCount === 3 && initial.residentSourceBytes === 3 * FRAME_BYTE_LENGTH, 'resident startup must retain only the initial three frames before background fill');
  check(!initial.fullSequenceResidencyCompleted, 'resident startup must not report full completion early');

  await resident.fillAllSourceFrames();
  const complete = resident.diagnostics();
  check(sequence.sourceFrames.size === FRAME_COUNT, 'resident fill must retain every source frame');
  check(complete.sourceFrameCount === FRAME_COUNT && complete.residentSourceFrameCount === FRAME_COUNT, 'resident diagnostics must expose the complete frame count');
  check(complete.residentSourceBytes === FRAME_COUNT * FRAME_BYTE_LENGTH, 'resident bytes must equal exact Float32 payload bytes');
  check(complete.fullSequenceResidencyCompleted, 'resident fill must report full sequence completion');
  check(complete.retainAllSourceFrames && complete.lruEvictions === 0, 'resident policy must never evict source frames');

  const beforeScrub = resident.diagnostics();
  for (const frameIndex of scrubSequence) await resident.requestSourceFrame(frameIndex, { priority: 'high' });
  const afterScrub = resident.diagnostics();
  check(afterScrub.sourceFetchesStarted === beforeScrub.sourceFetchesStarted, 'wide scrub after residency must not fetch');
  check(afterScrub.validationScans === beforeScrub.validationScans, 'wide scrub after residency must not validate');
  check(afterScrub.residentSourceFrameCount === FRAME_COUNT && afterScrub.lruEvictions === 0, 'wide scrub must preserve full resident source state');
  check(starts.length === FRAME_COUNT, 'resident sequence must fetch each source frame exactly once');
});

const pausedStarts = [];
await withFetch(fixtureFetch(pausedStarts, { delayMs: 3 }), async () => {
  const starts = pausedStarts;
  const paused = beginRealWeatherSequenceLoad('metadata', { retainAllSourceFrames: true });
  await paused.loadSequence(0);
  await paused.requestSourceFrames([1, 2], { priority: 'high' });
  paused.setBackgroundPrefetchPaused(true);
  const fill = paused.fillAllSourceFrames();
  await delay(1);
  check(!starts.includes(3), 'map movement pause must prevent new LOW resident fill work');
  paused.setBackgroundPrefetchPaused(false);
  await fill;

  const preemptedStarts = [];
  globalThis.fetch = fixtureFetch(preemptedStarts, { delayMs: 3 });
  const preempted = beginRealWeatherSequenceLoad('metadata', { retainAllSourceFrames: true });
  await preempted.loadSequence(0);
  await preempted.requestSourceFrames([1, 2], { priority: 'high' });
  const background = preempted.fillAllSourceFrames();
  await delay(1);
  await preempted.requestSourceFrame(17, { priority: 'high' });
  await background;
  check(preemptedStarts.indexOf(17) >= 0 && preemptedStarts.indexOf(17) < preemptedStarts.indexOf(4), 'HIGH interactive work must preempt queued LOW resident fill work');
  check(preempted.diagnostics().peakActiveFetches === 1, 'resident fill must retain global fetch concurrency one');
});

console.log('resident source-frame verification passed: incremental startup, bounded initial playback readiness, full LOW residency, exact resident bytes, no post-completion fetch/validation/eviction, HIGH preemption, and map-pause resume');
