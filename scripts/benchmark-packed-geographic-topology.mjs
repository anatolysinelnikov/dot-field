import fs from 'node:fs';
import { performance } from 'node:perf_hooks';
import {
  canonicalWindowFromMercatorBounds,
  GeographicLodTopology,
  MAX_GRID_LEVEL,
  MIN_GRID_LEVEL,
  mercatorToLngLat,
  lngLatToMercator,
  normalizeCanonicalWindow
} from '../src/engine/geographic-lod.js';
import { buildCenteredContributions, GeographicWeatherPyramid } from '../src/engine/geographic-weather-pyramid.js';
import { prepareGeographicFieldFrame, setActiveWeatherField, WEATHER_REGION } from '../src/engine/geography.js';
import { parseRealWeatherCsv } from '../src/engine/real-weather.js';

const FULL_RANGE = { minLevel: MIN_GRID_LEVEL, maxLevel: MAX_GRID_LEVEL };
// The full range intentionally keeps explicit canonical L15 coverage. These
// are the active product/display ranges, which stop at L14.
const CONFIGURATIONS = [
  ['L10', { minLevel: 10, maxLevel: 13 }],
  ['L11', { minLevel: 10, maxLevel: 13 }],
  ['L12', { minLevel: 11, maxLevel: 13 }],
  ['L13', { minLevel: 12, maxLevel: 14 }],
  ['L14', { minLevel: 13, maxLevel: 14 }]
];

const field = parseRealWeatherCsv(fs.readFileSync(new URL('../data/mrl_z3_t+40min_376x239.csv', import.meta.url), 'utf8'));
setActiveWeatherField(field);
const frame = prepareGeographicFieldFrame(0.347);
const [centerX, centerY] = lngLatToMercator(...WEATHER_REGION.center);
const viewportWindow = canonicalWindowFromMercatorBounds({ minX: centerX - 0.004, maxX: centerX + 0.004, minY: centerY - 0.004, maxY: centerY + 0.004 });
const supportWindow = new GeographicLodTopology(undefined, { minLevel: MIN_GRID_LEVEL, maxLevel: MIN_GRID_LEVEL }).canonicalWindow;

function oldSelect(level, canonicalWindow) {
  const spacing = 1 / 2 ** level;
  const identityScale = 2 ** (MAX_GRID_LEVEL - level);
  const minI = Math.ceil(canonicalWindow.minX / identityScale);
  const maxI = Math.floor(canonicalWindow.maxX / identityScale);
  const minJ = Math.ceil(canonicalWindow.minY / identityScale);
  const maxJ = Math.floor(canonicalWindow.maxY / identityScale);
  const samples = [];
  for (let j = minJ; j <= maxJ; j++) for (let i = minI; i <= maxI; i++) {
    const x = i * spacing;
    const y = j * spacing;
    const canonicalX = i * identityScale;
    const canonicalY = j * identityScale;
    samples.push({ id: `${canonicalX}:${canonicalY}`, canonicalX, canonicalY, mercator: [x, y], lngLat: mercatorToLngLat(x, y), level, spacing });
  }
  return { level, spacing, samples, canonicalAnchors: new Float64Array(samples.length * 2) };
}

function oldIndexMap(levelData) {
  return new Map(levelData.samples.map((sample, index) => [sample.id, index]));
}

function oldBuildTopology(canonicalWindow, range) {
  const started = performance.now();
  const levels = new Map();
  const levelTimes = [];
  for (let level = range.minLevel; level <= range.maxLevel; level++) {
    const levelStarted = performance.now();
    const levelData = oldSelect(level, canonicalWindow);
    for (let index = 0; index < levelData.samples.length; index++) {
      levelData.canonicalAnchors[index * 2] = levelData.samples[index].mercator[0];
      levelData.canonicalAnchors[index * 2 + 1] = levelData.samples[index].mercator[1];
    }
    levelData.samplesById = oldIndexMap(levelData);
    levels.set(level, levelData);
    levelTimes.push({ level, ms: performance.now() - levelStarted });
  }
  const transitionParents = new Map();
  const transitionStarted = performance.now();
  for (let level = range.minLevel + 1; level <= range.maxLevel; level++) {
    const fine = levels.get(level);
    const coarse = levels.get(level - 1);
    const coarseIndices = oldIndexMap(coarse);
    const bounds = { minX: coarse.samples[0].canonicalX, maxX: coarse.samples.at(-1).canonicalX, minY: coarse.samples[0].canonicalY, maxY: coarse.samples.at(-1).canonicalY };
    const parentStep = 2 ** (MAX_GRID_LEVEL - coarse.level);
    const childIndices = Array.from({ length: coarse.samples.length }, () => []);
    const parentIndexByChild = new Int32Array(fine.samples.length);
    for (let childIndex = 0; childIndex < fine.samples.length; childIndex++) {
      const child = fine.samples[childIndex];
      const x = Math.max(bounds.minX, Math.min(bounds.maxX, Math.floor(child.canonicalX / parentStep) * parentStep));
      const y = Math.max(bounds.minY, Math.min(bounds.maxY, Math.floor(child.canonicalY / parentStep) * parentStep));
      const parentIndex = coarseIndices.get(`${x}:${y}`);
      childIndices[parentIndex].push(childIndex);
      parentIndexByChild[childIndex] = parentIndex;
    }
    transitionParents.set(level, { childIndices, parentIndexByChild });
  }
  const transitionParentsMs = performance.now() - transitionStarted;
  const directPairs = new Map();
  const directStarted = performance.now();
  for (let level = range.minLevel + 1; level <= range.maxLevel; level++) {
    const lower = levels.get(level - 1);
    const higher = levels.get(level);
    const higherIndices = oldIndexMap(higher);
    const lowerIndices = oldIndexMap(lower);
    const pairs = [];
    for (let index = 0; index < lower.samples.length; index++) pairs.push(index, higherIndices.get(lower.samples[index].id) ?? -1);
    for (let index = 0; index < higher.samples.length; index++) if (!lowerIndices.has(higher.samples[index].id)) pairs.push(-1, index);
    directPairs.set(level, new Int32Array(pairs));
  }
  const directPairsMs = performance.now() - directStarted;
  return { levels, transitionParents, directPairs, levelTimes, transitionParentsMs, directPairsMs, totalMs: performance.now() - started };
}

function oldCentered(fine, coarse) {
  const coarseIndices = oldIndexMap(coarse);
  const parentStep = 2 ** (MAX_GRID_LEVEL - coarse.level);
  const offsets = new Uint32Array(fine.samples.length + 1);
  const parentIndices = [];
  const weights = [];
  const candidates = (coordinate) => coordinate % parentStep === 0
    ? [[coordinate, 1]]
    : [[coordinate - parentStep / 2, 0.5], [coordinate + parentStep / 2, 0.5]];
  for (let childIndex = 0; childIndex < fine.samples.length; childIndex++) {
    const child = fine.samples[childIndex];
    const entries = [];
    for (const [x, xWeight] of candidates(child.canonicalX)) for (const [y, yWeight] of candidates(child.canonicalY)) {
      const parentIndex = coarseIndices.get(`${x}:${y}`);
      if (parentIndex !== undefined) entries.push([parentIndex, xWeight * yWeight]);
    }
    const total = entries.reduce((sum, [, weight]) => sum + weight, 0);
    for (const [parentIndex, weight] of entries) { parentIndices.push(parentIndex); weights.push(weight / total); }
    offsets[childIndex + 1] = parentIndices.length;
  }
  return { offsets, parentIndices: Uint32Array.from(parentIndices), weights: Float64Array.from(weights) };
}

function oldTopologySetup(topology, range) {
  const started = performance.now();
  const contributionsStarted = performance.now();
  const contributions = new Map();
  for (let level = range.minLevel + 1; level <= range.maxLevel; level++) {
    contributions.set(level, oldCentered(topology.levels.get(level), topology.levels.get(level - 1)));
  }
  const contributionsMs = performance.now() - contributionsStarted;
  const totalWeightsStarted = performance.now();
  const totalWeights = new Map();
  if (topology.levels.has(13)) {
    const referenceWeights = new Float32Array(topology.levels.get(13).samples.length);
    referenceWeights.fill(1);
    totalWeights.set(13, referenceWeights);
    for (let level = 12; level >= range.minLevel; level--) {
      const childWeights = totalWeights.get(level + 1);
      const levelContributions = contributions.get(level + 1);
      if (!childWeights || !levelContributions || !topology.levels.has(level)) continue;
      const weights = new Float32Array(topology.levels.get(level).samples.length);
      for (let childIndex = 0; childIndex < childWeights.length; childIndex++) {
        const start = levelContributions.offsets[childIndex];
        const end = levelContributions.offsets[childIndex + 1];
        for (let contributionIndex = start; contributionIndex < end; contributionIndex++) {
          weights[levelContributions.parentIndices[contributionIndex]] += childWeights[childIndex]
            * levelContributions.weights[contributionIndex];
        }
      }
      totalWeights.set(level, weights);
    }
  }
  return {
    contributionsMs,
    totalWeightsMs: performance.now() - totalWeightsStarted,
    totalMs: performance.now() - started,
    contributions,
    totalWeights
  };
}

function legacyTopologyBytes(topology) {
  let bytes = 0;
  for (const levelData of topology.levels.values()) {
    bytes += levelData.canonicalAnchors.byteLength;
  }
  for (const pairs of topology.directPairs.values()) bytes += pairs.byteLength;
  for (const parents of topology.transitionParents.values()) bytes += parents.parentIndexByChild.byteLength;
  return bytes;
}

function packedTopologyBytes(topology) {
  let bytes = 0;
  for (const levelData of topology.levels.values()) bytes += levelData.canonicalAnchors.byteLength;
  for (const parents of topology.transitionParents.values()) bytes += parents.childOffsets.byteLength + parents.childIndices.byteLength + parents.parentIndexByChild.byteLength;
  for (const pairs of topology.directPairs.values()) bytes += pairs.byteLength;
  return bytes;
}

function oldRetainedCounts(topology) {
  let samples = 0;
  let maps = 0;
  let childArrays = 0;
  for (const levelData of topology.levels.values()) { samples += levelData.samples.length; maps += levelData.samplesById.size; }
  for (const parents of topology.transitionParents.values()) { childArrays += parents.childIndices.length; maps += 1; }
  for (const pairs of topology.directPairs.values()) maps += 2;
  return { sampleObjects: samples, sampleIds: samples, mapEntries: maps, nestedChildArrays: childArrays };
}

function packedRetainedCounts(topology) {
  return { sampleObjects: 0, sampleIds: 0, mapEntries: topology.levels.size + topology.transitionParents.size + topology.directPairs.size, nestedChildArrays: 0 };
}

function measureHeap(builder, repetitions = 3) {
  if (typeof global.gc !== 'function') return null;
  const values = [];
  for (let repetition = 0; repetition < repetitions; repetition++) {
    global.gc();
    const before = process.memoryUsage();
    const value = builder();
    global.gc();
    const after = process.memoryUsage();
    values.push({ heapDelta: after.heapUsed - before.heapUsed, externalDelta: after.external - before.external, arrayBuffersDelta: after.arrayBuffers - before.arrayBuffers });
    void value;
  }
  return values;
}

function median(values) {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)];
}

function prepareOldGeometry(levelData) {
  const longitudes = new Float64Array(levelData.samples.length);
  const latitudes = new Float64Array(levelData.samples.length);
  for (let index = 0; index < levelData.samples.length; index++) { longitudes[index] = levelData.samples[index].lngLat[0]; latitudes[index] = levelData.samples[index].lngLat[1]; }
  return frame.prepareSamplingGeometry(longitudes, latitudes);
}

function windowSequence(window) {
  const step = 2 ** (MAX_GRID_LEVEL - MIN_GRID_LEVEL);
  return [
    window,
    normalizeCanonicalWindow({ minX: window.minX + step, maxX: window.maxX + step, minY: window.minY, maxY: window.maxY }),
    normalizeCanonicalWindow({ minX: window.minX, maxX: window.maxX, minY: window.minY + step, maxY: window.maxY + step }),
    window
  ];
}

function replacementMetrics(window) {
  const initial = new GeographicWeatherPyramid(Float32Array, new GeographicLodTopology(window, CONFIGURATIONS[3][1]));
  const windows = windowSequence(window);
  const windowTimes = [];
  for (const nextWindow of windows.slice(1)) {
    const started = performance.now();
    initial.setCanonicalWindow(nextWindow);
    windowTimes.push(performance.now() - started);
  }
  const rangeTimes = [];
  for (const [, range] of CONFIGURATIONS) {
    const started = performance.now();
    initial.setLevelRange(range);
    rangeTimes.push(performance.now() - started);
  }
  return { windowTimes, rangeTimes };
}

function oldReplacementMetrics(window) {
  const initialRange = CONFIGURATIONS[3][1];
  const windows = windowSequence(window);
  const windowTimes = [];
  for (const nextWindow of windows.slice(1)) {
    const started = performance.now();
    const topology = oldBuildTopology(nextWindow, initialRange);
    oldTopologySetup(topology, initialRange);
    windowTimes.push(performance.now() - started);
  }
  const rangeTimes = [];
  for (const [, range] of CONFIGURATIONS) {
    const started = performance.now();
    const topology = oldBuildTopology(window, range);
    oldTopologySetup(topology, range);
    rangeTimes.push(performance.now() - started);
  }
  return { windowTimes, rangeTimes };
}

function runCase(name, window, range, fullSupport) {
  const packed = new GeographicLodTopology(window, range);
  const legacy = oldBuildTopology(window, range);
  const packedPyramid = new GeographicWeatherPyramid(Float32Array, packed);
  const oldReference = legacy.levels.get(range.maxLevel);
  const packedReference = packed.levelDataFor(range.maxLevel);
  const oldGeometryStarted = performance.now();
  const oldGeometry = fullSupport ? null : prepareOldGeometry(oldReference);
  const oldGeometryMs = fullSupport ? null : performance.now() - oldGeometryStarted;
  const packedGeometryStarted = performance.now();
  const packedGeometry = packedPyramid.prepareSamplingGeometry(range.maxLevel, frame);
  const packedGeometryMs = performance.now() - packedGeometryStarted;
  const oldCenteredStarted = performance.now();
  for (let level = Math.max(MIN_GRID_LEVEL + 1, range.minLevel + 1); level <= Math.min(13, range.maxLevel); level++) oldCentered(legacy.levels.get(level), legacy.levels.get(level - 1));
  const oldCenteredMs = performance.now() - oldCenteredStarted;
  const packedCenteredStarted = performance.now();
  for (let level = Math.max(MIN_GRID_LEVEL + 1, range.minLevel + 1); level <= Math.min(13, range.maxLevel); level++) buildCenteredContributions(packed.levelDataFor(level), packed.levelDataFor(level - 1));
  const packedCenteredMs = performance.now() - packedCenteredStarted;
  const oldSetup = oldTopologySetup(legacy, range);
  const replacement = replacementMetrics(window);
  const oldReplacement = oldReplacementMetrics(window);
  const oldCounts = oldRetainedCounts(legacy);
  const packedCounts = packedRetainedCounts(packed);
  const result = {
    name,
    fullSupport,
    range,
    counts: Object.fromEntries([...packed.levels].map(([level, data]) => [`L${level}`, data.count])),
    completeConstructionMs: { legacy: legacy.totalMs, packed: packed.constructionTimings.totalMs },
    perLevelGridMs: { legacy: legacy.levelTimes, packed: packed.constructionTimings.levels },
    transitionParentsMs: { legacy: legacy.transitionParentsMs, packed: packed.constructionTimings.transitionParentsMs },
    directPairsMs: { legacy: legacy.directPairsMs, packed: packed.constructionTimings.directPairsMs },
    centeredContributionsMs: { legacy: oldCenteredMs, packed: packedCenteredMs },
    legacySetTopologyMs: {
      contributionsMs: oldSetup.contributionsMs,
      totalWeightsMs: oldSetup.totalWeightsMs,
      totalMs: oldSetup.totalMs
    },
    setTopologyMs: packedPyramid.topologySetupTimings,
    providerSamplingGeometryMs: { legacy: oldGeometryMs, packed: packedGeometryMs, bytes: frame.samplingGeometryBytes(packedGeometry) },
    replacementMs: { legacy: oldReplacement, packed: replacement },
    memory: {
      legacyHeap: fullSupport ? null : measureHeap(() => oldBuildTopology(window, range), 2),
      packedHeap: measureHeap(() => new GeographicLodTopology(window, range), 3),
      legacyTypedBytes: legacyTopologyBytes(legacy),
      packedTypedBytes: packedTopologyBytes(packed),
      oldCounts,
      packedCounts
    },
    sequenceWindowMs: windowSequence(window).length
  };
  void oldGeometry;
  void packedReference;
  return result;
}

function runFullSupportCase(label, range) {
  let legacyMetrics;
  if (process.env.PACKED_TOPOLOGY_INCLUDE_LEGACY_FULL === '1') {
    const legacy = oldBuildTopology(supportWindow, range);
    const centeredStarted = performance.now();
    for (let level = Math.max(MIN_GRID_LEVEL + 1, range.minLevel + 1); level <= Math.min(13, range.maxLevel); level++) oldCentered(legacy.levels.get(level), legacy.levels.get(level - 1));
    legacyMetrics = {
      completeConstructionMs: legacy.totalMs,
      perLevelGridMs: legacy.levelTimes,
      transitionParentsMs: legacy.transitionParentsMs,
      directPairsMs: legacy.directPairsMs,
      centeredContributionsMs: performance.now() - centeredStarted,
      memory: { legacyTypedBytes: legacyTopologyBytes(legacy), oldCounts: oldRetainedCounts(legacy) },
      counts: Object.fromEntries([...legacy.levels].map(([level, data]) => [`L${level}`, data.samples.length]))
    };
  }
  if (typeof global.gc === 'function') global.gc();
  const packedHeap = measureHeap(() => new GeographicLodTopology(supportWindow, range), 2);
  const packed = new GeographicLodTopology(supportWindow, range);
  if (!legacyMetrics) {
    const counts = Object.fromEntries([...packed.levels].map(([level, data]) => [`L${level}`, data.count]));
    const sampleObjects = [...packed.levels.values()].reduce((sum, data) => sum + data.count, 0);
    const nestedChildArrays = [...packed.levels.keys()].filter((level) => level > range.minLevel).reduce((sum, level) => sum + packed.levelDataFor(level - 1).count, 0);
    const legacyTypedBytes = sampleObjects * 2 * Float64Array.BYTES_PER_ELEMENT
      + [...packed.levels.keys()].filter((level) => level > range.minLevel).reduce((sum, level) => sum + packed.levelDataFor(level).count * Int32Array.BYTES_PER_ELEMENT, 0)
      + [...packed.directPairs.values()].reduce((sum, pairs) => sum + pairs.byteLength, 0);
    legacyMetrics = {
      completeConstructionMs: null,
      perLevelGridMs: null,
      transitionParentsMs: null,
      directPairsMs: null,
      centeredContributionsMs: null,
      memory: { legacyTypedBytes, oldCounts: { sampleObjects, sampleIds: sampleObjects, mapEntries: sampleObjects + (packed.levels.size - 1) * 3, nestedChildArrays } },
      counts
    };
  }
  const pyramid = new GeographicWeatherPyramid(Float32Array, packed);
  const geometryStarted = performance.now();
  const geometry = pyramid.prepareSamplingGeometry(range.maxLevel, frame);
  const packedGeometryMs = performance.now() - geometryStarted;
  return {
    name: `full-support ${label}`,
    fullSupport: true,
    range,
    counts: legacyMetrics.counts,
    completeConstructionMs: { legacy: legacyMetrics.completeConstructionMs, packed: packed.constructionTimings.totalMs },
    perLevelGridMs: { legacy: legacyMetrics.perLevelGridMs, packed: packed.constructionTimings.levels },
    transitionParentsMs: { legacy: legacyMetrics.transitionParentsMs, packed: packed.constructionTimings.transitionParentsMs },
    directPairsMs: { legacy: legacyMetrics.directPairsMs, packed: packed.constructionTimings.directPairsMs },
    centeredContributionsMs: { legacy: legacyMetrics.centeredContributionsMs, packed: pyramid.topologySetupTimings.contributionsMs },
    setTopologyMs: pyramid.topologySetupTimings,
    providerSamplingGeometryMs: { legacy: null, packed: packedGeometryMs, bytes: frame.samplingGeometryBytes(geometry) },
    replacementMs: null,
    memory: {
      legacyHeap: null,
      packedHeap,
      legacyTypedBytes: legacyMetrics.memory.legacyTypedBytes,
      packedTypedBytes: packedTopologyBytes(packed),
      oldCounts: legacyMetrics.memory.oldCounts,
      packedCounts: packedRetainedCounts(packed)
    },
    note: process.env.PACKED_TOPOLOGY_INCLUDE_LEGACY_FULL === '1'
      ? 'Legacy full-support heap and geometry probes are omitted because the object-heavy baseline exceeds this runner\'s practical heap budget.'
      : 'Legacy full-support construction is disabled by default because the object-heavy baseline exceeds this runner\'s practical heap budget; viewport cases measure the complete legacy baseline and full-support counts/packed timings remain deterministic.'
  };
}

console.log(JSON.stringify({ metadata: { node: process.version, gc: typeof global.gc === 'function', fullSupportWindow: supportWindow, viewportWindow }, results: [] }, null, 2));
for (const [label, range] of CONFIGURATIONS) {
  // Full-support L10..L13 is the practical large-domain before/after baseline.
  // Higher full-support ranges are intentionally omitted because the legacy
  // object topology exceeds normal desktop heap budgets; viewport cases cover
  // all five active stable LOD contracts.
  if (range.maxLevel <= 13 && process.env.PACKED_TOPOLOGY_SKIP_FULL !== '1') console.log(JSON.stringify(runFullSupportCase(label, range)));
  console.log(JSON.stringify(runCase(`viewport ${label}`, viewportWindow, range, false)));
}
