import { readFile } from 'node:fs/promises';
import {
  GeographicLodTopology,
  lngLatToMercator,
  setGeographicWeatherSupport
} from '../src/engine/geographic-lod.js';
import {
  fixedL13ChunkForCenter,
  fixedL13ChunkForCell,
  fixedL13ChunkKeysForCanonicalWindow,
  fixedL13ChunksForCanonicalWindow,
  fixedL13ChunkPresentationSampleIds,
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

const [mercatorX, mercatorY] = lngLatToMercator(45.03, 43.35);
const canonicalWindow = {
  minX: Math.floor(mercatorX * 2 ** 15) - span,
  maxX: Math.floor(mercatorX * 2 ** 15) + span,
  minY: Math.floor(mercatorY * 2 ** 15) - span / 2,
  maxY: Math.floor(mercatorY * 2 ** 15) + span / 2
};
const selected = fixedL13ChunksForCanonicalWindow(canonicalWindow);
const repeat = fixedL13ChunksForCanonicalWindow(canonicalWindow);
check(fixedL13ChunkKeysForCanonicalWindow(canonicalWindow).join(',') === selected.map((chunk) => chunk.key).join(','), 'chunk selection key order is deterministic');
check(selected.map((chunk) => chunk.key).join(',') === repeat.map((chunk) => chunk.key).join(','), 'identical world windows produce identical ordered chunk-key sets');
check(selected.every((chunk) => chunk.canonicalBounds.minX % span === 0 && chunk.canonicalBounds.minY % span === 0), 'all selected chunk boundaries use the global full-span lattice');
check(fixedL13ChunkForCell(first.chunkX, first.chunkY).key === first.key, 'chunk cell identity is deterministic and viewport-independent');

const adjacentLeft = fixedL13ChunkForCell(first.chunkX, first.chunkY);
const adjacentRight = fixedL13ChunkForCell(first.chunkX + 1, first.chunkY);
const leftTopology = new GeographicLodTopology(adjacentLeft.canonicalWindow, { minLevel: GPU_WEATHER_L13_CHUNK_LEVEL, maxLevel: GPU_WEATHER_L13_CHUNK_LEVEL });
const rightTopology = new GeographicLodTopology(adjacentRight.canonicalWindow, { minLevel: GPU_WEATHER_L13_CHUNK_LEVEL, maxLevel: GPU_WEATHER_L13_CHUNK_LEVEL });
const leftIds = fixedL13ChunkPresentationSampleIds(leftTopology.levelDataFor(GPU_WEATHER_L13_CHUNK_LEVEL), adjacentLeft);
const rightIds = fixedL13ChunkPresentationSampleIds(rightTopology.levelDataFor(GPU_WEATHER_L13_CHUNK_LEVEL), adjacentRight);
const leftSet = new Set(leftIds);
const rightSet = new Set(rightIds);
const overlap = leftIds.filter((id) => rightSet.has(id));
check(overlap.length === 0, 'adjacent chunks have no duplicate presentation-owned canonical sample IDs');
const seamX = adjacentRight.canonicalBounds.minX;
const seamIds = [];
for (let y = rightTopology.levelDataFor(GPU_WEATHER_L13_CHUNK_LEVEL).minJ; y <= rightTopology.levelDataFor(GPU_WEATHER_L13_CHUNK_LEVEL).maxJ; y++) seamIds.push(`${seamX},${y * rightTopology.levelDataFor(GPU_WEATHER_L13_CHUNK_LEVEL).identityScale}`);
check(seamIds.every((id) => rightSet.has(id) || !leftSet.has(id)), 'adjacent seam samples have exactly one deterministic owner');
check(seamIds.every((id) => rightSet.has(id)), 'no canonical seam sample is missing from presentation ownership');

console.log(`GPU fixed-L13 chunk verification passed: key=${first.key}, extentL10=${first.extentL10}, dimensions=${levelData.width}x${levelData.height}, samples=${levelData.count}`);
