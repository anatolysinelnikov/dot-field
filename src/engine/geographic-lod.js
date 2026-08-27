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
    // A camera can be panned entirely outside the finite compact data domain.
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

export function selectMercatorGridSamples(level, canonicalWindow = canonicalSupport) {
  const boundedLevel = clamp(level, MIN_GRID_LEVEL, MAX_GRID_LEVEL);
  const window = normalizeCanonicalWindow(canonicalWindow);
  const gridSize = 2 ** boundedLevel;
  const step = 1 / gridSize;
  const identityScale = 2 ** (MAX_GRID_LEVEL - boundedLevel);
  const minI = Math.ceil(window.minX / identityScale);
  const maxI = Math.floor(window.maxX / identityScale);
  const minJ = Math.ceil(window.minY / identityScale);
  const maxJ = Math.floor(window.maxY / identityScale);
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

function parentIdFor(child, bounds, parentStep) {
  const x = Math.max(bounds.minX, Math.min(bounds.maxX, Math.floor(child.canonicalX / parentStep) * parentStep));
  const y = Math.max(bounds.minY, Math.min(bounds.maxY, Math.floor(child.canonicalY / parentStep) * parentStep));
  return `${x}:${y}`;
}

function buildTransitionParents(fine, coarse) {
  const samplesById = new Map(coarse.samples.map((sample, index) => [sample.id, index]));
  const bounds = {
    minX: coarse.samples[0].canonicalX,
    maxX: coarse.samples[coarse.samples.length - 1].canonicalX,
    minY: coarse.samples[0].canonicalY,
    maxY: coarse.samples[coarse.samples.length - 1].canonicalY
  };
  const parentStep = 2 ** (MAX_GRID_LEVEL - coarse.level);
  const childIndices = Array.from({ length: coarse.samples.length }, () => []);
  const parentIndexByChild = new Int32Array(fine.samples.length);
  for (let childIndex = 0; childIndex < fine.samples.length; childIndex++) {
    const parentIndex = samplesById.get(parentIdFor(fine.samples[childIndex], bounds, parentStep));
    if (parentIndex === undefined) throw new Error('Fine Mercator sample has no deterministic transition parent.');
    childIndices[parentIndex].push(childIndex);
    parentIndexByChild[childIndex] = parentIndex;
  }
  return { childIndices, parentIndexByChild };
}

function buildDirectPairs(lower, higher) {
  const higherIndices = new Map(higher.samples.map((sample, index) => [sample.id, index]));
  const lowerIndices = new Map(lower.samples.map((sample, index) => [sample.id, index]));
  const pairs = [];
  for (let index = 0; index < lower.samples.length; index++) pairs.push(index, higherIndices.get(lower.samples[index].id) ?? -1);
  for (let index = 0; index < higher.samples.length; index++) {
    if (!lowerIndices.has(higher.samples[index].id)) pairs.push(-1, index);
  }
  return new Int32Array(pairs);
}

// Canonical positions and one-parent ownership for visual LOD morphs. This is
// deliberately independent from centered weather-summary contributions.
export class GeographicLodTopology {
  constructor(canonicalWindow = canonicalSupport, levelRange) {
    this.canonicalWindow = normalizeCanonicalWindow(canonicalWindow);
    this.levelRange = normalizeLodRange(levelRange);
    this.levels = new Map();
    for (let level = this.levelRange.minLevel; level <= this.levelRange.maxLevel; level++) {
      const selection = selectMercatorGridSamples(level, this.canonicalWindow);
      const canonicalAnchors = new Float64Array(selection.samples.length * 2);
      for (let index = 0; index < selection.samples.length; index++) {
        canonicalAnchors[index * 2] = selection.samples[index].mercator[0];
        canonicalAnchors[index * 2 + 1] = selection.samples[index].mercator[1];
      }
      this.levels.set(level, {
        level,
        samples: selection.samples,
        samplesById: new Map(selection.samples.map((sample, index) => [sample.id, index])),
        canonicalAnchors
      });
    }
    this.transitionParents = new Map();
    for (let level = this.levelRange.minLevel + 1; level <= this.levelRange.maxLevel; level++) {
      this.transitionParents.set(level, buildTransitionParents(this.levels.get(level), this.levels.get(level - 1)));
    }
    this.directPairs = new Map();
    for (let level = this.levelRange.minLevel + 1; level <= this.levelRange.maxLevel; level++) {
      this.directPairs.set(level, buildDirectPairs(this.levels.get(level - 1), this.levels.get(level)));
    }
  }

  levelDataFor(level) {
    const levelData = this.levels.get(level);
    if (!levelData) throw new Error(`LOD L${level} is not materialized in the active topology range.`);
    return levelData;
  }

  samplesFor(level) { return this.levelDataFor(level).samples; }
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
