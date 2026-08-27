import { prepareGeographicFieldFrame } from './geography.js';
import { geographicTemporalFrameAt, setGeographicProjection, TEMPORAL_FRAME_COUNT } from './geographic-layer-utils.js';
import {
  dotsStrongRainMmhToRadius,
  dotsStrongRainMmhToRadiusFraction,
  rainMmhToRadiusFraction
} from './precipitation-mapping.js';
import { GeographicWeatherPyramid, WEATHER_REFERENCE_LEVEL, rainCoverageWeightForThreshold, WEATHER_SUMMARY_PROFILE_RAIN_ONLY_DISPLAY } from './geographic-weather-pyramid.js';
import { canonicalWindowsEqual, MAX_GRID_LEVEL, mercatorXForIndex, mercatorYForIndex } from './geographic-lod.js';
import { geographicHazardRadii, geographicHazardRadiusForSeverity } from './hazard-renderer.js';

const REFERENCE_GRID_LEVEL = WEATHER_REFERENCE_LEVEL;
export const STORM_INNER_RATIO = 0.38;

const COLORS = { rain: [0, 0.565, 1, 1], strong: [0, 0, 1, 1], storm: [1, 0, 1, 1], hail: [1, 0.831, 0, 1] };
const INSTANCE_STRIDE = 8;
const INSTANCE_BYTES = INSTANCE_STRIDE * Float32Array.BYTES_PER_ELEMENT;
const WEATHER_TYPES = ['rain', 'strong', 'storm', 'hail'];
const RADIUS_KEYS = { rain: 'rainRadius', strong: 'strongRadius', storm: 'stormRadius', hail: 'hailRadius' };
const QUAD = new Float32Array([-1, -1, 1, -1, 1, 1, -1, -1, 1, 1, -1, 1]);
const now = () => globalThis.performance?.now?.() ?? Date.now();

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

function makeMappedState(length, reusable) {
  if (reusable?.rainRadius?.length === length) return reusable;
  return {
    rainRadius: new Float32Array(length),
    strongRadius: new Float32Array(length),
    stormRadius: new Float32Array(length),
    hailRadius: new Float32Array(length)
  };
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
          state.stormRadius[index] = 0;
          state.hailRadius[index] = 0;
        }
      } else if (state.mappingInitialized) {
        state.rainRadius.fill(0);
        state.strongRadius.fill(0);
        state.stormRadius.fill(0);
        state.hailRadius.fill(0);
      }
    }
  }
  state.potentialActiveIndices = activeIndices || null;
  state.mappingInitialized = true;
}

// Pure presentation mapping: physical summary values never feed a coarser LOD.
export function mapDotsWeatherSummary(summary, reusable = null) {
  const state = makeMappedState(summary.levelData.count, reusable);
  const activeIndices = summary.potentialActiveIndices;
  prepareMappedActiveSet(state, activeIndices);
  const isDirectPointSummary = summary.level >= REFERENCE_GRID_LEVEL;
  const directHazardValue = { storm: 0, hail: 0 };
  const directHazard = { stormRadius: 0, hailRadius: 0 };
  const rainCoverageWeights = rainCoverageWeightForThreshold(summary, 0.05);
  const strongCoverageWeights = rainCoverageWeightForThreshold(summary, 2.5);
  const hazardsUnavailable = summary.profile === WEATHER_SUMMARY_PROFILE_RAIN_ONLY_DISPLAY;
  const count = activeIndices ? activeIndices.length : summary.levelData.count;
  const spacing = summary.levelData.spacing;
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

    if (hazardsUnavailable) {
      state.stormRadius[index] = 0;
      state.hailRadius[index] = 0;
      continue;
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
    const radius0 = radii0[index];
    const radius1 = radii1[index];
    if (!hasTemporalRadius(radius0, radius1)) continue;
    const x = mercatorXForIndex(levelData, index);
    const y = mercatorYForIndex(levelData, index);
    writer.push(x, y, x, y, radius0, radius1, radius0, radius1);
  }
  return writer.finish();
}

function buildDirectTemporalInstances(fromTime0, toTime0, fromTime1, toTime1, fromLevelData, toLevelData, pairs, fromIsLower, radiusKey, writer) {
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

function isHierarchicalTransition(fromLevel, toLevel) {
  return Math.abs(fromLevel - toLevel) === 1 && Math.max(fromLevel, toLevel) <= REFERENCE_GRID_LEVEL;
}

export class GeographicDotsLayer {
  constructor(weatherPyramid = new GeographicWeatherPyramid()) {
    this.id = 'geographic-weather-dots';
    this.type = 'custom';
    this.renderingMode = '3d';
    this.programs = new Map();
    this.instances = { rain: new Float32Array(), strong: new Float32Array(), storm: new Float32Array(), hail: new Float32Array() };
    this.instanceWriters = { rain: new InstanceWriter(), strong: new InstanceWriter(), storm: new InstanceWriter(), hail: new InstanceWriter() };
    this.counts = { rain: 0, strong: 0, storm: 0, hail: 0 };
    this.bufferCapacity = { rain: 0, strong: 0, storm: 0, hail: 0 };
    this.weatherPyramid = weatherPyramid;
    this.topology = weatherPyramid.topology;
    this.levelData = null;
    this.transition = null;
    this.transitionProgress = 1;
    this.temporal = null;
    this.temporalProgress = 0;
    this.buffersDirty = true;
    this.active = true;
    this.hazardsVisible = true;
    this.lifecycleDiagnostics = {
      evaluateKeyframeCalls: 0, evaluateTransitionKeyframeCalls: 0, weatherEvaluationMs: 0, mappingMs: 0,
      instanceRebuildCalls: 0, instanceRebuildMs: 0, preservedTopologyStates: 0
    };
  }

  onAdd(map, gl) {
    this.map = map;
    this.instanceBuffers = Object.fromEntries(WEATHER_TYPES.map((type) => [type, gl.createBuffer()]));
    this.vertexBuffers = { rain: gl.createBuffer(), strong: gl.createBuffer(), storm: gl.createBuffer(), hail: gl.createBuffer() };
    for (const [type, vertices] of Object.entries({ rain: QUAD, strong: QUAD, storm: STORM, hail: HAIL })) {
      gl.bindBuffer(gl.ARRAY_BUFFER, this.vertexBuffers[type]);
      gl.bufferData(gl.ARRAY_BUFFER, vertices, gl.STATIC_DRAW);
    }
  }

  onRemove(map, gl) {
    for (const programs of this.programs.values()) { gl.deleteProgram(programs.circle.program); gl.deleteProgram(programs.hazard.program); }
    for (const buffer of [...Object.values(this.instanceBuffers || {}), ...Object.values(this.vertexBuffers || {})]) if (buffer) gl.deleteBuffer(buffer);
  }

  setTopology(topology, options = {}) {
    const previousTopology = this.topology;
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

  activeLevels() {
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

  setLevelData(levelData, time) {
    const level = levelData?.level ?? null;
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
      for (const type of WEATHER_TYPES) {
        this.setInstances(type, buildSameLevelTemporalInstances(frames0.mapped[level], frames1.mapped[level], levelData, RADIUS_KEYS[type], this.instanceWriters[type]));
      }
    } else {
      const fromLevel = this.transition.fromLevelData.level;
      const toLevel = this.transition.toLevelData.level;
      const fromTemporal = this.temporal.levels.get(fromLevel);
      const toTemporal = this.temporal.levels.get(toLevel);
      const hierarchical = isHierarchicalTransition(fromLevel, toLevel);
      const refining = toLevel > fromLevel;
      const coarseLevel = refining ? fromLevel : toLevel;
      const fineLevel = refining ? toLevel : fromLevel;
      const pairs = hierarchical ? null : this.topology.directPairsFor(Math.min(fromLevel, toLevel), Math.max(fromLevel, toLevel));
      const fromIsLower = fromLevel < toLevel;
      const coarseLevelData = this.topology.levels.get(coarseLevel);
      const fineLevelData = this.topology.levels.get(fineLevel);
      const fromLevelData = this.topology.levels.get(fromLevel);
      const toLevelData = this.topology.levels.get(toLevel);

      for (const type of WEATHER_TYPES) {
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
            fromLevelData,
            toLevelData,
            pairs,
            fromIsLower,
            RADIUS_KEYS[type],
            this.instanceWriters[type]
          );
        this.setInstances(type, data);
      }
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

  programsFor(gl, shaderData) {
    let programs = this.programs.get(shaderData.variantName);
    if (!programs) {
      programs = { circle: makeProgram(gl, shaderData, 'circle'), hazard: makeProgram(gl, shaderData, 'hazard') };
      this.programs.set(shaderData.variantName, programs);
    }
    return programs;
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
  }
}
