import fs from 'node:fs';
import { GeographicDotsLayer, mapDotsWeatherSummary } from '../src/engine/geographic-dots-layer.js';
import { GeographicSquaresLayer, mapSquaresWeatherSummary } from '../src/engine/geographic-squares-layer.js';
import {
  canonicalWindowFromMercatorBounds,
  GeographicLodTopology,
  MAX_GRID_LEVEL,
  MIN_GRID_LEVEL,
  lngLatToMercator,
  mercatorXForIndex,
  mercatorYForIndex,
  normalizeCanonicalWindow,
  lodRangeForStableLevel
} from '../src/engine/geographic-lod.js';
import { prepareGeographicFieldFrame, setActiveWeatherField, WEATHER_REGION } from '../src/engine/geography.js';
import { RealWeatherSequence } from '../src/engine/real-weather.js';
import { buildCenteredContributions, forEachCenteredContributionRelationEntry, GeographicWeatherPyramid } from '../src/engine/geographic-weather-pyramid.js';

const TEMPORAL_FRAME_COUNT = 180;
const LEVELS = [10, 11, 12, 13, 14, 15];
const ACTIVE_STABLE_LEVELS = [10, 11, 12, 13, 14];
const L10_STEP = 2 ** (MAX_GRID_LEVEL - MIN_GRID_LEVEL);
let failures = 0;

function check(condition, message) {
  if (condition) console.log(`PASS ${message}`);
  else { failures++; console.error(`FAIL ${message}`); }
}

function sameArray(left, right) {
  if (!left || !right || left.length !== right.length) return false;
  for (let index = 0; index < left.length; index++) if (left[index] !== right[index]) return false;
  return true;
}

function sameObjectArrays(left, right, names) {
  const scalarNames = names || ['totalWeight', 'rainWeightedSumMmh', 'rainMaxMmh', ...(
    left.profile === 'rain-only-display' ? [] : ['stormCoverageWeight', 'stormWeightedSeverity', 'stormMaxSeverity', 'hailCoverageWeight', 'hailWeightedSeverity', 'hailMaxSeverity']
  )];
  return scalarNames.every((name) => sameArray(left[name], right[name]))
    && left.rainCoverageWeight.length === right.rainCoverageWeight.length
    && left.rainCoverageWeight.every((values, index) => sameArray(values, right.rainCoverageWeight[index]));
}

function samePreparedGeometry(dense, compact) {
  if (!dense?.baseIndex || compact?.kind !== 'compact-rectangular'
    || dense.baseIndex.length !== compact.width * compact.height) return false;
  for (let index = 0; index < dense.baseIndex.length; index++) {
    const column = index % compact.width;
    const row = (index - column) / compact.width;
    const sourceColumn = compact.sourceColumn[column];
    const sourceRowBase = compact.sourceRowBase[row];
    const compactInside = sourceColumn !== 0xffffffff && sourceRowBase !== 0xffffffff;
    const denseBase = dense.baseIndex[index];
    if (compactInside !== (denseBase !== 0xffffffff)) return false;
    if (compactInside && (sourceRowBase + sourceColumn !== denseBase
      || compact.longitudeFraction[column] !== dense.longitudeFraction[index]
      || compact.latitudeFraction[row] !== dense.latitudeFraction[index])) return false;
  }
  return sameArray(dense.potentialActiveIndices, compact.potentialActiveIndices);
}

function installDenseGeometryFallback(pyramid) {
  pyramid.prepareSamplingGeometry = (level, frame) => {
    const existing = pyramid.samplingGeometries.get(level);
    if (existing && frame.isSamplingGeometryCompatible(existing)) return existing;
    const levelData = pyramid.levelDataFor(level);
    const longitudes = new Float64Array(levelData.count);
    const latitudes = new Float64Array(levelData.count);
    for (let index = 0; index < levelData.count; index++) {
      longitudes[index] = mercatorXForIndex(levelData, index) * 360 - 180;
      latitudes[index] = Math.atan(Math.sinh(Math.PI * (1 - 2 * mercatorYForIndex(levelData, index)))) * 180 / Math.PI;
    }
    const mask = weather.potentialWeatherMask;
    weather.potentialWeatherMask = null;
    const geometry = frame.prepareSamplingGeometry(longitudes, latitudes);
    weather.potentialWeatherMask = mask;
    const activeIndices = [];
    for (let index = 0; index < geometry.baseIndex.length; index++) {
      const baseIndex = geometry.baseIndex[index];
      if (baseIndex === 0xffffffff) continue;
      const x1y0 = baseIndex + 1;
      const x0y1 = baseIndex + geometry.sourceWidth;
      const x1y1 = x0y1 + 1;
      if (mask[baseIndex] || mask[x1y0] || mask[x0y1] || mask[x1y1]) activeIndices.push(index);
    }
    geometry.potentialActiveIndices = Uint32Array.from(activeIndices);
    geometry.potentialWeatherMask = mask;
    geometry.spatialRainCache = new Map();
    pyramid.samplingGeometries.set(level, geometry);
    return geometry;
  };
}

function windows(base) {
  const shifts = [[1, 0], [0, 1], [1, 1], [-1, 0], [0, -1], [0, 0]];
  const supportEdges = [
    { minX: base.minX, maxX: base.minX + 3 * L10_STEP, minY: base.minY + L10_STEP, maxY: base.maxY - L10_STEP },
    { minX: base.maxX - 3 * L10_STEP, maxX: base.maxX, minY: base.minY + L10_STEP, maxY: base.maxY - L10_STEP },
    { minX: base.minX + L10_STEP, maxX: base.maxX - L10_STEP, minY: base.minY, maxY: base.minY + 3 * L10_STEP },
    { minX: base.minX + L10_STEP, maxX: base.maxX - L10_STEP, minY: base.maxY - 3 * L10_STEP, maxY: base.maxY },
    { minX: base.minX - 100000, maxX: base.minX - 99900, minY: base.minY, maxY: base.maxY }
  ];
  return [
    ...shifts.map(([x, y]) => normalizeCanonicalWindow({ minX: base.minX + x * L10_STEP, maxX: base.maxX + x * L10_STEP, minY: base.minY + y * L10_STEP, maxY: base.maxY + y * L10_STEP })),
    ...supportEdges.map(normalizeCanonicalWindow)
  ];
}

function compareTopology(oldTopology, optimizedTopology, name) {
  for (const level of LEVELS) {
    const oldLevel = oldTopology.levels.get(level);
    const optimizedLevel = optimizedTopology.levels.get(level);
    check(Boolean(oldLevel) === Boolean(optimizedLevel), `${name} L${level} materialization matches`);
    if (!oldLevel || !optimizedLevel) continue;
    let positionError = 0;
    const count = Math.min(oldLevel.count, optimizedLevel.count);
    for (let index = 0; index < count; index++) {
      positionError = Math.max(positionError,
        Math.abs(mercatorXForIndex(oldLevel, index) - mercatorXForIndex(optimizedLevel, index)),
        Math.abs(mercatorYForIndex(oldLevel, index) - mercatorYForIndex(optimizedLevel, index)));
    }
    check(oldLevel.count === optimizedLevel.count
      && oldLevel.minI === optimizedLevel.minI && oldLevel.maxI === optimizedLevel.maxI
      && oldLevel.minJ === optimizedLevel.minJ && oldLevel.maxJ === optimizedLevel.maxJ
      && positionError === 0, `${name} L${level} packed positions and identities match exactly`);
  }
}

function comparePyramid(oldPyramid, optimizedPyramid, name) {
  for (const level of LEVELS) {
    const oldLevel = oldPyramid.levels.get(level);
    const optimizedLevel = optimizedPyramid.levels.get(level);
    if (!oldLevel || !optimizedLevel) continue;
    if (level >= 11 && level <= 13 && oldPyramid.levels.has(level - 1) && optimizedPyramid.levels.has(level - 1)) {
      const oldContribution = buildCenteredContributions(oldPyramid.levels.get(level), oldPyramid.levels.get(level - 1));
      const optimizedRelation = optimizedPyramid.centeredRelations.get(level);
      let contributionIndex = 0;
      let relationMatches = Boolean(optimizedRelation);
      if (relationMatches) {
        for (let childIndex = 0; childIndex < optimizedRelation.fineWidth * optimizedRelation.fineHeight; childIndex++) {
          forEachCenteredContributionRelationEntry(optimizedRelation, childIndex, (parentIndex, weight) => {
            if (oldContribution.parentIndices[contributionIndex] !== parentIndex || oldContribution.weights[contributionIndex] !== weight) relationMatches = false;
            contributionIndex++;
          });
        }
      }
      check(relationMatches && contributionIndex === oldContribution.parentIndices.length, `${name} L${level} centered relation matches dense reference exactly`);
    }
    const oldWeights = oldPyramid.totalWeights.get(level);
    const optimizedWeights = optimizedPyramid.totalWeights.get(level);
    check(Boolean(oldWeights) === Boolean(optimizedWeights)
      && (!oldWeights || sameArray(oldWeights, optimizedWeights)), `${name} L${level} totalWeight matches exactly`);
  }
}

function compareRendererPacking(oldPyramid, optimizedPyramid, level, oldSummaries, optimizedSummaries, name) {
  const oldDots = mapDotsWeatherSummary(oldSummaries[level]);
  const optimizedDots = mapDotsWeatherSummary(optimizedSummaries[level]);
  const oldSquares = mapSquaresWeatherSummary(oldSummaries[level]);
  const optimizedSquares = mapSquaresWeatherSummary(optimizedSummaries[level]);
  const mappedNames = ['rainRadius', 'strongRadius', 'stormRadius', 'hailRadius'];
  const squareNames = ['rainWetMeanMmh', 'rainCoverage', 'stormCoverage', 'stormMeanSeverity', 'stormMaxSeverity', 'hailCoverage', 'hailMeanSeverity', 'hailMaxSeverity'];
  check(mappedNames.every((key) => sameArray(oldDots[key], optimizedDots[key])), `${name} L${level} Dots mapped values match exactly`);
  check(squareNames.every((key) => sameArray(oldSquares[key], optimizedSquares[key])), `${name} L${level} Squares mapped values match exactly`);

  const makeDots = (pyramid, mapped0, mapped1) => {
    const layer = new GeographicDotsLayer(pyramid);
    layer.active = true; layer.levelData = pyramid.levelDataFor(level);
    layer.temporal = { levels: new Map([[level, { frames0: { mapped: { [level]: mapped0 } }, frames1: { mapped: { [level]: mapped1 } } }]]) };
    layer.rebuildInstances();
    return layer.instances;
  };
  const makeSquares = (pyramid, mapped0, mapped1) => {
    const layer = new GeographicSquaresLayer(pyramid);
    layer.active = true; layer.levelData = pyramid.levelDataFor(level);
    layer.temporal = { levels: new Map([[level, { frames0: { mapped: { [level]: mapped0 } }, frames1: { mapped: { [level]: mapped1 } } }]]) };
    layer.rebuildInstances();
    return layer.instanceData[0].subarray(0, layer.instanceCounts[0] * 18);
  };
  const oldDotsInstances = makeDots(oldPyramid, oldDots, oldDots);
  const optimizedDotsInstances = makeDots(optimizedPyramid, optimizedDots, optimizedDots);
  const oldSquaresInstances = makeSquares(oldPyramid, oldSquares, oldSquares);
  const optimizedSquaresInstances = makeSquares(optimizedPyramid, optimizedSquares, optimizedSquares);
  for (const type of ['rain', 'strong', 'storm', 'hail']) check(sameArray(oldDotsInstances[type], optimizedDotsInstances[type]), `${name} L${level} Dots instances match exactly (${type})`);
  check(sameArray(oldSquaresInstances, optimizedSquaresInstances), `${name} L${level} Squares instances match exactly`);
}

const metadata = JSON.parse(fs.readFileSync(new URL('../data/generated/202608262200/metadata.json', import.meta.url), 'utf8'));
const binary = fs.readFileSync(new URL('../data/generated/202608262200/rain.f32', import.meta.url));
const { width, height, longitude_start: longitudeStart, latitude_start: latitudeStart, longitude_spacing: longitudeSpacing, latitude_spacing: latitudeSpacing } = metadata.spatial_grid;
const weather = new RealWeatherSequence({
  longitudes: Float64Array.from({ length: width }, (_, index) => longitudeStart + index * longitudeSpacing),
  latitudes: Float64Array.from({ length: height }, (_, index) => latitudeStart + index * latitudeSpacing),
  rainFramesMmh: new Float32Array(binary.buffer, binary.byteOffset, binary.byteLength / Float32Array.BYTES_PER_ELEMENT),
  frameCount: metadata.time.count,
  longitudeSpacing,
  latitudeSpacing,
  timestamps: metadata.time.timestamps
});
setActiveWeatherField(weather);
const [centerX, centerY] = lngLatToMercator(...WEATHER_REGION.center);
const base = canonicalWindowFromMercatorBounds({ minX: centerX - 0.004, maxX: centerX + 0.004, minY: centerY - 0.004, maxY: centerY + 0.004 });
const testWindows = windows(base);
const frame0 = prepareGeographicFieldFrame(62 / TEMPORAL_FRAME_COUNT);
const frame1 = prepareGeographicFieldFrame(63 / TEMPORAL_FRAME_COUNT);

for (let windowIndex = 0; windowIndex < testWindows.length; windowIndex++) {
  const window = testWindows[windowIndex];
  for (const stableLevel of ACTIVE_STABLE_LEVELS) {
    const range = lodRangeForStableLevel(stableLevel);
    const oldTopology = new GeographicLodTopology(window, range);
    const optimizedTopology = new GeographicLodTopology(window, range);
    const oldPyramid = new GeographicWeatherPyramid(Float32Array, oldTopology, { reuse: false });
    const optimizedPyramid = new GeographicWeatherPyramid(Float32Array, optimizedTopology, { reuse: true });
    installDenseGeometryFallback(oldPyramid);
    compareTopology(oldTopology, optimizedTopology, `window ${windowIndex} stable L${stableLevel}`);
    comparePyramid(oldPyramid, optimizedPyramid, `window ${windowIndex} stable L${stableLevel}`);
    const referenceLevel = stableLevel <= 13 ? 13 : stableLevel;
    const oldGeometry = oldPyramid.prepareSamplingGeometry(referenceLevel, frame0);
    const optimizedGeometry = optimizedPyramid.prepareSamplingGeometry(referenceLevel, frame0);
    check(samePreparedGeometry(oldGeometry, optimizedGeometry), `window ${windowIndex} stable L${stableLevel} sampling geometry and potential-active set match exactly`);
    const requested = [...Array(range.maxLevel - range.minLevel + 1)].map((_, index) => range.minLevel + index);
    const old0 = oldPyramid.evaluate(requested, frame0);
    const optimized0 = optimizedPyramid.evaluate(requested, frame0);
    const old1 = oldPyramid.evaluate(requested, frame1);
    const optimized1 = optimizedPyramid.evaluate(requested, frame1);
    check(requested.every((level) => sameObjectArrays(old0[level], optimized0[level]) && sameObjectArrays(old1[level], optimized1[level])), `window ${windowIndex} stable L${stableLevel} sampled physical summaries match exactly at two keyframes`);
    compareRendererPacking(oldPyramid, optimizedPyramid, stableLevel, old0, optimized0, `window ${windowIndex}`);
  }
}

console.log(failures ? `VERIFICATION FAILED: ${failures}` : 'VERIFICATION PASSED');
if (failures) process.exitCode = 1;
