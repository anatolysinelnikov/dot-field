import { WEATHER_SUPPORT } from './geography.js';
import { clamp } from './math.js';

// MapLibre's world is 512 CSS pixels wide at zoom 0. A dyadic grid step of
// 1 / 2^level therefore has this nominal screen spacing at a given zoom.
export const MERCATOR_WORLD_SIZE = 512;
export const TARGET_GRID_SPACING = 9;
export const MIN_GRID_LEVEL = 8;
export const MAX_GRID_LEVEL = 15;
export const HAZARD_ANALYSIS_LEVEL = 13;

const MAX_GRID_SIZE = 2 ** MAX_GRID_LEVEL;
const MAX_MERCATOR_LATITUDE = 85.05112878;

export function lngLatToMercator(longitude, latitude) {
  const clampedLatitude = clamp(latitude, -MAX_MERCATOR_LATITUDE, MAX_MERCATOR_LATITUDE);
  const latitudeRadians = clampedLatitude * Math.PI / 180;
  return [
    (longitude + 180) / 360,
    (1 - Math.log(Math.tan(Math.PI / 4 + latitudeRadians / 2)) / Math.PI) / 2
  ];
}

export function mercatorToLngLat(x, y) {
  return [
    x * 360 - 180,
    Math.atan(Math.sinh(Math.PI * (1 - 2 * y))) * 180 / Math.PI
  ];
}

function supportMercatorBounds() {
  const [west] = lngLatToMercator(WEATHER_SUPPORT.west, WEATHER_SUPPORT.south);
  const [east] = lngLatToMercator(WEATHER_SUPPORT.east, WEATHER_SUPPORT.north);
  const [, north] = lngLatToMercator(WEATHER_SUPPORT.west, WEATHER_SUPPORT.north);
  const [, south] = lngLatToMercator(WEATHER_SUPPORT.east, WEATHER_SUPPORT.south);
  return { minX: Math.min(west, east), maxX: Math.max(west, east), minY: Math.min(north, south), maxY: Math.max(north, south) };
}

const supportBounds = supportMercatorBounds();
// Express the conservative support envelope once at the canonical resolution.
// Selecting every level from these coordinates keeps an active coarse point in
// every finer selection, including the support-boundary overscan.
const canonicalSupport = Object.freeze({
  minX: Math.max(0, Math.floor(supportBounds.minX * MAX_GRID_SIZE) - 1),
  maxX: Math.min(MAX_GRID_SIZE, Math.ceil(supportBounds.maxX * MAX_GRID_SIZE) + 1),
  minY: Math.max(0, Math.floor(supportBounds.minY * MAX_GRID_SIZE) - 1),
  maxY: Math.min(MAX_GRID_SIZE, Math.ceil(supportBounds.maxY * MAX_GRID_SIZE) + 1)
});

// Choose the nearest dyadic step to the requested CSS-pixel density. This
// depends only on zoom, so map navigation and projection never reseat samples.
export function zoomToMercatorGridLevel(zoom) {
  const desired = Number(zoom) + Math.log2(MERCATOR_WORLD_SIZE / TARGET_GRID_SPACING);
  return clamp(Math.round(desired), MIN_GRID_LEVEL, MAX_GRID_LEVEL);
}

export function selectMercatorGridSamples(level) {
  const boundedLevel = clamp(level, MIN_GRID_LEVEL, MAX_GRID_LEVEL);
  const gridSize = 2 ** boundedLevel;
  const step = 1 / gridSize;
  const identityScale = 2 ** (MAX_GRID_LEVEL - boundedLevel);
  const minI = Math.ceil(canonicalSupport.minX / identityScale);
  const maxI = Math.floor(canonicalSupport.maxX / identityScale);
  const minJ = Math.ceil(canonicalSupport.minY / identityScale);
  const maxJ = Math.floor(canonicalSupport.maxY / identityScale);
  const samples = [];

  for (let j = minJ; j <= maxJ; j++) {
    for (let i = minI; i <= maxI; i++) {
      const x = i * step;
      const y = j * step;
      const canonicalX = i * identityScale;
      const canonicalY = j * identityScale;
      samples.push({
        // Max-resolution integer coordinates give a single compact identity
        // to a point shared by every coarser dyadic level.
        id: `${canonicalX}:${canonicalY}`,
        canonicalX,
        canonicalY,
        mercator: [x, y],
        lngLat: mercatorToLngLat(x, y),
        level: boundedLevel,
        spacing: step
      });
    }
  }
  return { samples, level: boundedLevel, gridSize, spacing: step };
}

// Map native grid probes to the nearest active display vertex using canonical
// integer coordinates. Clamping at the rectangular support edge means every
// native probe remains represented when a display level becomes coarser.
export function groupNativeSamplesByDisplaySample(displaySamples, nativeSamples) {
  if (!displaySamples.length || !nativeSamples.length) return new Map();
  const displayLevel = displaySamples[0].level;
  const nativeLevel = nativeSamples[0].level;
  if (nativeLevel < displayLevel) throw new Error('Native hazard level must not be coarser than the display level.');
  // Canonical coordinates are expressed at MAX_GRID_LEVEL, so the nearest
  // parent must be aligned to the active display level's canonical step.
  const scale = 2 ** (MAX_GRID_LEVEL - displayLevel);
  const ids = new Map(displaySamples.map((sample) => [sample.id, sample]));
  const minX = Math.min(...displaySamples.map((sample) => sample.canonicalX));
  const maxX = Math.max(...displaySamples.map((sample) => sample.canonicalX));
  const minY = Math.min(...displaySamples.map((sample) => sample.canonicalY));
  const maxY = Math.max(...displaySamples.map((sample) => sample.canonicalY));
  const groups = new Map();

  for (const probe of nativeSamples) {
    const canonicalX = clamp(Math.round(probe.canonicalX / scale) * scale, minX, maxX);
    const canonicalY = clamp(Math.round(probe.canonicalY / scale) * scale, minY, maxY);
    const parent = ids.get(`${canonicalX}:${canonicalY}`);
    if (!parent) throw new Error('Native hazard probe could not be assigned to the active display grid.');
    const group = groups.get(parent.id) || [];
    group.push(probe);
    groups.set(parent.id, group);
  }
  return groups;
}
