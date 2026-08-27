import { loadRealWeatherSequence, RealWeatherSequenceAssetsUnavailableError } from '../src/engine/real-weather.js';

const metadata = {
  schema_version: 'dot-field-netcdf-sequence-v1',
  binary: {
    dtype: 'Float32', byte_order: 'little-endian', filename: 'rain.f32',
    logical_dimensions: ['time', 'latitude', 'longitude'], shape: [2, 2, 2],
    element_count: 8, byte_count: 32
  },
  spatial_grid: {
    width: 2, height: 2, longitude_start: 10, latitude_start: 20,
    longitude_spacing: 1, latitude_spacing: 1,
    longitude_order: 'west_to_east', latitude_order: 'south_to_north'
  },
  time: { count: 2, timestamps: ['2026-08-26T22:00:00', '2026-08-26T22:10:00'] },
  channels: { rain: true, storm: false, hail: false },
  rain: { available: true },
  source: { normalized_units: 'mm/h' }
};

function check(condition, message) {
  if (!condition) throw new Error(message);
}

function binaryResponse(values) {
  return new Response(new Float32Array(values).buffer);
}

async function withFetch(fetchImplementation, run) {
  const original = globalThis.fetch;
  globalThis.fetch = fetchImplementation;
  try {
    await run();
  } finally {
    globalThis.fetch = original;
  }
}

await withFetch(async (url) => {
  if (url === 'metadata') return new Response(JSON.stringify(metadata));
  if (url === 'binary') return binaryResponse([0, 1, 0, 0, 0, 0, 2, 0]);
  throw new Error(`unexpected URL ${url}`);
}, async () => {
  const sequence = await loadRealWeatherSequence('metadata', 'binary');
  check(sequence.potentialWeatherMask.join(',') === '0,1,1,0', 'combined validation must retain the exact sequence-wide union mask');
});

await withFetch(async (url, options) => {
  if (url === 'metadata') return new Response('', { status: 404 });
  if (url === 'binary') {
    check(options?.signal instanceof AbortSignal, 'binary request must be abortable while metadata is authoritative');
    return binaryResponse(new Array(8).fill(0));
  }
  throw new Error(`unexpected URL ${url}`);
}, async () => {
  await loadRealWeatherSequence('metadata', 'binary')
    .then(() => { throw new Error('missing metadata must reject'); })
    .catch((error) => check(error instanceof RealWeatherSequenceAssetsUnavailableError, 'missing metadata must retain the sequence-asset fallback signal'));
});

await withFetch(async (url) => url === 'metadata'
  ? new Response(JSON.stringify(metadata))
  : new Response('', { status: 404 }), async () => {
  await loadRealWeatherSequence('metadata', 'binary')
    .then(() => { throw new Error('missing binary must reject'); })
    .catch((error) => check(error instanceof RealWeatherSequenceAssetsUnavailableError, 'missing binary must retain the sequence-asset fallback signal'));
});

for (const [name, values, expected] of [
  ['invalid length', [0, 1], 'byte length'],
  ['negative value', [0, 1, 0, 0, 0, 0, -1, 0], 'invalid value'],
  ['non-finite value', [0, 1, 0, 0, 0, 0, Number.NaN, 0], 'invalid value']
]) {
  await withFetch(async (url) => url === 'metadata'
    ? new Response(JSON.stringify(metadata))
    : binaryResponse(values), async () => {
    await loadRealWeatherSequence('metadata', 'binary')
      .then(() => { throw new Error(`${name} must reject`); })
      .catch((error) => check(String(error.message).includes(expected), `${name} must preserve validation`));
  });
}

await withFetch(async (url) => url === 'metadata'
  ? new Response(JSON.stringify({ ...metadata, binary: { ...metadata.binary, byte_count: 31 } }))
  : binaryResponse(new Array(8).fill(0)), async () => {
  await loadRealWeatherSequence('metadata', 'binary')
    .then(() => { throw new Error('malformed metadata must reject'); })
    .catch((error) => check(String(error.message).includes('binary.byte_count'), 'malformed metadata must preserve validation'));
});

console.log('real weather loader verification passed: concurrent transfers, fallback signal, exact fused mask, and malformed binary/metadata rejection');
