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
const phenomenaBuffers = await Promise.all(metadata.phenomena.frame_assets.map(async (asset) => readFile(new URL(asset, root))));
const phenomenaFrames = new Map(phenomenaBuffers.map((buffer, index) => [
  index,
  new Uint8Array(buffer.buffer, buffer.byteOffset, buffer.byteLength)
]));
const supportBuffer = await readFile(new URL(metadata.support_mask.asset, root));
const potentialWeatherMask = decodePackedWeatherSupport(
  supportBuffer.buffer.slice(supportBuffer.byteOffset, supportBuffer.byteOffset + supportBuffer.byteLength), frameSize
);
const longitudes = Float64Array.from({ length: grid.width }, (_, index) => grid.longitude_start + index * grid.longitude_spacing);
const latitudes = Float64Array.from({ length: grid.height }, (_, index) => grid.latitude_start + index * grid.latitude_spacing);
const sequence = new RealWeatherSequence({
  longitudes, latitudes, sourceFrames, frameCount: metadata.time.count,
  longitudeSpacing: grid.longitude_spacing, latitudeSpacing: grid.latitude_spacing,
  weatherSupport: grid.weather_support,
  timestamps: metadata.time.timestamps, potentialWeatherMask,
  phenomenaFrames, phenomenaAvailable: true,
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
for (const [index, buffer] of phenomenaBuffers.entries()) {
  same(buffer.byteLength, metadata.phenomena.frame_byte_length, `phenomena frame ${index} byte length`);
  if (phenomenaFrames.get(index).some((value) => !Object.hasOwn(metadata.phenomena.codebook, value))) throw new Error(`phenomena frame ${index} has an unsupported code`);
}
const longitudeIndex = 160;
const latitudeIndex = 41;
const longitude = longitudes[longitudeIndex];
const latitude = latitudes[latitudeIndex];
for (let frame = 0; frame < sequence.frameCount; frame++) {
  same(sequence.prepareFrame(frame / (sequence.frameCount - 1)).sample(longitude, latitude, {}).rainMmh, sourceValue(frame, longitudeIndex, latitudeIndex), `exact source frame ${frame}`);
}

const severity = { 10: 0.2660123, 11: 0.4818750, 12: 0.6977377 };
const sourceHazardSamples = [
  { code: 10, longitudeIndex: 197, latitudeIndex: 300 },
  { code: 11, longitudeIndex: 572, latitudeIndex: 341 },
  { code: 12, longitudeIndex: 645, latitudeIndex: 330 }
];
for (const { code, longitudeIndex: sampleLongitudeIndex, latitudeIndex: sampleLatitudeIndex } of sourceHazardSamples) {
  const index = sampleLatitudeIndex * grid.width + sampleLongitudeIndex;
  same(phenomenaFrames.get(0)[index], code, `source phenomenon ${code}`);
  const sample = sequence.prepareFrame(0).sample(longitudes[sampleLongitudeIndex], latitudes[sampleLatitudeIndex], {});
  same(sample.storm, severity[code], `exact source storm severity ${code}`);
}
const transitionIndex = 17 * grid.width + 552;
same(phenomenaFrames.get(0)[transitionIndex], 10, 'temporal test source phenomenon at frame 0');
same(phenomenaFrames.get(1)[transitionIndex], 0, 'temporal test source phenomenon at frame 1');
const temporalSample = sequence.prepareFrame(0.5 / (sequence.frameCount - 1)).sample(longitudes[552], latitudes[17], {});
same(temporalSample.storm, severity[10] / 2, 'temporal storm interpolation');
const zeroRainSample = sequence.prepareFrame(0).sample(longitudes[593], latitudes[19], {});
same(sourceValue(0, 593, 19), 0, 'zero-rain phenomenon source sample');
if (zeroRainSample.storm <= 0) throw new Error('phenomenon-only storm must remain renderable');
if (potentialWeatherMask[19 * grid.width + 593] !== 1) throw new Error('phenomenon-only sample must be included in potential support');
const otherIndex = phenomenaFrames.get(0).findIndex((value) => value === 6);
if (otherIndex >= 0) {
  const otherLatitudeIndex = Math.floor(otherIndex / grid.width);
  const otherLongitudeIndex = otherIndex % grid.width;
  const otherSample = sequence.prepareFrame(0).sample(longitudes[otherLongitudeIndex], latitudes[otherLatitudeIndex], {});
  same(otherSample.storm, 0, 'non-storm phenomenon must not render as storm');
  same(otherSample.hail, 0, 'non-hail phenomenon must not render as hail');
}

const hazardSequence = new RealWeatherSequence({
  longitudes: Float64Array.of(0, 1), latitudes: Float64Array.of(0, 1),
  sourceFrames: new Map([[0, new Float32Array(4).fill(0)], [1, new Float32Array(4).fill(0)]]),
  phenomenaFrames: new Map([[0, Uint8Array.of(13, 14, 15, 16)], [1, Uint8Array.of(15, 13, 14, 17)]]),
  phenomenaAvailable: true, frameCount: 2, longitudeSpacing: 1, latitudeSpacing: 1,
  timestamps: ['2026-01-01T00:00:00Z', '2026-01-01T00:10:00Z'],
  potentialWeatherMask: Uint8Array.of(1, 1, 1, 1), sourceFrameCacheLimit: 2
});
const hailSeverity = [0.2776807, 0.4897500, 0.7018193];
for (const [index, expected] of [[0, hailSeverity[0]], [1, hailSeverity[1]], [2, hailSeverity[2]], [3, 0]]) {
  same(hazardSequence.prepareFrame(0).sample(index % 2, Math.floor(index / 2), {}).hail, expected, `exact hail severity ${index}`);
}
same(hazardSequence.prepareFrame(0.5).sample(0, 0, {}).hail, (hailSeverity[0] + hailSeverity[2]) / 2, 'temporal hail interpolation');
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
for (const values of phenomenaFrames.values()) for (let index = 0; index < values.length; index++) if (values[index] >= 1 && values[index] <= 19) expectedPackedSupport[index] = 1;
for (let index = 0; index < frameSize; index++) same(potentialWeatherMask[index], expectedPackedSupport[index], `support bit ${index}`);

console.log(`Real weather sequence verification passed: ${sequence.frameCount} independent exact Float32 frames; every exact time, every interval source-node interpolation, packed sequence-wide support, prepared reconstruction, and terminal semantics.`);
