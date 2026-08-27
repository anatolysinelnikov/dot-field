import { WEATHER_SUPPORT } from './geography.js';
import { clamp } from './math.js';

// MapLibre's world is 512 CSS pixels wide at zoom 0. A dyadic grid step of
// 1 / 2^level therefore has this nominal screen spacing at a given zoom.
export const MERCATOR_WORLD_SIZE = 512;
export const TARGET_GRID_SPACING = 9;
export const MIN_GRID_LEVEL = 10;
export const MAX_GRID_LEVEL = 15;
// The discrete renderers materialize only the active canonical window. This is
// independent from the physical weather reference level.
export const MAX_DISPLAY_GRID_LEVEL = 15;

const LOD_LEVEL_OFFSET = Math.log2(MERCATOR_WORLD_SIZE / TARGET_GRID_SPACING);
// The rounded zoom mapping first reaches the next level at N + 0.5.
export const MAX_LOGICAL_SAMPLING_ZOOM = MAX_DISPLAY_GRID_LEVEL + 0.5 - LOD_LEVEL_OFFSET;

const MAX_GRID_SIZE = 2 ** MAX_GRID_LEVEL;
const MAX_MERCATOR_LATITUDE = 85.05112878;
const COARSE_CANONICAL_STEP = 2 ** (MAX_GRID_LEVEL - MIN_GRID_LEVEL);
const COARSE_MERCATOR_STEP = 1 / 2 ** MIN_GRID_LEVEL;
const DEFAULT_TOPOLOGY_MIN_LEVEL = 13;
const DEFAULT_TOPOLOGY_MAX_LEVEL = 13;
const now = () => globalThis.performance?.now?.() ?? Date.now();

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
    mercatorXToLongitude(x),
    mercatorYToLatitude(y)
  ];
}

export function mercatorXToLongitude(x) {
  return x * 360 - 180;
}

export function mercatorYToLatitude(y) {
  return Math.atan(Math.sinh(Math.PI * (1 - 2 * y))) * 180 / Math.PI;
}

function latitudeCosine(latitude) {
  return Math.max(0.001, Math.cos(latitude * Math.PI / 180));
}

// MapLibre Globe's latitude adjustment is kept here so logical zoom tracking
// and the raw camera limit use exactly the same correction.
export function logicalZoomLatitudeAdjustment(newLatitude, oldLatitude) {
  return Math.log2(latitudeCosine(newLatitude) / latitudeCosine(oldLatitude));
}

export function rawZoomForLogicalSamplingZoom(logicalZoom, latitude, referenceLatitude) {
  return logicalZoom + logicalZoomLatitudeAdjustment(latitude, referenceLatitude);
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

function finiteCanonicalCoordinate(value, name) {
  const number = Number(value);
  if (!Number.isFinite(number)) throw new Error(`${name} must be finite.`);
  return number;
}

// Canonical windows are expressed in the globally anchored L15 identity
// coordinate system. The outward snap makes every active boundary compatible
// with the coarsest L10 grid. A caller may pass an already snapped window or
// raw canonical coordinates; both paths remain deterministic.
export function normalizeCanonicalWindow(window = canonicalSupport) {
  if (window === canonicalSupport) return canonicalSupport;
  const minX = finiteCanonicalCoordinate(window.minX, 'canonicalWindow.minX');
  const maxX = finiteCanonicalCoordinate(window.maxX, 'canonicalWindow.maxX');
  const minY = finiteCanonicalCoordinate(window.minY, 'canonicalWindow.minY');
  const maxY = finiteCanonicalCoordinate(window.maxY, 'canonicalWindow.maxY');
  const snapAxis = (rawMin, rawMax, supportMin, supportMax) => {
    const snappedMin = Math.max(supportMin, Math.floor(rawMin / COARSE_CANONICAL_STEP) * COARSE_CANONICAL_STEP);
    const snappedMax = Math.min(supportMax, Math.ceil(rawMax / COARSE_CANONICAL_STEP) * COARSE_CANONICAL_STEP);
    if (snappedMax >= snappedMin) return [snappedMin, snappedMax];
    // A camera can be panned entirely outside the finite provider data domain.
    // Keep a valid one-cell topology at the nearest supported edge so an
    // off-domain viewport never creates an invalid or exception path.
    if (rawMax < supportMin) {
      const edge = Math.ceil(supportMin / COARSE_CANONICAL_STEP) * COARSE_CANONICAL_STEP;
      return [edge, edge];
    }
    if (rawMin > supportMax) {
      const edge = Math.floor(supportMax / COARSE_CANONICAL_STEP) * COARSE_CANONICAL_STEP;
      return [edge, edge];
    }
    throw new Error('canonicalWindow must have non-empty bounds.');
  };
  const [snappedMinX, snappedMaxX] = snapAxis(minX, maxX, canonicalSupport.minX, canonicalSupport.maxX);
  const [snappedMinY, snappedMaxY] = snapAxis(minY, maxY, canonicalSupport.minY, canonicalSupport.maxY);
  const snapped = { minX: snappedMinX, maxX: snappedMaxX, minY: snappedMinY, maxY: snappedMaxY };
  return Object.freeze(snapped);
}

export function canonicalWindowsEqual(left, right) {
  return Boolean(left && right)
    && left.minX === right.minX && left.maxX === right.maxX
    && left.minY === right.minY && left.maxY === right.maxY;
}

export function normalizeLodRange(range = { minLevel: DEFAULT_TOPOLOGY_MIN_LEVEL, maxLevel: DEFAULT_TOPOLOGY_MAX_LEVEL }) {
  const minLevel = Number(range.minLevel);
  const maxLevel = Number(range.maxLevel);
  if (!Number.isInteger(minLevel) || !Number.isInteger(maxLevel)
    || minLevel < MIN_GRID_LEVEL || maxLevel > MAX_DISPLAY_GRID_LEVEL || maxLevel < minLevel) {
    throw new Error(`LOD range must be contiguous and between L${MIN_GRID_LEVEL} and L${MAX_DISPLAY_GRID_LEVEL}.`);
  }
  return Object.freeze({ minLevel, maxLevel });
}

export function lodRangesEqual(left, right) {
  return Boolean(left && right) && left.minLevel === right.minLevel && left.maxLevel === right.maxLevel;
}

export function lodRangeForStableLevel(level) {
  const stableLevel = Number(level);
  if (!Number.isInteger(stableLevel) || stableLevel < MIN_GRID_LEVEL || stableLevel > MAX_DISPLAY_GRID_LEVEL) {
    throw new Error(`Stable LOD must be between L${MIN_GRID_LEVEL} and L${MAX_DISPLAY_GRID_LEVEL}.`);
  }
  if (stableLevel <= 11) return normalizeLodRange({ minLevel: 10, maxLevel: 13 });
  if (stableLevel === 12) return normalizeLodRange({ minLevel: 11, maxLevel: 13 });
  if (stableLevel === 13) return normalizeLodRange({ minLevel: 12, maxLevel: 14 });
  if (stableLevel === 14) return normalizeLodRange({ minLevel: 13, maxLevel: 15 });
  return normalizeLodRange({ minLevel: 14, maxLevel: 15 });
}

// Convert an application-owned visible Mercator envelope to a deterministic
// active topology window. The 25% envelope expansion is viewport overscan;
// one additional L10 interval protects centered coarse aggregation at the
// active boundary. The result is then snapped outward to L10 boundaries.
export function canonicalWindowFromMercatorBounds(bounds) {
  const minX = finiteCanonicalCoordinate(bounds.minX, 'Mercator bounds.minX');
  const maxX = finiteCanonicalCoordinate(bounds.maxX, 'Mercator bounds.maxX');
  const minY = finiteCanonicalCoordinate(bounds.minY, 'Mercator bounds.minY');
  const maxY = finiteCanonicalCoordinate(bounds.maxY, 'Mercator bounds.maxY');
  const spanX = Math.max(maxX - minX, 1 / MAX_GRID_SIZE);
  const spanY = Math.max(maxY - minY, 1 / MAX_GRID_SIZE);
  return normalizeCanonicalWindow({
    minX: (minX - spanX * 0.25 - COARSE_MERCATOR_STEP) * MAX_GRID_SIZE,
    maxX: (maxX + spanX * 0.25 + COARSE_MERCATOR_STEP) * MAX_GRID_SIZE,
    minY: (minY - spanY * 0.25 - COARSE_MERCATOR_STEP) * MAX_GRID_SIZE,
    maxY: (maxY + spanY * 0.25 + COARSE_MERCATOR_STEP) * MAX_GRID_SIZE
  });
}

// Choose the nearest dyadic step to the requested CSS-pixel density. This
// depends only on zoom, so map navigation and projection never reseat samples.
export function zoomToMercatorGridLevel(zoom) {
  const boundedZoom = Math.min(Number(zoom), MAX_LOGICAL_SAMPLING_ZOOM);
  const desired = boundedZoom + LOD_LEVEL_OFFSET;
  return clamp(Math.round(desired), MIN_GRID_LEVEL, MAX_DISPLAY_GRID_LEVEL);
}

export function selectMercatorGridLevel(level, canonicalWindow = canonicalSupport) {
  const boundedLevel = clamp(level, MIN_GRID_LEVEL, MAX_GRID_LEVEL);
  const window = normalizeCanonicalWindow(canonicalWindow);
  const gridSize = 2 ** boundedLevel;
  const step = 1 / gridSize;
  const identityScale = 2 ** (MAX_GRID_LEVEL - boundedLevel);
  const minI = Math.ceil(window.minX / identityScale);
  const maxI = Math.floor(window.maxX / identityScale);
  const minJ = Math.ceil(window.minY / identityScale);
  const maxJ = Math.floor(window.maxY / identityScale);
  const width = Math.max(0, maxI - minI + 1);
  const height = Math.max(0, maxJ - minJ + 1);
  const count = width * height;
  const canonicalAnchors = new Float64Array(count * 2);
  for (let index = 0; index < count; index++) {
    const i = minI + index % width;
    const j = minJ + Math.floor(index / width);
    canonicalAnchors[index * 2] = i * step;
    canonicalAnchors[index * 2 + 1] = j * step;
  }
  return Object.freeze({
    level: boundedLevel,
    spacing: step,
    gridSize,
    identityScale,
    minI,
    maxI,
    minJ,
    maxJ,
    width,
    height,
    count,
    canonicalWindow: window,
    canonicalAnchors
  });
}

export const selectMercatorGridSamples = selectMercatorGridLevel;

export function canonicalCoordinatesForIndex(levelData, index) {
  if (!Number.isInteger(index) || index < 0 || index >= levelData.count) throw new Error('Level sample index is out of bounds.');
  return {
    canonicalX: canonicalXForIndex(levelData, index),
    canonicalY: canonicalYForIndex(levelData, index)
  };
}

export function canonicalXForIndex(levelData, index) {
  return (levelData.minI + index % levelData.width) * levelData.identityScale;
}

export function canonicalYForIndex(levelData, index) {
  return (levelData.minJ + Math.floor(index / levelData.width)) * levelData.identityScale;
}

export function canonicalIndexForCoordinates(levelData, canonicalX, canonicalY) {
  const i = canonicalX / levelData.identityScale;
  const j = canonicalY / levelData.identityScale;
  if (!Number.isInteger(i) || !Number.isInteger(j)
    || i < levelData.minI || i > levelData.maxI || j < levelData.minJ || j > levelData.maxJ) return -1;
  return (j - levelData.minJ) * levelData.width + i - levelData.minI;
}

function parentIndexForChild(fine, coarse, childIndex) {
  const parentStep = coarse.identityScale;
  const childI = canonicalXForIndex(fine, childIndex) / parentStep;
  const childJ = canonicalYForIndex(fine, childIndex) / parentStep;
  const parentI = Math.max(coarse.minI, Math.min(coarse.maxI, Math.floor(childI)));
  const parentJ = Math.max(coarse.minJ, Math.min(coarse.maxJ, Math.floor(childJ)));
  return (parentJ - coarse.minJ) * coarse.width + parentI - coarse.minI;
}

function buildTransitionParents(fine, coarse) {
  const parentIndexByChild = new Int32Array(fine.count);
  const childCounts = new Uint32Array(coarse.count);
  for (let childIndex = 0; childIndex < fine.count; childIndex++) {
    const parentIndex = parentIndexForChild(fine, coarse, childIndex);
    if (parentIndex < 0 || parentIndex >= coarse.count) throw new Error('Fine Mercator sample has no deterministic transition parent.');
    childCounts[parentIndex]++;
    parentIndexByChild[childIndex] = parentIndex;
  }
  const childOffsets = new Uint32Array(coarse.count + 1);
  for (let parentIndex = 0; parentIndex < coarse.count; parentIndex++) childOffsets[parentIndex + 1] = childOffsets[parentIndex] + childCounts[parentIndex];
  const childIndices = new Uint32Array(fine.count);
  const cursors = childOffsets.slice(0, -1);
  for (let childIndex = 0; childIndex < fine.count; childIndex++) childIndices[cursors[parentIndexByChild[childIndex]]++] = childIndex;
  return { childOffsets, childIndices, parentIndexByChild };
}

function buildDirectPairs(lower, higher) {
  const pairs = new Int32Array((lower.count + higher.count) * 2);
  let cursor = 0;
  for (let index = 0; index < lower.count; index++) {
    const canonicalX = canonicalXForIndex(lower, index);
    const canonicalY = canonicalYForIndex(lower, index);
    pairs[cursor++] = index;
    pairs[cursor++] = canonicalIndexForCoordinates(higher, canonicalX, canonicalY);
  }
  for (let index = 0; index < higher.count; index++) {
    const canonicalX = canonicalXForIndex(higher, index);
    const canonicalY = canonicalYForIndex(higher, index);
    if (canonicalIndexForCoordinates(lower, canonicalX, canonicalY) >= 0) continue;
    pairs[cursor++] = -1;
    pairs[cursor++] = index;
  }
  return pairs.slice(0, cursor);
}

// Canonical positions and one-parent ownership for visual LOD morphs. This is
// deliberately independent from centered weather-summary contributions.
export class GeographicLodTopology {
  constructor(canonicalWindow = canonicalSupport, levelRange) {
    const topologyStarted = now();
    this.canonicalWindow = normalizeCanonicalWindow(canonicalWindow);
    this.levelRange = normalizeLodRange(levelRange);
    this.levels = new Map();
    this.constructionTimings = { levels: [], transitionParentsMs: 0, directPairsMs: 0, totalMs: 0 };
    for (let level = this.levelRange.minLevel; level <= this.levelRange.maxLevel; level++) {
      const levelStarted = now();
      this.levels.set(level, selectMercatorGridLevel(level, this.canonicalWindow));
      this.constructionTimings.levels.push({ level, ms: now() - levelStarted });
    }
    this.transitionParents = new Map();
    const transitionStarted = now();
    for (let level = this.levelRange.minLevel + 1; level <= this.levelRange.maxLevel; level++) {
      this.transitionParents.set(level, buildTransitionParents(this.levels.get(level), this.levels.get(level - 1)));
    }
    this.constructionTimings.transitionParentsMs = now() - transitionStarted;
    this.directPairs = new Map();
    const directPairsStarted = now();
    for (let level = this.levelRange.minLevel + 1; level <= this.levelRange.maxLevel; level++) {
      this.directPairs.set(level, buildDirectPairs(this.levels.get(level - 1), this.levels.get(level)));
    }
    this.constructionTimings.directPairsMs = now() - directPairsStarted;
    this.constructionTimings.totalMs = now() - topologyStarted;
  }

  levelDataFor(level) {
    const levelData = this.levels.get(level);
    if (!levelData) throw new Error(`LOD L${level} is not materialized in the active topology range.`);
    return levelData;
  }

  transitionParentsFor(fineLevel) {
    const parents = this.transitionParents.get(fineLevel);
    if (!parents) throw new Error(`LOD transition parent data for L${fineLevel} is not materialized.`);
    return parents;
  }
  directPairsFor(lowerLevel, higherLevel) {
    if (higherLevel !== lowerLevel + 1) throw new Error('Direct grid pairs require adjacent levels.');
    const pairs = this.directPairs.get(higherLevel);
    if (!pairs) throw new Error(`LOD direct-pair data for L${lowerLevel}↔L${higherLevel} is not materialized.`);
    return pairs;
  }
}
