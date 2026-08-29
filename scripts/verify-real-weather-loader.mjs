import {
  beginRealWeatherSequenceLoad,
  decodePackedWeatherSupport,
  RealWeatherSequenceAssetsUnavailableError
} from '../src/engine/real-weather.js';

const metadata = {
  schema_version: 'dot-field-weather-transport-v2',
  spatial_grid: {
    width: 2, height: 2, longitude_start: 10, latitude_start: 20,
    longitude_spacing: 1, latitude_spacing: 1,
    longitude_order: 'west_to_east', latitude_order: 'south_to_north',
    weather_support: { west: 10, east: 11, south: 20, north: 21 }
  },
  time: { count: 3, timestamps: ['2026-08-26T22:00:00', '2026-08-26T22:10:00', '2026-08-26T22:20:00'] },
  source: { normalized_units: 'mm/h' },
  channels: { rain: true, phenomena: false },
  rain: {
    available: true, dtype: 'Float32', byte_order: 'little-endian', physical_units: 'mm/h',
    logical_dimensions: ['latitude', 'longitude'], frame_node_count: 4, frame_byte_length: 16,
    frame_assets: ['frame-0', 'frame-1', 'frame-2']
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

function response(values) {
  return new Response(new Float32Array(values).buffer);
}

async function withFetch(fetchImplementation, run) {
  const original = globalThis.fetch;
  globalThis.fetch = fetchImplementation;
  try { await run(); } finally { globalThis.fetch = original; }
}

await withFetch(async (url) => {
  if (url === 'metadata') return new Response(JSON.stringify(metadata));
  if (url === 'support') return new Response(Uint8Array.of(0b00000110));
  if (url === 'frame-0') return response([0, 1, 0, 0]);
  if (url === 'frame-1') return response([0, 0, 2, 0]);
  if (url === 'frame-2') return response([0, 0, 0, 3]);
  throw new Error(`unexpected URL ${url}`);
}, async () => {
  const requests = [];
  const original = globalThis.fetch;
  globalThis.fetch = async (url) => {
    requests.push(url);
    if (url === 'metadata') return new Response(JSON.stringify(metadata));
    if (url === 'support') return new Response(Uint8Array.of(0b00000110));
    if (url === 'frame-0') return response([0, 1, 0, 0]);
    if (url === 'frame-1') return response([0, 0, 2, 0]);
    if (url === 'frame-2') return response([0, 0, 0, 3]);
    throw new Error(`unexpected URL ${url}`);
  };
  const staged = beginRealWeatherSequenceLoad('metadata', {
    sourceFrameCacheLimit: 2,
    retainAllSourceFrames: false
  });
  await staged.supportReady;
  check(requests.join(',') === 'metadata,support', 'metadata and support must not begin a rain-frame request');
  const sequence = await staged.loadSequence(0);
  check(requests.join(',') === 'metadata,support,frame-0', 'initial weather must require only frame 0');
  check(sequence.potentialWeatherMask.join(',') === '0,1,1,0', 'packed support must decode as the sequence-wide union');
  check(sequence.hasRequiredSourceFrames(0), 'exact first source time must be ready from frame 0 alone');
  check(!sequence.hasRequiredSourceFrames(0.25), 'interpolated time must require the adjacent unloaded source frame');
  await staged.requestSourceFrame(1);
  await staged.requestSourceFrame(2);
  check(sequence.sourceFrames.size === 2 && !sequence.isSourceFrameAvailable(0), 'opt-in bounded source-frame cache must evict least-recently-used frames at its configured bound');
  await staged.requestSourceFrame(0);
  check(sequence.exactSourceFrameAt(0).rainMmh[1] === 1, 'evicted frame reload must retain exact Float32 values');
  globalThis.fetch = original;
});

await withFetch(async (url) => url === 'metadata'
  ? new Response(JSON.stringify(metadata))
  : new Response('', { status: 404 }), async () => {
  await beginRealWeatherSequenceLoad('metadata').loadSequence()
    .then(() => { throw new Error('missing frame must reject'); })
    .catch((error) => check(error instanceof RealWeatherSequenceAssetsUnavailableError, 'missing source frame must retain the explicit asset-unavailable error type'));
});

check(decodePackedWeatherSupport(Uint8Array.of(0b00011111).buffer, 5).join(',') === '1,1,1,1,1', 'support decoder must accept zero trailing unused bits');
try {
  decodePackedWeatherSupport(Uint8Array.of(0b11100000).buffer, 5);
  throw new Error('non-zero support trailing bits must reject');
} catch (error) {
  check(String(error.message).includes('trailing unused bits'), 'support trailing-bit validation must remain explicit');
}

console.log('real weather loader verification passed: v2 manifest, packed support, initial-frame readiness, opt-in bounded LRU reload, and malformed/missing asset handling');
