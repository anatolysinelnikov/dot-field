import { geographicPreparedIntensityAt, geographicToSynthetic } from './geography.js';
import { MAX_DISPLAY_GRID_LEVEL, MAX_GRID_LEVEL, MIN_GRID_LEVEL, selectMercatorGridSamples } from './geographic-lod.js';

const REFERENCE_GRID_LEVEL = MAX_DISPLAY_GRID_LEVEL;
const HAZARD_CHANNELS = ['storm', 'hail', 'squall', 'hurricane'];

function parentIdForSample(sample, bounds, parentStep) {
  const x = Math.max(bounds.minX, Math.min(bounds.maxX, Math.floor(sample.canonicalX / parentStep) * parentStep));
  const y = Math.max(bounds.minY, Math.min(bounds.maxY, Math.floor(sample.canonicalY / parentStep) * parentStep));
  return `${x}:${y}`;
}

function buildParentTopology(fine, coarse) {
  const coarseIndexById = new Map(coarse.samples.map((sample, index) => [sample.id, index]));
  const bounds = {
    minX: coarse.samples[0].canonicalX,
    maxX: coarse.samples[coarse.samples.length - 1].canonicalX,
    minY: coarse.samples[0].canonicalY,
    maxY: coarse.samples[coarse.samples.length - 1].canonicalY
  };
  const parentStep = 2 ** (MAX_GRID_LEVEL - coarse.level);
  const childIndices = Array.from({ length: coarse.samples.length }, () => []);

  for (let childIndex = 0; childIndex < fine.samples.length; childIndex++) {
    const parentId = parentIdForSample(fine.samples[childIndex], bounds, parentStep);
    const parentIndex = coarseIndexById.get(parentId);
    if (parentIndex === undefined) throw new Error('Fine Mercator sample has no deterministic parent.');
    childIndices[parentIndex].push(childIndex);
  }

  return childIndices;
}

function makeState(length, reusable) {
  if (reusable?.hazardValues?.storm.length === length) return reusable;
  return {
    hazardValues: Object.fromEntries(HAZARD_CHANNELS.map((channel) => [channel, new Float32Array(length)]))
  };
}

function evaluateReference(level, frame, reusable) {
  const state = makeState(level.samples.length, reusable);
  const { hazardValues } = state;
  const value = { storm: 0, hail: 0, squall: 0, hurricane: 0 };
  const point = { x: 0, y: 0 };

  for (let index = 0; index < level.samples.length; index++) {
    point.x = level.fieldPoints[index * 2];
    point.y = level.fieldPoints[index * 2 + 1];
    geographicPreparedIntensityAt(frame, point, value);
    for (const channel of HAZARD_CHANNELS) hazardValues[channel][index] = value[channel];
  }
  return state;
}

function reduceState(parent, children, childIndices, reusable) {
  const state = makeState(parent.samples.length, reusable);
  const { hazardValues } = state;
  const childHazards = children.hazardValues;

  for (let parentIndex = 0; parentIndex < parent.samples.length; parentIndex++) {
    const indices = childIndices[parentIndex];
    const hazardMaxima = { storm: 0, hail: 0, squall: 0, hurricane: 0 };
    for (let childPosition = 0; childPosition < indices.length; childPosition++) {
      const childIndex = indices[childPosition];
      for (const channel of HAZARD_CHANNELS) {
        const value = childHazards[channel][childIndex];
        hazardMaxima[channel] = Math.max(hazardMaxima[channel], value);
      }
    }
    for (const channel of HAZARD_CHANNELS) hazardValues[channel][parentIndex] = hazardMaxima[channel];
  }
  return state;
}

export class GeographicSymbolPyramid {
  constructor() {
    this.levels = new Map();
    for (let level = MIN_GRID_LEVEL; level <= REFERENCE_GRID_LEVEL; level++) {
      const selection = selectMercatorGridSamples(level);
      const fieldPoints = level === REFERENCE_GRID_LEVEL ? new Float64Array(selection.samples.length * 2) : null;
      if (fieldPoints) {
        for (let index = 0; index < selection.samples.length; index++) {
          const point = geographicToSynthetic(...selection.samples[index].lngLat);
          fieldPoints[index * 2] = point.x;
          fieldPoints[index * 2 + 1] = point.y;
        }
      }
      this.levels.set(level, { level, samples: selection.samples, fieldPoints });
    }

    this.childIndicesByLevel = new Map();
    for (let level = REFERENCE_GRID_LEVEL - 1; level >= MIN_GRID_LEVEL; level--) {
      this.childIndicesByLevel.set(level + 1, buildParentTopology(this.levels.get(level + 1), this.levels.get(level)));
    }
  }

  samplesFor(level) {
    return this.levels.get(level).samples;
  }

  evaluate(requestedLevels, frame, reusableStates = null) {
    const states = new Array(REFERENCE_GRID_LEVEL + 1);
    if (!requestedLevels.length) return states;
    const minimumRequested = Math.min(...requestedLevels);
    const reference = this.levels.get(REFERENCE_GRID_LEVEL);
    let state = evaluateReference(reference, frame, reusableStates?.[REFERENCE_GRID_LEVEL]);
    states[REFERENCE_GRID_LEVEL] = state;
    for (let level = REFERENCE_GRID_LEVEL - 1; level >= minimumRequested; level--) {
      state = reduceState(this.levels.get(level), state, this.childIndicesByLevel.get(level + 1), reusableStates?.[level]);
      states[level] = state;
    }
    return states;
  }
}
