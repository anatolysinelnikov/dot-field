import { readFile } from 'node:fs/promises';
import { geographicTemporalFrameAt } from '../src/engine/geographic-layer-utils.js';
import { RealWeatherSequence } from '../src/engine/real-weather.js';

const root = new URL('../data/generated/202608262200/', import.meta.url);
const metadata = JSON.parse(await readFile(new URL('metadata.json', root), 'utf8'));
const binary = await readFile(new URL('rain.f32', root));
const { width, height, longitude_start: longitudeStart, latitude_start: latitudeStart, longitude_spacing: longitudeSpacing, latitude_spacing: latitudeSpacing } = metadata.spatial_grid;
const { count: frameCount, timestamps } = metadata.time;
const longitudes = Float64Array.from({ length: width }, (_, index) => longitudeStart + index * longitudeSpacing);
const latitudes = Float64Array.from({ length: height }, (_, index) => latitudeStart + index * latitudeSpacing);
const rainFramesMmh = new Float32Array(binary.buffer, binary.byteOffset, binary.byteLength / Float32Array.BYTES_PER_ELEMENT);
const sequence = new RealWeatherSequence({ longitudes, latitudes, rainFramesMmh, frameCount, longitudeSpacing, latitudeSpacing, timestamps });

function assertClose(actual, expected, message) {
  if (Math.abs(actual - expected) > 1e-6) throw new Error(`${message}: expected ${expected}, received ${actual}`);
}

function sourceValue(frame, longitudeIndex, latitudeIndex) {
  return rainFramesMmh[frame * sequence.frameSize + latitudeIndex * width + longitudeIndex];
}

const longitudeIndex = 160;
const latitudeIndex = 41;
const longitude = longitudes[longitudeIndex];
const latitude = latitudes[latitudeIndex];
const output = {};

assertClose(sequence.prepareFrame(0).sample(longitude, latitude, output).rainMmh, sourceValue(0, longitudeIndex, latitudeIndex), 't=0 source node');
assertClose(sequence.prepareFrame(1).sample(longitude, latitude, output).rainMmh, sourceValue(18, longitudeIndex, latitudeIndex), 't=1 source node');
assertClose(sequence.prepareFrame(4.5 / 18).sample(longitude, latitude, output).rainMmh, (sourceValue(4, longitudeIndex, latitudeIndex) + sourceValue(5, longitudeIndex, latitudeIndex)) / 2, 'temporal midpoint');
assertClose(sequence.prepareFrame(7 / 18).sample(longitude, latitude, output).rainMmh, sourceValue(7, longitudeIndex, latitudeIndex), 'spatial source node');

const sampleLongitudes = Float64Array.of(longitude, longitude + longitudeSpacing * 0.37);
const sampleLatitudes = Float64Array.of(latitude, latitude + latitudeSpacing * 0.61);
const geometry = sequence.prepareSamplingGeometry(sampleLongitudes, sampleLatitudes);
const frame = sequence.prepareFrame(8.25 / 18);
for (let index = 0; index < sampleLongitudes.length; index++) {
  const direct = frame.sample(sampleLongitudes[index], sampleLatitudes[index], {});
  const prepared = frame.samplePrepared(geometry, index, {});
  assertClose(prepared.rainMmh, direct.rainMmh, `prepared sample ${index}`);
  assertClose(prepared.storm, 0, `prepared storm ${index}`);
  assertClose(prepared.hail, 0, `prepared hail ${index}`);
}

const endpoint = geographicTemporalFrameAt(1);
if (endpoint.index !== 180 || endpoint.nextIndex !== 180 || endpoint.progress !== 0) throw new Error('terminal renderer keyframe is cyclic.');
const finalSourceFrame = sequence.prepareFrame(1);
if (finalSourceFrame.frame0 !== 18 || finalSourceFrame.frame1 !== 18 || finalSourceFrame.progress !== 0) throw new Error('terminal source frame is cyclic.');

console.log('Real weather sequence verification passed.');
