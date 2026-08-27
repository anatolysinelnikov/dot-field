import fs from 'node:fs';
import { setActiveWeatherField, WEATHER_REGION } from '../src/engine/geography.js';
import { RealWeatherSequence } from '../src/engine/real-weather.js';
import {
  canonicalWindowFromMercatorBounds,
  GeographicLodTopology,
  lngLatToMercator,
  lodRangeForStableLevel
} from '../src/engine/geographic-lod.js';
import { GeographicWeatherPyramid } from '../src/engine/geographic-weather-pyramid.js';
import { GeographicDotsLayer } from '../src/engine/geographic-dots-layer.js';
import { GeographicSquaresLayer } from '../src/engine/geographic-squares-layer.js';

const TEMPORAL_FRAME_COUNT = 180;
const levels = [10, 11, 12, 13, 14, 15];
const time = 0.37;
let failures = 0;

function check(condition, message) {
  if (condition) console.log(`PASS ${message}`);
  else { failures++; console.error(`FAIL ${message}`); }
}

function loadSequence() {
  const dataRoot = new URL('../data/generated/202608262200/', import.meta.url);
  const metadata = JSON.parse(fs.readFileSync(new URL('metadata.json', dataRoot), 'utf8'));
  const binary = fs.readFileSync(new URL('rain.f32', dataRoot));
  const grid = metadata.spatial_grid;
  return new RealWeatherSequence({
    longitudes: Float64Array.from({ length: grid.width }, (_, index) => grid.longitude_start + index * grid.longitude_spacing),
    latitudes: Float64Array.from({ length: grid.height }, (_, index) => grid.latitude_start + index * grid.latitude_spacing),
    rainFramesMmh: new Float32Array(binary.buffer, binary.byteOffset, binary.byteLength / Float32Array.BYTES_PER_ELEMENT),
    frameCount: metadata.time.count,
    longitudeSpacing: grid.longitude_spacing,
    latitudeSpacing: grid.latitude_spacing,
    timestamps: metadata.time.timestamps
  });
}

function arraysEqual(left, right) {
  if (left === right) return true;
  if (!left || !right || left.length !== right.length) return false;
  for (let index = 0; index < left.length; index++) if (left[index] !== right[index]) return false;
  return true;
}

function valueSnapshot(layer) {
  const output = {
    level: layer.levelData?.level ?? null,
    transition: layer.transition ? {
      from: layer.transition.fromLevelData.level,
      to: layer.transition.toLevelData.level,
      progress: layer.transitionProgress
    } : null,
    temporal: null,
    instances: {}
  };
  if (layer.temporal) {
    output.temporal = { index: layer.temporal.index, nextIndex: layer.temporal.nextIndex, levels: {} };
    for (const [level, temporalState] of layer.temporal.levels) {
      output.temporal.levels[level] = {};
      for (const frameName of ['frames0', 'frames1']) {
        const frame = temporalState[frameName];
        const summary = frame.summaries[level];
        const mapped = frame.mapped[level];
        output.temporal.levels[level][frameName] = {
          index: frame.index,
          summary: Object.fromEntries(Object.entries(summary).filter(([, value]) => ArrayBuffer.isView(value)).map(([key, value]) => [key, value.slice()])),
          mapped: Object.fromEntries(Object.entries(mapped).filter(([, value]) => ArrayBuffer.isView(value)).map(([key, value]) => [key, value.slice()]))
        };
      }
    }
  }
  if (layer.instances) {
    for (const [type, value] of Object.entries(layer.instances)) output.instances[type] = value.slice();
  } else {
    for (const [index, value] of layer.instanceData.entries()) output.instances[index] = value.slice(0, layer.instanceCounts[index] * 18);
  }
  return output;
}

function snapshotsEqual(left, right) {
  if (left.level !== right.level || JSON.stringify(left.transition) !== JSON.stringify(right.transition) || Boolean(left.temporal) !== Boolean(right.temporal)) return false;
  if (left.temporal) {
    if (left.temporal.index !== right.temporal.index || left.temporal.nextIndex !== right.temporal.nextIndex) return false;
    const leftLevels = Object.keys(left.temporal.levels);
    if (leftLevels.join(',') !== Object.keys(right.temporal.levels).join(',')) return false;
    for (const level of leftLevels) {
      for (const frameName of ['frames0', 'frames1']) {
        const leftFrame = left.temporal.levels[level][frameName];
        const rightFrame = right.temporal.levels[level][frameName];
        if (leftFrame.index !== rightFrame.index) return false;
        for (const key of Object.keys(leftFrame.summary)) if (!arraysEqual(leftFrame.summary[key], rightFrame.summary[key])) return false;
        for (const key of Object.keys(leftFrame.mapped)) if (!arraysEqual(leftFrame.mapped[key], rightFrame.mapped[key])) return false;
      }
    }
  }
  const leftInstanceTypes = Object.keys(left.instances);
  return leftInstanceTypes.join(',') === Object.keys(right.instances).join(',')
    && leftInstanceTypes.every((type) => arraysEqual(left.instances[type], right.instances[type]));
}

function makeScenario(Layer, fromLevel) {
  const fromRange = lodRangeForStableLevel(fromLevel);
  const topology = new GeographicLodTopology(testWindow, fromRange);
  const pyramid = new GeographicWeatherPyramid(Float32Array, topology);
  const layer = new Layer(pyramid);
  layer.setActive(true);
  layer.setLevelData(topology.levelDataFor(fromLevel), time);
  return { layer, pyramid, topology };
}

function runTransition(Layer, fromLevel, toLevel, optimized) {
  const scenario = makeScenario(Layer, fromLevel);
  const { layer, pyramid, topology: oldTopology } = scenario;
  const fromData = oldTopology.levelDataFor(fromLevel);
  const toData = oldTopology.levelDataFor(toLevel);
  layer.setTransition(fromData, toData, time, 0.2);
  const startCalls = layer.lifecycleDiagnostics.evaluateKeyframeCalls;
  const startSnapshot = valueSnapshot(layer);
  layer.updateWeather(time + 0.006);
  const advancedSnapshot = valueSnapshot(layer);
  layer.setLevelData(toData, time + 0.006);
  const toRange = lodRangeForStableLevel(toLevel);
  const rangeChanged = oldTopology.levelRange.minLevel !== toRange.minLevel || oldTopology.levelRange.maxLevel !== toRange.maxLevel;
  const oldGeometry = new Map(pyramid.samplingGeometries);
  const oldContributions = pyramid.contributions;
  const oldTotalWeights = pyramid.totalWeights;
  const oldTemporal = layer.temporal;
  let replacementCalls = 0;
  if (rangeChanged) {
    const nextTopology = optimized
      ? new GeographicLodTopology(testWindow, toRange, pyramid.topology)
      : new GeographicLodTopology(testWindow, toRange);
    if (optimized) {
      for (const [level, data] of pyramid.topology.levels) {
        if (nextTopology.levels.has(level)) check(nextTopology.levels.get(level) === data, `L${fromLevel}->L${toLevel} reuses packed L${level} levelData`);
      }
      for (const [level, relation] of pyramid.topology.transitionParents) {
        if (nextTopology.transitionParents.has(level)) check(nextTopology.transitionParents.get(level) === relation, `L${fromLevel}->L${toLevel} reuses transition parents L${level}`);
      }
      for (const [level, relation] of pyramid.topology.directPairs) {
        if (nextTopology.directPairs.has(level)) check(nextTopology.directPairs.get(level) === relation, `L${fromLevel}->L${toLevel} reuses direct pairs L${level}`);
      }
      pyramid.setTopology(nextTopology, { preserveCompatibleState: true });
      for (const [level, plan] of oldContributions) {
        if (pyramid.contributions.has(level)) check(pyramid.contributions.get(level) === plan, `L${fromLevel}->L${toLevel} reuses centered contributions L${level}`);
      }
      for (const [level, weights] of oldTotalWeights) {
        if (pyramid.totalWeights.has(level)) check(pyramid.totalWeights.get(level) === weights, `L${fromLevel}->L${toLevel} reuses totalWeight L${level}`);
      }
    } else {
      pyramid.setTopology(nextTopology, { preserveCompatibleState: false });
    }
    const beforeCalls = layer.lifecycleDiagnostics.evaluateKeyframeCalls;
    layer.setTopology(nextTopology, { preserveCompatibleState: optimized });
    layer.setLevelData(nextTopology.levelDataFor(toLevel), time + 0.006);
    replacementCalls = layer.lifecycleDiagnostics.evaluateKeyframeCalls - beforeCalls;
    if (optimized) {
      for (const [level, geometry] of oldGeometry) {
        if (nextTopology.levels.get(level) === oldTopology.levels.get(level)) check(pyramid.samplingGeometries.get(level) === geometry, `L${fromLevel}->L${toLevel} preserves L${level} sampling geometry`);
      }
      check(layer.temporal !== oldTemporal, `L${fromLevel}->L${toLevel} creates only the promoted stable wrapper`);
      check(replacementCalls === 0, `L${fromLevel}->L${toLevel} does not reevaluate destination at stable-range completion`);
    }
    return { layer, startCalls, startSnapshot, advancedSnapshot, replacementCalls, rangeChanged };
  }
  return { layer, startCalls, startSnapshot, advancedSnapshot, replacementCalls, rangeChanged };
}

function verifyReversal(Layer, fromLevel, toLevel) {
  const { layer, topology } = makeScenario(Layer, fromLevel);
  layer.setTransition(topology.levelDataFor(fromLevel), topology.levelDataFor(toLevel), time, 0.55);
  const before = layer.lifecycleDiagnostics.evaluateKeyframeCalls;
  const endpointSnapshot = valueSnapshot(layer);
  layer.setTransition(topology.levelDataFor(toLevel), topology.levelDataFor(fromLevel), time, 0.45);
  check(layer.lifecycleDiagnostics.evaluateKeyframeCalls === before, `${Layer.name} L${fromLevel}->L${toLevel} reversal reuses both endpoint keyframes`);
  check(snapshotsEqual(endpointSnapshot, valueSnapshot(layer)) === false, `${Layer.name} reversal changes only transition ownership/progress`);
}

const sequence = loadSequence();
setActiveWeatherField(sequence);
const [centerX, centerY] = lngLatToMercator(...WEATHER_REGION.center);
const testWindow = canonicalWindowFromMercatorBounds({ minX: centerX - 0.004, maxX: centerX + 0.004, minY: centerY - 0.004, maxY: centerY + 0.004 });

for (const Layer of [GeographicDotsLayer, GeographicSquaresLayer]) {
  for (let index = 0; index < levels.length - 1; index++) {
    const fromLevel = levels[index];
    const toLevel = levels[index + 1];
    for (const [left, right] of [[fromLevel, toLevel], [toLevel, fromLevel]]) {
      const baseline = runTransition(Layer, left, right, false);
      const optimized = runTransition(Layer, left, right, true);
      check(baseline.startCalls === optimized.startCalls, `${Layer.name} L${left}->L${right} start evaluation count is unchanged`);
      check(snapshotsEqual(baseline.startSnapshot, optimized.startSnapshot), `${Layer.name} L${left}->L${right} transition instances and values match`);
      check(snapshotsEqual(baseline.advancedSnapshot, optimized.advancedSnapshot), `${Layer.name} L${left}->L${right} playback advancement matches`);
      check(baseline.replacementCalls >= optimized.replacementCalls, `${Layer.name} L${left}->L${right} completion does not add weather work`);
      verifyReversal(Layer, left, right);
      console.log(`${Layer.name} L${left}->L${right}: startCalls=${optimized.startCalls}, replacementCalls=${baseline.replacementCalls}->${optimized.replacementCalls}`);
    }
  }
}

for (const Layer of [GeographicDotsLayer, GeographicSquaresLayer]) {
  const scenario = makeScenario(Layer, 14);
  const shiftedWindow = { ...testWindow, minX: testWindow.minX + 32, maxX: testWindow.maxX + 32 };
  const oldGeometry = scenario.pyramid.samplingGeometries;
  scenario.pyramid.setCanonicalWindow(shiftedWindow);
  scenario.layer.setTopology(scenario.pyramid.topology);
  check(scenario.layer.temporal === null && scenario.layer.levelData === null, `${Layer.name} canonical-window replacement clears incompatible state`);
  check([...oldGeometry.values()].every((geometry) => ![...scenario.pyramid.samplingGeometries.values()].includes(geometry)), `${Layer.name} canonical-window replacement drops old sampling geometry`);
  scenario.layer.setLevelData(scenario.pyramid.levelDataFor(14), time);
  check(scenario.layer.temporal?.levels.get(14)?.frames0?.index === Math.floor(time * TEMPORAL_FRAME_COUNT), `${Layer.name} changed window rebuilds at current weather time`);
}

console.log(failures ? `VERIFICATION FAILED: ${failures}` : 'VERIFICATION PASSED');
if (failures) process.exitCode = 1;
