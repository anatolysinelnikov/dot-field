import { beginRealWeatherSequenceLoad } from '../src/engine/real-weather.js';
import { V3_PHENOMENA_METADATA } from './sequence-test-metadata.mjs';

const FRAME_COUNT = 19;
const FRAME_BYTE_LENGTH = 16;
const metadata = {
  schema_version: 'dot-field-weather-transport-v3',
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
    logical_dimensions: ['latitude', 'longitude'], frame_node_count: 4,
    frame_byte_length: FRAME_BYTE_LENGTH,
    frame_assets: Array.from({ length: FRAME_COUNT }, (_, index) => `frame-${index}`)
  },
  support_mask: { asset: 'support', encoding: 'bitset-lsb0', node_count: 4, byte_length: 1, potential_weather_condition: 'rain > 0 or phenomenon code in 1..19', trailing_unused_bits: 'zero' },
  phenomena: V3_PHENOMENA_METADATA
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
let baseReport = null;
let residentReport = null;

const baseStarts = [];
await withFetch(fixtureFetch(baseStarts), async () => {
  const starts = baseStarts;
  const base = beginRealWeatherSequenceLoad('metadata', { sourceFrameCacheLimit: 6, retainAllSourceFrames: false });
  const sequence = await base.loadSequence(0);
  await base.requestSourceFrames([1, 2], { priority: 'high' });
  const initial = base.diagnostics();
  check(starts.join(',') === '0,1,2', 'startup must fetch frame 0, then only the initial playback frames');
  check(initial.residentSourceFrameCount === 3 && !initial.fullSequenceResidencyCompleted, 'Play readiness must not wait for full source residency');
  for (const frameIndex of scrubSequence) await base.requestSourceFrame(frameIndex, { priority: 'high' });
  const baseDiagnostics = base.diagnostics();
  check(baseDiagnostics.lruEvictions > 0, 'the opt-in bounded source cache must evict during a wide scrub');
  check(baseDiagnostics.validationScans === baseDiagnostics.sourceFetchesStarted, 'base validation scans must match source fetches');
  check(baseDiagnostics.logicalSourceBytesRequested > FRAME_COUNT * FRAME_BYTE_LENGTH, 'base wide scrub must transfer more than one sequence payload');
  check(sequence.sourceFrames.size === 6, 'base source residency must remain bounded at six frames');
  baseReport = baseDiagnostics;
});

const residentStarts = [];
const residentChanges = [];
await withFetch(fixtureFetch(residentStarts), async () => {
  const starts = residentStarts;
  const resident = beginRealWeatherSequenceLoad('metadata', {
    sourceFrameCacheLimit: 6,
    retainAllSourceFrames: true,
    onResidencyChange: (indices) => residentChanges.push(indices)
  });
  const sequence = await resident.loadSequence(0);
  await resident.requestSourceFrames([1, 2], { priority: 'high' });
  const initial = resident.diagnostics();
  check(initial.residentSourceFrameCount === 3 && initial.residentSourceBytes === 3 * FRAME_BYTE_LENGTH, 'resident startup must retain only the initial three frames before background fill');
  check(initial.residentSourceFrameIndices.join(',') === '0,1,2', 'resident diagnostics must expose the actual sorted startup frame indices');
  check(residentChanges.at(-1)?.join(',') === '0,1,2' && Object.isFrozen(residentChanges.at(-1)), 'residency changes must publish an immutable actual startup index snapshot');
  check(!initial.fullSequenceResidencyCompleted, 'resident startup must not report full completion early');

  await resident.fillAllSourceFrames();
  const complete = resident.diagnostics();
  check(sequence.sourceFrames.size === FRAME_COUNT, 'resident fill must retain every source frame');
  check(complete.sourceFrameCount === FRAME_COUNT && complete.residentSourceFrameCount === FRAME_COUNT, 'resident diagnostics must expose the complete frame count');
  check(complete.residentSourceBytes === FRAME_COUNT * FRAME_BYTE_LENGTH, 'resident bytes must equal exact Float32 payload bytes');
  check(complete.residentSourceFrameIndices.join(',') === Array.from({ length: FRAME_COUNT }, (_, index) => index).join(','), 'resident diagnostics must expose every actual resident frame index');
  check(residentChanges.at(-1)?.join(',') === Array.from({ length: FRAME_COUNT }, (_, index) => index).join(','), 'residency changes must publish the actual complete index snapshot');
  check(complete.fullSequenceResidencyCompleted, 'resident fill must report full sequence completion');
  check(complete.retainAllSourceFrames && complete.lruEvictions === 0, 'full source residency must never evict source frames');
  check(complete.sourceFetchConcurrency === 1 && complete.configuredConcurrency === 1, 'full source residency must retain one global fetch slot');
  check(Number.isFinite(complete.fullSequenceLoadDurationMs) && complete.fullSequenceLoadDurationMs >= 0, 'full source residency must report its load duration');

  const rawFrame = sequence.exactSourceFrameAt(FRAME_COUNT - 2);
  check(rawFrame.mmh === sequence.sourceFrames.get(FRAME_COUNT - 2), 'RAW exact frame must reference the resident source Float32Array');
  check(!complete.rawExactFrameDuplicatePayload, 'RAW exact frame must not duplicate its resident source payload');

  const beforeScrub = resident.diagnostics();
  for (const frameIndex of scrubSequence) await resident.requestSourceFrame(frameIndex, { priority: 'high' });
  for (let frameIndex = FRAME_COUNT - 1; frameIndex >= 0; frameIndex--) {
    await resident.requestSourceFrames(sequence.requiredSourceFrames(frameIndex / (FRAME_COUNT - 1)), { priority: 'high' });
  }
  const afterScrub = resident.diagnostics();
  check(afterScrub.sourceFetchesStarted === beforeScrub.sourceFetchesStarted, 'wide scrub after residency must not fetch');
  check(afterScrub.validationScans === beforeScrub.validationScans, 'wide scrub after residency must not validate');
  check(afterScrub.residentSourceFrameCount === FRAME_COUNT && afterScrub.lruEvictions === 0, 'wide scrub must preserve full resident source state');
  check(starts.length === FRAME_COUNT, 'resident sequence must fetch each source frame exactly once');
  residentReport = { complete, beforeScrub, afterScrub };
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

console.log(`resident source-frame verification passed: incremental startup, bounded initial playback readiness, full LOW residency, exact resident bytes, no post-completion fetch/validation/eviction, HIGH preemption, and map-pause resume`);
console.log(`A/B wide scrub: base fetches=${baseReport.sourceFetchesStarted}, misses=${baseReport.cacheMisses}, validation=${baseReport.validationScans}, evictions=${baseReport.lruEvictions}, logicalBytes=${baseReport.logicalSourceBytesRequested}; resident post-completion fetch delta=${residentReport.afterScrub.sourceFetchesStarted - residentReport.beforeScrub.sourceFetchesStarted}, validation delta=${residentReport.afterScrub.validationScans - residentReport.beforeScrub.validationScans}, evictions=${residentReport.afterScrub.lruEvictions}`);
