import { readFile } from 'node:fs/promises';
import {
  GeographicLodTopology,
  setGeographicWeatherSupport
} from '../src/engine/geographic-lod.js';
import {
  fixedL13ChunkForCenter,
  GPU_WEATHER_L13_CHUNK_EXTENT_L10,
  GPU_WEATHER_L13_CHUNK_LEVEL,
  L10_CANONICAL_INTERVAL_L15
} from '../src/engine/gpu-weather-chunk.js';

function check(value, message) {
  if (!value) throw new Error(message);
}

const metadata = JSON.parse(await readFile(new URL('../data/generated/current/metadata.json', import.meta.url)));
setGeographicWeatherSupport(metadata.spatial_grid.weather_support);

const first = fixedL13ChunkForCenter([45.03, 43.35]);
const second = fixedL13ChunkForCenter([45.04, 43.34]);
const span = GPU_WEATHER_L13_CHUNK_EXTENT_L10 * L10_CANONICAL_INTERVAL_L15;
const topology = new GeographicLodTopology(first.canonicalWindow, { minLevel: GPU_WEATHER_L13_CHUNK_LEVEL, maxLevel: GPU_WEATHER_L13_CHUNK_LEVEL });
const levelData = topology.levelDataFor(GPU_WEATHER_L13_CHUNK_LEVEL);

check(first.key === second.key, 'camera movement inside the candidate chunk changed its key');
check(first.level === GPU_WEATHER_L13_CHUNK_LEVEL, 'fixed chunk level changed');
check(first.extentL10 === GPU_WEATHER_L13_CHUNK_EXTENT_L10, 'experimental chunk extent changed');
check(first.canonicalBounds.maxX - first.canonicalBounds.minX === span, 'chunk X extent is not aligned to L10 intervals');
check(first.canonicalBounds.maxY - first.canonicalBounds.minY === span, 'chunk Y extent is not aligned to L10 intervals');
check(first.canonicalBounds.minX % L10_CANONICAL_INTERVAL_L15 === 0
  && first.canonicalBounds.minY % L10_CANONICAL_INTERVAL_L15 === 0, 'chunk origin is not globally anchored');
check(levelData.minI * levelData.identityScale === first.canonicalWindow.minX, 'L13 minimum X lost canonical identity');
check(levelData.minJ * levelData.identityScale === first.canonicalWindow.minY, 'L13 minimum Y lost canonical identity');
check(levelData.width > 0 && levelData.height > 0 && levelData.count === levelData.width * levelData.height, 'fixed L13 descriptor is empty or inconsistent');

console.log(`GPU fixed-L13 chunk verification passed: key=${first.key}, extentL10=${first.extentL10}, dimensions=${levelData.width}x${levelData.height}, samples=${levelData.count}`);
