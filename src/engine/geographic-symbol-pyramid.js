import { geographicIntensityAt } from './geography.js';
import { MAX_GRID_LEVEL, MIN_GRID_LEVEL, selectMercatorGridSamples } from './geographic-lod.js';
import { intensityToRadius, strongPrecipitationIntensity } from './precipitation-mapping.js';
import { hazardStateAppearance } from './hazard-renderer.js';
import { resolveHazardState } from './lod.js';

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

function parentIdFor(child, parentSamples, parentStep) {
  const minX = parentSamples.minX;
  const maxX = parentSamples.maxX;
  const minY = parentSamples.minY;
  const maxY = parentSamples.maxY;
  const x = Math.max(minX, Math.min(maxX, Math.floor(child.canonicalX / parentStep) * parentStep));
  const y = Math.max(minY, Math.min(maxY, Math.floor(child.canonicalY / parentStep) * parentStep));
  return x + ':' + y;
}

function parentTopology(fine, coarse) {
  const samplesById = new Map(coarse.samples.map((sample) => [sample.id, sample]));
  const parentBounds = {
    minX: Math.min(...coarse.samples.map((sample) => sample.canonicalX)),
    maxX: Math.max(...coarse.samples.map((sample) => sample.canonicalX)),
    minY: Math.min(...coarse.samples.map((sample) => sample.canonicalY)),
    maxY: Math.max(...coarse.samples.map((sample) => sample.canonicalY))
  };
  const parentStep = 2 ** (MAX_GRID_LEVEL - coarse.level);
  const children = new Map(coarse.samples.map((sample) => [sample.id, []]));
  const parentByChild = new Map();
  for (const child of fine.samples) {
    const parentId = parentIdFor(child, parentBounds, parentStep);
    if (!samplesById.has(parentId)) throw new Error('Fine Mercator sample has no deterministic parent.');
    children.get(parentId).push(child.id);
    parentByChild.set(child.id, parentId);
  }
  return { children, parentByChild };
}

function leafSymbol(sample, time) {
  const value = geographicIntensityAt(...sample.lngLat, time);
  const appearance = hazardStateAppearance(value, resolveHazardState(value), sample.spacing);
  return {
    id: sample.id,
    sample,
    rainRadius: intensityToRadius(value.rain, sample.spacing, 'rain'),
    strongRadius: intensityToRadius(strongPrecipitationIntensity(value.rain), sample.spacing, 'rain'),
    hazardType: appearance.radius > 0 ? appearance.type : null,
    hazardRadius: appearance.radius
  };
}

export function reduceSymbols(parentSample, children) {
  let rainArea = 0;
  let strongArea = 0;
  let hazardArea = 0;
  let hasHail = false;
  let hasStorm = false;
  for (const child of children) {
    rainArea += child.rainRadius * child.rainRadius;
    strongArea += child.strongRadius * child.strongRadius;
    if (!child.hazardType) continue;
    hazardArea += glyphArea(child.hazardType, child.hazardRadius);
    hasHail ||= child.hazardType === 'hail';
    hasStorm ||= child.hazardType === 'storm';
  }
  const hazardType = hasHail ? 'hail' : hasStorm ? 'storm' : null;
  return {
    id: parentSample.id,
    sample: parentSample,
    rainRadius: Math.sqrt(rainArea),
    strongRadius: Math.sqrt(strongArea),
    hazardType,
    hazardRadius: hazardType ? glyphRadiusForArea(hazardType, hazardArea) : 0
  };
}

export class GeographicSymbolPyramid {
  constructor() {
    this.levels = new Map();
    for (let level = MIN_GRID_LEVEL; level <= MAX_GRID_LEVEL; level++) {
      const selection = selectMercatorGridSamples(level);
      this.levels.set(level, { level, samples: selection.samples, samplesById: new Map(selection.samples.map((sample) => [sample.id, sample])) });
    }
    this.parents = new Map();
    for (let level = MIN_GRID_LEVEL; level < MAX_GRID_LEVEL; level++) {
      this.parents.set(level + 1, parentTopology(this.levels.get(level + 1), this.levels.get(level)));
    }
  }

  samplesFor(level) {
    return this.levels.get(level).samples;
  }

  evaluate(time) {
    const representations = new Map();
    const leaves = new Map();
    for (const sample of this.levels.get(MAX_GRID_LEVEL).samples) leaves.set(sample.id, leafSymbol(sample, time));
    representations.set(MAX_GRID_LEVEL, leaves);
    for (let level = MAX_GRID_LEVEL - 1; level >= MIN_GRID_LEVEL; level--) {
      const finer = representations.get(level + 1);
      const topology = this.parents.get(level + 1);
      const coarse = this.levels.get(level);
      const symbols = new Map();
      for (const [parentId, childIds] of topology.children) {
        symbols.set(parentId, reduceSymbols(coarse.samplesById.get(parentId), childIds.map((id) => finer.get(id))));
      }
      representations.set(level, symbols);
    }
    return representations;
  }
}
