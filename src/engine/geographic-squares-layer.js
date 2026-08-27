import { prepareGeographicFieldFrame } from './geography.js';
import { geographicTemporalFrameAt, setGeographicProjection, TEMPORAL_FRAME_COUNT } from './geographic-layer-utils.js';
import { GeographicWeatherPyramid, RAIN_COVERAGE_THRESHOLDS_MMH } from './geographic-weather-pyramid.js';
import { canonicalWindowsEqual, MAX_GRID_LEVEL, mercatorXForIndex, mercatorYForIndex } from './geographic-lod.js';
import { RAIN_VISIBILITY_SHADER, STRONG_RAIN_SHADER } from './precipitation-mapping.js';

const INSTANCE_STRIDE = 18;
const CELL_VERTICES = new Float32Array([-0.5, -0.5, 0.5, -0.5, 0.5, 0.5, -0.5, -0.5, 0.5, 0.5, -0.5, 0.5]);

function coverageIndex(threshold) {
  const index = RAIN_COVERAGE_THRESHOLDS_MMH.indexOf(threshold);
  if (index < 0) throw new Error(`Missing shared rain coverage threshold ${threshold}.`);
  return index;
}
const RAIN_COVERAGE_INDEX = coverageIndex(0.05);
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

function makeMappedState(length, reusable) {
  if (reusable?.rainWetMeanMmh?.length === length) return reusable;
  return {
    rainWetMeanMmh: new Float32Array(length), rainCoverage: new Float32Array(length),
    stormCoverage: new Float32Array(length), stormMeanSeverity: new Float32Array(length), stormMaxSeverity: new Float32Array(length),
    hailCoverage: new Float32Array(length), hailMeanSeverity: new Float32Array(length), hailMaxSeverity: new Float32Array(length)
  };
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
        state.stormCoverage[index] = 0;
        state.stormMeanSeverity[index] = 0;
        state.stormMaxSeverity[index] = 0;
        state.hailCoverage[index] = 0;
        state.hailMeanSeverity[index] = 0;
        state.hailMaxSeverity[index] = 0;
      }
    } else if (state.mappingInitialized) {
      state.rainWetMeanMmh.fill(0);
      state.rainCoverage.fill(0);
      state.stormCoverage.fill(0);
      state.stormMeanSeverity.fill(0);
      state.stormMaxSeverity.fill(0);
      state.hailCoverage.fill(0);
      state.hailMeanSeverity.fill(0);
      state.hailMaxSeverity.fill(0);
    }
  }
  state.potentialActiveIndices = activeIndices || null;
  state.mappingInitialized = true;
}

// Pure renderer mapping. Coverage remains separate from wet/positive severity.
export function mapSquaresWeatherSummary(summary, reusable = null) {
  const state = makeMappedState(summary.levelData.count, reusable);
  const activeIndices = summary.potentialActiveIndices;
  prepareMappedActiveSet(state, activeIndices);
  const count = activeIndices ? activeIndices.length : summary.levelData.count;
  for (let position = 0; position < count; position++) {
    const index = activeIndices ? activeIndices[position] : position;
    const total = summary.totalWeight[index];
    const rainWeight = summary.rainCoverageWeight[RAIN_COVERAGE_INDEX][index];
    const stormWeight = summary.stormCoverageWeight[index];
    const hailWeight = summary.hailCoverageWeight[index];
    state.rainCoverage[index] = total > 0 ? rainWeight / total : 0;
    state.rainWetMeanMmh[index] = rainWeight > 0 ? summary.rainWeightedSumMmh[index] / rainWeight : 0;
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

function makeProgram(gl, shaderData) {
  const vertexSource = [
    '#version 300 es', shaderData.vertexShaderPrelude, shaderData.define,
    'in vec2 a_vertex;\nin vec2 a_center;\nin vec4 a_values0;\nin vec4 a_values1;\nin vec4 a_hazards0;\nin vec4 a_hazards1;\nuniform float u_temporalProgress;\nuniform float u_spacing;\nout vec4 v_values;\nout vec4 v_hazards;\nvoid main() {\n  v_values = mix(a_values0, a_values1, u_temporalProgress);\n  v_hazards = mix(a_hazards0, a_hazards1, u_temporalProgress);\n  gl_Position = projectTile(a_center + a_vertex * u_spacing);\n}'
  ].join('\n');
  const fragmentSource = [
    '#version 300 es', 'precision highp float;', 'in vec4 v_values;\nin vec4 v_hazards;\nuniform float u_opacity;\nuniform float u_hazardsVisible;\nout vec4 fragColor;',
    `${RAIN_VISIBILITY_SHADER}
${STRONG_RAIN_SHADER}
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
}`
  ].join('\n');
  const program = gl.createProgram();
  gl.attachShader(program, compileShader(gl, gl.VERTEX_SHADER, vertexSource));
  gl.attachShader(program, compileShader(gl, gl.FRAGMENT_SHADER, fragmentSource));
  gl.linkProgram(program);
  if (!gl.getProgramParameter(program, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(program) || 'Square weather shader linking failed.');
  const names = ['a_vertex', 'a_center', 'a_values0', 'a_values1', 'a_hazards0', 'a_hazards1', 'u_temporalProgress', 'u_spacing', 'u_opacity', 'u_hazardsVisible', 'u_matrix', 'u_projection_fallback_matrix', 'u_projection_matrix', 'u_projection_tile_mercator_coords', 'u_projection_clipping_plane', 'u_projection_transition'];
  return { program, locations: Object.fromEntries(names.map((name) => [name, name.startsWith('a_') ? gl.getAttribLocation(program, name) : gl.getUniformLocation(program, name)])) };
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
    this.instanceData = [new Float32Array(), new Float32Array()];
    this.instanceCounts = [0, 0];
    this.instanceBufferCapacity = [0, 0];
    this.instanceDirty = [true, true];
    this.stableGroup = 0;
    this.programs = new Map();
    this.lifecycleDiagnostics = {
      evaluateKeyframeCalls: 0, weatherEvaluationMs: 0, mappingMs: 0,
      instanceRebuildCalls: 0, instanceRebuildMs: 0, preservedTopologyStates: 0
    };
  }

  onAdd(map, gl) {
    this.map = map;
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
      this.instanceCounts = [0, 0];
      this.instanceBufferCapacity = [0, 0];
      this.instanceDirty = [true, true];
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
    this.temporal = {
      index: frame.index, nextIndex,
      levels: new Map(levels.map((level) => [level, {
        frames0: this.evaluateKeyframe(level, frame.index),
        frames1: this.evaluateKeyframe(level, nextIndex)
      }]))
    };
    this.temporalProgress = frame.progress;
    this.rebuildInstances();
  }

  setLevelData(levelData, time) {
    const level = levelData?.level ?? null;
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

  buildGroup(group, level, state0, state1) {
    const levelData = this.weatherPyramid.topology.levels.get(level);
    const activeIndices = state0.potentialActiveIndices && state1.potentialActiveIndices
      && samePotentialActiveIndices(state0.potentialActiveIndices, state1.potentialActiveIndices)
      ? state0.potentialActiveIndices
      : null;
    const count = activeIndices ? activeIndices.length : levelData.count;
    const length = count * INSTANCE_STRIDE;
    let result = this.instanceData[group];
    if (result.length < length) result = new Float32Array(Math.max(length, result.length * 2, INSTANCE_STRIDE * 256));
    for (let position = 0, offset = 0; position < count; position++, offset += INSTANCE_STRIDE) {
      const index = activeIndices ? activeIndices[position] : position;
      result[offset] = mercatorXForIndex(levelData, index); result[offset + 1] = mercatorYForIndex(levelData, index);
      result[offset + 2] = state0.rainWetMeanMmh[index]; result[offset + 3] = state0.rainCoverage[index];
      result[offset + 4] = state0.stormCoverage[index]; result[offset + 5] = state0.stormMeanSeverity[index]; result[offset + 6] = state0.stormMaxSeverity[index];
      result[offset + 7] = state0.hailCoverage[index]; result[offset + 8] = state0.hailMeanSeverity[index]; result[offset + 9] = state0.hailMaxSeverity[index];
      result[offset + 10] = state1.rainWetMeanMmh[index]; result[offset + 11] = state1.rainCoverage[index];
      result[offset + 12] = state1.stormCoverage[index]; result[offset + 13] = state1.stormMeanSeverity[index]; result[offset + 14] = state1.stormMaxSeverity[index];
      result[offset + 15] = state1.hailCoverage[index]; result[offset + 16] = state1.hailMeanSeverity[index]; result[offset + 17] = state1.hailMaxSeverity[index];
    }
    this.instanceData[group] = result;
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
        for (const [level, temporalState] of this.temporal.levels) {
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

  programFor(gl, shaderData) {
    let entry = this.programs.get(shaderData.variantName);
    if (!entry) { entry = makeProgram(gl, shaderData); this.programs.set(shaderData.variantName, entry); }
    return entry;
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
    gl.uniform1f(locations.u_hazardsVisible, this.hazardsVisible ? 1 : 0);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.vertexBuffer);
    gl.enableVertexAttribArray(locations.a_vertex);
    gl.vertexAttribPointer(locations.a_vertex, 2, gl.FLOAT, false, 0, 0);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.instanceBuffers[group]);
    gl.enableVertexAttribArray(locations.a_center);
    gl.vertexAttribPointer(locations.a_center, 2, gl.FLOAT, false, INSTANCE_STRIDE * 4, 0); gl.vertexAttribDivisor(locations.a_center, 1);
    gl.enableVertexAttribArray(locations.a_values0);
    gl.vertexAttribPointer(locations.a_values0, 4, gl.FLOAT, false, INSTANCE_STRIDE * 4, 8); gl.vertexAttribDivisor(locations.a_values0, 1);
    gl.enableVertexAttribArray(locations.a_hazards0);
    gl.vertexAttribPointer(locations.a_hazards0, 4, gl.FLOAT, false, INSTANCE_STRIDE * 4, 24); gl.vertexAttribDivisor(locations.a_hazards0, 1);
    gl.enableVertexAttribArray(locations.a_values1);
    gl.vertexAttribPointer(locations.a_values1, 4, gl.FLOAT, false, INSTANCE_STRIDE * 4, 40); gl.vertexAttribDivisor(locations.a_values1, 1);
    gl.enableVertexAttribArray(locations.a_hazards1);
    gl.vertexAttribPointer(locations.a_hazards1, 4, gl.FLOAT, false, INSTANCE_STRIDE * 4, 56); gl.vertexAttribDivisor(locations.a_hazards1, 1);
    gl.drawArraysInstanced(gl.TRIANGLES, 0, 6, this.instanceCounts[group]);
    for (const location of [locations.a_center, locations.a_values0, locations.a_hazards0, locations.a_values1, locations.a_hazards1]) gl.vertexAttribDivisor(location, 0);
  }

  uploadBuffers(gl) {
    if (!this.instanceBuffers) return;
    for (let index = 0; index < 2; index++) {
      if (!this.instanceDirty[index]) continue;
      gl.bindBuffer(gl.ARRAY_BUFFER, this.instanceBuffers[index]);
      const byteLength = this.instanceCounts[index] * INSTANCE_STRIDE * Float32Array.BYTES_PER_ELEMENT;
      if (byteLength > this.instanceBufferCapacity[index]) {
        gl.bufferData(gl.ARRAY_BUFFER, byteLength, gl.DYNAMIC_DRAW);
        this.instanceBufferCapacity[index] = byteLength;
      }
      if (byteLength) gl.bufferSubData(gl.ARRAY_BUFFER, 0, this.instanceData[index].subarray(0, this.instanceCounts[index] * INSTANCE_STRIDE));
      this.instanceDirty[index] = false;
    }
  }

  render(gl, args) {
    if (!this.active || !this.temporal) return;
    this.uploadBuffers(gl);
    const entry = this.programFor(gl, args.shaderData);
    gl.enable(gl.BLEND); gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA); gl.enable(gl.DEPTH_TEST); gl.depthMask(false); gl.enable(gl.POLYGON_OFFSET_FILL); gl.polygonOffset(-1, -1);
    if (this.transition) {
      this.renderGroup(gl, entry, args.defaultProjectionData, this.transition.fromGroup, 1 - this.transitionProgress);
      this.renderGroup(gl, entry, args.defaultProjectionData, this.transition.toGroup, this.transitionProgress);
    } else this.renderGroup(gl, entry, args.defaultProjectionData, this.stableGroup, 1);
    gl.disable(gl.POLYGON_OFFSET_FILL); gl.depthMask(true);
  }
}
