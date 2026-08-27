import fs from 'node:fs';
import { prepareGeographicFieldFrame, setActiveWeatherField } from '../src/engine/geography.js';
import { GeographicDotsLayer, mapDotsWeatherSummary } from '../src/engine/geographic-dots-layer.js';
import { GeographicSquaresLayer, mapSquaresWeatherSummary } from '../src/engine/geographic-squares-layer.js';
import {
  GeographicLodTopology,
  MAX_GRID_LEVEL,
  MIN_GRID_LEVEL
} from '../src/engine/geographic-lod.js';
import { GeographicWeatherPyramid } from '../src/engine/geographic-weather-pyramid.js';
import { parseRealWeatherCsv } from '../src/engine/real-weather.js';
import { geographicTemporalFrameAt } from '../src/engine/geographic-layer-utils.js';

const LEVELS = [10, 11, 12, 13, 14, 15];
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
  return LEVELS.reduce((total, level) => total + topology.samplesFor(level).length, 0);
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
  return LEVELS.flatMap((level) => topology.samplesFor(level).map((sample) => [
    level, sample.id, sample.canonicalX, sample.canonicalY, sample.mercator[0], sample.mercator[1], sample.lngLat[0], sample.lngLat[1]
  ]));
}

function verifyIdentity(A, B) {
  for (const level of LEVELS) {
    const a = A.samplesFor(level);
    const bById = new Map(B.samplesFor(level).map((sample) => [sample.id, sample]));
    let overlap = 0;
    let error = 0;
    for (const sample of a) {
      const other = bById.get(sample.id);
      if (!other) continue;
      overlap++;
      error = Math.max(
        error,
        Math.abs(sample.canonicalX - other.canonicalX), Math.abs(sample.canonicalY - other.canonicalY),
        Math.abs(sample.mercator[0] - other.mercator[0]), Math.abs(sample.mercator[1] - other.mercator[1]),
        Math.abs(sample.lngLat[0] - other.lngLat[0]), Math.abs(sample.lngLat[1] - other.lngLat[1]),
        sample.level === other.level ? 0 : Infinity
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
  for (let level = MIN_GRID_LEVEL; level < MAX_GRID_LEVEL; level++) {
    const lower = topology.levels.get(level);
    const higher = topology.levels.get(level + 1);
    const higherIds = new Set(higher.samples.map((sample) => sample.id));
    for (const sample of lower.samples) if (!higherIds.has(sample.id)) missingInherited++;
    const parents = topology.transitionParentsFor(level + 1);
    for (const parentIndex of parents.parentIndexByChild) if (parentIndex < 0 || parentIndex >= lower.samples.length) invalidParents++;
    const pairs = topology.directPairsFor(level, level + 1);
    for (const pair of pairs) if (pair < -1 || pair >= Math.max(lower.samples.length, higher.samples.length)) invalidPairs++;
    if (level + 1 <= 13) {
      const contributions = pyramid.topologyFor(level + 1).contributionsToParent;
      for (let child = 0; child < contributions.offsets.length - 1; child++) {
        let weight = 0;
        for (let index = contributions.offsets[child]; index < contributions.offsets[child + 1]; index++) {
          if (contributions.parentIndices[index] >= lower.samples.length) invalidParents++;
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
    samples: [summary.samples[index]],
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

function verifyWeatherInvariance(fullPyramid, window, name) {
  const windowPyramid = new GeographicWeatherPyramid(Float64Array, new GeographicLodTopology(window));
  const times = [0, 0.173, 0.5, 0.923, 1];
  let maximumSummaryError = 0;
  let maximumDotsError = 0;
  let maximumSquaresError = 0;
  let comparisons = 0;
  for (const time of times) {
    const full = fullPyramid.evaluate(LEVELS, prepareGeographicFieldFrame(time));
    const active = windowPyramid.evaluate(LEVELS, prepareGeographicFieldFrame(time));
    for (const level of LEVELS) {
      const fullById = new Map(full[level].samples.map((sample, index) => [sample.id, index]));
      const activeSamples = active[level].samples;
      const interior = activeSamples.map((sample, index) => [sample, index]).filter(([sample]) =>
        sample.canonicalX > window.minX + L10_STEP && sample.canonicalX < window.maxX - L10_STEP
        && sample.canonicalY > window.minY + L10_STEP && sample.canonicalY < window.maxY - L10_STEP
      );
      for (const [sample, activeIndex] of interior) {
        const fullIndex = fullById.get(sample.id);
        if (fullIndex === undefined) continue;
        const activeSummary = summaryAt(active[level], activeIndex);
        const fullSummary = summaryAt(full[level], fullIndex);
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
  console.log(`${name} weather invariance: comparisons=${comparisons}, summary=${maximumSummaryError}, Dots=${maximumDotsError}, Squares=${maximumSquaresError}`);
  check(comparisons > 0 && maximumSummaryError <= TOLERANCE && maximumDotsError <= TOLERANCE && maximumSquaresError <= TOLERANCE, `${name} interior weather summaries and mappings match full-support baseline`);
}

const field = parseRealWeatherCsv(fs.readFileSync(new URL('../data/mrl_z3_t+40min_376x239.csv', import.meta.url), 'utf8'));
setActiveWeatherField(field);
const fullPyramid = new GeographicWeatherPyramid(Float64Array);
const windows = alignedInteriorWindows(fullPyramid.topology.canonicalWindow);
const topologyA = new GeographicLodTopology(windows[0]);
const topologyB = new GeographicLodTopology(windows[1]);
const topologyC = new GeographicLodTopology(windows[2]);
console.log(`support canonical bounds: ${JSON.stringify(fullPyramid.topology.canonicalWindow)}`);
console.log(`window A: ${JSON.stringify(topologyA.canonicalWindow)}`);
console.log(`window B: ${JSON.stringify(topologyB.canonicalWindow)}`);
console.log(`window C: ${JSON.stringify(topologyC.canonicalWindow)}`);

verifyIdentity(topologyA, topologyB);
const originalA = selectionDigest(topologyA);
let roundTripTopology = new GeographicLodTopology(topologyA.canonicalWindow);
roundTripTopology = new GeographicLodTopology(topologyB.canonicalWindow);
roundTripTopology = new GeographicLodTopology(topologyA.canonicalWindow);
const roundTripSelection = selectionDigest(roundTripTopology);
check(JSON.stringify(roundTripSelection) === JSON.stringify(originalA), 'A → B → A selection preserves exact row/order determinism');
const unchangedTopology = new GeographicWeatherPyramid(Float64Array, topologyA);
const originalTopology = unchangedTopology.topology;
check(unchangedTopology.setCanonicalWindow(topologyA.canonicalWindow) === false && unchangedTopology.topology === originalTopology, 'unchanged snapped window does not rebuild the topology');
for (const [name, topology] of [['A', topologyA], ['B', topologyB], ['C', topologyC]]) verifyHierarchy(topology, `window ${name}`);

verifyWeatherInvariance(fullPyramid, topologyA.canonicalWindow, 'window A');
verifyWeatherInvariance(fullPyramid, topologyB.canonicalWindow, 'window B');
verifyWeatherInvariance(fullPyramid, topologyC.canonicalWindow, 'window C');

const sharedPyramid = new GeographicWeatherPyramid(Float64Array, topologyA);
const dots = new GeographicDotsLayer(sharedPyramid);
const squares = new GeographicSquaresLayer(sharedPyramid);
dots.setActive(true);
squares.setActive(true);
dots.setSamples(sharedPyramid.samplesFor(13), 0.5);
squares.setSamples(sharedPyramid.samplesFor(13), 0.5);
const oldDotsTemporal = dots.temporal;
const oldSquaresTemporal = squares.temporal;
sharedPyramid.setCanonicalWindow(topologyB.canonicalWindow);
dots.setTopology(sharedPyramid.topology);
squares.setTopology(sharedPyramid.topology);
check(dots.temporal === null && squares.temporal === null && dots.samples.length === 0 && squares.samples.length === 0, 'topology replacement clears stale Dots/Squares temporal state');
dots.setSamples(sharedPyramid.samplesFor(13), 0.5);
squares.setSamples(sharedPyramid.samplesFor(13), 0.5);
const switchedFrame = geographicTemporalFrameAt(0.5);
check(dots.temporal && squares.temporal && dots.temporal.index === switchedFrame.index && squares.temporal.index === switchedFrame.index, 'topology replacement restores both renderers at the current non-zero weather time');
check(oldDotsTemporal !== dots.temporal && oldSquaresTemporal !== squares.temporal, 'topology replacement does not reuse incompatible temporal arrays');

const fixedCount = sumCounts(fullPyramid.topology);
const summaryAndAnchorBytes = (topology) => sumCounts(topology) * (SUMMARY_BYTES_PER_SAMPLE + ANCHOR_BYTES_PER_SAMPLE);
console.log('topology counts and typed summary+anchor memory:');
for (const [name, topology] of [['full support', fullPyramid.topology], ['initial/large', topologyA], ['tighter L13', topologyB], ['L14', topologyC], ['L15', new GeographicLodTopology({ minX: windows[1].minX + L10_STEP, maxX: windows[1].maxX - L10_STEP, minY: windows[1].minY + L10_STEP, maxY: windows[1].maxY - L10_STEP })]]) {
  const counts = LEVELS.map((level) => topology.samplesFor(level).length);
  const bytes = summaryAndAnchorBytes(topology);
  console.log(`${name}: ${counts.map((count, index) => `L${LEVELS[index]}=${count}`).join(', ')}; approx=${(bytes / 1024 / 1024).toFixed(3)} MiB`);
}
const windowedCounts = sumCounts(topologyB);
console.log(`all-level active topology reduction at tighter L13 window: ${(100 * (1 - windowedCounts / fixedCount)).toFixed(2)}%; fixed/windowed typed summary+anchor bytes=${(summaryAndAnchorBytes(fullPyramid.topology) / 1024 / 1024).toFixed(3)}/${(summaryAndAnchorBytes(topologyB) / 1024 / 1024).toFixed(3)} MiB`);
check(windowedCounts < fixedCount, 'windowed topology materializes fewer canonical samples than fixed support');

console.log(failures ? `VERIFICATION FAILED: ${failures}` : 'VERIFICATION PASSED');
if (failures) process.exitCode = 1;
