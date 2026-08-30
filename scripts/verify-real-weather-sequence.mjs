import { readFile } from 'node:fs/promises';
import { geographicTemporalFrameAt } from '../src/engine/geographic-layer-utils.js';
import { decodePackedWeatherSupport, RealWeatherSequence } from '../src/engine/real-weather.js';

const root = new URL('../data/generated/current/', import.meta.url);
const metadata = JSON.parse(await readFile(new URL('metadata.json', root), 'utf8'));
const grid = metadata.spatial_grid;
const frameSize = grid.width * grid.height;
const frameBuffers = await Promise.all(metadata.rain.frame_assets.map(async (asset) => readFile(new URL(asset, root))));
const sourceFrames = new Map(frameBuffers.map((buffer, index) => [
  index,
  new Float32Array(buffer.buffer, buffer.byteOffset, buffer.byteLength / Float32Array.BYTES_PER_ELEMENT)
]));
const supportBuffer = await readFile(new URL(metadata.support_mask.asset, root));
const potentialWeatherMask = decodePackedWeatherSupport(
  supportBuffer.buffer.slice(supportBuffer.byteOffset, supportBuffer.byteOffset + supportBuffer.byteLength), frameSize
);
const longitudes = Float64Array.from({ length: grid.width }, (_, index) => grid.longitude_start + index * grid.longitude_spacing);
const latitudes = Float64Array.from({ length: grid.height }, (_, index) => grid.latitude_start + index * grid.latitude_spacing);
const motion = metadata.motion ? {
  width: metadata.motion.grid_width, height: metadata.motion.grid_height,
  spacing: metadata.motion.grid_spacing_source_nodes,
  intervals: await Promise.all(metadata.motion.interval_assets.map(async (asset) => {
    const buffer = await readFile(new URL(asset, root));
    return new Float32Array(buffer.buffer, buffer.byteOffset, buffer.byteLength / Float32Array.BYTES_PER_ELEMENT);
  }))
} : null;
const sequence = new RealWeatherSequence({
  longitudes, latitudes, sourceFrames, frameCount: metadata.time.count,
  longitudeSpacing: grid.longitude_spacing, latitudeSpacing: grid.latitude_spacing,
  weatherSupport: grid.weather_support,
  timestamps: metadata.time.timestamps, potentialWeatherMask, motion, temporalMode: 'linear',
  sourceFrameCacheLimit: metadata.time.count
});

function same(left, right, message) {
  if (left !== right) throw new Error(`${message}: expected ${right}, received ${left}`);
}
function sourceValue(frame, longitudeIndex, latitudeIndex) {
  return sourceFrames.get(frame)[latitudeIndex * grid.width + longitudeIndex];
}

for (const [index, buffer] of frameBuffers.entries()) {
  same(buffer.byteLength, metadata.rain.frame_byte_length, `frame ${index} byte length`);
  const values = sourceFrames.get(index);
  for (let node = 0; node < values.length; node++) {
    if (!Number.isFinite(values[node]) || values[node] < 0) throw new Error(`frame ${index} has invalid value ${node}`);
  }
}
const longitudeIndex = 160;
const latitudeIndex = 41;
const longitude = longitudes[longitudeIndex];
const latitude = latitudes[latitudeIndex];
for (let frame = 0; frame < sequence.frameCount; frame++) {
  same(sequence.prepareFrame(frame / (sequence.frameCount - 1)).sample(longitude, latitude, {}).rainMmh, sourceValue(frame, longitudeIndex, latitudeIndex), `exact source frame ${frame}`);
}
for (let frame = 0; frame < sequence.frameCount - 1; frame++) {
  const progress = 0.37;
  const actual = sequence.prepareFrame((frame + progress) / (sequence.frameCount - 1)).sample(longitude, latitude, {}).rainMmh;
  const expected = sourceValue(frame, longitudeIndex, latitudeIndex) + (sourceValue(frame + 1, longitudeIndex, latitudeIndex) - sourceValue(frame, longitudeIndex, latitudeIndex)) * progress;
  same(actual, expected, `interpolated source node ${frame}`);
}

const geometry = sequence.prepareSamplingGeometry(Float64Array.of(longitude, longitude + grid.longitude_spacing * 0.37), Float64Array.of(latitude, latitude + grid.latitude_spacing * 0.61));
for (const time of [0, 0.123, 0.347, 0.777, 1]) {
  const frame = sequence.prepareFrame(time);
  for (let index = 0; index < 2; index++) {
    const direct = frame.sample(geometry.longitudes?.[index] ?? [longitude, longitude + grid.longitude_spacing * 0.37][index], [latitude, latitude + grid.latitude_spacing * 0.61][index], {});
    const prepared = frame.samplePrepared(geometry, index, {});
    same(prepared.rainMmh, direct.rainMmh, `prepared exact output ${time}/${index}`);
  }
}

const endpoint = geographicTemporalFrameAt(1);
if (endpoint.index !== 180 || endpoint.nextIndex !== 180 || endpoint.progress !== 0) throw new Error('terminal renderer keyframe is cyclic.');
const terminal = sequence.prepareFrame(1);
if (terminal.frame0 !== 18 || terminal.frame1 !== 18 || terminal.progress !== 0) throw new Error('terminal source frame must require one frame.');

const expectedPackedSupport = new Uint8Array(frameSize);
for (const values of sourceFrames.values()) for (let index = 0; index < values.length; index++) if (values[index] > 0) expectedPackedSupport[index] = 1;
if (metadata.support_mask.positive_condition === 'rain > 0') {
  for (let index = 0; index < frameSize; index++) same(potentialWeatherMask[index], expectedPackedSupport[index], `support bit ${index}`);
} else if (metadata.support_mask.positive_condition !== 'rain > 0 expanded by motion search radius') {
  throw new Error(`unsupported support condition ${metadata.support_mask.positive_condition}`);
}

console.log(`Real weather sequence verification passed: ${sequence.frameCount} independent exact Float32 frames; every exact time, every interval source-node interpolation, packed sequence-wide support, prepared reconstruction, and terminal semantics.`);
