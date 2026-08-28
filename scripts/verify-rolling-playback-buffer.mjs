import {
  beginRealWeatherSequenceLoad,
  INITIAL_PLAYBACK_SOURCE_FRAME_COUNT,
  rollingPlaybackSourceFrameIndices
} from '../src/engine/real-weather.js';

const FRAME_COUNT = 19;
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
    logical_dimensions: ['latitude', 'longitude'], frame_node_count: 4, frame_byte_length: 16,
    frame_assets: Array.from({ length: FRAME_COUNT }, (_, index) => `frame-${index}`)
  },
  support_mask: { asset: 'support', encoding: 'bitset-lsb0', node_count: 4, byte_length: 1, positive_condition: 'rain > 0', trailing_unused_bits: 'zero' },
  phenomena: { available: false, dtype: 'Uint8', enum: { none: 0, thunderstorm_1: 1, thunderstorm_2: 2, thunderstorm_3: 3, hail_1: 4, hail_2: 5, hail_3: 6, reserved: 7 }, frame_assets: [] }
};

function check(condition, message) {
  if (!condition) throw new Error(message);
}

function equal(actual, expected, message) {
  check(actual.join(',') === expected.join(','), `${message}: ${actual.join(',')} !== ${expected.join(',')}`);
}

const starts = [];
const originalFetch = globalThis.fetch;
globalThis.fetch = async (url) => {
  if (url === 'metadata') return new Response(JSON.stringify(metadata));
  if (url === 'support') return new Response(Uint8Array.of(1));
  const frameIndex = Number(String(url).replace('frame-', ''));
  starts.push(frameIndex);
  return new Response(new Float32Array([frameIndex, 0, 0, 0]).buffer);
};

try {
  equal(rollingPlaybackSourceFrameIndices(FRAME_COUNT, 0), [0, 1, 2, 3, 4], 'initial rolling horizon');
  equal(rollingPlaybackSourceFrameIndices(FRAME_COUNT, 2 / 18), [1, 2, 3, 4, 5, 6], 'advanced rolling horizon');
  equal(rollingPlaybackSourceFrameIndices(FRAME_COUNT, 1), [17, 18], 'terminal rolling horizon');
  for (let frame = 0; frame < FRAME_COUNT; frame++) {
    check(rollingPlaybackSourceFrameIndices(FRAME_COUNT, frame / 18).length <= 6, 'rolling horizon must fit the six-frame source cache');
  }

  const staged = beginRealWeatherSequenceLoad('metadata', { sourceFrameCacheLimit: 6 });
  const sequence = await staged.loadSequence(0);
  await staged.requestSourceFrames([0, 1, 2], { priority: 'high' });
  equal(starts, [0, 1, 2], 'initial playback readiness must not request the full sequence');
  check(sequence.sourceFrames.size === INITIAL_PLAYBACK_SOURCE_FRAME_COUNT, 'initial playback readiness must retain exactly the configured initial source buffer');

  await staged.requestSourceFrames(rollingPlaybackSourceFrameIndices(FRAME_COUNT, 0), { priority: 'low', replaceKey: 'rolling-playback-prefetch' });
  equal(starts, [0, 1, 2, 3, 4], 'initial rolling horizon must request only its forward neighborhood');
  await staged.requestSourceFrames(rollingPlaybackSourceFrameIndices(FRAME_COUNT, 2 / 18), { priority: 'low', replaceKey: 'rolling-playback-prefetch' });
  equal(starts, [0, 1, 2, 3, 4, 5, 6], 'horizon advancement must request only newly relevant frames');
  check(sequence.sourceFrames.size === 6 && !sequence.isSourceFrameAvailable(0), 'the source LRU must remain bounded as rolling playback advances');

  staged.setBackgroundPrefetchPaused(true);
  const pausedPrefetch = staged.prefetchFrames([14]);
  await Promise.resolve();
  check(!starts.includes(14), 'map interaction pause must prevent new LOW rolling work from starting');
  staged.setBackgroundPrefetchPaused(false);
  await pausedPrefetch;
  check(starts.includes(14), 'rolling LOW work must resume after map interaction ends');

  await staged.requestSourceFrames([2], { priority: 'high', replaceKey: 'manual' });
  await staged.requestSourceFrames(rollingPlaybackSourceFrameIndices(FRAME_COUNT, 2 / 18), { priority: 'low', replaceKey: 'rolling-playback-prefetch' });
  check(starts.filter((index) => index === 2).length === 1, 'backward/rebased playback must reuse an available source frame without duplication');
  const diagnostics = staged.diagnostics();
  check(diagnostics.peakActiveFetches === 1, 'rolling playback must retain global source-fetch concurrency one');

  starts.length = 0;
  const uninterrupted = beginRealWeatherSequenceLoad('metadata', { sourceFrameCacheLimit: 6 });
  await uninterrupted.loadSequence(0);
  await uninterrupted.requestSourceFrames([0, 1, 2], { priority: 'high' });
  for (let frame = 0; frame < FRAME_COUNT; frame++) {
    await uninterrupted.requestSourceFrames(rollingPlaybackSourceFrameIndices(FRAME_COUNT, frame / 18), {
      priority: 'low', replaceKey: 'rolling-playback-prefetch'
    });
  }
  check(starts.length === FRAME_COUNT, 'uninterrupted forward playback must fetch each source frame once');
  for (let frame = 0; frame < FRAME_COUNT; frame++) {
    check(starts.filter((index) => index === frame).length === 1, `uninterrupted forward playback must not re-download frame ${frame}`);
  }
  const uninterruptedDiagnostics = uninterrupted.diagnostics();
  check(uninterruptedDiagnostics.peakSourceCacheEntries === 6, `uninterrupted rolling playback must retain the six-frame source-cache bound (observed ${uninterruptedDiagnostics.peakSourceCacheEntries})`);
  console.log(`rolling playback verification passed: initial=${INITIAL_PLAYBACK_SOURCE_FRAME_COUNT}; horizon=previous/current-pair/+3; fetches=${starts.length}; evictions=${diagnostics.lruEvictions}`);
} finally {
  globalThis.fetch = originalFetch;
}
