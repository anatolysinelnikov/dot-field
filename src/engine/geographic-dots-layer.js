import { prepareGeographicFieldFrame } from './geography.js';
import { geographicTemporalFrameAt, setGeographicProjection, TEMPORAL_FRAME_COUNT } from './geographic-layer-utils.js';
import {
  dotsStrongRainMmhToRadius,
  dotsStrongRainMmhToRadiusFraction,
  rainMmhToRadiusFraction
} from './precipitation-mapping.js';
import { GeographicWeatherPyramid, WEATHER_DIRECT_STATE_PACKED, WEATHER_REFERENCE_LEVEL, rainCoverageWeightForThreshold, WEATHER_SUMMARY_PROFILE_RAIN_ONLY_DISPLAY } from './geographic-weather-pyramid.js';
import { canonicalWindowsEqual, MAX_GRID_LEVEL, mercatorXForIndex, mercatorYForIndex } from './geographic-lod.js';
import { geographicHazardRadii, geographicHazardRadiusForSeverity } from './hazard-renderer.js';
import {
  createGpuWeatherProgram,
  gpuWeatherProjectionLocations,
  GPU_DOTS_RAIN_MAPPING_SHADER,
  GPU_WEATHER_COMMON_VERTEX,
  isGpuWeatherLevel
} from './geographic-gpu-weather-presentation.js';
import { createGpuPresentationTiming } from './gpu-presentation-timing.js';

const REFERENCE_GRID_LEVEL = WEATHER_REFERENCE_LEVEL;
export const STORM_INNER_RATIO = 0.38;

const COLORS = { rain: [0, 0.565, 1, 1], strong: [0, 0, 1, 1], storm: [1, 0, 1, 1], hail: [1, 0.831, 0, 1] };
const INSTANCE_STRIDE = 8;
const INSTANCE_BYTES = INSTANCE_STRIDE * Float32Array.BYTES_PER_ELEMENT;
const WEATHER_TYPES = ['rain', 'strong', 'storm', 'hail'];
const RAIN_ONLY_WEATHER_TYPES = ['rain', 'strong'];
const RADIUS_KEYS = { rain: 'rainRadius', strong: 'strongRadius', storm: 'stormRadius', hail: 'hailRadius' };
const EMPTY_INSTANCES = new Float32Array();
const QUAD = new Float32Array([-1, -1, 1, -1, 1, 1, -1, -1, 1, 1, -1, 1]);
const now = () => globalThis.performance?.now?.() ?? Date.now();
const sumNumbers = (values) => values.reduce((total, value) => total + (Number.isFinite(value) ? value : 0), 0);

function retainedLevelData(previousTopology, nextTopology, levelData) {
  return Boolean(previousTopology && levelData
    && canonicalWindowsEqual(previousTopology.canonicalWindow, nextTopology.canonicalWindow)
    && previousTopology.levels.get(levelData.level) === levelData
    && nextTopology.levels.get(levelData.level) === levelData);
}

function retainedTemporalState(previousTopology, nextTopology, level, state) {
  const levelData = previousTopology?.levels.get(level);
  return Boolean(state && retainedLevelData(previousTopology, nextTopology, levelData)
    && state.frames0?.summaries?.[level]?.levelData === levelData
    && state.frames1?.summaries?.[level]?.levelData === levelData);
}

function circularPoints(count) {
  return Array.from({ length: count }, (_, index) => {
    const angle = -Math.PI / 2 + index * Math.PI * 2 / count;
    return [Math.cos(angle), Math.sin(angle)];
  });
}

function unitShape(points) {
  const vertices = [];
  for (let index = 0; index < points.length; index++) {
    const current = points[index];
    const next = points[(index + 1) % points.length];
    vertices.push(0, 0, current[0], current[1], next[0], next[1]);
  }
  return new Float32Array(vertices);
}

const HAIL = unitShape(circularPoints(6));
const STORM = unitShape(circularPoints(8).map((point, index) => {
  const scale = index % 2 === 0 ? 1 : STORM_INNER_RATIO;
  return [point[0] * scale, point[1] * scale];
}));

export function areaLinearRadius(startRadius, endRadius, progress) {
  return Math.sqrt(startRadius * startRadius + (endRadius * endRadius - startRadius * startRadius) * progress);
}

function positiveMean(weightedSeverity, coverageWeight) {
  return coverageWeight > 0 ? weightedSeverity / coverageWeight : 0;
}

function summaryCoverage(summary, weight, index) {
  const total = summary.totalWeight[index];
  return total > 0 ? weight / total : 0;
}

function mappedLayoutForSummary(summary) {
  return summary.profile === WEATHER_SUMMARY_PROFILE_RAIN_ONLY_DISPLAY ? 'rain-only' : 'full';
}

function weatherTypesForMapped(mapped) {
  return mapped.layout === 'rain-only' ? RAIN_ONLY_WEATHER_TYPES : WEATHER_TYPES;
}

function makeMappedState(length, layout, reusable) {
  if (reusable?.representation === 'dense-mapped' && reusable.layout === layout && reusable.rainRadius?.length === length) return reusable;
  const state = { representation: 'dense-mapped', layout, rainRadius: new Float32Array(length), strongRadius: new Float32Array(length) };
  if (layout === 'full') {
    state.stormRadius = new Float32Array(length);
    state.hailRadius = new Float32Array(length);
  }
  return state;
}

function makePackedMappedState(summary, layout, reusable) {
  const length = summary.potentialActiveIndices.length;
  if (reusable?.representation === WEATHER_DIRECT_STATE_PACKED
    && reusable.layout === layout
    && reusable.potentialActiveIndices === summary.potentialActiveIndices
    && reusable.rainRadius.length === length) return reusable;
  const state = {
    representation: WEATHER_DIRECT_STATE_PACKED,
    layout,
    levelData: summary.levelData,
    potentialActiveIndices: summary.potentialActiveIndices,
    rainRadius: new Float32Array(length),
    strongRadius: new Float32Array(length)
  };
  if (layout === 'full') {
    state.stormRadius = new Float32Array(length);
    state.hailRadius = new Float32Array(length);
  }
  return state;
}

// A sequence active set is static for a prepared topology. Aggregate summaries
// may materialize equivalent typed arrays independently, so compare values when
// the references differ instead of forcing a dense renderer pass.
function samePotentialActiveIndices(left, right) {
  if (left === right) return true;
  if (!left || !right || left.length !== right.length) return false;
  for (let index = 0; index < left.length; index++) if (left[index] !== right[index]) return false;
  return true;
}

function sharedPotentialActiveIndices(left, right) {
  const first = left.potentialActiveIndices;
  const second = right.potentialActiveIndices;
  return first && second && samePotentialActiveIndices(first, second) ? first : null;
}

function prepareMappedActiveSet(state, activeIndices) {
  const previous = state.potentialActiveIndices;
  if (activeIndices) {
    if (!samePotentialActiveIndices(previous, activeIndices)) {
      if (previous) {
        for (const index of previous) {
          state.rainRadius[index] = 0;
          state.strongRadius[index] = 0;
          if (state.layout === 'full') { state.stormRadius[index] = 0; state.hailRadius[index] = 0; }
        }
      } else if (state.mappingInitialized) {
        state.rainRadius.fill(0);
        state.strongRadius.fill(0);
        if (state.layout === 'full') { state.stormRadius.fill(0); state.hailRadius.fill(0); }
      }
    }
  }
  state.potentialActiveIndices = activeIndices || null;
  state.mappingInitialized = true;
}

// Pure presentation mapping: physical summary values never feed a coarser LOD.
export function mapDotsWeatherSummary(summary, reusable = null) {
  const layout = mappedLayoutForSummary(summary);
  if (summary.representation === WEATHER_DIRECT_STATE_PACKED) {
    const state = makePackedMappedState(summary, layout, reusable);
    const spacing = summary.levelData.spacing;
    const rainValues = summary.channels.rainMmh;
    const rainMask = summary.coverageMasks.rain;
    for (let position = 0; position < rainValues.length; position++) {
      const rainMmh = rainValues[position];
      const rainCoverage = rainMask[position] & 1 ? 1 : 0;
      state.rainRadius[position] = spacing * Math.sqrt(rainCoverage) * rainMmhToRadiusFraction(rainMmh);
      state.strongRadius[position] = dotsStrongRainMmhToRadius(rainMmh, spacing);
      if (layout !== 'full') continue;
      geographicHazardRadii({
        storm: summary.channels.storm[position],
        hail: summary.channels.hail[position]
      }, spacing, state);
    }
    return state;
  }
  const state = makeMappedState(summary.levelData.count, layout, reusable);
  const activeIndices = summary.potentialActiveIndices;
  prepareMappedActiveSet(state, activeIndices);
  const isDirectPointSummary = summary.level >= REFERENCE_GRID_LEVEL;
  const directHazardValue = { storm: 0, hail: 0 };
  const directHazard = { stormRadius: 0, hailRadius: 0 };
  const rainCoverageWeights = rainCoverageWeightForThreshold(summary, 0.05);
  const strongCoverageWeights = rainCoverageWeightForThreshold(summary, 2.5);
  const count = activeIndices ? activeIndices.length : summary.levelData.count;
  const spacing = summary.levelData.spacing;
  if (layout === 'rain-only') {
    for (let position = 0; position < count; position++) {
      const index = activeIndices ? activeIndices[position] : position;
      const total = summary.totalWeight[index];
      const rainCoverageWeight = rainCoverageWeights[index];
      const rainCoverage = summaryCoverage(summary, rainCoverageWeight, index);
      const wetMeanMmh = positiveMean(summary.rainWeightedSumMmh[index], rainCoverageWeight);
      const strongCoverage = summaryCoverage(summary, strongCoverageWeights[index], index);
      state.rainRadius[index] = spacing * Math.sqrt(rainCoverage) * rainMmhToRadiusFraction(wetMeanMmh);
      state.strongRadius[index] = isDirectPointSummary
        ? dotsStrongRainMmhToRadius(total > 0 ? summary.rainWeightedSumMmh[index] / total : 0, spacing)
        : spacing * Math.sqrt(strongCoverage) * dotsStrongRainMmhToRadiusFraction(summary.rainMaxMmh[index]);
    }
    return state;
  }
  for (let position = 0; position < count; position++) {
    const index = activeIndices ? activeIndices[position] : position;
    const total = summary.totalWeight[index];
    const rainCoverageWeight = rainCoverageWeights[index];
    const rainCoverage = summaryCoverage(summary, rainCoverageWeight, index);
    const wetMeanMmh = positiveMean(summary.rainWeightedSumMmh[index], rainCoverageWeight);
    const strongCoverage = summaryCoverage(summary, strongCoverageWeights[index], index);
    state.rainRadius[index] = spacing * Math.sqrt(rainCoverage) * rainMmhToRadiusFraction(wetMeanMmh);
    if (isDirectPointSummary) {
      const rainMmh = total > 0 ? summary.rainWeightedSumMmh[index] / total : 0;
      state.strongRadius[index] = dotsStrongRainMmhToRadius(rainMmh, spacing);
    } else {
      state.strongRadius[index] = spacing * Math.sqrt(strongCoverage)
        * dotsStrongRainMmhToRadiusFraction(summary.rainMaxMmh[index]);
    }

    const hailCoverageWeight = summary.hailCoverageWeight[index];
    const hailCoverage = summaryCoverage(summary, hailCoverageWeight, index);
    const hailMean = positiveMean(summary.hailWeightedSeverity[index], hailCoverageWeight);
    const stormCoverageWeight = summary.stormCoverageWeight[index];
    const stormCoverage = summaryCoverage(summary, stormCoverageWeight, index);
    const stormMean = positiveMean(summary.stormWeightedSeverity[index], stormCoverageWeight);
    if (isDirectPointSummary) {
      directHazardValue.storm = total > 0 ? summary.stormWeightedSeverity[index] / total : 0;
      directHazardValue.hail = total > 0 ? summary.hailWeightedSeverity[index] / total : 0;
      geographicHazardRadii(directHazardValue, spacing, directHazard);
      state.stormRadius[index] = directHazard.stormRadius;
      state.hailRadius[index] = directHazard.hailRadius;
    } else {
      const hailPresentationSeverity = Math.max(hailMean, summary.hailMaxSeverity[index]);
      const hailRadius = total > 0
        ? Math.sqrt(hailCoverage) * geographicHazardRadiusForSeverity('hail', hailPresentationSeverity, spacing)
        : 0;
      const stormPresentationSeverity = Math.max(stormMean, summary.stormMaxSeverity[index]);
      state.hailRadius[index] = hailRadius;
      // Hail wins only when its mapped glyph is actually visible; both physical summaries remain intact.
      state.stormRadius[index] = hailRadius > 0 || total <= 0
        ? 0
        : Math.sqrt(stormCoverage) * geographicHazardRadiusForSeverity('storm', stormPresentationSeverity, spacing);
    }
  }
  return state;
}

class InstanceWriter {
  constructor() {
    this.values = new Float32Array();
    this.length = 0;
  }

  reset() {
    this.length = 0;
  }

  push(startX, startY, endX, endY, startTime0, startTime1, endTime0, endTime1) {
    const nextLength = this.length + INSTANCE_STRIDE;
    if (nextLength > this.values.length) {
      const capacity = Math.max(nextLength, this.values.length * 2, 256);
      const values = new Float32Array(capacity);
      values.set(this.values);
      this.values = values;
    }
    const offset = this.length;
    this.values[offset] = startX;
    this.values[offset + 1] = startY;
    this.values[offset + 2] = endX;
    this.values[offset + 3] = endY;
    this.values[offset + 4] = startTime0;
    this.values[offset + 5] = startTime1;
    this.values[offset + 6] = endTime0;
    this.values[offset + 7] = endTime1;
    this.length = nextLength;
  }

  finish() {
    return this.values.subarray(0, this.length);
  }
}

function hasTemporalRadius(radius0, radius1, radius2 = 0, radius3 = 0) {
  return radius0 > 0 || radius1 > 0 || radius2 > 0 || radius3 > 0;
}

function knownArrayBytes(value, seen = null) {
  if (!ArrayBuffer.isView(value)) return 0;
  if (seen?.has(value.buffer)) return 0;
  seen?.add(value.buffer);
  return value.buffer.byteLength;
}

function summaryBytes(summary, seen) {
  if (!summary) return 0;
  if (summary.representation === WEATHER_DIRECT_STATE_PACKED) {
    return [
      summary.potentialActiveIndices,
      summary.channels?.rainMmh,
      summary.channels?.storm,
      summary.channels?.hail,
      summary.coverageMasks?.rain,
      summary.coverageMasks?.storm,
      summary.coverageMasks?.hail
    ].reduce((total, value) => total + knownArrayBytes(value, seen), 0);
  }
  return [
    summary.totalWeight,
    summary.potentialActiveIndices,
    summary.rainWeightedSumMmh,
    summary.rainMaxMmh,
    ...(summary.rainCoverageWeight || []),
    summary.stormCoverageWeight,
    summary.stormWeightedSeverity,
    summary.stormMaxSeverity,
    summary.hailCoverageWeight,
    summary.hailWeightedSeverity,
    summary.hailMaxSeverity
  ].reduce((total, value) => total + knownArrayBytes(value, seen), 0);
}

function mappedStateBytes(mapped, seen) {
  if (!mapped) return 0;
  return [
    mapped.rainRadius,
    mapped.strongRadius,
    mapped.stormRadius,
    mapped.hailRadius
  ].reduce((total, value) => total + knownArrayBytes(value, seen), 0);
}

function temporalStateBreakdown(temporal) {
  if (!temporal) return { physicalSummaryBytes: 0, mappedPresentationBytes: 0 };
  const seen = new Set();
  let physicalSummaryBytes = 0;
  let mappedPresentationBytes = 0;
  for (const [level, levelState] of temporal.levels) {
    for (const frameState of [levelState.frames0, levelState.frames1]) {
      physicalSummaryBytes += summaryBytes(frameState?.summaries?.[level], seen);
      mappedPresentationBytes += mappedStateBytes(frameState?.mapped?.[level], seen);
    }
  }
  return { physicalSummaryBytes, mappedPresentationBytes };
}

function buildHierarchicalTemporalInstances(coarseTime0, fineTime0, coarseTime1, fineTime1, coarseLevelData, fineLevelData, transitionParents, radiusKey, refining, writer) {
  writer.reset();
  const activeParents = sharedPotentialActiveIndices(coarseTime0, coarseTime1);
  const parentCount = activeParents ? activeParents.length : coarseTime0[radiusKey].length;
  for (let parentPosition = 0; parentPosition < parentCount; parentPosition++) {
    const parentIndex = activeParents ? activeParents[parentPosition] : parentPosition;
    const parentRadius0 = coarseTime0[radiusKey][parentIndex];
    const parentRadius1 = coarseTime1[radiusKey][parentIndex];
    const parentX = mercatorXForIndex(coarseLevelData, parentIndex);
    const parentY = mercatorYForIndex(coarseLevelData, parentIndex);
    if (hasTemporalRadius(parentRadius0, parentRadius1)) {
      if (refining) writer.push(parentX, parentY, parentX, parentY, parentRadius0, parentRadius1, 0, 0);
      else writer.push(parentX, parentY, parentX, parentY, 0, 0, parentRadius0, parentRadius1);
    }

    const childStart = transitionParents.childOffsets[parentIndex];
    const childEnd = transitionParents.childOffsets[parentIndex + 1];
    for (let childOffset = childStart; childOffset < childEnd; childOffset++) {
      const childIndex = transitionParents.childIndices[childOffset];
      const childRadius0 = fineTime0[radiusKey][childIndex];
      const childRadius1 = fineTime1[radiusKey][childIndex];
      if (!hasTemporalRadius(childRadius0, childRadius1)) continue;
      const childX = mercatorXForIndex(fineLevelData, childIndex);
      const childY = mercatorYForIndex(fineLevelData, childIndex);
      if (refining) writer.push(parentX, parentY, childX, childY, 0, 0, childRadius0, childRadius1);
      else writer.push(childX, childY, parentX, parentY, childRadius0, childRadius1, 0, 0);
    }
  }
  return writer.finish();
}

function buildSameLevelTemporalInstances(time0, time1, levelData, radiusKey, writer) {
  writer.reset();
  const radii0 = time0[radiusKey];
  const radii1 = time1[radiusKey];
  const activeIndices = sharedPotentialActiveIndices(time0, time1);
  const count = activeIndices ? activeIndices.length : radii0.length;
  for (let position = 0; position < count; position++) {
    const index = activeIndices ? activeIndices[position] : position;
    const radius0 = time0.representation === WEATHER_DIRECT_STATE_PACKED ? radii0[position] : radii0[index];
    const radius1 = time1.representation === WEATHER_DIRECT_STATE_PACKED ? radii1[position] : radii1[index];
    if (!hasTemporalRadius(radius0, radius1)) continue;
    const x = mercatorXForIndex(levelData, index);
    const y = mercatorYForIndex(levelData, index);
    writer.push(x, y, x, y, radius0, radius1, radius0, radius1);
  }
  return writer.finish();
}

function mappedValueReader(mapped, key) {
  if (mapped.representation !== WEATHER_DIRECT_STATE_PACKED) return { value: (index) => mapped[key][index] };
  const activeIndices = mapped.potentialActiveIndices;
  const values = mapped[key];
  let position = 0;
  return {
    value(index) {
      while (position < activeIndices.length && activeIndices[position] < index) position++;
      return position < activeIndices.length && activeIndices[position] === index ? values[position] : 0;
    }
  };
}

function sharedHigherIndex(relation, higherIndex) {
  const row = Math.floor(higherIndex / relation.higher.width);
  const column = higherIndex - row * relation.higher.width;
  const alignedRow = row >= relation.sharedHigherRowStart && row <= relation.sharedHigherRowEnd
    && ((row - relation.sharedHigherRowStart) & 1) === 0;
  return alignedRow && column >= relation.sharedHigherColumnStart && column <= relation.sharedHigherColumnEnd
    && ((column - relation.sharedHigherColumnStart) & 1) === 0;
}

function buildDirectActiveTemporalInstances(fromTime0, toTime0, fromTime1, toTime1, relation, fromIsLower, radiusKey, writer, lowerActive, higherActive) {
  writer.reset();
  const lowerTime0 = fromIsLower ? fromTime0 : toTime0;
  const lowerTime1 = fromIsLower ? fromTime1 : toTime1;
  const higherTime0 = fromIsLower ? toTime0 : fromTime0;
  const higherTime1 = fromIsLower ? toTime1 : fromTime1;
  const lowerReader0 = mappedValueReader(lowerTime0, radiusKey);
  const lowerReader1 = mappedValueReader(lowerTime1, radiusKey);
  const higherReader0 = mappedValueReader(higherTime0, radiusKey);
  const higherReader1 = mappedValueReader(higherTime1, radiusKey);
  const lowerWidth = relation.lower.width;
  const higherWidth = relation.higher.width;

  for (let position = 0; position < lowerActive.length; position++) {
    const lowerIndex = lowerActive[position];
    const lowerRow = Math.floor(lowerIndex / lowerWidth);
    const lowerColumn = lowerIndex - lowerRow * lowerWidth;
    const higherColumn = relation.lowerToHigherColumns[lowerColumn];
    const higherRowBase = relation.lowerToHigherRows[lowerRow];
    const higherIndex = higherRowBase >= 0 && higherColumn >= 0 ? higherRowBase + higherColumn : -1;
    const lowerRadius0 = lowerReader0.value(lowerIndex);
    const lowerRadius1 = lowerReader1.value(lowerIndex);
    const higherRadius0 = higherIndex < 0 ? 0 : higherReader0.value(higherIndex);
    const higherRadius1 = higherIndex < 0 ? 0 : higherReader1.value(higherIndex);
    if (!hasTemporalRadius(lowerRadius0, lowerRadius1, higherRadius0, higherRadius1)) continue;
    const lowerX = (relation.lower.minI + lowerColumn) * relation.lower.spacing;
    const lowerY = (relation.lower.minJ + lowerRow) * relation.lower.spacing;
    writer.push(lowerX, lowerY, lowerX, lowerY,
      fromIsLower ? lowerRadius0 : higherRadius0,
      fromIsLower ? lowerRadius1 : higherRadius1,
      fromIsLower ? higherRadius0 : lowerRadius0,
      fromIsLower ? higherRadius1 : lowerRadius1);
  }

  const higherOnlyReader0 = mappedValueReader(higherTime0, radiusKey);
  const higherOnlyReader1 = mappedValueReader(higherTime1, radiusKey);
  for (let position = 0; position < higherActive.length; position++) {
    const higherIndex = higherActive[position];
    if (sharedHigherIndex(relation, higherIndex)) continue;
    const higherRadius0 = higherOnlyReader0.value(higherIndex);
    const higherRadius1 = higherOnlyReader1.value(higherIndex);
    if (!hasTemporalRadius(higherRadius0, higherRadius1)) continue;
    const higherRow = Math.floor(higherIndex / higherWidth);
    const higherColumn = higherIndex - higherRow * higherWidth;
    const higherX = (relation.higher.minI + higherColumn) * relation.higher.spacing;
    const higherY = (relation.higher.minJ + higherRow) * relation.higher.spacing;
    writer.push(higherX, higherY, higherX, higherY,
      fromIsLower ? 0 : higherRadius0,
      fromIsLower ? 0 : higherRadius1,
      fromIsLower ? higherRadius0 : 0,
      fromIsLower ? higherRadius1 : 0);
  }
  return writer.finish();
}

export function buildDirectTemporalInstancesReference(fromTime0, toTime0, fromTime1, toTime1, fromLevelData, toLevelData, pairs, fromIsLower, radiusKey, writer) {
  writer.reset();
  const fromRadii0 = fromTime0[radiusKey];
  const toRadii0 = toTime0[radiusKey];
  const fromRadii1 = fromTime1[radiusKey];
  const toRadii1 = toTime1[radiusKey];
  for (let index = 0; index < pairs.length; index += 2) {
    const lowerIndex = pairs[index];
    const higherIndex = pairs[index + 1];
    const fromIndex = fromIsLower ? lowerIndex : higherIndex;
    const toIndex = fromIsLower ? higherIndex : lowerIndex;
    const fromRadius0 = fromIndex < 0 ? 0 : fromRadii0[fromIndex];
    const fromRadius1 = fromIndex < 0 ? 0 : fromRadii1[fromIndex];
    const toRadius0 = toIndex < 0 ? 0 : toRadii0[toIndex];
    const toRadius1 = toIndex < 0 ? 0 : toRadii1[toIndex];
    if (!hasTemporalRadius(fromRadius0, fromRadius1, toRadius0, toRadius1)) continue;
    const startLevelData = fromIndex < 0 ? toLevelData : fromLevelData;
    const startIndex = fromIndex < 0 ? toIndex : fromIndex;
    const endLevelData = toIndex < 0 ? fromLevelData : toLevelData;
    const endIndex = toIndex < 0 ? fromIndex : toIndex;
    writer.push(mercatorXForIndex(startLevelData, startIndex), mercatorYForIndex(startLevelData, startIndex), mercatorXForIndex(endLevelData, endIndex), mercatorYForIndex(endLevelData, endIndex), fromRadius0, fromRadius1, toRadius0, toRadius1);
  }
  return writer.finish();
}

// This matches the former direct-pair sequence exactly: every lower sample,
// then every higher-only sample. Adjacent dyadic grids make shared positions
// identical, so the hot loop needs only affine row/column arithmetic and no
// pair array, canonical lookup, callback, or coordinate object.
export function buildDirectTemporalInstances(fromTime0, toTime0, fromTime1, toTime1, relation, fromIsLower, radiusKey, writer) {
  const lowerTime0 = fromIsLower ? fromTime0 : toTime0;
  const lowerTime1 = fromIsLower ? fromTime1 : toTime1;
  const higherTime0 = fromIsLower ? toTime0 : fromTime0;
  const higherTime1 = fromIsLower ? toTime1 : fromTime1;
  const lowerActive = sharedPotentialActiveIndices(lowerTime0, lowerTime1);
  const higherActive = sharedPotentialActiveIndices(higherTime0, higherTime1);
  if (lowerActive && higherActive) {
    return buildDirectActiveTemporalInstances(fromTime0, toTime0, fromTime1, toTime1, relation, fromIsLower, radiusKey, writer, lowerActive, higherActive);
  }
  writer.reset();
  const lower = relation.lower;
  const higher = relation.higher;
  const fromRadii0 = fromTime0[radiusKey];
  const toRadii0 = toTime0[radiusKey];
  const fromRadii1 = fromTime1[radiusKey];
  const toRadii1 = toTime1[radiusKey];
  const lowerSpacing = lower.spacing;
  const higherSpacing = higher.spacing;
  const lowerWidth = lower.width;
  const higherWidth = higher.width;
  const lowerIsFrom = fromIsLower;
  const lowerToHigherColumns = relation.lowerToHigherColumns;
  const lowerToHigherRows = relation.lowerToHigherRows;
  const sharedHigherColumnStart = relation.sharedHigherColumnStart;
  const sharedHigherColumnEnd = relation.sharedHigherColumnEnd;
  const sharedHigherRowStart = relation.sharedHigherRowStart;
  const sharedHigherRowEnd = relation.sharedHigherRowEnd;

  for (let lowerRow = 0, lowerIndex = 0; lowerRow < lower.height; lowerRow++) {
    const lowerY = (lower.minJ + lowerRow) * lowerSpacing;
    const higherRowBase = lowerToHigherRows[lowerRow];
    for (let lowerColumn = 0; lowerColumn < lowerWidth; lowerColumn++, lowerIndex++) {
      const higherColumn = lowerToHigherColumns[lowerColumn];
      const higherIndex = higherRowBase >= 0 && higherColumn >= 0 ? higherRowBase + higherColumn : -1;
      const fromIndex = lowerIsFrom ? lowerIndex : higherIndex;
      const toIndex = lowerIsFrom ? higherIndex : lowerIndex;
      const fromRadius0 = fromIndex < 0 ? 0 : fromRadii0[fromIndex];
      const fromRadius1 = fromIndex < 0 ? 0 : fromRadii1[fromIndex];
      const toRadius0 = toIndex < 0 ? 0 : toRadii0[toIndex];
      const toRadius1 = toIndex < 0 ? 0 : toRadii1[toIndex];
      if (!hasTemporalRadius(fromRadius0, fromRadius1, toRadius0, toRadius1)) continue;
      const lowerX = (lower.minI + lowerColumn) * lowerSpacing;
      writer.push(lowerX, lowerY, lowerX, lowerY, fromRadius0, fromRadius1, toRadius0, toRadius1);
    }
  }

  for (let higherRow = 0, higherIndex = 0; higherRow < higher.height; higherRow++) {
    const higherY = (higher.minJ + higherRow) * higherSpacing;
    const alignedRow = higherRow >= sharedHigherRowStart && higherRow <= sharedHigherRowEnd
      && ((higherRow - sharedHigherRowStart) & 1) === 0;
    for (let higherColumn = 0; higherColumn < higherWidth; higherColumn++, higherIndex++) {
      if (alignedRow && higherColumn >= sharedHigherColumnStart && higherColumn <= sharedHigherColumnEnd
        && ((higherColumn - sharedHigherColumnStart) & 1) === 0) continue;
      const fromIndex = lowerIsFrom ? -1 : higherIndex;
      const toIndex = lowerIsFrom ? higherIndex : -1;
      const fromRadius0 = fromIndex < 0 ? 0 : fromRadii0[fromIndex];
      const fromRadius1 = fromIndex < 0 ? 0 : fromRadii1[fromIndex];
      const toRadius0 = toIndex < 0 ? 0 : toRadii0[toIndex];
      const toRadius1 = toIndex < 0 ? 0 : toRadii1[toIndex];
      if (!hasTemporalRadius(fromRadius0, fromRadius1, toRadius0, toRadius1)) continue;
      const higherX = (higher.minI + higherColumn) * higherSpacing;
      writer.push(higherX, higherY, higherX, higherY, fromRadius0, fromRadius1, toRadius0, toRadius1);
    }
  }
  return writer.finish();
}

function compileShader(gl, type, source) {
  const shader = gl.createShader(type);
  gl.shaderSource(shader, source);
  gl.compileShader(shader);
  if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(shader) || 'Weather shader compilation failed.');
  return shader;
}

function makeProgram(gl, shaderData, kind) {
  const circle = kind === 'circle';
  const vertexSource = [
    '#version 300 es', shaderData.vertexShaderPrelude, shaderData.define,
    'in vec2 a_vertex;\nin vec2 a_startCenter;\nin vec2 a_endCenter;\nin float a_startTime0;\nin float a_startTime1;\nin float a_endTime0;\nin float a_endTime1;\nuniform float u_temporalProgress;\nuniform float u_lodTransition;',
    circle ? 'out vec2 v_local;' : '',
    'float temporalRadius(float radius0, float radius1) { return sqrt(mix(radius0 * radius0, radius1 * radius1, u_temporalProgress)); }\nvoid main() {\n  float startRadius = temporalRadius(a_startTime0, a_startTime1);\n  float endRadius = temporalRadius(a_endTime0, a_endTime1);\n  float radius = sqrt(mix(startRadius * startRadius, endRadius * endRadius, u_lodTransition));\n  vec2 center = mix(a_startCenter, a_endCenter, u_lodTransition);\n  ' + (circle ? 'v_local = a_vertex;\n  ' : '') + 'gl_Position = projectTile(center + a_vertex * radius);\n}'
  ].join('\n');
  const fragmentSource = [
    '#version 300 es', 'precision highp float;', 'uniform vec4 u_color;',
    circle ? 'in vec2 v_local;' : '', 'out vec4 fragColor;',
    circle
      ? 'void main() {\n  float distanceToCenter = length(v_local);\n  float edge = fwidth(distanceToCenter);\n  float alpha = 1.0 - smoothstep(1.0 - edge, 1.0 + edge, distanceToCenter);\n  fragColor = vec4(u_color.rgb, u_color.a * alpha);\n}'
      : 'void main() { fragColor = u_color; }'
  ].join('\n');
  const program = gl.createProgram();
  gl.attachShader(program, compileShader(gl, gl.VERTEX_SHADER, vertexSource));
  gl.attachShader(program, compileShader(gl, gl.FRAGMENT_SHADER, fragmentSource));
  gl.linkProgram(program);
  if (!gl.getProgramParameter(program, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(program) || 'Weather shader linking failed.');

  return {
    program,
    locations: {
      vertex: gl.getAttribLocation(program, 'a_vertex'),
      startCenter: gl.getAttribLocation(program, 'a_startCenter'),
      endCenter: gl.getAttribLocation(program, 'a_endCenter'),
      startTime0: gl.getAttribLocation(program, 'a_startTime0'),
      startTime1: gl.getAttribLocation(program, 'a_startTime1'),
      endTime0: gl.getAttribLocation(program, 'a_endTime0'),
      endTime1: gl.getAttribLocation(program, 'a_endTime1'),
      color: gl.getUniformLocation(program, 'u_color'),
      temporalProgress: gl.getUniformLocation(program, 'u_temporalProgress'),
      lodTransition: gl.getUniformLocation(program, 'u_lodTransition'),
      matrix: gl.getUniformLocation(program, 'u_matrix'),
      fallbackMatrix: gl.getUniformLocation(program, 'u_projection_fallback_matrix'),
      projectionMatrix: gl.getUniformLocation(program, 'u_projection_matrix'),
      tileMercatorCoords: gl.getUniformLocation(program, 'u_projection_tile_mercator_coords'),
      clippingPlane: gl.getUniformLocation(program, 'u_projection_clipping_plane'),
      projectionTransition: gl.getUniformLocation(program, 'u_projection_transition')
    }
  };
}

function makeGpuWeatherProgram(gl, shaderData, strong, { multiChunk = false } = {}) {
  const vertexSource = `${GPU_WEATHER_COMMON_VERTEX}
${GPU_DOTS_RAIN_MAPPING_SHADER}
${multiChunk ? 'uniform ivec4 u_owner_bounds;' : ''}
out vec2 v_local;
void main() {
  int sampleIndex;
  vec4 weather = gpuWeatherAt(sampleIndex);
  float radius = u_spacing * ${strong
    ? '(u_weather_kind == 0 ? dotsStrongRadiusFraction(weather.z) : sqrt(max(weather.w, 0.0)) * dotsStrongRadiusFraction(weather.z))'
    : 'sqrt(max(weather.y, 0.0)) * rainRadiusFraction(weather.x)'};
  ${multiChunk ? 'int ownerColumn = sampleIndex % u_width; int ownerRow = sampleIndex / u_width; ivec2 ownerCoordinate = ivec2(u_minI + ownerColumn, u_minJ + ownerRow); if (ownerCoordinate.x < u_owner_bounds.x || ownerCoordinate.x > u_owner_bounds.y || ownerCoordinate.y < u_owner_bounds.z || ownerCoordinate.y > u_owner_bounds.w) radius = 0.0;' : ''}
  v_local = a_vertex;
  gl_Position = projectTile(gpuWeatherCenter(sampleIndex) + a_vertex * radius);
}`;
  const fragmentSource = `in vec2 v_local;
uniform vec4 u_color;
uniform float u_opacity;
out vec4 fragColor;
void main() {
  float distanceToCenter = length(v_local);
  float edge = fwidth(distanceToCenter);
  float alpha = 1.0 - smoothstep(1.0 - edge, 1.0 + edge, distanceToCenter);
  fragColor = vec4(u_color.rgb, u_color.a * u_opacity * alpha);
}`;
  const program = createGpuWeatherProgram(gl, shaderData, vertexSource, fragmentSource, 'GPU Dots weather');
  return {
    program,
    locations: {
      vertex: gl.getAttribLocation(program, 'a_vertex'),
      weatherA: gl.getUniformLocation(program, 'u_weather_a'),
      weatherB: gl.getUniformLocation(program, 'u_weather_b'),
      coverageA: gl.getUniformLocation(program, 'u_weather_coverage_a'),
      coverageB: gl.getUniformLocation(program, 'u_weather_coverage_b'),
      weatherProgress: gl.getUniformLocation(program, 'u_weather_progress'),
      weatherKind: gl.getUniformLocation(program, 'u_weather_kind'),
      width: gl.getUniformLocation(program, 'u_width'),
      minI: gl.getUniformLocation(program, 'u_minI'),
      minJ: gl.getUniformLocation(program, 'u_minJ'),
      spacing: gl.getUniformLocation(program, 'u_spacing'),
      opacity: gl.getUniformLocation(program, 'u_opacity'),
      ownerBounds: multiChunk ? gl.getUniformLocation(program, 'u_owner_bounds') : null,
      color: gl.getUniformLocation(program, 'u_color'),
      ...gpuWeatherProjectionLocations(gl, program)
    }
  };
}

function makeGpuWeatherLodTransitionProgram(gl, shaderData, strong) {
  const vertexSource = `${GPU_DOTS_RAIN_MAPPING_SHADER}
in vec2 a_vertex;
out vec2 v_local;
uniform sampler2D u_from_weather_a;
uniform sampler2D u_from_weather_b;
uniform sampler2D u_from_coverage_a;
uniform sampler2D u_from_coverage_b;
uniform sampler2D u_to_weather_a;
uniform sampler2D u_to_weather_b;
uniform sampler2D u_to_coverage_a;
uniform sampler2D u_to_coverage_b;
uniform float u_weather_progress;
uniform float u_lod_progress;
uniform int u_from_kind;
uniform int u_to_kind;
uniform int u_from_is_fine;
uniform int u_to_is_fine;
uniform int u_from_width;
uniform int u_from_height;
uniform int u_from_min_i;
uniform int u_from_min_j;
uniform int u_to_width;
uniform int u_to_height;
uniform int u_to_min_i;
uniform int u_to_min_j;
uniform int u_fine_min_i;
uniform int u_fine_min_j;
uniform int u_fine_width;
uniform float u_fine_spacing;
uniform float u_from_spacing;
uniform float u_to_spacing;
vec4 decodeWeather(vec4 values, vec2 coverage, int kind) {
  if (kind == 0) return vec4(values.r, 1.0, values.r, step(2.5, values.r));
  float totalWeight = values.b;
  float wetMean = coverage.x > 0.0 ? values.r / coverage.x : 0.0;
  float wetCoverage = totalWeight > 0.0 ? coverage.x / totalWeight : 0.0;
  float strongCoverage = totalWeight > 0.0 ? coverage.y / totalWeight : 0.0;
  return vec4(wetMean, wetCoverage, values.g, strongCoverage);
}
vec4 fromRecord(ivec2 coordinate, bool second) {
  return decodeWeather(
    second ? texelFetch(u_from_weather_b, coordinate, 0) : texelFetch(u_from_weather_a, coordinate, 0),
    second ? texelFetch(u_from_coverage_b, coordinate, 0).rg : texelFetch(u_from_coverage_a, coordinate, 0).rg,
    u_from_kind
  );
}
vec4 toRecord(ivec2 coordinate, bool second) {
  return decodeWeather(
    second ? texelFetch(u_to_weather_b, coordinate, 0) : texelFetch(u_to_weather_a, coordinate, 0),
    second ? texelFetch(u_to_coverage_b, coordinate, 0).rg : texelFetch(u_to_coverage_a, coordinate, 0).rg,
    u_to_kind
  );
}
bool sourceCoordinate(ivec2 fineCoordinate, int isFine, int width, int height, int minI, int minJ, out ivec2 coordinate) {
  if (isFine != 0) coordinate = fineCoordinate - ivec2(minI, minJ);
  else {
    if ((fineCoordinate.x & 1) != 0 || (fineCoordinate.y & 1) != 0) return false;
    coordinate = ivec2(fineCoordinate.x / 2 - minI, fineCoordinate.y / 2 - minJ);
  }
  return coordinate.x >= 0 && coordinate.x < width && coordinate.y >= 0 && coordinate.y < height;
}
vec4 endpointFrom(ivec2 fineCoordinate, bool second) {
  ivec2 coordinate;
  return sourceCoordinate(fineCoordinate, u_from_is_fine, u_from_width, u_from_height, u_from_min_i, u_from_min_j, coordinate)
    ? mix(fromRecord(coordinate, false), fromRecord(coordinate, true), u_weather_progress)
    : vec4(0.0);
}
vec4 endpointTo(ivec2 fineCoordinate, bool second) {
  ivec2 coordinate;
  return sourceCoordinate(fineCoordinate, u_to_is_fine, u_to_width, u_to_height, u_to_min_i, u_to_min_j, coordinate)
    ? mix(toRecord(coordinate, false), toRecord(coordinate, true), u_weather_progress)
    : vec4(0.0);
}
float endpointRadius(vec4 weather, int kind, float spacing) {
  return spacing * ${strong
    ? '(kind == 0 ? dotsStrongRadiusFraction(weather.z) : sqrt(max(weather.w, 0.0)) * dotsStrongRadiusFraction(weather.z))'
    : 'sqrt(max(weather.y, 0.0)) * rainRadiusFraction(weather.x)'};
}
void main() {
  int sampleIndex = gl_InstanceID;
  int column = sampleIndex % u_fine_width;
  int row = sampleIndex / u_fine_width;
  ivec2 fineCoordinate = ivec2(u_fine_min_i + column, u_fine_min_j + row);
  float fromRadius = endpointRadius(endpointFrom(fineCoordinate, false), u_from_kind, u_from_spacing);
  float toRadius = endpointRadius(endpointTo(fineCoordinate, false), u_to_kind, u_to_spacing);
  float radius = sqrt(mix(fromRadius * fromRadius, toRadius * toRadius, u_lod_progress));
  v_local = a_vertex;
  gl_Position = projectTile(vec2(fineCoordinate) * u_fine_spacing + a_vertex * radius);
}`;
  const fragmentSource = `in vec2 v_local;
uniform vec4 u_color;
out vec4 fragColor;
void main() {
  float distanceToCenter = length(v_local);
  float edge = fwidth(distanceToCenter);
  float alpha = 1.0 - smoothstep(1.0 - edge, 1.0 + edge, distanceToCenter);
  fragColor = vec4(u_color.rgb, u_color.a * alpha);
}`;
  const program = createGpuWeatherProgram(gl, shaderData, vertexSource, fragmentSource, 'GPU Dots LOD transition');
  return {
    program,
    locations: {
      vertex: gl.getAttribLocation(program, 'a_vertex'),
      fromWeatherA: gl.getUniformLocation(program, 'u_from_weather_a'),
      fromWeatherB: gl.getUniformLocation(program, 'u_from_weather_b'),
      fromCoverageA: gl.getUniformLocation(program, 'u_from_coverage_a'),
      fromCoverageB: gl.getUniformLocation(program, 'u_from_coverage_b'),
      toWeatherA: gl.getUniformLocation(program, 'u_to_weather_a'),
      toWeatherB: gl.getUniformLocation(program, 'u_to_weather_b'),
      toCoverageA: gl.getUniformLocation(program, 'u_to_coverage_a'),
      toCoverageB: gl.getUniformLocation(program, 'u_to_coverage_b'),
      weatherProgress: gl.getUniformLocation(program, 'u_weather_progress'),
      lodProgress: gl.getUniformLocation(program, 'u_lod_progress'),
      fromKind: gl.getUniformLocation(program, 'u_from_kind'),
      toKind: gl.getUniformLocation(program, 'u_to_kind'),
      fromIsFine: gl.getUniformLocation(program, 'u_from_is_fine'),
      toIsFine: gl.getUniformLocation(program, 'u_to_is_fine'),
      fromWidth: gl.getUniformLocation(program, 'u_from_width'),
      fromHeight: gl.getUniformLocation(program, 'u_from_height'),
      fromMinI: gl.getUniformLocation(program, 'u_from_min_i'),
      fromMinJ: gl.getUniformLocation(program, 'u_from_min_j'),
      toWidth: gl.getUniformLocation(program, 'u_to_width'),
      toHeight: gl.getUniformLocation(program, 'u_to_height'),
      toMinI: gl.getUniformLocation(program, 'u_to_min_i'),
      toMinJ: gl.getUniformLocation(program, 'u_to_min_j'),
      fineMinI: gl.getUniformLocation(program, 'u_fine_min_i'),
      fineMinJ: gl.getUniformLocation(program, 'u_fine_min_j'),
      fineWidth: gl.getUniformLocation(program, 'u_fine_width'),
      fineSpacing: gl.getUniformLocation(program, 'u_fine_spacing'),
      fromSpacing: gl.getUniformLocation(program, 'u_from_spacing'),
      toSpacing: gl.getUniformLocation(program, 'u_to_spacing'),
      color: gl.getUniformLocation(program, 'u_color'),
      ...gpuWeatherProjectionLocations(gl, program)
    }
  };
}

function isHierarchicalTransition(fromLevel, toLevel, legacyHierarchicalLodMorph = false) {
  return legacyHierarchicalLodMorph
    && Math.abs(fromLevel - toLevel) === 1
    && Math.max(fromLevel, toLevel) <= REFERENCE_GRID_LEVEL;
}

export class GeographicDotsLayer {
  constructor(weatherPyramid = new GeographicWeatherPyramid(), options = {}) {
    this.id = 'geographic-weather-dots';
    this.type = 'custom';
    this.renderingMode = '3d';
    this.programs = new Map();
    this.instances = { rain: new Float32Array(), strong: new Float32Array(), storm: new Float32Array(), hail: new Float32Array() };
    this.instanceWriters = { rain: new InstanceWriter(), strong: new InstanceWriter(), storm: new InstanceWriter(), hail: new InstanceWriter() };
    this.counts = { rain: 0, strong: 0, storm: 0, hail: 0 };
    this.bufferCapacity = { rain: 0, strong: 0, storm: 0, hail: 0 };
    this.weatherPyramid = weatherPyramid;
    this.legacyHierarchicalLodMorph = options.legacyHierarchicalLodMorph === true;
    this.renderDiagnostics = options.renderDiagnostics || null;
    this.topology = weatherPyramid.topology;
    this.levelData = null;
    this.transition = null;
    this.transitionProgress = 1;
    this.temporal = null;
    this.temporalProgress = 0;
    this.gpuWeatherMode = false;
    this.gpuWeatherSource = null;
    this.gpuWeatherMultiChunkSources = null;
    this.gpuWeatherTransition = null;
    this.gpuWeatherPresentationEnabled = true;
    this.gpuWeatherRenderSynchronizer = null;
    this.gpuPresentationTiming = createGpuPresentationTiming();
    this.buffersDirty = true;
    this.active = true;
    this.hazardsVisible = true;
    this.lifecycleDiagnostics = {
      evaluateKeyframeCalls: 0, evaluateTransitionKeyframeCalls: 0, weatherEvaluationMs: 0, mappingMs: 0,
      instanceRebuildCalls: 0, instanceRebuildMs: 0, preservedTopologyStates: 0,
      gpuWeatherRenderCalls: 0, gpuWeatherPresentationDrawCalls: 0
    };
  }

  onAdd(map, gl) {
    this.map = map;
    this.gpuPresentationTiming.attach(gl);
    this.instanceBuffers = Object.fromEntries(WEATHER_TYPES.map((type) => [type, gl.createBuffer()]));
    this.vertexBuffers = { rain: gl.createBuffer(), strong: gl.createBuffer(), storm: gl.createBuffer(), hail: gl.createBuffer() };
    for (const [type, vertices] of Object.entries({ rain: QUAD, strong: QUAD, storm: STORM, hail: HAIL })) {
      gl.bindBuffer(gl.ARRAY_BUFFER, this.vertexBuffers[type]);
      gl.bufferData(gl.ARRAY_BUFFER, vertices, gl.STATIC_DRAW);
    }
  }

  onRemove(map, gl) {
    for (const programs of this.programs.values()) {
      for (const entry of Object.values(programs)) if (entry?.program) gl.deleteProgram(entry.program);
    }
    for (const buffer of [...Object.values(this.instanceBuffers || {}), ...Object.values(this.vertexBuffers || {})]) if (buffer) gl.deleteBuffer(buffer);
  }

  setTopology(topology, options = {}) {
    const previousTopology = this.topology;
    const preserveGpuWeatherSource = options.preserveGpuWeatherSource === true;
    if (previousTopology !== topology && !canonicalWindowsEqual(previousTopology?.canonicalWindow, topology?.canonicalWindow)) this.gpuWeatherTransition = null;
    if (this.gpuWeatherSource && previousTopology !== topology && !preserveGpuWeatherSource) this.gpuWeatherSource = null;
    const canPreserve = options.preserveCompatibleState !== false
      && previousTopology
      && canonicalWindowsEqual(previousTopology.canonicalWindow, topology.canonicalWindow);
    const previousLevelData = this.levelData;
    const previousTemporal = this.temporal;
    const previousTransition = this.transition;
    this.topology = topology;
    if (!canPreserve) {
      this.levelData = null;
      this.transition = null;
      this.temporal = null;
      this.temporalProgress = 0;
      this.instances = { rain: new Float32Array(), strong: new Float32Array(), storm: new Float32Array(), hail: new Float32Array() };
      this.counts = { rain: 0, strong: 0, storm: 0, hail: 0 };
      this.bufferCapacity = { rain: 0, strong: 0, storm: 0, hail: 0 };
      this.buffersDirty = true;
      if (!preserveGpuWeatherSource) this.gpuWeatherSource = null;
    } else {
      const retainedCurrent = retainedLevelData(previousTopology, topology, previousLevelData);
      this.levelData = retainedCurrent ? previousLevelData : null;
      this.transition = previousTransition
        && retainedLevelData(previousTopology, topology, previousTransition.fromLevelData)
        && retainedLevelData(previousTopology, topology, previousTransition.toLevelData)
        ? previousTransition : null;
      const levels = new Map();
      if (previousTemporal) {
        for (const [level, state] of previousTemporal.levels) {
          if (retainedTemporalState(previousTopology, topology, level, state)) levels.set(level, state);
        }
      }
      this.temporal = levels.size ? { ...previousTemporal, levels } : null;
      if (!this.levelData || !this.temporal) {
        this.levelData = this.levelData && retainedCurrent ? this.levelData : null;
        this.transition = this.temporal && this.transition ? this.transition : null;
        this.temporalProgress = 0;
        if (!this.levelData || !this.temporal) {
          this.instances = { rain: new Float32Array(), strong: new Float32Array(), storm: new Float32Array(), hail: new Float32Array() };
          this.counts = { rain: 0, strong: 0, storm: 0, hail: 0 };
          this.bufferCapacity = { rain: 0, strong: 0, storm: 0, hail: 0 };
          this.buffersDirty = true;
        }
      }
      if (retainedCurrent || this.temporal) this.lifecycleDiagnostics.preservedTopologyStates++;
    }
    this.map?.triggerRepaint();
  }

  setHazardsVisible(visible) {
    this.hazardsVisible = visible;
    if (this.active) this.map?.triggerRepaint();
  }

  setGpuWeatherMode(enabled, time = 0, { rebuildCpu = true, requestRepaint = true } = {}) {
    const next = Boolean(enabled);
    if (this.gpuWeatherMode === next) return;
    this.gpuWeatherMode = next;
    this.gpuWeatherSource = null;
    this.gpuWeatherMultiChunkSources = null;
    this.gpuWeatherTransition = null;
    this.temporal = null;
    if (next) {
      // GPU reactivation is a stable ownership boundary. A CPU transition can
      // survive the preceding disable path when its final promotion was
      // interrupted; it must not veto the first complete GPU source publish.
      this.transition = null;
      this.instances = { rain: new Float32Array(), strong: new Float32Array(), storm: new Float32Array(), hail: new Float32Array() };
      this.counts = { rain: 0, strong: 0, storm: 0, hail: 0 };
      this.instanceWriters = { rain: new InstanceWriter(), strong: new InstanceWriter(), storm: new InstanceWriter(), hail: new InstanceWriter() };
      this.bufferCapacity = { rain: 0, strong: 0, storm: 0, hail: 0 };
      const gl = this.map?.painter?.context?.gl;
      if (gl && this.instanceBuffers) for (const buffer of Object.values(this.instanceBuffers)) {
        gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
        gl.bufferData(gl.ARRAY_BUFFER, 0, gl.STREAM_DRAW);
      }
      this.buffersDirty = false;
    } else if (rebuildCpu && this.active && this.levelData) this.rebuildTemporal(time);
    if (requestRepaint) this.map?.triggerRepaint();
  }

  setGpuWeatherSource(source, { requestRepaint = true } = {}) {
    if (!this.gpuWeatherMode) return;
    if (source && !this.isGpuWeatherSourceCompatible(source)) {
      throw new Error(`GPU weather source must match the active stable GPU topology (expected topology=${this.topology?.canonicalWindow ? JSON.stringify(this.topology.canonicalWindow) : 'none'}, levelData=${this.levelData?.level ?? 'none'}; actual topology=${source.topology?.canonicalWindow ? JSON.stringify(source.topology.canonicalWindow) : 'none'}, levelData=${source.levelData?.level ?? 'none'}).`);
    }
    this.gpuWeatherSource = source;
    this.gpuWeatherMultiChunkSources = null;
    if (requestRepaint) this.map?.triggerRepaint();
  }

  gpuWeatherMultiChunkSourceCompatibilityDetails(source, gl = this.map?.painter?.context?.gl) {
    const failedPredicates = [];
    if (!this.gpuWeatherMode) failedPredicates.push('gpu-weather-mode-inactive');
    if (!source) failedPredicates.push('source-missing');
    if (source?.gl && gl && source.gl !== gl) failedPredicates.push('webgl-context-mismatch');
    if (source && source.presentationLevel !== REFERENCE_GRID_LEVEL) failedPredicates.push('not-direct-l13');
    if (source && source.kind !== 'physical') failedPredicates.push('not-physical');
    if (!source?.chunk?.key) failedPredicates.push('chunk-key-missing');
    if (!source?.presentationOwnership) failedPredicates.push('presentation-ownership-missing');
    if (!source?.textureA) failedPredicates.push('texture-a-missing');
    if (!source?.textureB) failedPredicates.push('texture-b-missing');
    if (!source?.reconstructor?.layout) failedPredicates.push('reconstructor-owner-not-live');
    return { compatible: failedPredicates.length === 0, failedPredicates };
  }

  setGpuWeatherMultiChunkSources(sources, { requestRepaint = true } = {}) {
    if (!this.gpuWeatherMode) throw new Error('Cannot install multi-chunk GPU weather while GPU weather mode is inactive.');
    const next = [...(sources || [])];
    const keys = new Set();
    const pair = next[0] ? [next[0].temporalA, next[0].temporalB, next[0].progress] : null;
    for (const source of next) {
      const compatibility = this.gpuWeatherMultiChunkSourceCompatibilityDetails(source);
      if (!compatibility.compatible) throw new Error(`GPU multi-chunk source rejected: ${compatibility.failedPredicates.join(', ')}.`);
      if (keys.has(source.chunk.key)) throw new Error(`GPU multi-chunk source key is duplicated: ${source.chunk.key}.`);
      keys.add(source.chunk.key);
      if (pair && (source.temporalA !== pair[0] || source.temporalB !== pair[1] || source.progress !== pair[2])) {
        throw new Error('GPU multi-chunk sources must share one renderer temporal pair and progress.');
      }
    }
    this.gpuWeatherSource = null;
    this.gpuWeatherMultiChunkSources = next;
    if (requestRepaint) this.map?.triggerRepaint();
  }

  setGpuWeatherTransition(transition, { requestRepaint = true } = {}) {
    if (!this.gpuWeatherMode) throw new Error('Cannot install a GPU LOD transition while GPU weather mode is inactive.');
    if (!transition?.fromSource || !transition?.toSource || !transition.fineLevelData) {
      throw new Error('GPU LOD transition requires both endpoint sources and a fine level domain.');
    }
    const topology = transition.topology || this.topology;
    if (!this.isGpuWeatherSourceCompatible(transition.fromSource, {
      topology, levelData: transition.fromSource.levelData, allowTransition: true
    }) || !this.isGpuWeatherSourceCompatible(transition.toSource, {
      topology, levelData: transition.toSource.levelData, allowTransition: true
    })) throw new Error('GPU LOD transition endpoint source is incompatible with the active topology.');
    this.gpuWeatherTransition = { ...transition, progress: transition.progress ?? 0 };
    this.transition = null;
    this.temporal = null;
    if (requestRepaint) this.map?.triggerRepaint();
  }

  clearGpuWeatherTransition({ requestRepaint = true } = {}) {
    this.gpuWeatherTransition = null;
    if (requestRepaint) this.map?.triggerRepaint();
  }

  setGpuWeatherCommittedState(topology, levelData, source, time) {
    if (!this.gpuWeatherMode) throw new Error('Cannot commit GPU weather state while GPU weather mode is inactive.');
    if (!this.isGpuWeatherSourceCompatible(source, { topology, levelData, allowTransition: true })) {
      throw new Error('GPU weather committed state must contain a matching stable topology, level data, and source.');
    }
    this.setTopology(topology, { preserveCompatibleState: false, preserveGpuWeatherSource: true });
    this.setLevelData(levelData, time, { preserveGpuWeatherSource: true });
    this.gpuWeatherTransition = null;
    this.gpuWeatherSource = source;
    this.map?.triggerRepaint();
  }

  gpuWeatherSourceCompatibilityDetails(source, { topology = this.topology, levelData = this.levelData, allowTransition = false } = {}) {
    const expectedKind = source?.levelData?.level < REFERENCE_GRID_LEVEL ? 'summary' : 'physical';
    const predicates = {
      gpuWeatherMode: Boolean(this.gpuWeatherMode),
      sourcePresent: Boolean(source),
      topologyIdentity: Boolean(source && source.topology === topology),
      levelDataIdentity: Boolean(source && source.levelData === levelData),
      supportedLevel: Boolean(source && isGpuWeatherLevel(source.levelData?.level)),
      expectedKind: expectedKind || null,
      actualKind: source?.kind || null,
      kindMatches: Boolean(source && source.kind === expectedKind),
      textureAPresent: Boolean(source?.textureA),
      textureBPresent: Boolean(source?.textureB),
      coverageTextureAPresent: Boolean(source?.coverageTextureA),
      coverageTextureBPresent: Boolean(source?.coverageTextureB),
      cpuTransitionClear: Boolean(!this.transition),
      transitionAllowed: Boolean(allowTransition)
    };
    const sourceOwners = {
      reconstructorPresent: Boolean(source?.reconstructor),
      reconstructorLive: source?.reconstructor ? Boolean(source.reconstructor.layout) : null,
      summaryBackendPresent: Boolean(source?.summaryBackend),
      summaryBackendLive: source?.summaryBackend ? source.summaryBackend.destroyed !== true : null
    };
    const failedPredicates = [];
    if (!predicates.gpuWeatherMode) failedPredicates.push('gpu-weather-mode-inactive');
    if (!predicates.sourcePresent) failedPredicates.push('source-missing');
    if (!predicates.topologyIdentity) failedPredicates.push('topology-identity-mismatch');
    if (!predicates.levelDataIdentity) failedPredicates.push('level-data-identity-mismatch');
    if (!predicates.supportedLevel) failedPredicates.push('unsupported-source-level');
    if (!predicates.kindMatches) failedPredicates.push('source-kind-mismatch');
    if (!predicates.textureAPresent) failedPredicates.push('texture-a-missing');
    if (!predicates.textureBPresent) failedPredicates.push('texture-b-missing');
    if (expectedKind === 'summary' && !predicates.coverageTextureAPresent) failedPredicates.push('coverage-texture-a-missing');
    if (expectedKind === 'summary' && !predicates.coverageTextureBPresent) failedPredicates.push('coverage-texture-b-missing');
    if (!allowTransition && !predicates.cpuTransitionClear) failedPredicates.push('cpu-transition-active');
    if (sourceOwners.reconstructorPresent && !sourceOwners.reconstructorLive) failedPredicates.push('reconstructor-owner-not-live');
    if (sourceOwners.summaryBackendPresent && !sourceOwners.summaryBackendLive) failedPredicates.push('summary-backend-owner-destroyed');
    return {
      compatible: failedPredicates.length === 0,
      failedPredicates,
      predicates,
      rendererState: {
        topologyPresent: Boolean(this.topology),
        levelDataLevel: this.levelData?.level ?? null,
        cpuTransition: Boolean(this.transition),
        gpuTransition: Boolean(this.gpuWeatherTransition)
      },
      sourceState: {
        topologyPresent: Boolean(source?.topology),
        levelDataLevel: source?.levelData?.level ?? null,
        presentationLevel: source?.presentationLevel ?? null,
        kind: source?.kind || null
      },
      sourceOwners
    };
  }

  isGpuWeatherSourceCompatible(source, options = {}) {
    return this.gpuWeatherSourceCompatibilityDetails(source, options).compatible;
  }

  setGpuWeatherPresentationEnabled(enabled) {
    this.gpuWeatherPresentationEnabled = Boolean(enabled);
  }

  setGpuWeatherTimingEnabled(enabled) {
    this.gpuPresentationTiming.setEnabled(enabled);
  }

  setGpuWeatherRenderSynchronizer(callback) {
    this.gpuWeatherRenderSynchronizer = typeof callback === 'function' ? callback : null;
  }

  activeLevels() {
    if (this.gpuWeatherTransition) return [this.gpuWeatherTransition.fromSource.levelData.level, this.gpuWeatherTransition.toSource.levelData.level];
    if (this.transition) return [this.transition.fromLevelData.level, this.transition.toLevelData.level];
    return this.levelData ? [this.levelData.level] : [];
  }

  evaluateKeyframe(level, index, reusableState = null) {
    const time = index / TEMPORAL_FRAME_COUNT;
    this.lifecycleDiagnostics.evaluateKeyframeCalls++;
    const weatherStarted = now();
    const summaries = this.weatherPyramid.evaluate([level], prepareGeographicFieldFrame(time), reusableState?.summaries);
    this.lifecycleDiagnostics.weatherEvaluationMs += now() - weatherStarted;
    const mapped = new Array(MAX_GRID_LEVEL + 1);
    const mappingStarted = now();
    mapped[level] = mapDotsWeatherSummary(summaries[level], reusableState?.mapped?.[level]);
    this.lifecycleDiagnostics.mappingMs += now() - mappingStarted;
    return { index, summaries, mapped };
  }

  evaluateTransitionKeyframes(levels, index, reusableStates = null) {
    this.lifecycleDiagnostics.evaluateTransitionKeyframeCalls++;
    this.lifecycleDiagnostics.evaluateKeyframeCalls += levels.length;
    const reusableSummaries = new Array(MAX_GRID_LEVEL + 1);
    for (const level of levels) reusableSummaries[level] = reusableStates?.get(level)?.summaries?.[level] || null;
    const weatherStarted = now();
    const summaries = this.weatherPyramid.evaluate(levels, prepareGeographicFieldFrame(index / TEMPORAL_FRAME_COUNT), reusableSummaries);
    this.lifecycleDiagnostics.weatherEvaluationMs += now() - weatherStarted;
    const mapped = new Array(MAX_GRID_LEVEL + 1);
    const mappingStarted = now();
    for (const level of levels) mapped[level] = mapDotsWeatherSummary(summaries[level], reusableStates?.get(level)?.mapped?.[level]);
    this.lifecycleDiagnostics.mappingMs += now() - mappingStarted;
    return new Map(levels.map((level) => [level, { index, summaries, mapped }]));
  }

  createLevelTemporalState(level, index, nextIndex) {
    return {
      frames0: this.evaluateKeyframe(level, index),
      frames1: this.evaluateKeyframe(level, nextIndex)
    };
  }

  rebuildTemporal(time) {
    const frame = geographicTemporalFrameAt(time);
    const nextIndex = frame.nextIndex;
    const levels = this.activeLevels();
    const joint = levels.length === 2 && levels.includes(12) && levels.includes(13);
    const frames0 = joint ? this.evaluateTransitionKeyframes(levels, frame.index) : null;
    const frames1 = joint ? this.evaluateTransitionKeyframes(levels, nextIndex) : null;
    this.temporal = {
      index: frame.index,
      nextIndex,
      levels: new Map(levels.map((level) => [level, joint
        ? { frames0: frames0.get(level), frames1: frames1.get(level) }
        : this.createLevelTemporalState(level, frame.index, nextIndex)]))
    };
    this.temporalProgress = frame.progress;
    this.rebuildInstances();
  }

  setLevelData(levelData, time, options = {}) {
    const level = levelData?.level ?? null;
    const preserveGpuWeatherSource = options.preserveGpuWeatherSource === true;
    if (this.gpuWeatherSource && (this.gpuWeatherSource.levelData !== levelData || !isGpuWeatherLevel(level)) && !preserveGpuWeatherSource) {
      this.gpuWeatherSource = null;
    }
    if (this.gpuWeatherMode && isGpuWeatherLevel(level)) {
      this.levelData = levelData;
      this.transition = null;
      this.temporal = null;
      this.temporalProgress = 0;
      this.map?.triggerRepaint();
      return;
    }
    if (this.active && this.transition && level === this.transition.toLevelData.level) {
      const promoted = this.temporal?.levels.get(level);
      if (promoted) {
        this.levelData = levelData;
        this.transition = null;
        this.temporal.levels = new Map([[level, promoted]]);
        this.temporalProgress = geographicTemporalFrameAt(time).progress;
        this.rebuildInstances();
        return;
      }
    }
    const frame = geographicTemporalFrameAt(time);
    const retained = this.active && !this.transition && this.levelData === levelData && this.temporal
      && this.temporal.index === frame.index && this.temporal.nextIndex === frame.nextIndex
      && retainedTemporalState(this.topology, this.topology, level, this.temporal.levels.get(level));
    if (retained) {
      this.temporalProgress = frame.progress;
      this.map?.triggerRepaint();
      return;
    }
    this.levelData = levelData;
    this.transition = null;
    if (this.active) this.rebuildTemporal(time);
    else this.temporal = null;
  }

  setActive(active) {
    this.active = active;
    if (!active) {
      this.temporal = null;
      this.buffersDirty = false;
    }
    this.map?.triggerRepaint();
  }

  setTransition(fromLevelData, toLevelData, time, progress = 0) {
    this.gpuWeatherSource = null;
    const fromLevel = fromLevelData.level;
    const toLevel = toLevelData.level;
    this.levelData = toLevelData;
    const previousTransition = this.transition;
    const reversing = previousTransition
      && previousTransition.fromLevelData.level === toLevel
      && previousTransition.toLevelData.level === fromLevel;
    if (reversing) {
      this.transition = { fromLevelData, toLevelData };
      this.transitionProgress = progress;
      this.rebuildInstances();
      return;
    }
    this.transition = { fromLevelData, toLevelData };
    this.transitionProgress = progress;
    if (!this.active) {
      this.temporal = null;
      return;
    }
    const frame = geographicTemporalFrameAt(time);
    const nextIndex = frame.nextIndex;
    if (!this.temporal || this.temporal.index !== frame.index || this.temporal.nextIndex !== nextIndex) {
      this.rebuildTemporal(time);
      return;
    }
    if (!this.temporal.levels.has(fromLevel)) this.temporal.levels.set(fromLevel, this.createLevelTemporalState(fromLevel, frame.index, nextIndex));
    if (!this.temporal.levels.has(toLevel)) this.temporal.levels.set(toLevel, this.createLevelTemporalState(toLevel, frame.index, nextIndex));
    this.rebuildInstances();
  }

  setTransitionProgress(progress) {
    this.transitionProgress = progress;
    this.map?.triggerRepaint();
  }

  updateWeather(time) {
    if (!this.levelData) return;
    const frame = geographicTemporalFrameAt(time);
    if (!this.temporal || frame.index !== this.temporal.index) {
      if (this.temporal && frame.index === this.temporal.nextIndex) {
        this.temporal.index = frame.index;
        this.temporal.nextIndex = frame.nextIndex;
        const levels = [...this.temporal.levels.keys()];
        if (levels.length === 2 && levels.includes(12) && levels.includes(13)) {
          const reusableStates = new Map(levels.map((level) => [level, this.temporal.levels.get(level).frames0]));
          const nextFrames = this.evaluateTransitionKeyframes(levels, this.temporal.nextIndex, reusableStates);
          for (const level of levels) {
            const temporalState = this.temporal.levels.get(level);
            temporalState.frames0 = temporalState.frames1;
            temporalState.frames1 = nextFrames.get(level);
          }
        } else for (const [level, temporalState] of this.temporal.levels) {
          const reusableState = temporalState.frames0;
          temporalState.frames0 = temporalState.frames1;
          temporalState.frames1 = this.evaluateKeyframe(level, this.temporal.nextIndex, reusableState);
        }
        this.temporalProgress = frame.progress;
        this.rebuildInstances();
      } else {
        this.rebuildTemporal(time);
      }
    } else {
      this.temporalProgress = frame.progress;
      this.map?.triggerRepaint();
    }
  }

  setInstances(type, data) {
    this.instances[type] = data;
    this.counts[type] = data.length / INSTANCE_STRIDE;
  }

  rebuildInstances() {
    if (!this.active || !this.temporal || !this.levelData) return;
    const started = now();
    this.lifecycleDiagnostics.instanceRebuildCalls++;
    if (!this.transition) {
      const level = this.levelData.level;
      const { frames0, frames1 } = this.temporal.levels.get(level);
      const levelData = this.topology.levels.get(level);
      const types = weatherTypesForMapped(frames0.mapped[level]);
      for (const type of types) {
        this.setInstances(type, buildSameLevelTemporalInstances(frames0.mapped[level], frames1.mapped[level], levelData, RADIUS_KEYS[type], this.instanceWriters[type]));
      }
      for (const type of WEATHER_TYPES) if (!types.includes(type)) this.setInstances(type, EMPTY_INSTANCES);
    } else {
      const fromLevel = this.transition.fromLevelData.level;
      const toLevel = this.transition.toLevelData.level;
      const fromTemporal = this.temporal.levels.get(fromLevel);
      const toTemporal = this.temporal.levels.get(toLevel);
      const hierarchical = isHierarchicalTransition(fromLevel, toLevel, this.legacyHierarchicalLodMorph);
      const refining = toLevel > fromLevel;
      const coarseLevel = refining ? fromLevel : toLevel;
      const fineLevel = refining ? toLevel : fromLevel;
      const directTransitionRelation = hierarchical ? null : this.topology.directTransitionRelationFor(Math.min(fromLevel, toLevel), Math.max(fromLevel, toLevel));
      const fromIsLower = fromLevel < toLevel;
      const coarseLevelData = this.topology.levels.get(coarseLevel);
      const fineLevelData = this.topology.levels.get(fineLevel);
      const fromLevelData = this.topology.levels.get(fromLevel);
      const toLevelData = this.topology.levels.get(toLevel);

      const types = weatherTypesForMapped(fromTemporal.frames0.mapped[fromLevel]);
      if (types !== weatherTypesForMapped(toTemporal.frames0.mapped[toLevel])) throw new Error('Dots transition endpoint mapped layouts must match.');
      for (const type of types) {
        const data = hierarchical
          ? buildHierarchicalTemporalInstances(
            this.temporal.levels.get(coarseLevel).frames0.mapped[coarseLevel],
            this.temporal.levels.get(fineLevel).frames0.mapped[fineLevel],
            this.temporal.levels.get(coarseLevel).frames1.mapped[coarseLevel],
            this.temporal.levels.get(fineLevel).frames1.mapped[fineLevel],
            coarseLevelData,
            fineLevelData,
            this.topology.transitionParentsFor(fineLevel),
            RADIUS_KEYS[type],
            refining,
            this.instanceWriters[type]
          )
          : buildDirectTemporalInstances(
            fromTemporal.frames0.mapped[fromLevel],
            toTemporal.frames0.mapped[toLevel],
            fromTemporal.frames1.mapped[fromLevel],
            toTemporal.frames1.mapped[toLevel],
            directTransitionRelation,
            fromIsLower,
            RADIUS_KEYS[type],
            this.instanceWriters[type]
          );
        this.setInstances(type, data);
      }
      for (const type of WEATHER_TYPES) if (!types.includes(type)) this.setInstances(type, EMPTY_INSTANCES);
    }

    this.buffersDirty = true;
    this.lifecycleDiagnostics.instanceRebuildMs += now() - started;
    this.map?.triggerRepaint();
  }

  uploadBuffers(gl) {
    if (!this.buffersDirty || !this.instanceBuffers) return;
    for (const type of WEATHER_TYPES) {
      const bytes = this.instances[type].byteLength;
      gl.bindBuffer(gl.ARRAY_BUFFER, this.instanceBuffers[type]);
      if (bytes > this.bufferCapacity[type]) {
        gl.bufferData(gl.ARRAY_BUFFER, bytes, gl.STREAM_DRAW);
        this.bufferCapacity[type] = bytes;
      }
      if (bytes) gl.bufferSubData(gl.ARRAY_BUFFER, 0, this.instances[type]);
    }
    this.buffersDirty = false;
  }

  diagnostics() {
    const instanceByteLengths = Object.fromEntries(WEATHER_TYPES.map((type) => [type, this.instances[type].byteLength]));
    const allocatedInstanceBytes = Object.fromEntries(WEATHER_TYPES.map((type) => [type, this.instanceWriters[type].values.byteLength]));
    const gpuInstanceBytes = sumNumbers(Object.values(this.bufferCapacity));
    const staticGpuBytes = QUAD.byteLength * 2 + STORM.byteLength + HAIL.byteLength;
    const temporalBreakdown = temporalStateBreakdown(this.temporal);
    const temporalBytes = temporalBreakdown.physicalSummaryBytes + temporalBreakdown.mappedPresentationBytes;
    const cpuInstanceBytes = sumNumbers(Object.values(allocatedInstanceBytes));
    const packedActiveCountByLevel = Object.fromEntries([...this.temporal?.levels || []].map(([level, state]) => {
      const summary = state.frames0?.summaries?.[level];
      return [level, summary?.representation === WEATHER_DIRECT_STATE_PACKED
        ? summary.potentialActiveIndices.length : null];
    }));
    const stateRepresentationByLevel = Object.fromEntries([...this.temporal?.levels || []].map(([level, state]) => [
      level, state.frames0?.summaries?.[level]?.representation || null
    ]));
    return {
      active: this.active,
      stableLevel: this.transition ? null : this.levelData?.level ?? null,
      activeLevels: this.activeLevels(),
      transition: this.transition ? {
        fromLevel: this.transition.fromLevelData.level,
        toLevel: this.transition.toLevelData.level,
        progress: this.transitionProgress
      } : null,
      instanceCounts: { ...this.counts },
      instanceByteLengths,
      allocatedInstanceBytes,
      bufferCapacity: { ...this.bufferCapacity },
      currentInstanceBytes: sumNumbers(Object.values(instanceByteLengths)),
      cpuBytes: cpuInstanceBytes + temporalBytes,
      cpuBreakdown: {
        temporalPhysicalSummaryBytes: temporalBreakdown.physicalSummaryBytes,
        mappedPresentationBytes: temporalBreakdown.mappedPresentationBytes,
        instanceWriterAllocatedBytes: cpuInstanceBytes,
        totalDotsCpuBytes: cpuInstanceBytes + temporalBytes
      },
      packedActiveCountByLevel,
      stateRepresentationByLevel,
      estimatedGpuBufferBytes: gpuInstanceBytes + staticGpuBytes,
      gpuWeather: {
        enabled: this.gpuWeatherMode,
        source: Boolean(this.gpuWeatherSource || this.gpuWeatherMultiChunkSources?.length),
        physicalField: this.gpuWeatherSource ? (this.gpuWeatherSource.kind === 'summary' ? 'gpu-physical-summary' : 'gpu-r16f')
          : this.gpuWeatherMultiChunkSources?.length ? 'gpu-r16f-multi-chunk' : null,
        level: this.gpuWeatherSource?.levelData?.level ?? (this.gpuWeatherMultiChunkSources?.length ? REFERENCE_GRID_LEVEL : null),
        sampleCount: this.gpuWeatherSource?.levelData?.count
          || this.gpuWeatherMultiChunkSources?.reduce((total, source) => total + source.levelData.count, 0) || 0,
        drawCallCount: this.gpuWeatherMode && (this.gpuWeatherSource || this.gpuWeatherMultiChunkSources?.length)
          ? (this.gpuWeatherMultiChunkSources?.length || 1) * 2 : 0,
        vertexCountPerDraw: 6,
        currentFieldBytes: this.gpuWeatherSource
          ? this.gpuWeatherSource.width * this.gpuWeatherSource.height * (this.gpuWeatherSource.kind === 'summary' ? 12 : 2)
          : this.gpuWeatherMultiChunkSources?.reduce((total, source) => total + source.width * source.height * 2, 0) || 0,
        mappedCpuBytes: this.gpuWeatherSource || this.gpuWeatherMultiChunkSources?.length ? 0 : temporalBreakdown.mappedPresentationBytes,
        mappedBufferUploads: this.gpuWeatherSource || this.gpuWeatherMultiChunkSources?.length ? 0 : null,
        multiChunk: this.gpuWeatherMultiChunkSources ? {
          count: this.gpuWeatherMultiChunkSources.length,
          keys: this.gpuWeatherMultiChunkSources.map((source) => source.chunk.key)
        } : null,
        transitionOwner: this.gpuWeatherTransition ? 'gpu' : null,
        transition: this.gpuWeatherTransition ? {
          fromLevel: this.gpuWeatherTransition.fromSource.levelData.level,
          toLevel: this.gpuWeatherTransition.toSource.levelData.level,
          progress: this.gpuWeatherTransition.progress,
          fineGridLevel: this.gpuWeatherTransition.fineLevelData.level,
          fromSourceComplete: Boolean(this.gpuWeatherTransition.fromSource.textureA && this.gpuWeatherTransition.fromSource.textureB),
          toSourceComplete: Boolean(this.gpuWeatherTransition.toSource.textureA && this.gpuWeatherTransition.toSource.textureB),
          drawCallCount: 2
        } : null
      },
      gpuPresentationTiming: this.gpuPresentationTiming.diagnostics(this.map?.painter?.context?.gl),
      lifecycle: { ...this.lifecycleDiagnostics }
    };
  }

  programsFor(gl, shaderData) {
    let programs = this.programs.get(shaderData.variantName);
    if (!programs) {
      programs = { circle: makeProgram(gl, shaderData, 'circle'), hazard: makeProgram(gl, shaderData, 'hazard') };
      this.programs.set(shaderData.variantName, programs);
    }
    return programs;
  }

  gpuProgramsFor(gl, shaderData) {
    const key = `gpu:${shaderData.variantName}`;
    let programs = this.programs.get(key);
    if (!programs) {
      programs = {
        rain: makeGpuWeatherProgram(gl, shaderData, false),
        strong: makeGpuWeatherProgram(gl, shaderData, true),
        transitionRain: makeGpuWeatherLodTransitionProgram(gl, shaderData, false),
        transitionStrong: makeGpuWeatherLodTransitionProgram(gl, shaderData, true)
      };
      this.programs.set(key, programs);
    }
    return programs;
  }

  gpuMultiChunkProgramsFor(gl, shaderData) {
    const key = `gpu-multi:${shaderData.variantName}`;
    let programs = this.programs.get(key);
    if (!programs) {
      programs = {
        rain: makeGpuWeatherProgram(gl, shaderData, false, { multiChunk: true }),
        strong: makeGpuWeatherProgram(gl, shaderData, true, { multiChunk: true })
      };
      this.programs.set(key, programs);
    }
    return programs;
  }

  renderGpuWeather(gl, shaderData, projection) {
    this.gpuWeatherRenderSynchronizer?.();
    if (this.gpuWeatherTransition) {
      this.renderGpuWeatherLodTransition(gl, shaderData, projection);
      return;
    }
    const source = this.gpuWeatherSource;
    const levelData = this.levelData;
    if (!source || !levelData || !isGpuWeatherLevel(levelData.level)) return;
    this.lifecycleDiagnostics.gpuWeatherRenderCalls++;
    if (!this.gpuWeatherPresentationEnabled) return;
    const startedAt = performance.now();
    const query = this.gpuPresentationTiming.begin(gl);
    const programs = this.gpuProgramsFor(gl, shaderData);
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
    gl.enable(gl.DEPTH_TEST);
    gl.depthMask(false);
    gl.enable(gl.POLYGON_OFFSET_FILL);
    gl.polygonOffset(-1, -1);
    for (const type of ['rain', 'strong']) {
      const entry = programs[type];
      const { locations } = entry;
      gl.useProgram(entry.program);
      setGeographicProjection(gl, locations, projection);
      gl.uniform1i(locations.weatherA, 0);
      gl.uniform1i(locations.weatherB, 1);
      gl.uniform1i(locations.coverageA, 2);
      gl.uniform1i(locations.coverageB, 3);
      gl.uniform1f(locations.weatherProgress, source.progress ?? 0);
      gl.uniform1i(locations.weatherKind, source.kind === 'summary' ? 1 : 0);
      gl.uniform1i(locations.width, levelData.width);
      gl.uniform1i(locations.minI, levelData.minI);
      gl.uniform1i(locations.minJ, levelData.minJ);
      gl.uniform1f(locations.spacing, levelData.spacing);
      gl.uniform1f(locations.opacity, 1);
      gl.uniform4fv(locations.color, COLORS[type]);
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, source.textureA || source.texture);
      gl.activeTexture(gl.TEXTURE1);
      gl.bindTexture(gl.TEXTURE_2D, source.textureB || source.textureA || source.texture);
      gl.activeTexture(gl.TEXTURE2);
      gl.bindTexture(gl.TEXTURE_2D, source.coverageTextureA || source.textureA || source.texture);
      gl.activeTexture(gl.TEXTURE3);
      gl.bindTexture(gl.TEXTURE_2D, source.coverageTextureB || source.textureB || source.textureA || source.texture);
      gl.bindBuffer(gl.ARRAY_BUFFER, this.vertexBuffers[type]);
      gl.enableVertexAttribArray(locations.vertex);
      gl.vertexAttribPointer(locations.vertex, 2, gl.FLOAT, false, 0, 0);
      gl.drawArraysInstanced(gl.TRIANGLES, 0, 6, levelData.count);
    }
    gl.disable(gl.POLYGON_OFFSET_FILL);
    gl.depthMask(true);
    this.lifecycleDiagnostics.gpuWeatherPresentationDrawCalls += 2;
    this.gpuPresentationTiming.end(gl, query, startedAt);
  }

  renderGpuWeatherMultiChunk(gl, shaderData, projection) {
    const sources = this.gpuWeatherMultiChunkSources;
    if (!sources?.length) return;
    this.lifecycleDiagnostics.gpuWeatherRenderCalls++;
    if (!this.gpuWeatherPresentationEnabled) return;
    const startedAt = performance.now();
    const query = this.gpuPresentationTiming.begin(gl);
    const programs = this.gpuMultiChunkProgramsFor(gl, shaderData);
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
    gl.enable(gl.DEPTH_TEST);
    gl.depthMask(false);
    gl.enable(gl.POLYGON_OFFSET_FILL);
    gl.polygonOffset(-1, -1);
    for (const type of ['rain', 'strong']) {
      const entry = programs[type];
      const { locations } = entry;
      gl.useProgram(entry.program);
      setGeographicProjection(gl, locations, projection);
      gl.uniform1i(locations.weatherA, 0);
      gl.uniform1i(locations.weatherB, 1);
      gl.uniform1i(locations.coverageA, 2);
      gl.uniform1i(locations.coverageB, 3);
      gl.uniform1i(locations.weatherKind, 0);
      gl.uniform1f(locations.opacity, 1);
      gl.uniform4fv(locations.color, COLORS[type]);
      gl.bindBuffer(gl.ARRAY_BUFFER, this.vertexBuffers[type]);
      gl.enableVertexAttribArray(locations.vertex);
      gl.vertexAttribPointer(locations.vertex, 2, gl.FLOAT, false, 0, 0);
      for (const source of sources) {
        const levelData = source.levelData;
        const ownership = source.presentationOwnership;
        gl.uniform1f(locations.weatherProgress, source.progress ?? 0);
        gl.uniform1i(locations.width, levelData.width);
        gl.uniform1i(locations.minI, levelData.minI);
        gl.uniform1i(locations.minJ, levelData.minJ);
        gl.uniform1f(locations.spacing, levelData.spacing);
        gl.uniform4i(locations.ownerBounds, ownership.minI, ownership.maxI, ownership.minJ, ownership.maxJ);
        gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, source.textureA);
        gl.activeTexture(gl.TEXTURE1); gl.bindTexture(gl.TEXTURE_2D, source.textureB);
        gl.activeTexture(gl.TEXTURE2); gl.bindTexture(gl.TEXTURE_2D, source.textureA);
        gl.activeTexture(gl.TEXTURE3); gl.bindTexture(gl.TEXTURE_2D, source.textureB);
        gl.drawArraysInstanced(gl.TRIANGLES, 0, 6, levelData.count);
      }
    }
    gl.disable(gl.POLYGON_OFFSET_FILL);
    gl.depthMask(true);
    this.lifecycleDiagnostics.gpuWeatherPresentationDrawCalls += sources.length * 2;
    this.gpuPresentationTiming.end(gl, query, startedAt);
  }

  renderGpuWeatherLodTransition(gl, shaderData, projection) {
    const transition = this.gpuWeatherTransition;
    const fine = transition?.fineLevelData;
    if (!transition || !fine || !this.gpuWeatherPresentationEnabled) return;
    const startedAt = performance.now();
    const query = this.gpuPresentationTiming.begin(gl);
    const programs = this.gpuProgramsFor(gl, shaderData);
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
    gl.enable(gl.DEPTH_TEST);
    gl.depthMask(false);
    gl.enable(gl.POLYGON_OFFSET_FILL);
    gl.polygonOffset(-1, -1);
    for (const type of ['rain', 'strong']) {
      const entry = programs[type === 'rain' ? 'transitionRain' : 'transitionStrong'];
      const { locations } = entry;
      const from = transition.fromSource;
      const to = transition.toSource;
      gl.useProgram(entry.program);
      setGeographicProjection(gl, locations, projection);
      for (const [location, unit] of [[locations.fromWeatherA, 0], [locations.fromWeatherB, 1], [locations.fromCoverageA, 2], [locations.fromCoverageB, 3], [locations.toWeatherA, 4], [locations.toWeatherB, 5], [locations.toCoverageA, 6], [locations.toCoverageB, 7]]) gl.uniform1i(location, unit);
      gl.uniform1f(locations.weatherProgress, from.progress ?? 0);
      gl.uniform1f(locations.lodProgress, transition.progress ?? 0);
      gl.uniform1i(locations.fromKind, from.kind === 'summary' ? 1 : 0);
      gl.uniform1i(locations.toKind, to.kind === 'summary' ? 1 : 0);
      gl.uniform1i(locations.fromIsFine, from.levelData.level === fine.level ? 1 : 0);
      gl.uniform1i(locations.toIsFine, to.levelData.level === fine.level ? 1 : 0);
      for (const [location, value] of [
        [locations.fromWidth, from.levelData.width], [locations.fromHeight, from.levelData.height], [locations.fromMinI, from.levelData.minI], [locations.fromMinJ, from.levelData.minJ],
        [locations.toWidth, to.levelData.width], [locations.toHeight, to.levelData.height], [locations.toMinI, to.levelData.minI], [locations.toMinJ, to.levelData.minJ],
        [locations.fineMinI, fine.minI], [locations.fineMinJ, fine.minJ], [locations.fineWidth, fine.width]
      ]) gl.uniform1i(location, value);
      gl.uniform1f(locations.fineSpacing, fine.spacing);
      gl.uniform1f(locations.fromSpacing, from.levelData.spacing);
      gl.uniform1f(locations.toSpacing, to.levelData.spacing);
      gl.uniform4fv(locations.color, COLORS[type]);
      const textures = [from.textureA, from.textureB, from.coverageTextureA || from.textureA, from.coverageTextureB || from.textureB, to.textureA, to.textureB, to.coverageTextureA || to.textureA, to.coverageTextureB || to.textureB];
      textures.forEach((texture, index) => { gl.activeTexture(gl.TEXTURE0 + index); gl.bindTexture(gl.TEXTURE_2D, texture); });
      gl.bindBuffer(gl.ARRAY_BUFFER, this.vertexBuffers[type]);
      gl.enableVertexAttribArray(locations.vertex);
      gl.vertexAttribPointer(locations.vertex, 2, gl.FLOAT, false, 0, 0);
      gl.drawArraysInstanced(gl.TRIANGLES, 0, 6, fine.count);
    }
    gl.disable(gl.POLYGON_OFFSET_FILL);
    gl.depthMask(true);
    this.lifecycleDiagnostics.gpuWeatherPresentationDrawCalls += 2;
    this.gpuPresentationTiming.end(gl, query, startedAt);
  }

  renderInstances(gl, entry, projection, types) {
    const { program, locations } = entry;
    gl.useProgram(program);
    setGeographicProjection(gl, locations, projection);
    gl.uniform1f(locations.temporalProgress, this.temporalProgress);
    gl.uniform1f(locations.lodTransition, this.transitionProgress);

    for (const type of types) {
      if (!this.counts[type]) continue;
      gl.bindBuffer(gl.ARRAY_BUFFER, this.vertexBuffers[type]);
      gl.enableVertexAttribArray(locations.vertex);
      gl.vertexAttribPointer(locations.vertex, 2, gl.FLOAT, false, 0, 0);
      gl.bindBuffer(gl.ARRAY_BUFFER, this.instanceBuffers[type]);
      gl.enableVertexAttribArray(locations.startCenter);
      gl.vertexAttribPointer(locations.startCenter, 2, gl.FLOAT, false, INSTANCE_BYTES, 0);
      gl.vertexAttribDivisor(locations.startCenter, 1);
      gl.enableVertexAttribArray(locations.endCenter);
      gl.vertexAttribPointer(locations.endCenter, 2, gl.FLOAT, false, INSTANCE_BYTES, 8);
      gl.vertexAttribDivisor(locations.endCenter, 1);
      gl.enableVertexAttribArray(locations.startTime0);
      gl.vertexAttribPointer(locations.startTime0, 1, gl.FLOAT, false, INSTANCE_BYTES, 16);
      gl.vertexAttribDivisor(locations.startTime0, 1);
      gl.enableVertexAttribArray(locations.startTime1);
      gl.vertexAttribPointer(locations.startTime1, 1, gl.FLOAT, false, INSTANCE_BYTES, 20);
      gl.vertexAttribDivisor(locations.startTime1, 1);
      gl.enableVertexAttribArray(locations.endTime0);
      gl.vertexAttribPointer(locations.endTime0, 1, gl.FLOAT, false, INSTANCE_BYTES, 24);
      gl.vertexAttribDivisor(locations.endTime0, 1);
      gl.enableVertexAttribArray(locations.endTime1);
      gl.vertexAttribPointer(locations.endTime1, 1, gl.FLOAT, false, INSTANCE_BYTES, 28);
      gl.vertexAttribDivisor(locations.endTime1, 1);
      gl.uniform4fv(locations.color, COLORS[type]);
      gl.drawArraysInstanced(gl.TRIANGLES, 0, type === 'rain' || type === 'strong' ? 6 : ((type === 'storm' ? STORM.length : HAIL.length) / 2), this.counts[type]);
    }

    for (const location of [locations.startCenter, locations.endCenter, locations.startTime0, locations.startTime1, locations.endTime0, locations.endTime1]) {
      gl.vertexAttribDivisor(location, 0);
    }
  }

  render(gl, args) {
    if (!this.active) return;
    if (this.gpuWeatherMode && !this.transition && this.gpuWeatherMultiChunkSources?.length) {
      this.renderDiagnostics?.enter();
      this.gpuWeatherRenderSynchronizer?.();
      this.renderGpuWeatherMultiChunk(gl, args.shaderData, args.defaultProjectionData);
      this.renderDiagnostics?.exit();
      return;
    }
    if (this.gpuWeatherMode && !this.transition && isGpuWeatherLevel(this.levelData?.level) && (this.gpuWeatherSource || this.gpuWeatherTransition)) {
      this.renderDiagnostics?.enter();
      this.renderGpuWeather(gl, args.shaderData, args.defaultProjectionData);
      this.renderDiagnostics?.exit();
      return;
    }
    this.renderDiagnostics?.enter();
    this.uploadBuffers(gl);
    const programs = this.programsFor(gl, args.shaderData);
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
    gl.enable(gl.DEPTH_TEST);
    gl.depthMask(false);
    gl.enable(gl.POLYGON_OFFSET_FILL);
    gl.polygonOffset(-1, -1);
    this.renderInstances(gl, programs.circle, args.defaultProjectionData, ['rain', 'strong']);
    if (this.hazardsVisible) this.renderInstances(gl, programs.hazard, args.defaultProjectionData, ['storm', 'hail']);
    gl.disable(gl.POLYGON_OFFSET_FILL);
    gl.depthMask(true);
    this.renderDiagnostics?.exit();
  }
}
