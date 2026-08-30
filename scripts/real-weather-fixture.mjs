import { readFile } from 'node:fs/promises';
import process from 'node:process';
import { decodePackedWeatherSupport, RealWeatherSequence } from '../src/engine/real-weather.js';

export async function loadRealWeatherFixture({ sourceFrameCacheLimit = 19, retainAllSourceFrames = false } = {}) {
  const currentRoot = new URL('../data/generated/current/', import.meta.url);
  const currentMetadata = JSON.parse(await readFile(new URL('metadata.json', currentRoot), 'utf8'));
  const generationId = process.env.DOT_FIELD_GENERATION || currentMetadata.generation_id;
  if (!generationId) throw new Error('Active metadata has no immutable generation_id.');
  const root = new URL(`../data/generated/${generationId}/`, import.meta.url);
  const metadata = JSON.parse(await readFile(new URL('metadata.json', root), 'utf8'));
  const grid = metadata.spatial_grid;
  const frameSize = grid.width * grid.height;
  const buffers = await Promise.all(metadata.rain.frame_assets.map((asset) => readFile(new URL(asset, root))));
  const sourceFrames = new Map(buffers.map((buffer, index) => [
    index,
    new Float32Array(buffer.buffer, buffer.byteOffset, buffer.byteLength / Float32Array.BYTES_PER_ELEMENT)
  ]));
  const support = await readFile(new URL(metadata.support_mask.asset, root));
  const motion = metadata.motion ? {
    width: metadata.motion.grid_width,
    height: metadata.motion.grid_height,
    spacing: metadata.motion.grid_spacing_source_nodes,
    intervals: await Promise.all(metadata.motion.interval_assets.map(async (asset) => {
      const buffer = await readFile(new URL(asset, root));
      return new Float32Array(buffer.buffer, buffer.byteOffset, buffer.byteLength / Float32Array.BYTES_PER_ELEMENT);
    }))
  } : null;
  const weather = new RealWeatherSequence({
    longitudes: Float64Array.from({ length: grid.width }, (_, index) => grid.longitude_start + index * grid.longitude_spacing),
    latitudes: Float64Array.from({ length: grid.height }, (_, index) => grid.latitude_start + index * grid.latitude_spacing),
    sourceFrames, frameCount: metadata.time.count,
    longitudeSpacing: grid.longitude_spacing, latitudeSpacing: grid.latitude_spacing,
    weatherSupport: grid.weather_support,
    timestamps: metadata.time.timestamps,
    potentialWeatherMask: decodePackedWeatherSupport(support.buffer.slice(support.byteOffset, support.byteOffset + support.byteLength), frameSize),
    motion,
    sourceFrameCacheLimit, retainAllSourceFrames
  });
  return { metadata, weather, sourceFrames };
}
