import { geographicIntensityAt } from './geography.js';
import { MAX_GRID_LEVEL, MIN_GRID_LEVEL, selectMercatorGridSamples } from './geographic-lod.js';
import { intensityToRadius, strongPrecipitationIntensity } from './precipitation-mapping.js';
import { hazardStateAppearance } from './hazard-renderer.js';
import { resolveHazardState } from './lod.js';

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

function directSymbol(sample, anchor, time, counts) {
  counts[sample.level] = (counts[sample.level] || 0) + 1;
  const value = geographicIntensityAt(...sample.lngLat, time);
  const appearance = hazardStateAppearance(value, resolveHazardState(value), sample.spacing);
  return {
    id: sample.id,
    sample,
    anchor,
    rainRadius: intensityToRadius(value.rain, sample.spacing, 'rain'),
    strongRadius: intensityToRadius(strongPrecipitationIntensity(value.rain), sample.spacing, 'rain'),
    hazardType: appearance.radius > 0 ? appearance.type : null,
    hazardRadius: appearance.radius
  };
}

export function reduceSymbols(parent, children) {
  return reduceChildIndices(parent, children, null);
}

function reduceChildIndices(parent, symbols, childIndices) {
  let rainArea = 0;
  let strongArea = 0;
  let hazardArea = 0;
  let hasHail = false;
  let hasStorm = false;

  const count = childIndices ? childIndices.length : symbols.length;
  for (let index = 0; index < count; index++) {
    const child = childIndices ? symbols[childIndices[index]] : symbols[index];
    rainArea += child.rainRadius * child.rainRadius;
    strongArea += child.strongRadius * child.strongRadius;
    if (!child.hazardType) continue;
    hazardArea += glyphArea(child.hazardType, child.hazardRadius);
    hasHail ||= child.hazardType === 'hail';
    hasStorm ||= child.hazardType === 'storm';
  }

  const hazardType = hasHail ? 'hail' : hasStorm ? 'storm' : null;
  return {
    id: parent.id,
    sample: parent.sample,
    anchor: parent.anchor,
    rainRadius: Math.sqrt(rainArea),
    strongRadius: Math.sqrt(strongArea),
    hazardType,
    hazardRadius: hazardType ? glyphRadiusForArea(hazardType, hazardArea) : 0
  };
}

function averageAnchor(children, anchors) {
  let x = 0;
  let y = 0;
  for (const childIndex of children) {
    x += anchors[childIndex][0];
    y += anchors[childIndex][1];
  }
  return [x / children.length, y / children.length];
}

export class GeographicSymbolPyramid {
  constructor() {
    this.levels = new Map();
    for (let level = MIN_GRID_LEVEL; level <= MAX_GRID_LEVEL; level++) {
      const selection = selectMercatorGridSamples(level);
      const anchors = selection.samples.map((sample) => sample.mercator);
      this.levels.set(level, {
        level,
        samples: selection.samples,
        samplesById: new Map(selection.samples.map((sample, index) => [sample.id, index])),
        anchors,
        nodes: selection.samples.map((sample, index) => ({ id: sample.id, sample, anchor: anchors[index] }))
      });
    }

    this.parents = new Map();
    for (let level = REFERENCE_GRID_LEVEL - 1; level >= MIN_GRID_LEVEL; level--) {
      const coarse = this.levels.get(level);
      const fine = this.levels.get(level + 1);
      const topology = buildParentTopology(fine, coarse);
      for (let parentIndex = 0; parentIndex < coarse.samples.length; parentIndex++) {
        coarse.anchors[parentIndex] = averageAnchor(topology.childIndices[parentIndex], fine.anchors);
        coarse.nodes[parentIndex] = {
          id: coarse.samples[parentIndex].id,
          sample: coarse.samples[parentIndex],
          anchor: coarse.anchors[parentIndex]
        };
      }
      this.parents.set(level + 1, topology);
    }

    this.lastEvaluationCounts = {};
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

  evaluate(requestedLevels, time) {
    const requested = [...new Set(requestedLevels)];
    const representations = new Map();
    const counts = {};
    const wantsReference = requested.some((level) => level <= REFERENCE_GRID_LEVEL);

    if (wantsReference) {
      const reference = this.levels.get(REFERENCE_GRID_LEVEL);
      let symbols = reference.nodes.map((node) => directSymbol(node.sample, node.anchor, time, counts));
      representations.set(REFERENCE_GRID_LEVEL, symbols);

      const minimumRequested = Math.min(...requested.filter((level) => level <= REFERENCE_GRID_LEVEL));
      for (let level = REFERENCE_GRID_LEVEL - 1; level >= minimumRequested; level--) {
        const coarse = this.levels.get(level);
        const topology = this.parents.get(level + 1);
        const reduced = new Array(coarse.nodes.length);
        for (let parentIndex = 0; parentIndex < coarse.nodes.length; parentIndex++) {
          reduced[parentIndex] = reduceChildIndices(coarse.nodes[parentIndex], symbols, topology.childIndices[parentIndex]);
        }
        symbols = reduced;
        representations.set(level, symbols);
      }
    }

    for (const level of requested) {
      if (level <= REFERENCE_GRID_LEVEL) continue;
      const direct = this.levels.get(level);
      representations.set(level, direct.nodes.map((node) => directSymbol(node.sample, node.anchor, time, counts)));
    }

    this.lastEvaluationCounts = counts;
    return representations;
  }
}
