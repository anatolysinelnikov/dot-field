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

const exactFrame = sequence.exactSourceFrameAt(7);
assertClose(exactFrame.rawCellAt(longitude, latitude).mmh, sourceValue(7, longitudeIndex, latitudeIndex), 'exact source frame');
if (exactFrame.timestamp !== timestamps[7]) throw new Error('exact source frame timestamp is not preserved.');
if (sequence.exactSourceFrameAt(7) !== exactFrame) throw new Error('exact source frame cache is not reused.');
if (exactFrame.longitudes !== sequence.longitudes || exactFrame.latitudes !== sequence.latitudes) throw new Error('exact source frame duplicated spatial axes.');

const endpoint = geographicTemporalFrameAt(1);
if (endpoint.index !== 180 || endpoint.nextIndex !== 180 || endpoint.progress !== 0) throw new Error('terminal renderer keyframe is cyclic.');
const finalSourceFrame = sequence.prepareFrame(1);
if (finalSourceFrame.frame0 !== 18 || finalSourceFrame.frame1 !== 18 || finalSourceFrame.progress !== 0) throw new Error('terminal source frame is cyclic.');

const firstWetSourceIndex = rainFramesMmh.findIndex((value) => value > 0);
const wetLongitudeIndex = firstWetSourceIndex % width;
const wetLatitudeIndex = Math.floor(firstWetSourceIndex / width);
const cacheGeometry = sequence.prepareSamplingGeometry(
  Float64Array.of(longitudes[wetLongitudeIndex]),
  Float64Array.of(latitudes[wetLatitudeIndex])
);
const expectedSpatialFrames = new Array(sequence.frameCount);
for (let frameIndex = 0; frameIndex < sequence.frameCount; frameIndex++) {
  expectedSpatialFrames[frameIndex] = Float64Array.from(
    sequence.prepareFrame(frameIndex / (sequence.frameCount - 1)).preparedSourceFrame(cacheGeometry, frameIndex)
  );
}
if (cacheGeometry.spatialRainCache.size > 4) throw new Error('spatial rain cache exceeded its four-frame bound.');
if (cacheGeometry.spatialRainCache.size !== 4) throw new Error('full source-frame traversal did not retain the four most recent spatial frames.');
const cachedFrame = sequence.prepareFrame(7 / 18).preparedSourceFrame(cacheGeometry, 7);
const refreshedCachedFrame = sequence.prepareFrame(7 / 18).preparedSourceFrame(cacheGeometry, 7);
if (cachedFrame !== refreshedCachedFrame) throw new Error('spatial rain cache hit did not return the exact existing Float64Array.');
cacheGeometry.spatialRainCache.clear();
for (const frameIndex of [0, 1, 2, 3]) sequence.prepareFrame(frameIndex / 18).preparedSourceFrame(cacheGeometry, frameIndex);
const refreshedFirstFrame = sequence.prepareFrame(0).preparedSourceFrame(cacheGeometry, 0);
sequence.prepareFrame(4 / 18).preparedSourceFrame(cacheGeometry, 4);
if (!cacheGeometry.spatialRainCache.has(0) || cacheGeometry.spatialRainCache.has(1) || refreshedFirstFrame !== cacheGeometry.spatialRainCache.get(0)) {
  throw new Error('spatial rain cache hit did not refresh LRU recency.');
}
for (const frameIndex of [0, 9, 18, 1, 17, 2, 16, 3, 15, 4, 14]) {
  sequence.prepareFrame(frameIndex / 18).preparedSourceFrame(cacheGeometry, frameIndex);
}
const recomputedFrame = sequence.prepareFrame(0).preparedSourceFrame(cacheGeometry, 0);
if (!recomputedFrame.every((value, index) => value === expectedSpatialFrames[0][index])) {
  throw new Error('evicted spatial source frame did not reproduce exact Float64 values.');
}
if (cacheGeometry.spatialRainCache.size > 4) throw new Error('wide scrub exceeded the spatial rain cache bound.');
const terminalBatch = finalSourceFrame.samplePreparedBatch(cacheGeometry);
const terminalFrame = finalSourceFrame.preparedSourceFrame(cacheGeometry, 18);
if (terminalBatch[0] !== terminalFrame[0]) throw new Error('terminal frame did not use the identical source-frame cache value.');

console.log('Real weather sequence verification passed.');
