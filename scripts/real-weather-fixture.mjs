import { readFile } from 'node:fs/promises';
import { decodePackedWeatherSupport, RealWeatherSequence } from '../src/engine/real-weather.js';

export async function loadRealWeatherFixture({ sourceFrameCacheLimit = 19, retainAllSourceFrames = false } = {}) {
  const root = new URL('../data/generated/current/', import.meta.url);
  const metadata = JSON.parse(await readFile(new URL('metadata.json', root), 'utf8'));
  const grid = metadata.spatial_grid;
  const frameSize = grid.width * grid.height;
  const buffers = await Promise.all(metadata.rain.frame_assets.map((asset) => readFile(new URL(asset, root))));
  const sourceFrames = new Map(buffers.map((buffer, index) => [
    index,
    new Float32Array(buffer.buffer, buffer.byteOffset, buffer.byteLength / Float32Array.BYTES_PER_ELEMENT)
  ]));
  const phenomenaFrames = new Map();
  if (metadata.phenomena?.available) {
    const phenomenaBuffers = await Promise.all(metadata.phenomena.frame_assets.map((asset) => readFile(new URL(asset, root))));
    for (const [index, buffer] of phenomenaBuffers.entries()) {
      phenomenaFrames.set(index, new Uint8Array(buffer.buffer, buffer.byteOffset, buffer.byteLength));
    }
  }
  const support = await readFile(new URL(metadata.support_mask.asset, root));
  const weather = new RealWeatherSequence({
    longitudes: Float64Array.from({ length: grid.width }, (_, index) => grid.longitude_start + index * grid.longitude_spacing),
    latitudes: Float64Array.from({ length: grid.height }, (_, index) => grid.latitude_start + index * grid.latitude_spacing),
    sourceFrames, frameCount: metadata.time.count,
    longitudeSpacing: grid.longitude_spacing, latitudeSpacing: grid.latitude_spacing,
    weatherSupport: grid.weather_support,
    timestamps: metadata.time.timestamps,
    potentialWeatherMask: decodePackedWeatherSupport(support.buffer.slice(support.byteOffset, support.byteOffset + support.byteLength), frameSize),
    phenomenaFrames: metadata.phenomena?.available ? phenomenaFrames : null,
    phenomenaAvailable: metadata.phenomena?.available === true,
    sourceFrameCacheLimit, retainAllSourceFrames
  });
  return { metadata, weather, sourceFrames };
}
