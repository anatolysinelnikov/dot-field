import fs from 'node:fs';
import { prepareGeographicFieldFrame, setActiveWeatherField, WEATHER_REGION } from '../src/engine/geography.js';
import { GeographicDotsLayer, mapDotsWeatherSummary } from '../src/engine/geographic-dots-layer.js';
import { GeographicSquaresLayer, mapSquaresWeatherSummary } from '../src/engine/geographic-squares-layer.js';
import {
  GeographicLodTopology,
  MAX_GRID_LEVEL,
  MIN_GRID_LEVEL,
  canonicalWindowFromMercatorBounds,
  canonicalCoordinatesForIndex,
  canonicalIndexForCoordinates,
  lodRangeForStableLevel,
  lngLatToMercator,
  normalizeLodRange
} from '../src/engine/geographic-lod.js';
import { GeographicWeatherPyramid } from '../src/engine/geographic-weather-pyramid.js';
import { parseRealWeatherCsv } from '../src/engine/real-weather.js';
import { geographicTemporalFrameAt } from '../src/engine/geographic-layer-utils.js';

const LEVELS = [10, 11, 12, 13, 14, 15];
const ACTIVE_STABLE_LEVELS = [10, 11, 12, 13, 14];
const L10_STEP = 2 ** (MAX_GRID_LEVEL - MIN_GRID_LEVEL);
const SUMMARY_BYTES_PER_SAMPLE = (3 + 7 + 6) * Float64Array.BYTES_PER_ELEMENT;
const ANCHOR_BYTES_PER_SAMPLE = 2 * Float64Array.BYTES_PER_ELEMENT;
const TOLERANCE = 1e-12;
let failures = 0;

function check(condition, message) {
  if (condition) console.log(`PASS ${message}`);
  else { failures++; console.error(`FAIL ${message}`); }
}

function maxError(left, right) {
  let error = 0;
  for (let index = 0; index < left.length; index++) error = Math.max(error, Math.abs(left[index] - right[index]));
  return error;
}

function sumCounts(topology) {
  return [...topology.levels.values()].reduce((total, levelData) => total + levelData.count, 0);
}

function alignedInteriorWindows(support) {
  const minX = Math.ceil(support.minX / L10_STEP) * L10_STEP;
  const maxX = Math.floor(support.maxX / L10_STEP) * L10_STEP;
  const minY = Math.ceil(support.minY / L10_STEP) * L10_STEP;
  const maxY = Math.floor(support.maxY / L10_STEP) * L10_STEP;
  return [
    { minX, maxX, minY, maxY },
    { minX: minX + L10_STEP, maxX: maxX - L10_STEP, minY: minY + L10_STEP, maxY: maxY - L10_STEP },
    { minX: minX + 2 * L10_STEP, maxX: maxX - 2 * L10_STEP, minY, maxY: maxY - L10_STEP }
  ];
}

function selectionDigest(topology) {
  return LEVELS.flatMap((level) => {
    if (!topology.levels.has(level)) return [];
    const levelData = topology.levelDataFor(level);
    return Array.from({ length: levelData.count }, (_, index) => {
      const { canonicalX, canonicalY } = canonicalCoordinatesForIndex(levelData, index);
      const anchorIndex = index * 2;
      return [level, `${canonicalX}:${canonicalY}`, canonicalX, canonicalY, levelData.canonicalAnchors[anchorIndex], levelData.canonicalAnchors[anchorIndex + 1]];
    });
  });
}

function verifyIdentity(A, B) {
  for (const level of LEVELS) {
    const a = A.levelDataFor(level);
    const b = B.levelDataFor(level);
    let overlap = 0;
    let error = 0;
    for (let index = 0; index < a.count; index++) {
      const { canonicalX, canonicalY } = canonicalCoordinatesForIndex(a, index);
      const otherIndex = canonicalIndexForCoordinates(b, canonicalX, canonicalY);
      if (otherIndex < 0) continue;
      overlap++;
      const anchorIndex = index * 2;
      const otherAnchorIndex = otherIndex * 2;
      error = Math.max(
        error,
        Math.abs(canonicalX - (b.minI + otherIndex % b.width) * b.identityScale),
        Math.abs(canonicalY - (b.minJ + Math.floor(otherIndex / b.width)) * b.identityScale),
        Math.abs(a.canonicalAnchors[anchorIndex] - b.canonicalAnchors[otherAnchorIndex]),
        Math.abs(a.canonicalAnchors[anchorIndex + 1] - b.canonicalAnchors[otherAnchorIndex + 1])
      );
    }
    console.log(`L${level} overlapping canonical samples=${overlap}, identity error=${error}`);
    check(overlap > 0 && error === 0, `A/B overlapping samples preserve exact IDs, coordinates, positions, and levels at L${level}`);
  }
}

function verifyHierarchy(topology, name) {
  const pyramid = new GeographicWeatherPyramid(Float64Array, topology);
  let missingInherited = 0;
  let invalidParents = 0;
  let invalidPairs = 0;
  let contributionWeightError = 0;
  for (let level = topology.levelRange.minLevel; level < topology.levelRange.maxLevel; level++) {
    const lower = topology.levels.get(level);
    const higher = topology.levels.get(level + 1);
    for (let index = 0; index < lower.count; index++) {
      const { canonicalX, canonicalY } = canonicalCoordinatesForIndex(lower, index);
      if (canonicalIndexForCoordinates(higher, canonicalX, canonicalY) < 0) missingInherited++;
    }
    const parents = topology.transitionParentsFor(level + 1);
    for (const parentIndex of parents.parentIndexByChild) if (parentIndex < 0 || parentIndex >= lower.count) invalidParents++;
    const pairs = topology.directPairsFor(level, level + 1);
    for (const pair of pairs) if (pair < -1 || pair >= Math.max(lower.count, higher.count)) invalidPairs++;
    if (level + 1 <= 13 && topology.levelRange.minLevel <= level) {
      const contributions = pyramid.topologyFor(level + 1).contributionsToParent;
      for (let child = 0; child < contributions.offsets.length - 1; child++) {
        let weight = 0;
        for (let index = contributions.offsets[child]; index < contributions.offsets[child + 1]; index++) {
          if (contributions.parentIndices[index] >= lower.count) invalidParents++;
          weight += contributions.weights[index];
        }
        contributionWeightError = Math.max(contributionWeightError, Math.abs(weight - 1));
      }
    }
  }
  console.log(`${name} hierarchy: missing inherited=${missingInherited}, invalid parents/pairs=${invalidParents}/${invalidPairs}, centered weight error=${contributionWeightError}`);
  check(missingInherited === 0, `${name} L10-L15 nesting preserves inherited identities`);
  check(invalidParents === 0 && invalidPairs === 0, `${name} transition parents and direct pairs are complete`);
  check(contributionWeightError <= TOLERANCE, `${name} centered contributions remain normalized`);
}

function summaryError(left, right) {
  let error = 0;
  for (const name of ['totalWeight', 'rainWeightedSumMmh', 'rainMaxMmh', 'stormCoverageWeight', 'stormWeightedSeverity', 'stormMaxSeverity', 'hailCoverageWeight', 'hailWeightedSeverity', 'hailMaxSeverity']) error = Math.max(error, maxError(left[name], right[name]));
  for (let threshold = 0; threshold < left.rainCoverageWeight.length; threshold++) error = Math.max(error, maxError(left.rainCoverageWeight[threshold], right.rainCoverageWeight[threshold]));
  return error;
}

function summaryAt(summary, index) {
  return {
    level: summary.level,
    levelData: { ...summary.levelData, count: 1, width: 1, height: 1, canonicalAnchors: summary.levelData.canonicalAnchors.slice(index * 2, index * 2 + 2) },
    totalWeight: summary.totalWeight.subarray(index, index + 1),
    rainWeightedSumMmh: summary.rainWeightedSumMmh.subarray(index, index + 1),
    rainMaxMmh: summary.rainMaxMmh.subarray(index, index + 1),
    rainCoverageWeight: summary.rainCoverageWeight.map((values) => values.subarray(index, index + 1)),
    stormCoverageWeight: summary.stormCoverageWeight.subarray(index, index + 1),
    stormWeightedSeverity: summary.stormWeightedSeverity.subarray(index, index + 1),
    stormMaxSeverity: summary.stormMaxSeverity.subarray(index, index + 1),
    hailCoverageWeight: summary.hailCoverageWeight.subarray(index, index + 1),
    hailWeightedSeverity: summary.hailWeightedSeverity.subarray(index, index + 1),
    hailMaxSeverity: summary.hailMaxSeverity.subarray(index, index + 1)
  };
}

function verifyWeatherInvariance(window, name) {
  const fullRange = normalizeLodRange({ minLevel: 10, maxLevel: 15 });
  const fullReference = new GeographicWeatherPyramid(Float64Array, new GeographicLodTopology(window, fullRange));
  const times = [0, 0.173, 0.5, 0.923, 1];
  for (const stableLevel of ACTIVE_STABLE_LEVELS) {
    const range = lodRangeForStableLevel(stableLevel);
    const bounded = new GeographicWeatherPyramid(Float64Array, new GeographicLodTopology(window, range));
    let maximumSummaryError = 0;
    let maximumDotsError = 0;
    let maximumSquaresError = 0;
    let comparisons = 0;
    for (const time of times) {
      const reference = fullReference.evaluate([...Array(range.maxLevel - range.minLevel + 1)].map((_, index) => range.minLevel + index), prepareGeographicFieldFrame(time));
      const active = bounded.evaluate([...Array(range.maxLevel - range.minLevel + 1)].map((_, index) => range.minLevel + index), prepareGeographicFieldFrame(time));
      for (const level of Object.keys(active).map(Number).filter(Number.isInteger)) {
        const activeLevelData = active[level].levelData;
        const interior = [];
        for (let activeIndex = 0; activeIndex < activeLevelData.count; activeIndex++) {
          const coordinates = canonicalCoordinatesForIndex(activeLevelData, activeIndex);
          if (coordinates.canonicalX > window.minX + L10_STEP && coordinates.canonicalX < window.maxX - L10_STEP
            && coordinates.canonicalY > window.minY + L10_STEP && coordinates.canonicalY < window.maxY - L10_STEP) interior.push([activeIndex, coordinates]);
        }
        for (const [activeIndex, coordinates] of interior) {
          const fullIndex = canonicalIndexForCoordinates(reference[level].levelData, coordinates.canonicalX, coordinates.canonicalY);
          if (fullIndex < 0) continue;
          const activeSummary = summaryAt(active[level], activeIndex);
          const fullSummary = summaryAt(reference[level], fullIndex);
          maximumSummaryError = Math.max(maximumSummaryError, summaryError(activeSummary, fullSummary));
          const activeDots = mapDotsWeatherSummary(activeSummary);
          const fullDots = mapDotsWeatherSummary(fullSummary);
          const activeSquares = mapSquaresWeatherSummary(activeSummary);
          const fullSquares = mapSquaresWeatherSummary(fullSummary);
          maximumDotsError = Math.max(maximumDotsError, maxError(activeDots.rainRadius, fullDots.rainRadius), maxError(activeDots.strongRadius, fullDots.strongRadius), maxError(activeDots.stormRadius, fullDots.stormRadius), maxError(activeDots.hailRadius, fullDots.hailRadius));
          maximumSquaresError = Math.max(maximumSquaresError, maxError(activeSquares.rainWetMeanMmh, fullSquares.rainWetMeanMmh), maxError(activeSquares.rainCoverage, fullSquares.rainCoverage), maxError(activeSquares.stormCoverage, fullSquares.stormCoverage), maxError(activeSquares.hailCoverage, fullSquares.hailCoverage));
          comparisons++;
        }
      }
    }
    console.log(`${name} stable L${stableLevel} range ${range.minLevel}..${range.maxLevel}: comparisons=${comparisons}, summary=${maximumSummaryError}, Dots=${maximumDotsError}, Squares=${maximumSquaresError}`);
    check(comparisons > 0 && maximumSummaryError <= TOLERANCE && maximumDotsError <= TOLERANCE && maximumSquaresError <= TOLERANCE, `${name} stable L${stableLevel} bounded range matches same-window all-level baseline`);
  }
}

const field = parseRealWeatherCsv(fs.readFileSync(new URL('../data/mrl_z3_t+40min_376x239.csv', import.meta.url), 'utf8'));
setActiveWeatherField(field);
const [centerX, centerY] = lngLatToMercator(...WEATHER_REGION.center);
const testWindow = canonicalWindowFromMercatorBounds({ minX: centerX - 0.0015, maxX: centerX + 0.0015, minY: centerY - 0.0015, maxY: centerY + 0.0015 });
const supportTopology = new GeographicLodTopology(testWindow, { minLevel: MIN_GRID_LEVEL, maxLevel: MIN_GRID_LEVEL });
const windows = alignedInteriorWindows(supportTopology.canonicalWindow);
const fullRange = normalizeLodRange({ minLevel: MIN_GRID_LEVEL, maxLevel: MAX_GRID_LEVEL });
const fullPyramid = new GeographicWeatherPyramid(Float64Array, new GeographicLodTopology(windows[0], fullRange));
const topologyA = new GeographicLodTopology(windows[0], fullRange);
const topologyB = new GeographicLodTopology(windows[1], fullRange);
const topologyC = new GeographicLodTopology(windows[2], fullRange);
console.log(`support canonical bounds (L10-only diagnostic): ${JSON.stringify(supportTopology.canonicalWindow)}`);
console.log(`window A: ${JSON.stringify(topologyA.canonicalWindow)}`);
console.log(`window B: ${JSON.stringify(topologyB.canonicalWindow)}`);
console.log(`window C: ${JSON.stringify(topologyC.canonicalWindow)}`);

verifyIdentity(topologyA, topologyB);
const originalA = selectionDigest(topologyA);
let roundTripTopology = new GeographicLodTopology(topologyA.canonicalWindow, fullRange);
roundTripTopology = new GeographicLodTopology(topologyB.canonicalWindow, fullRange);
roundTripTopology = new GeographicLodTopology(topologyA.canonicalWindow, fullRange);
const roundTripSelection = selectionDigest(roundTripTopology);
check(JSON.stringify(roundTripSelection) === JSON.stringify(originalA), 'A → B → A selection preserves exact row/order determinism');
const unchangedTopology = new GeographicWeatherPyramid(Float64Array, topologyA);
const originalTopology = unchangedTopology.topology;
check(unchangedTopology.setCanonicalWindow(topologyA.canonicalWindow) === false && unchangedTopology.topology === originalTopology, 'unchanged snapped window does not rebuild the topology');
for (const [name, topology] of [['A', topologyA], ['B', topologyB], ['C', topologyC]]) verifyHierarchy(topology, `window ${name}`);

for (const stableLevel of ACTIVE_STABLE_LEVELS) {
  const range = lodRangeForStableLevel(stableLevel);
  const topology = new GeographicLodTopology(topologyA.canonicalWindow, range);
  const expectedLevels = LEVELS.filter((level) => level >= range.minLevel && level <= range.maxLevel);
  const actualLevels = [...topology.levels.keys()];
  check(JSON.stringify(actualLevels) === JSON.stringify(expectedLevels), `stable L${stableLevel} materializes exactly ${range.minLevel}..${range.maxLevel}`);
  check(topology.levels.has(stableLevel), `stable L${stableLevel} current level is materialized`);
  check(stableLevel === MIN_GRID_LEVEL || topology.levels.has(stableLevel - 1), `stable L${stableLevel} lower adjacent target is available when valid`);
  check(stableLevel === ACTIVE_STABLE_LEVELS.at(-1) || topology.levels.has(stableLevel + 1), `stable L${stableLevel} upper adjacent target is available when valid`);
  check(stableLevel <= 13 ? topology.levels.has(13) : true, `stable L${stableLevel} retains the L13 reference when required`);
  verifyHierarchy(topology, `stable L${stableLevel}`);
}

function verifyRangeRoundTrip(window, firstRange, middleRange, name) {
  const original = new GeographicLodTopology(window, firstRange);
  const middle = new GeographicLodTopology(window, middleRange);
  const final = new GeographicLodTopology(window, firstRange);
  for (let level = firstRange.minLevel; level <= firstRange.maxLevel; level++) {
    const originalLevelData = original.levelDataFor(level);
    const finalLevelData = final.levelDataFor(level);
    check(originalLevelData.count === finalLevelData.count && maxError(originalLevelData.canonicalAnchors, finalLevelData.canonicalAnchors) === 0, `${name} L${level} returns exactly after range round-trip`);
  }
  check(middle.levels.size === middleRange.maxLevel - middleRange.minLevel + 1, `${name} intermediate range is contiguous and bounded`);
}

verifyRangeRoundTrip(topologyA.canonicalWindow, { minLevel: 11, maxLevel: 13 }, { minLevel: 10, maxLevel: 13 }, 'L11..L13 → L10..L13 → L11..L13');
verifyRangeRoundTrip(topologyA.canonicalWindow, { minLevel: 12, maxLevel: 14 }, { minLevel: 13, maxLevel: 15 }, 'L12..L14 → L13..L15 → L12..L14');
verifyWeatherInvariance(topologyA.canonicalWindow, 'window A');
verifyWeatherInvariance(topologyB.canonicalWindow, 'window B');
verifyWeatherInvariance(topologyC.canonicalWindow, 'window C');

const sharedPyramid = new GeographicWeatherPyramid(Float64Array, topologyA);
const dots = new GeographicDotsLayer(sharedPyramid);
const squares = new GeographicSquaresLayer(sharedPyramid);
dots.setActive(true);
squares.setActive(true);
dots.setLevelData(sharedPyramid.levelDataFor(13), 0.5);
squares.setLevelData(sharedPyramid.levelDataFor(13), 0.5);
const oldDotsTemporal = dots.temporal;
const oldSquaresTemporal = squares.temporal;
sharedPyramid.setCanonicalWindow(topologyB.canonicalWindow);
dots.setTopology(sharedPyramid.topology);
squares.setTopology(sharedPyramid.topology);
check(dots.temporal === null && squares.temporal === null && dots.levelData === null && squares.levelData === null, 'topology replacement clears stale Dots/Squares temporal state');
dots.setLevelData(sharedPyramid.levelDataFor(13), 0.5);
squares.setLevelData(sharedPyramid.levelDataFor(13), 0.5);
const switchedFrame = geographicTemporalFrameAt(0.5);
check(dots.temporal && squares.temporal && dots.temporal.index === switchedFrame.index && squares.temporal.index === switchedFrame.index, 'topology replacement restores both renderers at the current non-zero weather time');
check(oldDotsTemporal !== dots.temporal && oldSquaresTemporal !== squares.temporal, 'topology replacement does not reuse incompatible temporal arrays');
const oldRangeTemporal = { dots: dots.temporal, squares: squares.temporal };
check(sharedPyramid.setLevelRange(lodRangeForStableLevel(14)), 'shared pyramid replaces its materialized range after a stable LOD change');
dots.setTopology(sharedPyramid.topology);
squares.setTopology(sharedPyramid.topology);
dots.setLevelData(sharedPyramid.levelDataFor(14), 0.5);
squares.setLevelData(sharedPyramid.levelDataFor(14), 0.5);
check(dots.temporal && squares.temporal && dots.temporal.index === switchedFrame.index && squares.temporal.index === switchedFrame.index, 'range replacement restores both renderers at the current non-zero weather time');
check(oldRangeTemporal.dots !== dots.temporal && oldRangeTemporal.squares !== squares.temporal, 'range replacement does not reuse incompatible temporal arrays');

const fixedWindowTopology = new GeographicLodTopology(topologyB.canonicalWindow, fullRange);
const fixedCount = sumCounts(fixedWindowTopology);
const summaryAndAnchorBytes = (topology) => sumCounts(topology) * (SUMMARY_BYTES_PER_SAMPLE + ANCHOR_BYTES_PER_SAMPLE);
console.log('topology counts and typed summary+anchor memory:');
for (const [name, topology] of [['all-level same-window', fullPyramid.topology], ['initial/large', topologyA], ['tighter L13', topologyB], ['L14', topologyC], ['L15', new GeographicLodTopology({ minX: windows[1].minX + L10_STEP, maxX: windows[1].maxX - L10_STEP, minY: windows[1].minY + L10_STEP, maxY: windows[1].maxY - L10_STEP }, { minLevel: 14, maxLevel: 15 })]]) {
  const counts = LEVELS.map((level) => topology.levels.has(level) ? topology.levelDataFor(level).count : '—');
  const bytes = summaryAndAnchorBytes(topology);
  console.log(`${name}: ${counts.map((count, index) => `L${LEVELS[index]}=${count}`).join(', ')}; approx=${(bytes / 1024 / 1024).toFixed(3)} MiB`);
}
const windowedTopology = new GeographicLodTopology(topologyB.canonicalWindow, lodRangeForStableLevel(13));
const windowedCounts = sumCounts(windowedTopology);
console.log(`same-window L13 active topology reduction: ${(100 * (1 - windowedCounts / fixedCount)).toFixed(2)}%; fixed/windowed typed summary+anchor bytes=${(summaryAndAnchorBytes(fixedWindowTopology) / 1024 / 1024).toFixed(3)}/${(summaryAndAnchorBytes(windowedTopology) / 1024 / 1024).toFixed(3)} MiB`);
check(windowedCounts < fixedCount, 'windowed topology materializes fewer canonical samples than fixed support');

console.log(failures ? `VERIFICATION FAILED: ${failures}` : 'VERIFICATION PASSED');
if (failures) process.exitCode = 1;
