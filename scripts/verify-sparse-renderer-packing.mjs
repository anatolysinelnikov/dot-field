import fs from 'node:fs';
import { setActiveWeatherField } from '../src/engine/geography.js';
import { RealWeatherSequence } from '../src/engine/real-weather.js';
import { evaluateDirectWeatherSummary, aggregateWeatherSummary, GeographicWeatherPyramid } from '../src/engine/geographic-weather-pyramid.js';
import { GeographicLodTopology, lodRangeForStableLevel } from '../src/engine/geographic-lod.js';
import { GeographicDotsLayer, mapDotsWeatherSummary } from '../src/engine/geographic-dots-layer.js';
import { GeographicSquaresLayer, mapSquaresWeatherSummary } from '../src/engine/geographic-squares-layer.js';

const metadata = JSON.parse(fs.readFileSync(new URL('../data/generated/202608262200/metadata.json', import.meta.url), 'utf8'));
const grid = metadata.spatial_grid;
const time = metadata.time;
const binary = fs.readFileSync(new URL('../data/generated/202608262200/rain.f32', import.meta.url));
const rainFramesMmh = new Float32Array(binary.buffer, binary.byteOffset, binary.byteLength / Float32Array.BYTES_PER_ELEMENT);
const longitudes = Float64Array.from({ length: grid.width }, (_, index) => grid.longitude_start + index * grid.longitude_spacing);
const latitudes = Float64Array.from({ length: grid.height }, (_, index) => grid.latitude_start + index * grid.latitude_spacing);
const weather = new RealWeatherSequence({
  longitudes,
  latitudes,
  rainFramesMmh,
  frameCount: time.count,
  longitudeSpacing: grid.longitude_spacing,
  latitudeSpacing: grid.latitude_spacing,
  timestamps: time.timestamps
});
setActiveWeatherField(weather);

const topology = new GeographicLodTopology(undefined, lodRangeForStableLevel(10));
const optimizedPyramid = new GeographicWeatherPyramid(Float32Array, topology);
const densePyramid = new GeographicWeatherPyramid(Float32Array, topology);
const optimizedGeometry = optimizedPyramid.prepareSamplingGeometry(13, weather.prepareFrame(0));
const denseGeometry = { ...optimizedGeometry };
delete denseGeometry.potentialActiveIndices;
delete denseGeometry.potentialWeatherMask;

function denseChain(pyramid, frame, minimumLevel) {
  let summary = evaluateDirectWeatherSummary(pyramid.levels.get(13), frame, null, Float32Array, denseGeometry, pyramid.totalWeights.get(13));
  const summaries = { 13: summary };
  for (let level = 12; level >= minimumLevel; level--) {
    summary = aggregateWeatherSummary(
      pyramid.levels.get(level),
      summary,
      pyramid.contributions.get(level + 1),
      null,
      Float32Array,
      pyramid.totalWeights.get(level)
    );
    summaries[level] = summary;
  }
  return summaries;
}

function coarseAndDirect(pyramid, frame) {
  const summaries = pyramid.evaluate([10], frame);
  summaries[13] = pyramid.evaluate([13], frame)[13];
  return summaries;
}

function difference(left, right) {
  if (left.length !== right.length) throw new Error(`Array length mismatch ${left.length} !== ${right.length}.`);
  let maximum = 0;
  for (let index = 0; index < left.length; index++) maximum = Math.max(maximum, Math.abs(left[index] - right[index]));
  return maximum;
}

function compareArrays(label, left, right) {
  const maximum = difference(left, right);
  if (maximum > 1e-6) throw new Error(`${label} differs by ${maximum}.`);
}

function compareMapped(level, sparse, dense, names) {
  for (const name of names) compareArrays(`L${level} ${name}`, sparse[name], dense[name]);
}

function activeIndicesFor(summary, length) {
  return summary.potentialActiveIndices || Uint32Array.from({ length }, (_, index) => index);
}

function verifyOmittedSamples(level, summary, sparseDots, denseDots, sparseSquares, denseSquares, sparseDotsNext, denseDotsNext, sparseSquaresNext, denseSquaresNext) {
  const active = summary.potentialActiveIndices;
  if (!active) return;
  const activeMask = new Uint8Array(summary.levelData.count);
  for (const index of active) activeMask[index] = 1;
  const dotNames = ['rainRadius', 'strongRadius', 'stormRadius', 'hailRadius'];
  const squareNames = ['rainWetMeanMmh', 'rainCoverage', 'stormCoverage', 'stormMeanSeverity', 'stormMaxSeverity', 'hailCoverage', 'hailMeanSeverity', 'hailMaxSeverity'];
  for (let index = 0; index < activeMask.length; index++) {
    if (activeMask[index]) continue;
    for (const name of dotNames) {
      if (sparseDots[name][index] !== 0 || sparseDotsNext[name][index] !== 0 || denseDots[name][index] !== 0 || denseDotsNext[name][index] !== 0) throw new Error(`L${level} omitted Dots sample ${index} is nonzero.`);
    }
    for (const name of squareNames) {
      if (sparseSquares[name][index] !== 0 || sparseSquaresNext[name][index] !== 0 || denseSquares[name][index] !== 0 || denseSquaresNext[name][index] !== 0) throw new Error(`L${level} omitted Squares sample ${index} is nonzero.`);
    }
  }
}

function makeStableDots(pyramid, level, mapped0, mapped1) {
  const layer = new GeographicDotsLayer(pyramid);
  layer.levelData = pyramid.levelDataFor(level);
  layer.temporal = { levels: new Map([[level, { frames0: { mapped: { [level]: mapped0 } }, frames1: { mapped: { [level]: mapped1 } } }]]) };
  layer.rebuildInstances();
  return layer;
}

function makeStableSquares(pyramid, level, mapped0, mapped1) {
  const layer = new GeographicSquaresLayer(pyramid);
  layer.levelData = pyramid.levelDataFor(level);
  layer.temporal = { levels: new Map([[level, { frames0: { mapped: { [level]: mapped0 } }, frames1: { mapped: { [level]: mapped1 } } }]]) };
  layer.rebuildInstances();
  return layer;
}

function makeTransitionDots(pyramid, fromLevel, toLevel, mapped0, mapped1) {
  const layer = new GeographicDotsLayer(pyramid);
  layer.levelData = pyramid.levelDataFor(toLevel);
  layer.transition = { fromLevelData: pyramid.levelDataFor(fromLevel), toLevelData: pyramid.levelDataFor(toLevel) };
  layer.temporal = { levels: new Map([
    [fromLevel, { frames0: { mapped: { [fromLevel]: mapped0[fromLevel] } }, frames1: { mapped: { [fromLevel]: mapped1[fromLevel] } } }],
    [toLevel, { frames0: { mapped: { [toLevel]: mapped0[toLevel] } }, frames1: { mapped: { [toLevel]: mapped1[toLevel] } } }]
  ]) };
  layer.rebuildInstances();
  return layer;
}

function makeTransitionSquares(pyramid, fromLevel, toLevel, mapped0, mapped1) {
  const layer = new GeographicSquaresLayer(pyramid);
  layer.levelData = pyramid.levelDataFor(toLevel);
  layer.transition = { fromLevelData: pyramid.levelDataFor(fromLevel), toLevelData: pyramid.levelDataFor(toLevel), fromGroup: 0, toGroup: 1 };
  layer.temporal = { levels: new Map([
    [fromLevel, { frames0: { mapped: { [fromLevel]: mapped0[fromLevel] } }, frames1: { mapped: { [fromLevel]: mapped1[fromLevel] } } }],
    [toLevel, { frames0: { mapped: { [toLevel]: mapped0[toLevel] } }, frames1: { mapped: { [toLevel]: mapped1[toLevel] } } }]
  ]) };
  layer.rebuildInstances();
  return layer;
}

function compareDotPacked(level, sparse, dense) {
  for (const type of ['rain', 'strong', 'storm', 'hail']) compareArrays(`L${level} Dots packed ${type}`, sparse.instances[type], dense.instances[type]);
}

function compareSquarePacked(level, sparse, dense, summary) {
  const active = activeIndicesFor(summary, summary.levelData.count);
  if (sparse.instanceCounts[0] !== active.length) throw new Error(`L${level} sparse Squares count ${sparse.instanceCounts[0]} !== active ${active.length}.`);
  if (dense.instanceCounts[0] !== summary.levelData.count) throw new Error(`L${level} dense Squares count mismatch.`);
  const sparseData = sparse.instanceData[0];
  const denseData = dense.instanceData[0];
  for (let position = 0; position < active.length; position++) {
    const sparseOffset = position * 18;
    const denseOffset = active[position] * 18;
    for (let component = 0; component < 18; component++) {
      if (Math.abs(sparseData[sparseOffset + component] - denseData[denseOffset + component]) > 1e-6) throw new Error(`L${level} sparse Squares packed value differs at active ${active[position]}, component ${component}.`);
    }
  }
}

function compareTransitionSquares(level, sparse, dense, fromSummary, toSummary) {
  const activeByGroup = [
    activeIndicesFor(fromSummary, fromSummary.levelData.count),
    activeIndicesFor(toSummary, toSummary.levelData.count)
  ];
  if (sparse.instanceCounts[0] !== activeByGroup[0].length || sparse.instanceCounts[1] !== activeByGroup[1].length) throw new Error(`L${level} sparse transition Squares count mismatch.`);
  for (let group = 0; group < 2; group++) {
    const active = activeByGroup[group];
    const sparseData = sparse.instanceData[group];
    const denseData = dense.instanceData[group];
    for (let position = 0; position < active.length; position++) {
      const sparseOffset = position * 18;
      const denseOffset = active[position] * 18;
      for (let component = 0; component < 18; component++) {
        if (Math.abs(sparseData[sparseOffset + component] - denseData[denseOffset + component]) > 1e-6) throw new Error(`L${level} transition Squares packed value differs.`);
      }
    }
  }
}

const mappedNamesDots = ['rainRadius', 'strongRadius', 'stormRadius', 'hailRadius'];
const mappedNamesSquares = ['rainWetMeanMmh', 'rainCoverage', 'stormCoverage', 'stormMeanSeverity', 'stormMaxSeverity', 'hailCoverage', 'hailMeanSeverity', 'hailMaxSeverity'];
const testTimes = [0, 1 / 18, 5 / 18, 9 / 18, 13 / 18, 1, 0.123, 0.347, 0.777];
let stableChecks = 0;
for (const normalizedTime of testTimes) {
  const frame = weather.prepareFrame(normalizedTime);
  const frameNext = weather.prepareFrame(Math.min(1, normalizedTime + 1 / 180));
  const sparseSummaries = coarseAndDirect(optimizedPyramid, frame);
  const sparseSummariesNext = coarseAndDirect(optimizedPyramid, frameNext);
  const denseSummaries = denseChain(densePyramid, frame, 10);
  const denseSummariesNext = denseChain(densePyramid, frameNext, 10);
  const sparseDotsByLevel = {};
  const denseDotsByLevel = {};
  const sparseSquaresByLevel = {};
  const denseSquaresByLevel = {};
  const sparseDotsNextByLevel = {};
  const denseDotsNextByLevel = {};
  const sparseSquaresNextByLevel = {};
  const denseSquaresNextByLevel = {};
  for (const level of [10, 11, 12, 13]) {
    sparseDotsByLevel[level] = mapDotsWeatherSummary(sparseSummaries[level]);
    denseDotsByLevel[level] = mapDotsWeatherSummary(denseSummaries[level]);
    sparseSquaresByLevel[level] = mapSquaresWeatherSummary(sparseSummaries[level]);
    denseSquaresByLevel[level] = mapSquaresWeatherSummary(denseSummaries[level]);
    sparseDotsNextByLevel[level] = mapDotsWeatherSummary(sparseSummariesNext[level]);
    denseDotsNextByLevel[level] = mapDotsWeatherSummary(denseSummariesNext[level]);
    sparseSquaresNextByLevel[level] = mapSquaresWeatherSummary(sparseSummariesNext[level]);
    denseSquaresNextByLevel[level] = mapSquaresWeatherSummary(denseSummariesNext[level]);
    compareMapped(level, sparseDotsByLevel[level], denseDotsByLevel[level], mappedNamesDots);
    compareMapped(level, sparseSquaresByLevel[level], denseSquaresByLevel[level], mappedNamesSquares);
    compareMapped(level, sparseDotsNextByLevel[level], denseDotsNextByLevel[level], mappedNamesDots);
    compareMapped(level, sparseSquaresNextByLevel[level], denseSquaresNextByLevel[level], mappedNamesSquares);
    verifyOmittedSamples(level, sparseSummaries[level], sparseDotsByLevel[level], denseDotsByLevel[level], sparseSquaresByLevel[level], denseSquaresByLevel[level], sparseDotsNextByLevel[level], denseDotsNextByLevel[level], sparseSquaresNextByLevel[level], denseSquaresNextByLevel[level]);
    const sparseDots = makeStableDots(optimizedPyramid, level, sparseDotsByLevel[level], sparseDotsNextByLevel[level]);
    const denseDots = makeStableDots(densePyramid, level, denseDotsByLevel[level], denseDotsNextByLevel[level]);
    const sparseSquares = makeStableSquares(optimizedPyramid, level, sparseSquaresByLevel[level], sparseSquaresNextByLevel[level]);
    const denseSquares = makeStableSquares(densePyramid, level, denseSquaresByLevel[level], denseSquaresNextByLevel[level]);
    compareDotPacked(level, sparseDots, denseDots);
    compareSquarePacked(level, sparseSquares, denseSquares, sparseSummaries[level]);
    stableChecks++;
  }
}

const transitionTime = 0.347;
const transitionFrame = weather.prepareFrame(transitionTime);
const transitionSparse = coarseAndDirect(optimizedPyramid, transitionFrame);
const transitionDense = denseChain(densePyramid, transitionFrame, 10);
for (const [fromLevel, toLevel] of [[10, 11], [11, 12]]) {
  const sparseMapped0 = {};
  const denseMapped0 = {};
  const sparseMapped1 = {};
  const denseMapped1 = {};
  const sparseDotsMapped0 = {};
  const denseDotsMapped0 = {};
  const sparseDotsMapped1 = {};
  const denseDotsMapped1 = {};
  for (const level of [fromLevel, toLevel]) {
    sparseMapped0[level] = mapSquaresWeatherSummary(transitionSparse[level]);
    denseMapped0[level] = mapSquaresWeatherSummary(transitionDense[level]);
    sparseMapped1[level] = mapSquaresWeatherSummary(transitionSparse[level]);
    denseMapped1[level] = mapSquaresWeatherSummary(transitionDense[level]);
    sparseDotsMapped0[level] = mapDotsWeatherSummary(transitionSparse[level]);
    denseDotsMapped0[level] = mapDotsWeatherSummary(transitionDense[level]);
    sparseDotsMapped1[level] = mapDotsWeatherSummary(transitionSparse[level]);
    denseDotsMapped1[level] = mapDotsWeatherSummary(transitionDense[level]);
  }
  const sparseSquares = makeTransitionSquares(optimizedPyramid, fromLevel, toLevel, sparseMapped0, sparseMapped1);
  const denseSquares = makeTransitionSquares(densePyramid, fromLevel, toLevel, denseMapped0, denseMapped1);
  compareTransitionSquares(toLevel, sparseSquares, denseSquares, transitionSparse[fromLevel], transitionSparse[toLevel]);
  const sparseDots = makeTransitionDots(optimizedPyramid, fromLevel, toLevel, sparseDotsMapped0, sparseDotsMapped1);
  const denseDots = makeTransitionDots(densePyramid, fromLevel, toLevel, denseDotsMapped0, denseDotsMapped1);
  compareDotPacked(toLevel, sparseDots, denseDots);
}

console.log(`sparse renderer packing verification passed: ${stableChecks} stable level/time cases; exact and interpolated frames; L10-L13 mapped arrays and packed Dots/Squares values match within 1e-6`);
console.log('transition checks passed: hierarchical L10↔L11 and L11↔L12 endpoints preserve packed values and retained canonical centers');
