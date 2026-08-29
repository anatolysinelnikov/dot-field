import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { request } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gzip } from 'node:zlib';
import { promisify } from 'node:util';
import { createLocalServer } from './serve-local.mjs';
import { beginRealWeatherSequenceLoad } from '../src/engine/real-weather.js';

const compress = promisify(gzip);
const compressOptions = { level: 9 };

function check(condition, message) {
  if (!condition) throw new Error(message);
}

function rawRequest(port, path, headers) {
  return new Promise((resolve, reject) => {
    const client = request({ host: '127.0.0.1', port, path, headers }, (response) => {
      const chunks = [];
      response.on('data', (chunk) => chunks.push(chunk));
      response.on('end', () => resolve({ headers: response.headers, body: Buffer.concat(chunks) }));
    });
    client.on('error', reject);
    client.end();
  });
}

function metadataFor(generationId, width, height, value) {
  const frameCount = 3;
  const frameNodeCount = width * height;
  const frameByteLength = frameNodeCount * Float32Array.BYTES_PER_ELEMENT;
  return {
    schema_version: 'dot-field-weather-transport-v2',
    generation_id: generationId,
    spatial_grid: {
      width, height, longitude_start: 10, latitude_start: 20,
      longitude_spacing: 1, latitude_spacing: 1,
      longitude_order: 'west_to_east', latitude_order: 'south_to_north',
      weather_support: { west: 10, east: 10 + width - 1, south: 20, north: 20 + height - 1 }
    },
    time: {
      count: frameCount,
      timestamps: Array.from({ length: frameCount }, (_, index) => `2026-08-26T0${index}:00:00Z`)
    },
    source: { normalized_units: 'mm/h' },
    channels: { rain: true, phenomena: false },
    rain: {
      available: true, dtype: 'Float32', byte_order: 'little-endian', physical_units: 'mm/h',
      logical_dimensions: ['latitude', 'longitude'], frame_node_count: frameNodeCount,
      frame_byte_length: frameByteLength,
      frame_assets: Array.from({ length: frameCount }, (_, index) => `../${generationId}/rain/frame-${index}.f32`)
    },
    support_mask: {
      asset: `../${generationId}/support.mask`, encoding: 'bitset-lsb0',
      node_count: frameNodeCount, byte_length: Math.ceil(frameNodeCount / 8),
      positive_condition: 'rain > 0', trailing_unused_bits: 'zero'
    },
    phenomena: {
      available: false, dtype: 'Uint8',
      enum: { none: 0, thunderstorm_1: 1, thunderstorm_2: 2, thunderstorm_3: 3, hail_1: 4, hail_2: 5, hail_3: 6, reserved: 7 },
      frame_assets: []
    },
    test_value: value
  };
}

async function publishGeneration(root, generationId, width, height, value) {
  const directory = join(root, generationId);
  await mkdir(join(directory, 'rain'), { recursive: true });
  const metadata = metadataFor(generationId, width, height, value);
  await writeFile(join(directory, 'metadata.json'), `${JSON.stringify(metadata)}\n`);
  const support = Buffer.alloc(Math.ceil(width * height / 8));
  support[0] = (1 << (width * height)) - 1;
  await writeFile(join(directory, 'support.mask'), support);
  await writeFile(`${join(directory, 'support.mask')}.gz`, await compress(support, compressOptions));
  for (let index = 0; index < 3; index++) {
    const frame = Buffer.from(new Float32Array(width * height).fill(value + index).buffer);
    const path = join(directory, 'rain', `frame-${index}.f32`);
    await writeFile(path, frame);
    await writeFile(`${path}.gz`, await compress(frame, compressOptions));
  }
  return metadata;
}

const root = await mkdtemp(join(tmpdir(), 'dot-field-generations-'));
const originalFetch = globalThis.fetch;
const requestedUrls = [];
globalThis.fetch = async (url, options) => {
  requestedUrls.push(String(url));
  return originalFetch(url, options);
};
const server = createLocalServer({ root, compression: 'gzip' });
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const address = server.address();
const baseUrl = `http://127.0.0.1:${address.port}`;
const currentMetadataUrl = `${baseUrl}/current/metadata.json`;

try {
  const generationA = 'generation-a-test';
  const generationB = 'generation-b-test';
  const metadataA = await publishGeneration(root, generationA, 2, 2, 10);
  await mkdir(join(root, 'current'), { recursive: true });
  await writeFile(join(root, 'current', 'metadata.json'), `${JSON.stringify(metadataA)}\n`);

  const compressed = await rawRequest(address.port, `/${generationA}/rain/frame-0.f32`, { 'Accept-Encoding': 'gzip' });
  const sidecar = await readFile(join(root, generationA, 'rain', 'frame-0.f32.gz'));
  check(compressed.headers['content-encoding'] === 'gzip', 'immutable generation frame must serve gzip');
  check(compressed.body.equals(sidecar), 'immutable generation gzip response must equal its sidecar');

  const oldSession = beginRealWeatherSequenceLoad(currentMetadataUrl, { sourceFrameCacheLimit: 2 });
  const oldSequence = await oldSession.loadSequence(0);
  await oldSession.requestSourceFrame(1, { priority: 'high' });
  check(oldSequence.generationId === generationA, 'old session must retain generation A identity');

  const metadataB = await publishGeneration(root, generationB, 3, 2, 90);
  await writeFile(join(root, 'current', 'metadata.json'), `${JSON.stringify(metadataB)}\n`);

  await oldSession.requestSourceFrame(2, { priority: 'high' });
  const oldFrame = await oldSession.requestSourceFrame(0, { priority: 'high' });
  const oldRefetchUrl = requestedUrls.at(-1);
  check(oldFrame[0] === 10, 'old session re-fetch must return generation A data');
  check(oldRefetchUrl.includes(`/${generationA}/rain/frame-0.f32`), `old session re-fetch used the wrong URL: ${oldRefetchUrl}`);
  check(!oldRefetchUrl.includes('/current/'), 'old session re-fetch must not use mutable current');

  const newSession = beginRealWeatherSequenceLoad(currentMetadataUrl, { sourceFrameCacheLimit: 2 });
  const newSequence = await newSession.loadSequence(0);
  const newFrame = newSequence.sourceFrameAt(0);
  const newFrameUrl = requestedUrls.at(-1);
  check(newSequence.generationId === generationB, 'new session must read generation B metadata');
  check(newSequence.frameSize === 6 && newFrame[0] === 90, 'new session must use generation B dimensions and values');
  check(newFrameUrl.includes(`/${generationB}/rain/frame-0.f32`), `new session used the wrong URL: ${newFrameUrl}`);
  check(!newFrameUrl.includes('/current/'), 'new session asset request must not use mutable current');

  console.log(JSON.stringify({
    generationA: oldSequence.generationId,
    generationB: newSequence.generationId,
    oldSessionRefetch: { url: oldRefetchUrl, firstValue: oldFrame[0] },
    newSession: { url: newFrameUrl, frameSize: newSequence.frameSize, firstValue: newFrame[0] },
    requestedUrls
  }, null, 2));
  console.log('immutable weather generation verification passed: old sessions remain pinned while current points to the new generation');
} finally {
  globalThis.fetch = originalFetch;
  await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  await rm(root, { recursive: true, force: true });
}
