import { geographicPreparedIntensityAt, geographicToSynthetic } from './geography.js';
import { MAX_GRID_LEVEL, MIN_GRID_LEVEL, selectMercatorGridSamples } from './geographic-lod.js';
import { intensityToRadius, strongPrecipitationIntensity } from './precipitation-mapping.js';
import { geographicHazardRadii } from './hazard-renderer.js';

export const REFERENCE_GRID_LEVEL = 13;
export const STORM_INNER_RATIO = 0.38;
export const HAIL_AREA_COEFFICIENT = 3 * Math.sqrt(3) / 2;
export const STORM_AREA_COEFFICIENT = 2 * STORM_INNER_RATIO * Math.sqrt(2);

export function glyphArea(type, radius) {
  const coefficient = type === 'hail' ? HAIL_AREA_COEFFICIENT : STORM_AREA_COEFFICIENT;
  return coefficient * radius * radius;
}

export function glyphRadiusForArea(type, area) {
  const coefficient = type === 'hail' ? HAIL_AREA_COEFFICIENT : STORM_AREA_COEFFICIENT;
  return Math.sqrt(area / coefficient);
}

function parentIdFor(child, bounds, parentStep) {
  const x = Math.max(bounds.minX, Math.min(bounds.maxX, Math.floor(child.canonicalX / parentStep) * parentStep));
  const y = Math.max(bounds.minY, Math.min(bounds.maxY, Math.floor(child.canonicalY / parentStep) * parentStep));
  return x + ':' + y;
}

function buildParentTopology(fine, coarse) {
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
    const parentId = parentIdFor(fine.samples[childIndex], bounds, parentStep);
    const parentIndex = samplesById.get(parentId);
    if (parentIndex === undefined) throw new Error('Fine Mercator sample has no deterministic parent.');
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

function makeState(length, reusable) {
  if (reusable?.rainRadius.length === length) return reusable;
  return {
    rainRadius: new Float64Array(length),
    strongRadius: new Float64Array(length),
    stormRadius: new Float64Array(length),
    hailRadius: new Float64Array(length)
  };
}

function evaluateDirect(level, frame, reusable) {
  const state = makeState(level.samples.length, reusable);
  const { rainRadius, strongRadius, stormRadius, hailRadius } = state;
  const value = { rain: 0, storm: 0, hail: 0 };
  const hazard = { stormRadius: 0, hailRadius: 0 };
  const point = { x: 0, y: 0 };
  const { fieldPoints, samples } = level;

  for (let index = 0; index < samples.length; index++) {
    point.x = fieldPoints[index * 2];
    point.y = fieldPoints[index * 2 + 1];
    geographicPreparedIntensityAt(frame, point, value);
    rainRadius[index] = intensityToRadius(value.rain, samples[index].spacing, 'rain');
    strongRadius[index] = intensityToRadius(strongPrecipitationIntensity(value.rain), samples[index].spacing, 'rain');
    geographicHazardRadii(value, samples[index].spacing, hazard);
    stormRadius[index] = hazard.stormRadius;
    hailRadius[index] = hazard.hailRadius;
  }
  return state;
}

function reduceState(parent, children, childIndices, reusable) {
  const state = makeState(parent.samples.length, reusable);
  const { rainRadius, strongRadius, stormRadius, hailRadius } = state;
  const childRain = children.rainRadius;
  const childStrong = children.strongRadius;
  const childStorm = children.stormRadius;
  const childHail = children.hailRadius;

  for (let parentIndex = 0; parentIndex < parent.samples.length; parentIndex++) {
    let rainArea = 0;
    let strongArea = 0;
    let hazardArea = 0;
    let hasHail = false;
    let hasStorm = false;
    const indices = childIndices[parentIndex];
    for (let childPosition = 0; childPosition < indices.length; childPosition++) {
      const childIndex = indices[childPosition];
      const childRainRadius = childRain[childIndex];
      const childStrongRadius = childStrong[childIndex];
      const childStormRadius = childStorm[childIndex];
      const childHailRadius = childHail[childIndex];
      rainArea += childRainRadius * childRainRadius;
      strongArea += childStrongRadius * childStrongRadius;
      if (childHailRadius > 0) {
        hazardArea += HAIL_AREA_COEFFICIENT * childHailRadius * childHailRadius;
        hasHail = true;
      } else if (childStormRadius > 0) {
        hazardArea += STORM_AREA_COEFFICIENT * childStormRadius * childStormRadius;
        hasStorm = true;
      }
    }
    rainRadius[parentIndex] = Math.sqrt(rainArea);
    strongRadius[parentIndex] = Math.sqrt(strongArea);
    if (hasHail) {
      hailRadius[parentIndex] = Math.sqrt(hazardArea / HAIL_AREA_COEFFICIENT);
      stormRadius[parentIndex] = 0;
    } else if (hasStorm) {
      stormRadius[parentIndex] = Math.sqrt(hazardArea / STORM_AREA_COEFFICIENT);
      hailRadius[parentIndex] = 0;
    } else {
      stormRadius[parentIndex] = 0;
      hailRadius[parentIndex] = 0;
    }
  }
  return state;
}

function averageAnchor(children, anchors) {
  let x = 0;
  let y = 0;
  for (let index = 0; index < children.length; index++) {
    const childIndex = children[index] * 2;
    x += anchors[childIndex];
    y += anchors[childIndex + 1];
  }
  return [x / children.length, y / children.length];
}

export class GeographicSymbolPyramid {
  constructor() {
    this.levels = new Map();
    for (let level = MIN_GRID_LEVEL; level <= MAX_GRID_LEVEL; level++) {
      const selection = selectMercatorGridSamples(level);
      const anchors = new Float64Array(selection.samples.length * 2);
      const fieldPoints = level >= REFERENCE_GRID_LEVEL ? new Float64Array(selection.samples.length * 2) : null;
      for (let index = 0; index < selection.samples.length; index++) {
        const sample = selection.samples[index];
        anchors[index * 2] = sample.mercator[0];
        anchors[index * 2 + 1] = sample.mercator[1];
        if (fieldPoints) {
          const point = geographicToSynthetic(...sample.lngLat);
          fieldPoints[index * 2] = point.x;
          fieldPoints[index * 2 + 1] = point.y;
        }
      }
      this.levels.set(level, {
        level,
        samples: selection.samples,
        samplesById: new Map(selection.samples.map((sample, index) => [sample.id, index])),
        anchors,
        fieldPoints
      });
    }

    this.parents = new Map();
    for (let level = REFERENCE_GRID_LEVEL - 1; level >= MIN_GRID_LEVEL; level--) {
      const coarse = this.levels.get(level);
      const fine = this.levels.get(level + 1);
      const topology = buildParentTopology(fine, coarse);
      for (let parentIndex = 0; parentIndex < coarse.samples.length; parentIndex++) {
        const anchor = averageAnchor(topology.childIndices[parentIndex], fine.anchors);
        coarse.anchors[parentIndex * 2] = anchor[0];
        coarse.anchors[parentIndex * 2 + 1] = anchor[1];
      }
      this.parents.set(level + 1, topology);
    }

    this.directPairs = new Map();
    for (let level = REFERENCE_GRID_LEVEL; level < MAX_GRID_LEVEL; level++) {
      this.directPairs.set(level + 1, buildDirectPairs(this.levels.get(level), this.levels.get(level + 1)));
    }

    this.lastEvaluationCounts = new Uint32Array(MAX_GRID_LEVEL + 1);
  }

  samplesFor(level) {
    return this.levels.get(level).samples;
  }

  parentIdFor(level, childId) {
    const topology = this.parents.get(level);
    if (!topology) return null;
    const childIndex = this.levels.get(level).samplesById.get(childId);
    if (childIndex === undefined) return null;
    return this.levels.get(level - 1).samples[topology.parentIndexByChild[childIndex]].id;
  }

  directPairsFor(lowerLevel, higherLevel) {
    if (higherLevel !== lowerLevel + 1) throw new Error('Direct grid pairs require adjacent levels.');
    return this.directPairs.get(higherLevel);
  }

  evaluate(requestedLevels, frame, reusableStates = null) {
    const states = new Array(MAX_GRID_LEVEL + 1);
    let wantsReference = false;
    let minimumRequested = REFERENCE_GRID_LEVEL;
    for (let index = 0; index < requestedLevels.length; index++) {
      const level = requestedLevels[index];
      if (level <= REFERENCE_GRID_LEVEL) {
        wantsReference = true;
        minimumRequested = Math.min(minimumRequested, level);
      }
    }

    this.lastEvaluationCounts.fill(0);
    if (wantsReference) {
      const reference = this.levels.get(REFERENCE_GRID_LEVEL);
      let state = evaluateDirect(reference, frame, reusableStates?.[REFERENCE_GRID_LEVEL]);
      states[REFERENCE_GRID_LEVEL] = state;
      this.lastEvaluationCounts[REFERENCE_GRID_LEVEL] = reference.samples.length;
      for (let level = REFERENCE_GRID_LEVEL - 1; level >= minimumRequested; level--) {
        const coarse = this.levels.get(level);
        state = reduceState(coarse, state, this.parents.get(level + 1).childIndices, reusableStates?.[level]);
        states[level] = state;
      }
    }

    for (let index = 0; index < requestedLevels.length; index++) {
      const level = requestedLevels[index];
      if (level <= REFERENCE_GRID_LEVEL) continue;
      const direct = this.levels.get(level);
      states[level] = evaluateDirect(direct, frame, reusableStates?.[level]);
      this.lastEvaluationCounts[level] = direct.samples.length;
    }
    return states;
  }
}
