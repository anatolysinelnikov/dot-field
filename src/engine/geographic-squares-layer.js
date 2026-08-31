import { prepareGeographicFieldFrame } from './geography.js';
import { geographicTemporalFrameAt, setGeographicProjection, TEMPORAL_FRAME_COUNT } from './geographic-layer-utils.js';
import { GeographicWeatherPyramid, WEATHER_DIRECT_STATE_PACKED, WEATHER_REFERENCE_LEVEL, rainCoverageWeightForThreshold, WEATHER_SUMMARY_PROFILE_RAIN_ONLY_DISPLAY } from './geographic-weather-pyramid.js';
import { canonicalWindowsEqual, MAX_GRID_LEVEL, mercatorXForIndex, mercatorYForIndex } from './geographic-lod.js';
import { RAIN_VISIBILITY_SHADER, STRONG_RAIN_SHADER } from './precipitation-mapping.js';
import {
  createGpuWeatherProgram,
  gpuWeatherProjectionLocations,
  GPU_SQUARES_RAIN_MAPPING_SHADER,
  GPU_WEATHER_COMMON_VERTEX,
  isGpuWeatherLevel
} from './geographic-gpu-weather-presentation.js';
import { createGpuPresentationTiming } from './gpu-presentation-timing.js';


const FULL_INSTANCE_STRIDE = 18;
const RAIN_ONLY_INSTANCE_STRIDE = 6;
const CELL_VERTICES = new Float32Array([-0.5, -0.5, 0.5, -0.5, 0.5, 0.5, -0.5, -0.5, 0.5, 0.5, -0.5, 0.5]);

const now = () => globalThis.performance?.now?.() ?? Date.now();
const sumNumbers = (values) => values.reduce((total, value) => total + (Number.isFinite(value) ? value : 0), 0);

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
    mapped.rainWetMeanMmh,
    mapped.rainCoverage,
    mapped.stormCoverage,
    mapped.stormMeanSeverity,
    mapped.stormMaxSeverity,
    mapped.hailCoverage,
    mapped.hailMeanSeverity,
    mapped.hailMaxSeverity
  ].reduce((total, value) => total + knownArrayBytes(value, seen), 0);
}

function temporalStateBytes(temporal) {
  if (!temporal) return 0;
  const seen = new Set();
  let bytes = 0;
  for (const [level, levelState] of temporal.levels) {
    for (const frameState of [levelState.frames0, levelState.frames1]) {
      bytes += summaryBytes(frameState?.summaries?.[level], seen);
      bytes += mappedStateBytes(frameState?.mapped?.[level], seen);
    }
  }
  return bytes;
}

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

function mappedLayoutForSummary(summary) {
  return summary.profile === WEATHER_SUMMARY_PROFILE_RAIN_ONLY_DISPLAY ? 'rain-only' : 'full';
}

function instanceStrideForLayout(layout) {
  return layout === 'rain-only' ? RAIN_ONLY_INSTANCE_STRIDE : FULL_INSTANCE_STRIDE;
}

function makeMappedState(length, layout, reusable) {
  if (reusable?.representation === 'dense-mapped' && reusable.layout === layout && reusable.rainWetMeanMmh?.length === length) return reusable;
  const state = { representation: 'dense-mapped', layout, rainWetMeanMmh: new Float32Array(length), rainCoverage: new Float32Array(length) };
  if (layout === 'full') Object.assign(state, {
    stormCoverage: new Float32Array(length), stormMeanSeverity: new Float32Array(length), stormMaxSeverity: new Float32Array(length),
    hailCoverage: new Float32Array(length), hailMeanSeverity: new Float32Array(length), hailMaxSeverity: new Float32Array(length)
  });
  return state;
}

function makePackedMappedState(summary, layout, reusable) {
  const length = summary.potentialActiveIndices.length;
  if (reusable?.representation === WEATHER_DIRECT_STATE_PACKED
    && reusable.layout === layout
    && reusable.potentialActiveIndices === summary.potentialActiveIndices
    && reusable.rainWetMeanMmh.length === length) return reusable;
  const state = {
    representation: WEATHER_DIRECT_STATE_PACKED,
    layout,
    levelData: summary.levelData,
    potentialActiveIndices: summary.potentialActiveIndices,
    rainWetMeanMmh: new Float32Array(length),
    rainCoverage: new Float32Array(length)
  };
  if (layout === 'full') Object.assign(state, {
    stormCoverage: new Float32Array(length), stormMeanSeverity: new Float32Array(length), stormMaxSeverity: new Float32Array(length),
    hailCoverage: new Float32Array(length), hailMeanSeverity: new Float32Array(length), hailMaxSeverity: new Float32Array(length)
  });
  return state;
}

function samePotentialActiveIndices(left, right) {
  if (left === right) return true;
  if (!left || !right || left.length !== right.length) return false;
  for (let index = 0; index < left.length; index++) if (left[index] !== right[index]) return false;
  return true;
}

function prepareMappedActiveSet(state, activeIndices) {
  const previous = state.potentialActiveIndices;
  if (activeIndices && !samePotentialActiveIndices(previous, activeIndices)) {
    if (previous) {
      for (const index of previous) {
        state.rainWetMeanMmh[index] = 0;
        state.rainCoverage[index] = 0;
        if (state.layout === 'full') {
          state.stormCoverage[index] = 0; state.stormMeanSeverity[index] = 0; state.stormMaxSeverity[index] = 0;
          state.hailCoverage[index] = 0; state.hailMeanSeverity[index] = 0; state.hailMaxSeverity[index] = 0;
        }
      }
    } else if (state.mappingInitialized) {
      state.rainWetMeanMmh.fill(0);
      state.rainCoverage.fill(0);
      if (state.layout === 'full') {
        state.stormCoverage.fill(0); state.stormMeanSeverity.fill(0); state.stormMaxSeverity.fill(0);
        state.hailCoverage.fill(0); state.hailMeanSeverity.fill(0); state.hailMaxSeverity.fill(0);
      }
    }
  }
  state.potentialActiveIndices = activeIndices || null;
  state.mappingInitialized = true;
}

// Pure renderer mapping. Coverage remains separate from wet/positive severity.
export function mapSquaresWeatherSummary(summary, reusable = null) {
  const layout = mappedLayoutForSummary(summary);
  if (summary.representation === WEATHER_DIRECT_STATE_PACKED) {
    const state = makePackedMappedState(summary, layout, reusable);
    const count = summary.potentialActiveIndices.length;
    const rainValues = summary.channels.rainMmh;
    const rainMask = summary.coverageMasks.rain;
    for (let position = 0; position < count; position++) {
      state.rainCoverage[position] = rainMask[position] & 1 ? 1 : 0;
      state.rainWetMeanMmh[position] = rainValues[position];
      if (layout !== 'full') continue;
      const stormValue = summary.channels.storm[position];
      const hailValue = summary.channels.hail[position];
      state.stormCoverage[position] = summary.coverageMasks.storm[position];
      state.stormMeanSeverity[position] = stormValue;
      state.stormMaxSeverity[position] = stormValue;
      state.hailCoverage[position] = summary.coverageMasks.hail[position];
      state.hailMeanSeverity[position] = hailValue;
      state.hailMaxSeverity[position] = hailValue;
    }
    return state;
  }
  const state = makeMappedState(summary.levelData.count, layout, reusable);
  const activeIndices = summary.potentialActiveIndices;
  prepareMappedActiveSet(state, activeIndices);
  const count = activeIndices ? activeIndices.length : summary.levelData.count;
  const rainWeights = rainCoverageWeightForThreshold(summary, 0.05);
  if (layout === 'rain-only') {
    for (let position = 0; position < count; position++) {
      const index = activeIndices ? activeIndices[position] : position;
      const total = summary.totalWeight[index];
      const rainWeight = rainWeights[index];
      state.rainCoverage[index] = total > 0 ? rainWeight / total : 0;
      state.rainWetMeanMmh[index] = rainWeight > 0 ? summary.rainWeightedSumMmh[index] / rainWeight : 0;
    }
    return state;
  }
  for (let position = 0; position < count; position++) {
    const index = activeIndices ? activeIndices[position] : position;
    const total = summary.totalWeight[index];
    const rainWeight = rainWeights[index];
    state.rainCoverage[index] = total > 0 ? rainWeight / total : 0;
    state.rainWetMeanMmh[index] = rainWeight > 0 ? summary.rainWeightedSumMmh[index] / rainWeight : 0;
    const stormWeight = summary.stormCoverageWeight[index];
    const hailWeight = summary.hailCoverageWeight[index];
    state.stormCoverage[index] = total > 0 ? stormWeight / total : 0;
    state.stormMeanSeverity[index] = stormWeight > 0 ? summary.stormWeightedSeverity[index] / stormWeight : 0;
    state.stormMaxSeverity[index] = summary.stormMaxSeverity[index];
    state.hailCoverage[index] = total > 0 ? hailWeight / total : 0;
    state.hailMeanSeverity[index] = hailWeight > 0 ? summary.hailWeightedSeverity[index] / hailWeight : 0;
    state.hailMaxSeverity[index] = summary.hailMaxSeverity[index];
  }
  return state;
}

function compileShader(gl, type, source) {
  const shader = gl.createShader(type);
  gl.shaderSource(shader, source);
  gl.compileShader(shader);
  if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(shader) || 'Square weather shader compilation failed.');
  return shader;
}

function makeProgram(gl, shaderData, layout) {
  const rainOnly = layout === 'rain-only';
  const vertexSource = [
    '#version 300 es', shaderData.vertexShaderPrelude, shaderData.define,
    rainOnly
      ? 'in vec2 a_vertex;\nin vec2 a_center;\nin vec2 a_rain0;\nin vec2 a_rain1;\nuniform float u_temporalProgress;\nuniform float u_spacing;\nout vec2 v_rain;\nvoid main() {\n  v_rain = mix(a_rain0, a_rain1, u_temporalProgress);\n  gl_Position = projectTile(a_center + a_vertex * u_spacing);\n}'
      : 'in vec2 a_vertex;\nin vec2 a_center;\nin vec4 a_values0;\nin vec4 a_values1;\nin vec4 a_hazards0;\nin vec4 a_hazards1;\nuniform float u_temporalProgress;\nuniform float u_spacing;\nout vec4 v_values;\nout vec4 v_hazards;\nvoid main() {\n  v_values = mix(a_values0, a_values1, u_temporalProgress);\n  v_hazards = mix(a_hazards0, a_hazards1, u_temporalProgress);\n  gl_Position = projectTile(a_center + a_vertex * u_spacing);\n}'
  ].join('\n');
  const fragmentSource = [
    '#version 300 es', 'precision highp float;', rainOnly ? 'in vec2 v_rain;\nuniform float u_opacity;\nout vec4 fragColor;' : 'in vec4 v_values;\nin vec4 v_hazards;\nuniform float u_opacity;\nuniform float u_hazardsVisible;\nout vec4 fragColor;',
    `${RAIN_VISIBILITY_SHADER}
${STRONG_RAIN_SHADER}
${rainOnly ? `void main() {
  float rain = rainVisibility(v_rain.x) * clamp(v_rain.y, 0.0, 1.0);
  float strong = strongRain(v_rain.x);
  vec3 color = mix(vec3(0.0, 0.565, 1.0), vec3(0.0, 0.0, 1.0), strong);
  fragColor = vec4(color, rain * u_opacity);
}` : `
float strength(float value, float threshold) { return smoothstep(threshold * 0.45, 0.93, value); }
void main() {
  float rain = rainVisibility(v_values.x) * clamp(v_values.y, 0.0, 1.0);
  float strong = strongRain(v_values.x);
  vec3 color = mix(vec3(0.0, 0.565, 1.0), vec3(0.0, 0.0, 1.0), strong);
  float alpha = rain;
  float stormStrength = strength(v_values.w, 0.075);
  float stormPeak = strength(v_hazards.x, 0.075);
  float storm = u_hazardsVisible * clamp(v_values.z, 0.0, 1.0) * max(stormStrength, stormPeak);
  if (storm > 0.0) { color = mix(color, vec3(1.0, 0.0, 1.0), mix(0.45, 1.0, pow(max(stormStrength, stormPeak), 0.47))); alpha = max(alpha, storm); }
  float hailStrength = strength(v_hazards.z, 0.11);
  float hailPeak = strength(v_hazards.w, 0.11);
  float hail = u_hazardsVisible * clamp(v_hazards.y, 0.0, 1.0) * max(hailStrength, hailPeak);
  if (hail > 0.0) { color = mix(color, vec3(1.0, 0.831, 0.0), mix(0.5, 1.0, pow(max(hailStrength, hailPeak), 0.47))); alpha = max(alpha, hail); }
  fragColor = vec4(color, alpha * u_opacity);
}`}`
  ].join('\n');
  const program = gl.createProgram();
  gl.attachShader(program, compileShader(gl, gl.VERTEX_SHADER, vertexSource));
  gl.attachShader(program, compileShader(gl, gl.FRAGMENT_SHADER, fragmentSource));
  gl.linkProgram(program);
  if (!gl.getProgramParameter(program, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(program) || 'Square weather shader linking failed.');
  const names = rainOnly
    ? ['a_vertex', 'a_center', 'a_rain0', 'a_rain1', 'u_temporalProgress', 'u_spacing', 'u_opacity', 'u_matrix', 'u_projection_fallback_matrix', 'u_projection_matrix', 'u_projection_tile_mercator_coords', 'u_projection_clipping_plane', 'u_projection_transition']
    : ['a_vertex', 'a_center', 'a_values0', 'a_values1', 'a_hazards0', 'a_hazards1', 'u_temporalProgress', 'u_spacing', 'u_opacity', 'u_hazardsVisible', 'u_matrix', 'u_projection_fallback_matrix', 'u_projection_matrix', 'u_projection_tile_mercator_coords', 'u_projection_clipping_plane', 'u_projection_transition'];
  return { program, locations: Object.fromEntries(names.map((name) => [name, name.startsWith('a_') ? gl.getAttribLocation(program, name) : gl.getUniformLocation(program, name)])) };
}

function makeGpuWeatherProgram(gl, shaderData) {
  const vertexSource = `${GPU_WEATHER_COMMON_VERTEX}
out float v_rain;
void main() {
  int sampleIndex;
  v_rain = gpuRainAt(sampleIndex);
  gl_Position = projectTile(gpuWeatherCenter(sampleIndex) + a_vertex * u_spacing);
}`;
  const fragmentSource = `${GPU_SQUARES_RAIN_MAPPING_SHADER}
${STRONG_RAIN_SHADER}
in float v_rain;
uniform float u_opacity;
out vec4 fragColor;
void main() {
  float rain = rainVisibility(v_rain) * step(0.05, v_rain);
  float strong = strongRain(v_rain);
  vec3 color = mix(vec3(0.0, 0.565, 1.0), vec3(0.0, 0.0, 1.0), strong);
  fragColor = vec4(color, rain * u_opacity);
}`;
  const program = createGpuWeatherProgram(gl, shaderData, vertexSource, fragmentSource, 'GPU Squares weather');
  return {
    program,
    locations: {
      vertex: gl.getAttribLocation(program, 'a_vertex'),
      weatherA: gl.getUniformLocation(program, 'u_weather_a'),
      weatherB: gl.getUniformLocation(program, 'u_weather_b'),
      weatherProgress: gl.getUniformLocation(program, 'u_weather_progress'),
      width: gl.getUniformLocation(program, 'u_width'),
      minI: gl.getUniformLocation(program, 'u_minI'),
      minJ: gl.getUniformLocation(program, 'u_minJ'),
      spacing: gl.getUniformLocation(program, 'u_spacing'),
      opacity: gl.getUniformLocation(program, 'u_opacity'),
      ...gpuWeatherProjectionLocations(gl, program)
    }
  };
}

export class GeographicSquaresLayer {
  constructor(weatherPyramid = new GeographicWeatherPyramid()) {
    this.id = 'geographic-weather-squares';
    this.type = 'custom';
    this.renderingMode = '3d';
    this.active = false;
    this.hazardsVisible = true;
    this.weatherPyramid = weatherPyramid;
    this.topology = weatherPyramid.topology;
    this.levelData = null;
    this.transition = null;
    this.transitionProgress = 1;
    this.temporal = null;
    this.temporalProgress = 0;
    this.gpuWeatherMode = false;
    this.gpuWeatherSource = null;
    this.gpuWeatherPresentationEnabled = true;
    this.gpuWeatherRenderSynchronizer = null;
    this.gpuPresentationTiming = createGpuPresentationTiming();
    this.instanceData = [new Float32Array(), new Float32Array()];
    this.instanceLayouts = [null, null];
    this.instanceCounts = [0, 0];
    this.instanceBufferCapacity = [0, 0];
    this.instanceDirty = [true, true];
    this.stableGroup = 0;
    this.programs = new Map();
    this.lifecycleDiagnostics = {
      evaluateKeyframeCalls: 0, evaluateTransitionKeyframeCalls: 0, weatherEvaluationMs: 0, mappingMs: 0,
      instanceRebuildCalls: 0, instanceRebuildMs: 0, preservedTopologyStates: 0,
      gpuWeatherRenderCalls: 0, gpuWeatherPresentationDrawCalls: 0
    };
  }

  onAdd(map, gl) {
    this.map = map;
    this.gpuPresentationTiming.attach(gl);
    this.vertexBuffer = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, this.vertexBuffer);
    gl.bufferData(gl.ARRAY_BUFFER, CELL_VERTICES, gl.STATIC_DRAW);
    this.instanceBuffers = [gl.createBuffer(), gl.createBuffer()];
  }

  onRemove(map, gl) {
    for (const entry of this.programs.values()) gl.deleteProgram(entry.program);
    for (const buffer of [this.vertexBuffer, ...(this.instanceBuffers || [])]) if (buffer) gl.deleteBuffer(buffer);
  }

  setTopology(topology, options = {}) {
    if (this.weatherPyramid.topology !== topology) throw new Error('Squares topology must be the shared weather-pyramid topology.');
    const previousTopology = this.topology;
    if (this.gpuWeatherSource && previousTopology !== topology) this.gpuWeatherSource = null;
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
      this.instanceData = [new Float32Array(), new Float32Array()];
      this.instanceLayouts = [null, null];
      this.instanceCounts = [0, 0];
      this.instanceBufferCapacity = [0, 0];
      this.instanceDirty = [true, true];
      this.gpuWeatherSource = null;
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
        this.temporalProgress = 0;
        this.transition = this.temporal && this.transition ? this.transition : null;
        if (!this.levelData || !this.temporal) {
          this.instanceData = [new Float32Array(), new Float32Array()];
          this.instanceLayouts = [null, null];
          this.instanceCounts = [0, 0];
          this.instanceBufferCapacity = [0, 0];
          this.instanceDirty = [true, true];
        }
      }
      if (retainedCurrent || this.temporal) this.lifecycleDiagnostics.preservedTopologyStates++;
    }
    this.map?.triggerRepaint();
  }

  setActive(active) {
    this.active = active;
    if (!active) {
      this.temporal = null;
      this.instanceDirty[0] = false;
      this.instanceDirty[1] = false;
    }
    this.map?.triggerRepaint();
  }

  setGpuWeatherMode(enabled, time = 0) {
    const next = Boolean(enabled);
    if (this.gpuWeatherMode === next) return;
    this.gpuWeatherMode = next;
    this.gpuWeatherSource = null;
    this.temporal = null;
    if (next) {
      this.instanceData = [new Float32Array(), new Float32Array()];
      this.instanceLayouts = [null, null];
      this.instanceCounts = [0, 0];
      this.instanceBufferCapacity = [0, 0];
      const gl = this.map?.painter?.context?.gl;
      if (gl && this.instanceBuffers) for (const buffer of this.instanceBuffers) {
        gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
        gl.bufferData(gl.ARRAY_BUFFER, 0, gl.DYNAMIC_DRAW);
      }
      this.instanceDirty = [false, false];
    } else if (this.active && this.levelData) this.rebuildTemporal(time);
    this.map?.triggerRepaint();
  }

  setGpuWeatherSource(source, { requestRepaint = true } = {}) {
    if (!this.gpuWeatherMode) return;
    if (source && !this.isGpuWeatherSourceCompatible(source)) {
      throw new Error(`GPU weather source must match the active direct-level topology (expected topology=${this.topology?.canonicalWindow ? JSON.stringify(this.topology.canonicalWindow) : 'none'}, levelData=${this.levelData?.level ?? 'none'}; actual topology=${source.topology?.canonicalWindow ? JSON.stringify(source.topology.canonicalWindow) : 'none'}, levelData=${source.levelData?.level ?? 'none'}).`);
    }
    this.gpuWeatherSource = source;
    if (requestRepaint) this.map?.triggerRepaint();
  }

  isGpuWeatherSourceCompatible(source) {
    return Boolean(this.gpuWeatherMode && source && source.topology === this.topology
      && source.levelData === this.levelData
      && isGpuWeatherLevel(source.levelData?.level)
      && !this.transition);
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

  setHazardsVisible(visible) {
    this.hazardsVisible = visible;
    if (this.active) this.map?.triggerRepaint();
  }

  activeLevels() {
    if (this.transition) return [this.transition.fromLevelData.level, this.transition.toLevelData.level];
    return this.levelData ? [this.levelData.level] : [];
  }

  rebuildTemporal(time) {
    const frame = geographicTemporalFrameAt(time);
    const nextIndex = frame.nextIndex;
    const levels = this.activeLevels();
    const joint = levels.length === 2 && levels.includes(12) && levels.includes(13);
    const frames0 = joint ? this.evaluateTransitionKeyframes(levels, frame.index) : null;
    const frames1 = joint ? this.evaluateTransitionKeyframes(levels, nextIndex) : null;
    this.temporal = {
      index: frame.index, nextIndex,
      levels: new Map(levels.map((level) => [level, joint
        ? { frames0: frames0.get(level), frames1: frames1.get(level) }
        : { frames0: this.evaluateKeyframe(level, frame.index), frames1: this.evaluateKeyframe(level, nextIndex) }
      ]))
    };
    this.temporalProgress = frame.progress;
    this.rebuildInstances();
  }

  setLevelData(levelData, time) {
    const level = levelData?.level ?? null;
    if (this.gpuWeatherSource && (this.gpuWeatherSource.levelData !== levelData || !isGpuWeatherLevel(level))) {
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
        const previousGroup = this.transition.fromGroup;
        this.levelData = levelData;
        this.stableGroup = this.transition.toGroup;
        this.transition = null;
        this.temporal.levels = new Map([[level, promoted]]);
        this.temporalProgress = geographicTemporalFrameAt(time).progress;
        this.instanceDirty[previousGroup] = false;
        this.map?.triggerRepaint();
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

  setTransition(fromLevelData, toLevelData, time, progress = 0) {
    this.gpuWeatherSource = null;
    const fromLevel = fromLevelData.level;
    const toLevel = toLevelData.level;
    const previousTransition = this.transition;
    const reversing = previousTransition
      && previousTransition.fromLevelData.level === toLevel
      && previousTransition.toLevelData.level === fromLevel;
    this.levelData = toLevelData;
    if (reversing) {
      this.transition = {
        fromLevelData,
        toLevelData,
        fromGroup: previousTransition.toGroup,
        toGroup: previousTransition.fromGroup
      };
      this.transitionProgress = progress;
      this.map?.triggerRepaint();
      return;
    }
    this.transition = { fromLevelData, toLevelData, fromGroup: this.stableGroup, toGroup: 1 - this.stableGroup };
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
    if (!this.temporal.levels.has(fromLevel)) this.temporal.levels.set(fromLevel, { frames0: this.evaluateKeyframe(fromLevel, frame.index), frames1: this.evaluateKeyframe(fromLevel, nextIndex) });
    if (!this.temporal.levels.has(toLevel)) this.temporal.levels.set(toLevel, { frames0: this.evaluateKeyframe(toLevel, frame.index), frames1: this.evaluateKeyframe(toLevel, nextIndex) });
    this.rebuildInstances(new Set([toLevel]));
  }
  setTransitionProgress(progress) { this.transitionProgress = progress; if (this.active) this.map?.triggerRepaint(); }

  evaluateKeyframe(level, index, reusable = null) {
    this.lifecycleDiagnostics.evaluateKeyframeCalls++;
    const weatherStarted = now();
    const summaries = this.weatherPyramid.evaluate([level], prepareGeographicFieldFrame(index / TEMPORAL_FRAME_COUNT), reusable?.summaries);
    this.lifecycleDiagnostics.weatherEvaluationMs += now() - weatherStarted;
    const mapped = new Array(MAX_GRID_LEVEL + 1);
    const mappingStarted = now();
    mapped[level] = mapSquaresWeatherSummary(summaries[level], reusable?.mapped?.[level]);
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
    for (const level of levels) mapped[level] = mapSquaresWeatherSummary(summaries[level], reusableStates?.get(level)?.mapped?.[level]);
    this.lifecycleDiagnostics.mappingMs += now() - mappingStarted;
    return new Map(levels.map((level) => [level, { index, summaries, mapped }]));
  }

  buildGroup(group, level, state0, state1) {
    if (state0.layout !== state1.layout) throw new Error('Squares temporal endpoint mapped layouts must match.');
    const layout = state0.layout;
    const stride = instanceStrideForLayout(layout);
    const levelData = this.weatherPyramid.topology.levels.get(level);
    const activeIndices = state0.potentialActiveIndices && state1.potentialActiveIndices
      && samePotentialActiveIndices(state0.potentialActiveIndices, state1.potentialActiveIndices)
      ? state0.potentialActiveIndices
      : null;
    const count = activeIndices ? activeIndices.length : levelData.count;
    const length = count * stride;
    let result = this.instanceData[group];
    if (this.instanceLayouts[group] !== layout) result = new Float32Array();
    if (result.length < length) result = new Float32Array(Math.max(length, result.length * 2, stride * 256));
    const valueAt = (state, key, index, position) => state.representation === WEATHER_DIRECT_STATE_PACKED
      ? state[key][position] : state[key][index];
    if (layout === 'rain-only') for (let position = 0, offset = 0; position < count; position++, offset += stride) {
      const index = activeIndices ? activeIndices[position] : position;
      result[offset] = mercatorXForIndex(levelData, index); result[offset + 1] = mercatorYForIndex(levelData, index);
      result[offset + 2] = valueAt(state0, 'rainWetMeanMmh', index, position); result[offset + 3] = valueAt(state0, 'rainCoverage', index, position);
      result[offset + 4] = valueAt(state1, 'rainWetMeanMmh', index, position); result[offset + 5] = valueAt(state1, 'rainCoverage', index, position);
    } else for (let position = 0, offset = 0; position < count; position++, offset += stride) {
      const index = activeIndices ? activeIndices[position] : position;
      result[offset] = mercatorXForIndex(levelData, index); result[offset + 1] = mercatorYForIndex(levelData, index);
      result[offset + 2] = valueAt(state0, 'rainWetMeanMmh', index, position); result[offset + 3] = valueAt(state0, 'rainCoverage', index, position);
      result[offset + 4] = valueAt(state0, 'stormCoverage', index, position); result[offset + 5] = valueAt(state0, 'stormMeanSeverity', index, position); result[offset + 6] = valueAt(state0, 'stormMaxSeverity', index, position);
      result[offset + 7] = valueAt(state0, 'hailCoverage', index, position); result[offset + 8] = valueAt(state0, 'hailMeanSeverity', index, position); result[offset + 9] = valueAt(state0, 'hailMaxSeverity', index, position);
      result[offset + 10] = valueAt(state1, 'rainWetMeanMmh', index, position); result[offset + 11] = valueAt(state1, 'rainCoverage', index, position);
      result[offset + 12] = valueAt(state1, 'stormCoverage', index, position); result[offset + 13] = valueAt(state1, 'stormMeanSeverity', index, position); result[offset + 14] = valueAt(state1, 'stormMaxSeverity', index, position);
      result[offset + 15] = valueAt(state1, 'hailCoverage', index, position); result[offset + 16] = valueAt(state1, 'hailMeanSeverity', index, position); result[offset + 17] = valueAt(state1, 'hailMaxSeverity', index, position);
    }
    this.instanceData[group] = result;
    this.instanceLayouts[group] = layout;
    this.instanceCounts[group] = count;
  }

  rebuildInstances(changedLevels = null) {
    if (!this.temporal || !this.levelData) return;
    const started = now();
    this.lifecycleDiagnostics.instanceRebuildCalls++;
    const groups = this.transition
      ? [[this.transition.fromGroup, this.transition.fromLevelData.level], [this.transition.toGroup, this.transition.toLevelData.level]]
      : [[this.stableGroup, this.levelData.level]];
    for (const [group, level] of groups) {
      if (changedLevels && !changedLevels.has(level)) continue;
      const temporalState = this.temporal.levels.get(level);
      this.buildGroup(group, level, temporalState.frames0.mapped[level], temporalState.frames1.mapped[level]);
      this.instanceDirty[group] = true;
    }
    this.lifecycleDiagnostics.instanceRebuildMs += now() - started;
    this.map?.triggerRepaint();
  }

  updateWeather(time) {
    if (!this.levelData) return;
    const frame = geographicTemporalFrameAt(time);
    if (!this.temporal || frame.index !== this.temporal.index) {
      if (this.temporal && frame.index === this.temporal.nextIndex) {
        this.temporal.index = frame.index; this.temporal.nextIndex = frame.nextIndex;
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
          const reusable = temporalState.frames0;
          temporalState.frames0 = temporalState.frames1;
          temporalState.frames1 = this.evaluateKeyframe(level, this.temporal.nextIndex, reusable);
        }
        this.rebuildInstances();
      } else this.rebuildTemporal(time);
    }
    this.temporalProgress = frame.progress;
    if (this.active) this.map?.triggerRepaint();
  }

  programFor(gl, shaderData, layout) {
    const key = `${shaderData.variantName}:${layout}`;
    let entry = this.programs.get(key);
    if (!entry) { entry = makeProgram(gl, shaderData, layout); this.programs.set(key, entry); }
    return entry;
  }

  gpuProgramFor(gl, shaderData) {
    const key = `gpu:${shaderData.variantName}`;
    let entry = this.programs.get(key);
    if (!entry) {
      entry = makeGpuWeatherProgram(gl, shaderData);
      this.programs.set(key, entry);
    }
    return entry;
  }

  renderGpuWeather(gl, shaderData, projection) {
    this.gpuWeatherRenderSynchronizer?.();
    const source = this.gpuWeatherSource;
    const levelData = this.levelData;
    if (!source || !levelData || !isGpuWeatherLevel(levelData.level)) return;
    this.lifecycleDiagnostics.gpuWeatherRenderCalls++;
    if (!this.gpuWeatherPresentationEnabled) return;
    const startedAt = performance.now();
    const query = this.gpuPresentationTiming.begin(gl);
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
    gl.enable(gl.DEPTH_TEST);
    gl.depthMask(false);
    gl.enable(gl.POLYGON_OFFSET_FILL);
    gl.polygonOffset(-1, -1);
    const entry = this.gpuProgramFor(gl, shaderData);
    const { locations } = entry;
    gl.useProgram(entry.program);
    setGeographicProjection(gl, locations, projection);
    gl.uniform1i(locations.weatherA, 0);
    gl.uniform1i(locations.weatherB, 1);
    gl.uniform1f(locations.weatherProgress, source.progress ?? 0);
    gl.uniform1i(locations.width, levelData.width);
    gl.uniform1i(locations.minI, levelData.minI);
    gl.uniform1i(locations.minJ, levelData.minJ);
    gl.uniform1f(locations.spacing, levelData.spacing);
    gl.uniform1f(locations.opacity, 1);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, source.textureA || source.texture);
    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_2D, source.textureB || source.textureA || source.texture);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.vertexBuffer);
    gl.enableVertexAttribArray(locations.vertex);
    gl.vertexAttribPointer(locations.vertex, 2, gl.FLOAT, false, 0, 0);
    gl.drawArraysInstanced(gl.TRIANGLES, 0, 6, levelData.count);
    gl.disable(gl.POLYGON_OFFSET_FILL);
    gl.depthMask(true);
    this.lifecycleDiagnostics.gpuWeatherPresentationDrawCalls++;
    this.gpuPresentationTiming.end(gl, query, startedAt);
  }

  renderGroup(gl, entry, projection, group, opacity) {
    if (!this.instanceCounts[group] || opacity <= 0) return;
    const { program, locations } = entry;
    gl.useProgram(program);
    setGeographicProjection(gl, { matrix: locations.u_matrix, fallbackMatrix: locations.u_projection_fallback_matrix, projectionMatrix: locations.u_projection_matrix, tileMercatorCoords: locations.u_projection_tile_mercator_coords, clippingPlane: locations.u_projection_clipping_plane, projectionTransition: locations.u_projection_transition }, projection);
    gl.uniform1f(locations.u_temporalProgress, this.temporalProgress);
    const level = this.transition
      ? (group === this.transition.fromGroup ? this.transition.fromLevelData.level : this.transition.toLevelData.level)
      : this.levelData.level;
    gl.uniform1f(locations.u_spacing, 1 / 2 ** level);
    gl.uniform1f(locations.u_opacity, opacity);
    const layout = this.instanceLayouts[group];
    const stride = instanceStrideForLayout(layout);
    if (layout === 'full') gl.uniform1f(locations.u_hazardsVisible, this.hazardsVisible ? 1 : 0);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.vertexBuffer);
    gl.enableVertexAttribArray(locations.a_vertex);
    gl.vertexAttribPointer(locations.a_vertex, 2, gl.FLOAT, false, 0, 0);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.instanceBuffers[group]);
    gl.enableVertexAttribArray(locations.a_center);
    gl.vertexAttribPointer(locations.a_center, 2, gl.FLOAT, false, stride * 4, 0); gl.vertexAttribDivisor(locations.a_center, 1);
    if (layout === 'rain-only') {
      gl.enableVertexAttribArray(locations.a_rain0); gl.vertexAttribPointer(locations.a_rain0, 2, gl.FLOAT, false, stride * 4, 8); gl.vertexAttribDivisor(locations.a_rain0, 1);
      gl.enableVertexAttribArray(locations.a_rain1); gl.vertexAttribPointer(locations.a_rain1, 2, gl.FLOAT, false, stride * 4, 16); gl.vertexAttribDivisor(locations.a_rain1, 1);
    } else {
      gl.enableVertexAttribArray(locations.a_values0); gl.vertexAttribPointer(locations.a_values0, 4, gl.FLOAT, false, stride * 4, 8); gl.vertexAttribDivisor(locations.a_values0, 1);
      gl.enableVertexAttribArray(locations.a_hazards0); gl.vertexAttribPointer(locations.a_hazards0, 4, gl.FLOAT, false, stride * 4, 24); gl.vertexAttribDivisor(locations.a_hazards0, 1);
      gl.enableVertexAttribArray(locations.a_values1); gl.vertexAttribPointer(locations.a_values1, 4, gl.FLOAT, false, stride * 4, 40); gl.vertexAttribDivisor(locations.a_values1, 1);
      gl.enableVertexAttribArray(locations.a_hazards1); gl.vertexAttribPointer(locations.a_hazards1, 4, gl.FLOAT, false, stride * 4, 56); gl.vertexAttribDivisor(locations.a_hazards1, 1);
    }
    gl.drawArraysInstanced(gl.TRIANGLES, 0, 6, this.instanceCounts[group]);
    for (const location of layout === 'rain-only' ? [locations.a_center, locations.a_rain0, locations.a_rain1] : [locations.a_center, locations.a_values0, locations.a_hazards0, locations.a_values1, locations.a_hazards1]) gl.vertexAttribDivisor(location, 0);
  }

  uploadBuffers(gl) {
    if (!this.instanceBuffers) return;
    for (let index = 0; index < 2; index++) {
      if (!this.instanceDirty[index]) continue;
      gl.bindBuffer(gl.ARRAY_BUFFER, this.instanceBuffers[index]);
      const byteLength = this.instanceCounts[index] * instanceStrideForLayout(this.instanceLayouts[index]) * Float32Array.BYTES_PER_ELEMENT;
      if (byteLength > this.instanceBufferCapacity[index]) {
        gl.bufferData(gl.ARRAY_BUFFER, byteLength, gl.DYNAMIC_DRAW);
        this.instanceBufferCapacity[index] = byteLength;
      }
      if (byteLength) gl.bufferSubData(gl.ARRAY_BUFFER, 0, this.instanceData[index].subarray(0, this.instanceCounts[index] * instanceStrideForLayout(this.instanceLayouts[index])));
      this.instanceDirty[index] = false;
    }
  }

  diagnostics() {
    const activeInstanceByteLengths = this.instanceData.map((data, index) => {
      const layout = this.instanceLayouts[index];
      return layout ? this.instanceCounts[index] * instanceStrideForLayout(layout) * Float32Array.BYTES_PER_ELEMENT : 0;
    });
    const allocatedInstanceBytes = this.instanceData.map((data) => data.byteLength);
    return {
      active: this.active,
      stableLevel: this.transition ? null : this.levelData?.level ?? null,
      activeLevels: this.activeLevels(),
      transition: this.transition ? {
        fromLevel: this.transition.fromLevelData.level,
        toLevel: this.transition.toLevelData.level,
        progress: this.transitionProgress
      } : null,
      instanceCounts: [...this.instanceCounts],
      instanceLayouts: [...this.instanceLayouts],
      activeInstanceByteLengths,
      allocatedInstanceBytes,
      bufferCapacity: [...this.instanceBufferCapacity],
      cpuBytes: sumNumbers(allocatedInstanceBytes) + temporalStateBytes(this.temporal),
      estimatedGpuBufferBytes: sumNumbers(this.instanceBufferCapacity) + CELL_VERTICES.byteLength,
      gpuWeather: {
        enabled: this.gpuWeatherMode,
        source: Boolean(this.gpuWeatherSource),
        physicalField: this.gpuWeatherSource ? 'gpu-r16f' : null,
        level: this.gpuWeatherSource?.levelData?.level ?? null,
        sampleCount: this.gpuWeatherSource?.levelData?.count || 0,
        drawCallCount: this.gpuWeatherMode && this.gpuWeatherSource ? 1 : 0,
        vertexCountPerDraw: 6,
        currentFieldBytes: this.gpuWeatherSource?.width * this.gpuWeatherSource?.height * 2 || 0,
        mappedCpuBytes: this.gpuWeatherSource ? 0 : temporalStateBytes(this.temporal),
        mappedBufferUploads: this.gpuWeatherSource ? 0 : null
      },
      gpuPresentationTiming: this.gpuPresentationTiming.diagnostics(this.map?.painter?.context?.gl),
      lifecycle: { ...this.lifecycleDiagnostics }
    };
  }

  render(gl, args) {
    if (!this.active) return;
    if (this.gpuWeatherMode && !this.transition && isGpuWeatherLevel(this.levelData?.level) && this.gpuWeatherSource) {
      this.renderGpuWeather(gl, args.shaderData, args.defaultProjectionData);
      return;
    }
    if (!this.temporal) return;
    this.uploadBuffers(gl);
    const activeLayout = this.instanceLayouts[this.transition ? this.transition.fromGroup : this.stableGroup];
    if (this.transition && this.instanceLayouts[this.transition.toGroup] !== activeLayout) throw new Error('Squares transition groups must use one mapped layout.');
    const entry = this.programFor(gl, args.shaderData, activeLayout);
    gl.enable(gl.BLEND); gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA); gl.enable(gl.DEPTH_TEST); gl.depthMask(false); gl.enable(gl.POLYGON_OFFSET_FILL); gl.polygonOffset(-1, -1);
    if (this.transition) {
      this.renderGroup(gl, entry, args.defaultProjectionData, this.transition.fromGroup, 1 - this.transitionProgress);
      this.renderGroup(gl, entry, args.defaultProjectionData, this.transition.toGroup, this.transitionProgress);
    } else this.renderGroup(gl, entry, args.defaultProjectionData, this.stableGroup, 1);
    gl.disable(gl.POLYGON_OFFSET_FILL); gl.depthMask(true);
  }
}
