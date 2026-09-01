// Development-only fixed renderer chunk descriptor. This is deliberately not
// a residency cache: provider temporal tiles remain the existing data units.

import {
  lngLatToMercator,
  normalizeCanonicalWindow
} from './geographic-lod.js';

export const GPU_WEATHER_L13_CHUNK_LEVEL = 13;
// Profiling candidate only. One L10 interval is 2^(15 - 10) L15 units.
export const GPU_WEATHER_L13_CHUNK_EXTENT_L10 = 64;
export const L10_CANONICAL_INTERVAL_L15 = 2 ** (15 - 10);
export const MAX_CANONICAL_COORDINATE_L15 = 2 ** 15;

function integerCoordinate(value, name) {
  if (!Number.isInteger(value)) throw new TypeError(`${name} must be an integer.`);
  return value;
}

function sampleIdentity(levelData) {
  return levelData ? Object.freeze({
    level: levelData.level,
    minI: levelData.minI,
    maxI: levelData.maxI,
    minJ: levelData.minJ,
    maxJ: levelData.maxJ,
    width: levelData.width,
    height: levelData.height,
    count: levelData.count,
    identityScale: levelData.identityScale
  }) : null;
}

function validateExtent(extentL10) {
  if (!Number.isInteger(extentL10) || extentL10 <= 0) throw new RangeError('Chunk extent must be a positive integer.');
  return extentL10;
}

export function gpuWeatherL13ChunkSpanL15(extentL10 = GPU_WEATHER_L13_CHUNK_EXTENT_L10) {
  return validateExtent(extentL10) * L10_CANONICAL_INTERVAL_L15;
}

// The experiment's renderer chunks are cells in a global, non-overlapping
// lattice. chunkX/Y are lattice coordinates, not camera-derived origins.
export function fixedL13ChunkForCell(chunkX, chunkY, extentL10 = GPU_WEATHER_L13_CHUNK_EXTENT_L10) {
  validateExtent(extentL10);
  integerCoordinate(chunkX, 'chunkX');
  integerCoordinate(chunkY, 'chunkY');
  const span = gpuWeatherL13ChunkSpanL15(extentL10);
  const maximumChunkCoordinate = MAX_CANONICAL_COORDINATE_L15 / span - 1;
  if (chunkX < 0 || chunkY < 0 || chunkX > maximumChunkCoordinate || chunkY > maximumChunkCoordinate) {
    throw new RangeError('Chunk lattice coordinate is outside the canonical world.');
  }
  const originX = chunkX * span;
  const originY = chunkY * span;
  const requestedBounds = Object.freeze({
    minX: originX,
    maxX: Math.min(MAX_CANONICAL_COORDINATE_L15, originX + span),
    minY: originY,
    maxY: Math.min(MAX_CANONICAL_COORDINATE_L15, originY + span)
  });
  const canonicalWindow = normalizeCanonicalWindow(requestedBounds);
  return Object.freeze({
    level: GPU_WEATHER_L13_CHUNK_LEVEL,
    chunkX: integerCoordinate(chunkX, 'chunkX'),
    chunkY: integerCoordinate(chunkY, 'chunkY'),
    extentL10,
    canonicalBounds: requestedBounds,
    canonicalWindow,
    key: `${GPU_WEATHER_L13_CHUNK_LEVEL}/${chunkX}/${chunkY}`
  });
}

// Resolve a world location to its globally fixed chunk cell. The center is
// used only as a lookup coordinate; it never recenters or reshapes the cell.
export function fixedL13ChunkForCenter(center, extentL10 = GPU_WEATHER_L13_CHUNK_EXTENT_L10) {
  if (!Array.isArray(center) || center.length !== 2) throw new TypeError('Chunk center must be [longitude, latitude].');
  const [mercatorX, mercatorY] = lngLatToMercator(center[0], center[1]);
  const span = gpuWeatherL13ChunkSpanL15(extentL10);
  const canonicalX = Math.max(0, Math.min(MAX_CANONICAL_COORDINATE_L15 - 1, Math.floor(mercatorX * MAX_CANONICAL_COORDINATE_L15)));
  const canonicalY = Math.max(0, Math.min(MAX_CANONICAL_COORDINATE_L15 - 1, Math.floor(mercatorY * MAX_CANONICAL_COORDINATE_L15)));
  return fixedL13ChunkForCell(
    Math.min(MAX_CANONICAL_COORDINATE_L15 / span - 1, Math.floor(canonicalX / span)),
    Math.min(MAX_CANONICAL_COORDINATE_L15 / span - 1, Math.floor(canonicalY / span)),
    extentL10
  );
}

export function fixedL13ChunksForCanonicalWindow(window, extentL10 = GPU_WEATHER_L13_CHUNK_EXTENT_L10) {
  const span = gpuWeatherL13ChunkSpanL15(extentL10);
  const normalized = normalizeCanonicalWindow(window);
  const maximumChunkCoordinate = MAX_CANONICAL_COORDINATE_L15 / span - 1;
  const minChunkX = Math.max(0, Math.min(maximumChunkCoordinate, Math.floor(normalized.minX / span)));
  const maxChunkX = Math.max(0, Math.min(maximumChunkCoordinate, Math.floor(normalized.maxX / span)));
  const minChunkY = Math.max(0, Math.min(maximumChunkCoordinate, Math.floor(normalized.minY / span)));
  const maxChunkY = Math.max(0, Math.min(maximumChunkCoordinate, Math.floor(normalized.maxY / span)));
  const chunks = [];
  for (let chunkY = minChunkY; chunkY <= maxChunkY; chunkY++) {
    for (let chunkX = minChunkX; chunkX <= maxChunkX; chunkX++) {
      chunks.push(fixedL13ChunkForCell(chunkX, chunkY, extentL10));
    }
  }
  return chunks;
}

export function fixedL13ChunkKeysForCanonicalWindow(window, extentL10 = GPU_WEATHER_L13_CHUNK_EXTENT_L10) {
  return fixedL13ChunksForCanonicalWindow(window, extentL10).map((chunk) => chunk.key);
}

// Presentation uses half-open ownership on non-terminal chunk edges. The
// physical target still contains every boundary sample for reconstruction.
export function fixedL13ChunkPresentationBounds(levelData, descriptor) {
  if (!levelData || !descriptor) return null;
  return Object.freeze({
    minI: Math.max(levelData.minI, Math.ceil(descriptor.canonicalBounds.minX / levelData.identityScale)),
    maxI: Math.min(levelData.maxI, descriptor.canonicalBounds.maxX === MAX_CANONICAL_COORDINATE_L15
      ? levelData.maxI : Math.ceil(descriptor.canonicalBounds.maxX / levelData.identityScale) - 1),
    minJ: Math.max(levelData.minJ, Math.ceil(descriptor.canonicalBounds.minY / levelData.identityScale)),
    maxJ: Math.min(levelData.maxJ, descriptor.canonicalBounds.maxY === MAX_CANONICAL_COORDINATE_L15
      ? levelData.maxJ : Math.ceil(descriptor.canonicalBounds.maxY / levelData.identityScale) - 1)
  });
}

export function fixedL13ChunkPresentationSampleIds(levelData, descriptor) {
  const ownership = fixedL13ChunkPresentationBounds(levelData, descriptor);
  if (!ownership) return [];
  const ids = [];
  for (let row = 0; row < levelData.height; row++) {
    const canonicalY = (levelData.minJ + row) * levelData.identityScale;
    if (levelData.minJ + row < ownership.minJ || levelData.minJ + row > ownership.maxJ) continue;
    for (let column = 0; column < levelData.width; column++) {
      const canonicalX = (levelData.minI + column) * levelData.identityScale;
      if (levelData.minI + column < ownership.minI || levelData.minI + column > ownership.maxI) continue;
      ids.push(`${canonicalX},${canonicalY}`);
    }
  }
  return ids;
}

export function fixedL13ChunkSampleIdentity(levelData) {
  return sampleIdentity(levelData);
}
