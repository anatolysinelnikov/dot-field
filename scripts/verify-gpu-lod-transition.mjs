import {
  adjacentCoarseIndexForFineSample,
  gpuDotsTransitionRadius,
  gpuSquaresTransitionOpacities,
  GPU_WEATHER_LEVELS,
  gpuWeatherTransitionReadyPresentationLevels,
  isGpuWeatherLodTransitionPairSupported
} from '../src/engine/geographic-gpu-weather-presentation.js';
import { canonicalCoordinatesForIndex, canonicalWindowFromMercatorBounds, GeographicLodTopology, lngLatToMercator, lodRangeForStableLevel } from '../src/engine/geographic-lod.js';
import { GeographicDotsLayer } from '../src/engine/geographic-dots-layer.js';
import { GeographicSquaresLayer } from '../src/engine/geographic-squares-layer.js';
import { GeographicWeatherPyramid } from '../src/engine/geographic-weather-pyramid.js';
import { setActiveWeatherField, WEATHER_REGION } from '../src/engine/geography.js';
import { loadRealWeatherFixture } from './real-weather-fixture.mjs';

let failures = 0;
function check(condition, message) {
  if (condition) console.log(`PASS ${message}`);
  else { failures++; console.error(`FAIL ${message}`); }
}

const [centerX, centerY] = lngLatToMercator(...WEATHER_REGION.center);
const sequence = await loadRealWeatherFixture();
setActiveWeatherField(sequence.weather);
const window = canonicalWindowFromMercatorBounds({
  minX: centerX - 0.004, maxX: centerX + 0.004,
  minY: centerY - 0.004, maxY: centerY + 0.004
});

for (const level of [10, 11, 12, 13]) {
  const expected = { 10: [10, 11], 11: [10, 11, 12], 12: [11, 12, 13], 13: [12, 13] }[level];
  check(JSON.stringify(gpuWeatherTransitionReadyPresentationLevels(level)) === JSON.stringify(expected), `stable L${level} retains exactly ${expected.map((value) => `L${value}`).join('/')}`);
}
for (const [from, to] of [[10, 11], [11, 12], [12, 13], [11, 10], [12, 11], [13, 12]]) {
  check(isGpuWeatherLodTransitionPairSupported(from, to), `L${from}↔L${to} is GPU-native eligible`);
}
check(!isGpuWeatherLodTransitionPairSupported(13, 14) && !isGpuWeatherLodTransitionPairSupported(14, 13), 'L13↔L14 remains outside GPU-native eligibility');

const topology = new GeographicLodTopology(window, { minLevel: 10, maxLevel: 14 });
const deferredTopology = new GeographicLodTopology(window, lodRangeForStableLevel(10), null, { deferTransitionParents: true });
check(deferredTopology.transitionParents.size === 0, 'GPU stationary topology defers all visual transition-parent relations');
for (const fineLevel of [11, 12, 13]) {
  const parents = deferredTopology.transitionParentsFor(fineLevel);
  check(parents.childIndices.length === deferredTopology.levelDataFor(fineLevel).count,
    `legacy hierarchical L${fineLevel - 1}↔L${fineLevel} parent relation remains available on demand`);
}
check(deferredTopology.transitionParents.size === 3, 'on-demand parent materialization is limited to requested legacy relations');
for (const [coarseLevel, fineLevel] of [[10, 11], [11, 12], [12, 13]]) {
  const coarse = topology.levelDataFor(coarseLevel);
  const fine = topology.levelDataFor(fineLevel);
  let shared = 0;
  let fineOnly = 0;
  let centersMatch = true;
  for (let fineIndex = 0; fineIndex < fine.count; fineIndex++) {
    const coarseIndex = adjacentCoarseIndexForFineSample(fine, coarse, fineIndex);
    const fineCoordinates = canonicalCoordinatesForIndex(fine, fineIndex);
    if (coarseIndex >= 0) {
      shared++;
      const coarseCoordinates = canonicalCoordinatesForIndex(coarse, coarseIndex);
      centersMatch = centersMatch && fineCoordinates.canonicalX === coarseCoordinates.canonicalX && fineCoordinates.canonicalY === coarseCoordinates.canonicalY;
    } else fineOnly++;
  }
  check(centersMatch, `L${coarseLevel}↔L${fineLevel} every shared sample maps to the exact coarse texel and center`);
  check(shared > 0 && fineOnly > 0, `L${coarseLevel}↔L${fineLevel} has shared and fine-only samples in clipped window`);
  const fromRadius = 0.0002;
  const toRadius = 0.0007;
  const midpoint = gpuDotsTransitionRadius(fromRadius, toRadius, 0.5);
  check(Math.abs(midpoint * midpoint - (fromRadius * fromRadius + (toRadius * toRadius - fromRadius * fromRadius) * 0.5)) < 1e-15, `L${coarseLevel}↔L${fineLevel} shared refinement uses area interpolation`);
  check(Math.abs(gpuDotsTransitionRadius(fromRadius, toRadius, 0.37) - gpuDotsTransitionRadius(toRadius, fromRadius, 0.63)) < 1e-15, `L${coarseLevel}↔L${fineLevel} radius reversal is complementary`);
  check(gpuDotsTransitionRadius(0, toRadius, 0.37) > 0 && gpuDotsTransitionRadius(toRadius, 0, 0.37) > 0, `L${coarseLevel}↔L${fineLevel} fine-only growth/shrink stays at fixed fine position`);
}
for (const progress of [0, 0.2, 0.5, 0.8, 1]) {
  const opacities = gpuSquaresTransitionOpacities(progress);
  const reversed = gpuSquaresTransitionOpacities(1 - progress);
  check(opacities.from === 1 - progress && opacities.to === progress, `Squares opacity contract holds at p=${progress}`);
  check(Math.abs(opacities.from - reversed.to) < 1e-12 && Math.abs(opacities.to - reversed.from) < 1e-12, `Squares reversal swaps opacities at p=${progress}`);
}

function source(topologyValue, levelData, owner) {
  const textureA = { owner, slot: 0 };
  const textureB = { owner, slot: 1 };
  const summary = levelData.level < 13;
  return {
    topology: topologyValue, levelData, kind: summary ? 'summary' : 'physical',
    textureA, textureB,
    coverageTextureA: summary ? { owner, slot: 'coverage-a' } : textureA,
    coverageTextureB: summary ? { owner, slot: 'coverage-b' } : textureB,
    presentationLevel: levelData.level,
    width: levelData.width, height: levelData.height
  };
}

for (const Layer of [GeographicDotsLayer, GeographicSquaresLayer]) {
  const pyramid = new GeographicWeatherPyramid(Float32Array, new GeographicLodTopology(window, lodRangeForStableLevel(12)));
  const layer = new Layer(pyramid);
  layer.setGpuWeatherMode(true);
  const stableLevelData = pyramid.levelDataFor(12);
  const directOwner = {};
  const stableSource = source(pyramid.topology, stableLevelData, directOwner);
  layer.setGpuWeatherCommittedState(pyramid.topology, stableLevelData, stableSource, 0);
  const fromSource = source(pyramid.topology, pyramid.levelDataFor(12), directOwner);
  const toSource = source(pyramid.topology, pyramid.levelDataFor(13), directOwner);
  layer.setGpuWeatherTransition({ topology: pyramid.topology, fromSource, toSource, fineLevelData: pyramid.levelDataFor(13), progress: 0.37 }, { requestRepaint: false });
  const diagnostics = layer.diagnostics();
  check(!layer.transition && layer.gpuWeatherTransition, `${Layer.name} GPU transition does not enter CPU transition state`);
  check(diagnostics.gpuWeather.transitionOwner === 'gpu' && diagnostics.gpuWeather.transition.fromLevel === 12 && diagnostics.gpuWeather.transition.toLevel === 13, `${Layer.name} reports GPU endpoint ownership and levels`);
  check(diagnostics.cpuBytes === 0 && diagnostics.gpuWeather.mappedCpuBytes === 0, `${Layer.name} keeps CPU weather/instance state at zero during GPU transition`);
  check(fromSource.textureA.owner === directOwner && toSource.textureA.owner === directOwner, `${Layer.name} transition endpoints borrow one direct temporal owner`);
  layer.setGpuWeatherTransition({ topology: pyramid.topology, fromSource: toSource, toSource: fromSource, fineLevelData: pyramid.levelDataFor(13), progress: 0.63 }, { requestRepaint: false });
  check(layer.gpuWeatherTransition.fromSource === toSource && layer.gpuWeatherTransition.toSource === fromSource, `${Layer.name} reversal swaps endpoint sources without reallocation`);
  const promoted = source(pyramid.topology, pyramid.levelDataFor(13), directOwner);
  layer.setGpuWeatherCommittedState(pyramid.topology, pyramid.levelDataFor(13), promoted, 0);
  check(!layer.gpuWeatherTransition && layer.gpuWeatherSource === promoted, `${Layer.name} promotion clears GPU transition and publishes target source`);
  check(layer.diagnostics().cpuBytes === 0, `${Layer.name} promotion remains CPU-weather free`);
}

for (const Layer of [GeographicDotsLayer, GeographicSquaresLayer]) {
  const oldTopology = new GeographicLodTopology(window, lodRangeForStableLevel(10), null, { deferTransitionParents: true });
  const pyramid = new GeographicWeatherPyramid(Float32Array, oldTopology);
  const layer = new Layer(pyramid);
  layer.setGpuWeatherMode(true);
  const oldOwner = {};
  layer.setGpuWeatherCommittedState(oldTopology, oldTopology.levelDataFor(10), source(oldTopology, oldTopology.levelDataFor(10), oldOwner), 0);
  const newTopology = new GeographicLodTopology(window, lodRangeForStableLevel(10), oldTopology, { deferTransitionParents: true });
  pyramid.setTopology(newTopology);
  const newOwner = {};
  const newStable = source(newTopology, newTopology.levelDataFor(10), newOwner);
  layer.setGpuWeatherCommittedState(newTopology, newTopology.levelDataFor(10), newStable, 0);
  const newFrom = source(newTopology, newTopology.levelDataFor(10), newOwner);
  const newTo = source(newTopology, newTopology.levelDataFor(11), newOwner);
  layer.setGpuWeatherTransition({ topology: newTopology, fromSource: newFrom, toSource: newTo, fineLevelData: newTopology.levelDataFor(11), progress: 0.2 }, { requestRepaint: false });
  check(layer.gpuWeatherTransition?.fromSource === newFrom && layer.gpuWeatherTransition?.toSource === newTo,
    `${Layer.name} post-spatial-commit transition uses the new GPU endpoint owner`);
  check(layer.gpuWeatherTransition?.fromSource.topology === newTopology && layer.diagnostics().cpuBytes === 0,
    `${Layer.name} post-spatial-commit L10↔L11 remains GPU-owned and CPU-free`);
  let rejected = false;
  try {
    layer.setGpuWeatherTransition({
      topology: oldTopology,
      fromSource: source(oldTopology, oldTopology.levelDataFor(10), oldOwner),
      toSource: newTo,
      fineLevelData: newTopology.levelDataFor(11)
    }, { requestRepaint: false });
  } catch {
    rejected = true;
  }
  check(rejected, `${Layer.name} rejects a stale post-spatial endpoint instead of publishing mismatched ownership`);
}

check(GPU_WEATHER_LEVELS.join(',') === '10,11,12,13,14', 'GPU Weather stable support remains L10-L14');
console.log(failures ? `VERIFICATION FAILED: ${failures}` : 'GPU NATIVE LOD TRANSITION VERIFICATION PASSED');
if (failures) process.exitCode = 1;
