import {
  canonicalCoordinatesForIndex,
  GeographicLodTopology,
  MAX_GRID_LEVEL,
  MIN_GRID_LEVEL,
  canonicalWindowFromMercatorBounds,
  lngLatToMercator,
  mercatorToLngLat,
  normalizeCanonicalWindow,
  mercatorXForIndex,
  mercatorYForIndex,
  forEachDirectTransitionPair
} from '../src/engine/geographic-lod.js';
import { buildCenteredContributionRelation, forEachCenteredContributionRelationEntry } from '../src/engine/geographic-weather-pyramid.js';

const LEVELS = [10, 11, 12, 13, 14, 15];
const FULL_RANGE = { minLevel: MIN_GRID_LEVEL, maxLevel: MAX_GRID_LEVEL };
const L10_STEP = 2 ** (MAX_GRID_LEVEL - MIN_GRID_LEVEL);
let failures = 0;

function check(condition, message) {
  if (condition) console.log(`PASS ${message}`);
  else { failures++; console.error(`FAIL ${message}`); }
}

function oldSelect(level, canonicalWindow) {
  const gridSize = 2 ** level;
  const spacing = 1 / gridSize;
  const identityScale = 2 ** (MAX_GRID_LEVEL - level);
  const minI = Math.ceil(canonicalWindow.minX / identityScale);
  const maxI = Math.floor(canonicalWindow.maxX / identityScale);
  const minJ = Math.ceil(canonicalWindow.minY / identityScale);
  const maxJ = Math.floor(canonicalWindow.maxY / identityScale);
  const samples = [];
  for (let j = minJ; j <= maxJ; j++) {
    for (let i = minI; i <= maxI; i++) {
      const x = i * spacing;
      const y = j * spacing;
      const canonicalX = i * identityScale;
      const canonicalY = j * identityScale;
      samples.push({
        id: `${canonicalX}:${canonicalY}`,
        canonicalX,
        canonicalY,
        mercator: [x, y],
        lngLat: mercatorToLngLat(x, y),
        level,
        spacing
      });
    }
  }
  return samples;
}

function oldIndexMap(samples) {
  return new Map(samples.map((sample, index) => [sample.id, index]));
}

function oldAnchors(samples) {
  const anchors = new Float64Array(samples.length * 2);
  for (let index = 0; index < samples.length; index++) {
    anchors[index * 2] = samples[index].mercator[0];
    anchors[index * 2 + 1] = samples[index].mercator[1];
  }
  return anchors;
}

function oldParents(fine, coarse) {
  const coarseIndices = oldIndexMap(coarse);
  const bounds = {
    minX: coarse[0].canonicalX,
    maxX: coarse[coarse.length - 1].canonicalX,
    minY: coarse[0].canonicalY,
    maxY: coarse[coarse.length - 1].canonicalY
  };
  const parentStep = 2 ** (MAX_GRID_LEVEL - (coarse[0].level));
  const childIndices = Array.from({ length: coarse.length }, () => []);
  const parentIndexByChild = new Int32Array(fine.length);
  for (let childIndex = 0; childIndex < fine.length; childIndex++) {
    const child = fine[childIndex];
    const x = Math.max(bounds.minX, Math.min(bounds.maxX, Math.floor(child.canonicalX / parentStep) * parentStep));
    const y = Math.max(bounds.minY, Math.min(bounds.maxY, Math.floor(child.canonicalY / parentStep) * parentStep));
    const parentIndex = coarseIndices.get(`${x}:${y}`);
    childIndices[parentIndex].push(childIndex);
    parentIndexByChild[childIndex] = parentIndex;
  }
  return { childIndices, parentIndexByChild };
}

function oldPairs(lower, higher) {
  const higherIndices = oldIndexMap(higher);
  const lowerIndices = oldIndexMap(lower);
  const pairs = [];
  for (let index = 0; index < lower.length; index++) pairs.push(index, higherIndices.get(lower[index].id) ?? -1);
  for (let index = 0; index < higher.length; index++) if (!lowerIndices.has(higher[index].id)) pairs.push(-1, index);
  return Int32Array.from(pairs);
}

function oldCentered(fine, coarse) {
  const coarseIndices = oldIndexMap(coarse);
  const parentStep = 2 ** (MAX_GRID_LEVEL - coarse[0].level);
  const offsets = new Uint32Array(fine.length + 1);
  const parentIndices = [];
  const weights = [];
  const axisCandidates = (coordinate) => coordinate % parentStep === 0
    ? [[coordinate, 1]]
    : [[coordinate - parentStep / 2, 0.5], [coordinate + parentStep / 2, 0.5]];
  for (let childIndex = 0; childIndex < fine.length; childIndex++) {
    const child = fine[childIndex];
    const candidates = [];
    for (const [x, xWeight] of axisCandidates(child.canonicalX)) {
      for (const [y, yWeight] of axisCandidates(child.canonicalY)) {
        const parentIndex = coarseIndices.get(`${x}:${y}`);
        if (parentIndex !== undefined) candidates.push([parentIndex, xWeight * yWeight]);
      }
    }
    const total = candidates.reduce((sum, [, weight]) => sum + weight, 0);
    for (const [parentIndex, weight] of candidates) {
      parentIndices.push(parentIndex);
      weights.push(weight / total);
    }
    offsets[childIndex + 1] = parentIndices.length;
  }
  return { offsets, parentIndices: Uint32Array.from(parentIndices), weights: Float64Array.from(weights) };
}

function compareTyped(name, packed, reference, tolerance = 0) {
  check(packed.length === reference.length, `${name} length=${reference.length}`);
  let maxError = 0;
  const length = Math.min(packed.length, reference.length);
  for (let index = 0; index < length; index++) maxError = Math.max(maxError, Math.abs(packed[index] - reference[index]));
  check(maxError <= tolerance, `${name} max error=${maxError}`);
}

function directPairSequence(relation) {
  const pairs = [];
  forEachDirectTransitionPair(relation, (lowerIndex, higherIndex) => pairs.push(lowerIndex, higherIndex));
  return Int32Array.from(pairs);
}

function compareCenteredRelation(name, relation, reference) {
  let referenceIndex = 0;
  let mismatch = null;
  for (let childIndex = 0; childIndex < relation.fineWidth * relation.fineHeight; childIndex++) {
    let actualCount = 0;
    forEachCenteredContributionRelationEntry(relation, childIndex, (parentIndex, weight) => {
      if (mismatch) return;
      if (referenceIndex >= reference.parentIndices.length
        || reference.parentIndices[referenceIndex] !== parentIndex
        || reference.weights[referenceIndex] !== weight) {
        mismatch = `child=${childIndex} entry=${actualCount} expected=${reference.parentIndices[referenceIndex]}/${reference.weights[referenceIndex]} actual=${parentIndex}/${weight}`;
        return;
      }
      actualCount++;
      referenceIndex++;
    });
    const expectedCount = reference.offsets[childIndex + 1] - reference.offsets[childIndex];
    if (!mismatch && actualCount !== expectedCount) mismatch = `child=${childIndex} expected count=${expectedCount} actual=${actualCount}`;
  }
  check(!mismatch && referenceIndex === reference.parentIndices.length, `${name} centered relation exact sequence${mismatch ? ` (${mismatch})` : ''}`);
}

function verifyWindow(rawWindow, name) {
  const canonicalWindow = normalizeCanonicalWindow(rawWindow);
  const topology = new GeographicLodTopology(canonicalWindow, FULL_RANGE);
  const legacy = new Map(LEVELS.map((level) => [level, oldSelect(level, canonicalWindow)]));
  for (const level of LEVELS) {
    const packed = topology.levelDataFor(level);
    const samples = legacy.get(level);
    const referenceAnchors = oldAnchors(samples);
    check(packed.count === samples.length, `${name} L${level} count=${packed.count}`);
    check(!('canonicalAnchors' in packed), `${name} L${level} descriptor retains no dense canonical anchors`);
    let coordinateError = 0;
    for (let index = 0; index < samples.length; index++) {
      const sample = samples[index];
      const coordinates = canonicalCoordinatesForIndex(packed, index);
      const mercatorX = mercatorXForIndex(packed, index);
      const mercatorY = mercatorYForIndex(packed, index);
      coordinateError = Math.max(
        coordinateError,
        Math.abs(coordinates.canonicalX - sample.canonicalX),
        Math.abs(coordinates.canonicalY - sample.canonicalY),
        Math.abs(mercatorX - referenceAnchors[index * 2]),
        Math.abs(mercatorY - referenceAnchors[index * 2 + 1]),
        ...mercatorToLngLat(mercatorX, mercatorY).map((value, i) => Math.abs(value - sample.lngLat[i]))
      );
    }
    check(coordinateError === 0, `${name} L${level} row-major canonical/Mercator/lngLat traversal max error=${coordinateError}`);
  }

  for (let level = MIN_GRID_LEVEL + 1; level <= MAX_GRID_LEVEL; level++) {
    const packedFine = topology.levelDataFor(level);
    const packedCoarse = topology.levelDataFor(level - 1);
    const referenceFine = legacy.get(level);
    const referenceCoarse = legacy.get(level - 1);
    const referenceParents = oldParents(referenceFine, referenceCoarse);
    const packedParents = topology.transitionParentsFor(level);
    compareTyped(`${name} L${level} parentIndexByChild`, packedParents.parentIndexByChild, referenceParents.parentIndexByChild);
    const packedChildren = [];
    for (let parent = 0; parent < packedCoarse.count; parent++) {
      for (let offset = packedParents.childOffsets[parent]; offset < packedParents.childOffsets[parent + 1]; offset++) packedChildren.push(packedParents.childIndices[offset]);
    }
    const referenceChildren = referenceParents.childIndices.flat();
    compareTyped(`${name} L${level} parent-major child order`, Uint32Array.from(packedChildren), Uint32Array.from(referenceChildren));
    compareTyped(`${name} L${level - 1}<->L${level} direct transition pair sequence`, directPairSequence(topology.directTransitionRelationFor(level - 1, level)), oldPairs(referenceCoarse, referenceFine));
    if (level <= 13) {
      const packedRelation = buildCenteredContributionRelation(packedFine, packedCoarse);
      const referenceContributions = oldCentered(referenceFine, referenceCoarse);
      compareCenteredRelation(`${name} L${level}->L${level - 1}`, packedRelation, referenceContributions);
    }
  }
}

const [centerX, centerY] = lngLatToMercator(45.03, 43.35);
const interior = canonicalWindowFromMercatorBounds({ minX: centerX - 0.0015, maxX: centerX + 0.0015, minY: centerY - 0.0015, maxY: centerY + 0.0015 });
const support = new GeographicLodTopology(undefined, { minLevel: MIN_GRID_LEVEL, maxLevel: MIN_GRID_LEVEL }).canonicalWindow;
const windows = [
  [interior, 'interior'],
  [{ minX: support.minX, maxX: support.minX + 3 * L10_STEP, minY: support.minY, maxY: support.minY + 3 * L10_STEP }, 'south-west support edge'],
  [{ minX: support.maxX - 3 * L10_STEP, maxX: support.maxX, minY: support.maxY - 3 * L10_STEP, maxY: support.maxY }, 'north-east support edge'],
  [{ minX: -100, maxX: -99, minY: -100, maxY: -99 }, 'one-cell off-domain fallback']
];
for (const [window, name] of windows) verifyWindow(window, name);
if (failures) process.exitCode = 1;
else console.log('PACKED TOPOLOGY EQUIVALENCE PASSED');
