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
const MAX_CANONICAL_COORDINATE = 2 ** 15;

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

// Choose one useful fixed footprint from the global canonical camera
// coordinate. The footprint is centered on the camera after snapping its
// origin to an L10 interval. chunkX/Y are those integer L10-origin
// coordinates, not viewport pixels. The returned key is stable under camera
// motion; only a new experiment session can select another key.
export function fixedL13ChunkForCenter(center, extentL10 = GPU_WEATHER_L13_CHUNK_EXTENT_L10) {
  if (!Array.isArray(center) || center.length !== 2) throw new TypeError('Chunk center must be [longitude, latitude].');
  if (!Number.isInteger(extentL10) || extentL10 <= 0) throw new RangeError('Chunk extent must be a positive integer.');
  const [mercatorX, mercatorY] = lngLatToMercator(center[0], center[1]);
  const canonicalX = Math.max(0, Math.min(MAX_CANONICAL_COORDINATE - 1, Math.floor(mercatorX * MAX_CANONICAL_COORDINATE)));
  const canonicalY = Math.max(0, Math.min(MAX_CANONICAL_COORDINATE - 1, Math.floor(mercatorY * MAX_CANONICAL_COORDINATE)));
  const span = extentL10 * L10_CANONICAL_INTERVAL_L15;
  const originX = Math.max(0, Math.min(MAX_CANONICAL_COORDINATE - span,
    Math.floor((canonicalX - span / 2) / L10_CANONICAL_INTERVAL_L15) * L10_CANONICAL_INTERVAL_L15));
  const originY = Math.max(0, Math.min(MAX_CANONICAL_COORDINATE - span,
    Math.floor((canonicalY - span / 2) / L10_CANONICAL_INTERVAL_L15) * L10_CANONICAL_INTERVAL_L15));
  const chunkX = originX / L10_CANONICAL_INTERVAL_L15;
  const chunkY = originY / L10_CANONICAL_INTERVAL_L15;
  const requestedBounds = Object.freeze({
    minX: originX,
    maxX: Math.min(MAX_CANONICAL_COORDINATE, originX + span),
    minY: originY,
    maxY: Math.min(MAX_CANONICAL_COORDINATE, originY + span)
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

export function fixedL13ChunkSampleIdentity(levelData) {
  return sampleIdentity(levelData);
}
