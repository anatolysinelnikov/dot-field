import { RAIN_MODERATE_MAX } from './config.js';
import { prepareGeographicFieldFrame, geographicPreparedIntensityAtXY, geographicToSynthetic } from './geography.js';
import { geographicTemporalFrameAt, setGeographicProjection, TEMPORAL_FRAME_COUNT } from './geographic-layer-utils.js';
import { MAX_DISPLAY_GRID_LEVEL, MAX_GRID_LEVEL, MIN_GRID_LEVEL, selectMercatorGridSamples } from './geographic-lod.js';

const REFERENCE_GRID_LEVEL = 13;
const INSTANCE_STRIDE = 8;
const CELL_VERTICES = new Float32Array([-0.5, -0.5, 0.5, -0.5, 0.5, 0.5, -0.5, -0.5, 0.5, 0.5, -0.5, 0.5]);

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
    'in vec2 a_vertex;\nin vec2 a_center;\nin vec3 a_values0;\nin vec3 a_values1;\nuniform float u_temporalProgress;\nuniform float u_spacing;\nout vec3 v_values;\nvoid main() {\n  v_values = mix(a_values0, a_values1, u_temporalProgress);\n  gl_Position = projectTile(a_center + a_vertex * u_spacing);\n}'
  ].join('\n');
  const fragmentSource = [
    '#version 300 es', 'precision highp float;', 'in vec3 v_values;\nuniform float u_opacity;\nout vec4 fragColor;',
    `float strength(float value, float threshold) { return smoothstep(threshold * 0.45, 0.93, value); }
void main() {
  float rain = strength(v_values.x, 0.045);
  float strong = smoothstep(${RAIN_MODERATE_MAX.toFixed(3)}, 0.9, v_values.x);
  vec3 color = mix(vec3(0.0, 0.565, 1.0), vec3(0.0, 0.0, 1.0), strong);
  float alpha = rain;
  float storm = strength(v_values.y, 0.075);
  if (storm > 0.0) { color = mix(color, vec3(1.0, 0.0, 1.0), mix(0.45, 1.0, pow(storm, 0.47))); alpha = max(alpha, storm); }
  float hail = strength(v_values.z, 0.11);
  if (hail > 0.0) { color = mix(color, vec3(1.0, 0.831, 0.0), mix(0.5, 1.0, pow(hail, 0.47))); alpha = max(alpha, hail); }
  fragColor = vec4(color, alpha * u_opacity);
}`
  ].join('\n');
  const program = gl.createProgram();
  gl.attachShader(program, compileShader(gl, gl.VERTEX_SHADER, vertexSource));
  gl.attachShader(program, compileShader(gl, gl.FRAGMENT_SHADER, fragmentSource));
  gl.linkProgram(program);
  if (!gl.getProgramParameter(program, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(program) || 'Square weather shader linking failed.');
  const names = ['a_vertex', 'a_center', 'a_values0', 'a_values1', 'u_temporalProgress', 'u_spacing', 'u_opacity', 'u_matrix', 'u_projection_fallback_matrix', 'u_projection_matrix', 'u_projection_tile_mercator_coords', 'u_projection_clipping_plane', 'u_projection_transition'];
  return { program, locations: Object.fromEntries(names.map((name) => [name, name.startsWith('a_') ? gl.getAttribLocation(program, name) : gl.getUniformLocation(program, name)])) };
}

function makeState(length, reusable) {
  if (reusable?.rain.length === length) return reusable;
  return { rain: new Float32Array(length), storm: new Float32Array(length), hail: new Float32Array(length) };
}

function parentIdFor(sample, bounds, parentStep) {
  const canonicalX = Math.max(bounds.minX, Math.min(bounds.maxX, Math.floor(sample.canonicalX / parentStep) * parentStep));
  const canonicalY = Math.max(bounds.minY, Math.min(bounds.maxY, Math.floor(sample.canonicalY / parentStep) * parentStep));
  return `${canonicalX}:${canonicalY}`;
}

class GeographicSquarePyramid {
  constructor() {
    this.levels = new Map();
    for (let level = MIN_GRID_LEVEL; level <= MAX_DISPLAY_GRID_LEVEL; level++) {
      const { samples } = selectMercatorGridSamples(level);
      const fieldPoints = level >= REFERENCE_GRID_LEVEL ? new Float32Array(samples.length * 2) : null;
      for (let index = 0; fieldPoints && index < samples.length; index++) {
        const point = geographicToSynthetic(...samples[index].lngLat);
        fieldPoints[index * 2] = point.x;
        fieldPoints[index * 2 + 1] = point.y;
      }
      this.levels.set(level, { samples, fieldPoints, children: null });
    }
    for (let level = REFERENCE_GRID_LEVEL - 1; level >= MIN_GRID_LEVEL; level--) {
      const coarse = this.levels.get(level);
      const fine = this.levels.get(level + 1);
      const byId = new Map(coarse.samples.map((sample, index) => [sample.id, index]));
      const bounds = { minX: coarse.samples[0].canonicalX, maxX: coarse.samples[coarse.samples.length - 1].canonicalX, minY: coarse.samples[0].canonicalY, maxY: coarse.samples[coarse.samples.length - 1].canonicalY };
      const step = 2 ** (MAX_GRID_LEVEL - level);
      coarse.children = Array.from({ length: coarse.samples.length }, () => []);
      for (let index = 0; index < fine.samples.length; index++) {
        const parent = byId.get(parentIdFor(fine.samples[index], bounds, step));
        if (parent === undefined) throw new Error('Square sample has no deterministic parent.');
        coarse.children[parent].push(index);
      }
    }
  }

  evaluate(levels, frame, reusable = null) {
    const states = new Array(MAX_DISPLAY_GRID_LEVEL + 1);
    const requested = new Set(levels);
    const wantsReduced = levels.some((level) => level <= REFERENCE_GRID_LEVEL);
    if (wantsReduced) {
      const reference = this.levels.get(REFERENCE_GRID_LEVEL);
      const direct = makeState(reference.samples.length, reusable?.[REFERENCE_GRID_LEVEL]);
      const value = { rain: 0, storm: 0, hail: 0 };
      for (let index = 0; index < reference.samples.length; index++) {
        geographicPreparedIntensityAtXY(frame, reference.fieldPoints[index * 2], reference.fieldPoints[index * 2 + 1], value);
        direct.rain[index] = value.rain; direct.storm[index] = value.storm; direct.hail[index] = value.hail;
      }
      states[REFERENCE_GRID_LEVEL] = direct;
      const minimum = Math.min(...levels.filter((level) => level <= REFERENCE_GRID_LEVEL));
      let children = direct;
      for (let level = REFERENCE_GRID_LEVEL - 1; level >= minimum; level--) {
        const parent = this.levels.get(level);
        const state = makeState(parent.samples.length, reusable?.[level]);
        for (let parentIndex = 0; parentIndex < parent.samples.length; parentIndex++) {
          const indices = parent.children[parentIndex];
          let rain = 0, storm = 0, hail = 0, stormMax = 0, hailMax = 0;
          for (const child of indices) {
            rain += children.rain[child]; storm += children.storm[child]; hail += children.hail[child];
            stormMax = Math.max(stormMax, children.storm[child]); hailMax = Math.max(hailMax, children.hail[child]);
          }
          state.rain[parentIndex] = rain / indices.length;
          state.storm[parentIndex] = (storm / indices.length) * 0.42 + stormMax * 0.58;
          state.hail[parentIndex] = (hail / indices.length) * 0.28 + hailMax * 0.72;
        }
        states[level] = state;
        children = state;
      }
    }
    for (const level of requested) {
      if (level <= REFERENCE_GRID_LEVEL) continue;
      const entry = this.levels.get(level);
      const state = makeState(entry.samples.length, reusable?.[level]);
      const value = { rain: 0, storm: 0, hail: 0 };
      for (let index = 0; index < entry.samples.length; index++) {
        geographicPreparedIntensityAtXY(frame, entry.fieldPoints[index * 2], entry.fieldPoints[index * 2 + 1], value);
        state.rain[index] = value.rain; state.storm[index] = value.storm; state.hail[index] = value.hail;
      }
      states[level] = state;
    }
    return states;
  }
}

export class GeographicSquaresLayer {
  constructor() {
    this.id = 'geographic-weather-squares';
    this.type = 'custom';
    this.renderingMode = '3d';
    this.active = false;
    this.pyramid = new GeographicSquarePyramid();
    this.samples = [];
    this.transition = null;
    this.transitionProgress = 1;
    this.temporal = null;
    this.temporalProgress = 0;
    this.instanceData = [new Float32Array(), new Float32Array()];
    this.instanceCounts = [0, 0];
    this.instanceBufferCapacity = [0, 0];
    this.instancesDirty = true;
    this.programs = new Map();
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

  setActive(active) { this.active = active; this.map?.triggerRepaint(); }

  activeLevels() {
    if (this.transition) return [this.transition.fromSamples[0].level, this.transition.toSamples[0].level];
    return this.samples.length ? [this.samples[0].level] : [];
  }

  rebuildTemporal(time) {
    const frame = geographicTemporalFrameAt(time);
    const nextIndex = (frame.index + 1) % TEMPORAL_FRAME_COUNT;
    this.temporal = { index: frame.index, nextIndex, frames0: this.pyramid.evaluate(this.activeLevels(), prepareGeographicFieldFrame(frame.index / TEMPORAL_FRAME_COUNT)), frames1: this.pyramid.evaluate(this.activeLevels(), prepareGeographicFieldFrame(nextIndex / TEMPORAL_FRAME_COUNT)) };
    this.temporalProgress = frame.progress;
    this.rebuildInstances();
  }

  setSamples(samples, time) { this.samples = samples; this.transition = null; if (this.active) this.rebuildTemporal(time); else this.temporal = null; }
  setTransition(fromSamples, toSamples, time, progress = 0) { this.samples = toSamples; this.transition = { fromSamples, toSamples }; this.transitionProgress = progress; if (this.active) this.rebuildTemporal(time); else this.temporal = null; }
  setTransitionProgress(progress) { this.transitionProgress = progress; if (this.active) this.map?.triggerRepaint(); }

  buildGroup(group, level, state0, state1) {
    const samples = this.pyramid.levels.get(level).samples;
    const length = samples.length * INSTANCE_STRIDE;
    let result = this.instanceData[group];
    if (result.length < length) result = new Float32Array(Math.max(length, result.length * 2, INSTANCE_STRIDE * 256));
    for (let index = 0, offset = 0; index < samples.length; index++, offset += INSTANCE_STRIDE) {
      result[offset] = samples[index].mercator[0]; result[offset + 1] = samples[index].mercator[1];
      result[offset + 2] = state0.rain[index]; result[offset + 3] = state0.storm[index]; result[offset + 4] = state0.hail[index];
      result[offset + 5] = state1.rain[index]; result[offset + 6] = state1.storm[index]; result[offset + 7] = state1.hail[index];
    }
    this.instanceData[group] = result;
    this.instanceCounts[group] = samples.length;
  }

  rebuildInstances() {
    if (!this.temporal || !this.samples.length) return;
    const levels = this.transition ? [this.transition.fromSamples[0].level, this.transition.toSamples[0].level] : [this.samples[0].level];
    for (let index = 0; index < levels.length; index++) {
      this.buildGroup(index, levels[index], this.temporal.frames0[levels[index]], this.temporal.frames1[levels[index]]);
    }
    if (levels.length === 1) this.instanceCounts[1] = 0;
    this.instancesDirty = true;
    this.map?.triggerRepaint();
  }

  updateWeather(time) {
    if (!this.samples.length) return;
    const frame = geographicTemporalFrameAt(time);
    if (!this.temporal || frame.index !== this.temporal.index) {
      if (this.temporal && frame.index === this.temporal.nextIndex) {
        const reusable = this.temporal.frames0;
        this.temporal.index = frame.index; this.temporal.nextIndex = (frame.index + 1) % TEMPORAL_FRAME_COUNT;
        this.temporal.frames0 = this.temporal.frames1;
        this.temporal.frames1 = this.pyramid.evaluate(this.activeLevels(), prepareGeographicFieldFrame(this.temporal.nextIndex / TEMPORAL_FRAME_COUNT), reusable);
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
    const level = this.transition ? (group === 0 ? this.transition.fromSamples[0].level : this.transition.toSamples[0].level) : this.samples[0].level;
    gl.uniform1f(locations.u_spacing, 1 / 2 ** level);
    gl.uniform1f(locations.u_opacity, opacity);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.vertexBuffer);
    gl.enableVertexAttribArray(locations.a_vertex);
    gl.vertexAttribPointer(locations.a_vertex, 2, gl.FLOAT, false, 0, 0);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.instanceBuffers[group]);
    gl.enableVertexAttribArray(locations.a_center);
    gl.vertexAttribPointer(locations.a_center, 2, gl.FLOAT, false, INSTANCE_STRIDE * 4, 0); gl.vertexAttribDivisor(locations.a_center, 1);
    gl.enableVertexAttribArray(locations.a_values0);
    gl.vertexAttribPointer(locations.a_values0, 3, gl.FLOAT, false, INSTANCE_STRIDE * 4, 8); gl.vertexAttribDivisor(locations.a_values0, 1);
    gl.enableVertexAttribArray(locations.a_values1);
    gl.vertexAttribPointer(locations.a_values1, 3, gl.FLOAT, false, INSTANCE_STRIDE * 4, 20); gl.vertexAttribDivisor(locations.a_values1, 1);
    gl.drawArraysInstanced(gl.TRIANGLES, 0, 6, this.instanceCounts[group]);
    for (const location of [locations.a_center, locations.a_values0, locations.a_values1]) gl.vertexAttribDivisor(location, 0);
  }

  render(gl, args) {
    if (!this.active || !this.temporal) return;
    if (this.instancesDirty) {
      for (let index = 0; index < 2; index++) {
        gl.bindBuffer(gl.ARRAY_BUFFER, this.instanceBuffers[index]);
        const byteLength = this.instanceCounts[index] * INSTANCE_STRIDE * Float32Array.BYTES_PER_ELEMENT;
        if (byteLength > this.instanceBufferCapacity[index]) {
          gl.bufferData(gl.ARRAY_BUFFER, byteLength, gl.DYNAMIC_DRAW);
          this.instanceBufferCapacity[index] = byteLength;
        }
        if (byteLength) gl.bufferSubData(gl.ARRAY_BUFFER, 0, this.instanceData[index].subarray(0, this.instanceCounts[index] * INSTANCE_STRIDE));
      }
      this.instancesDirty = false;
    }
    const entry = this.programFor(gl, args.shaderData);
    gl.enable(gl.BLEND); gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA); gl.enable(gl.DEPTH_TEST); gl.depthMask(false); gl.enable(gl.POLYGON_OFFSET_FILL); gl.polygonOffset(-1, -1);
    if (this.transition) { this.renderGroup(gl, entry, args.defaultProjectionData, 0, 1 - this.transitionProgress); this.renderGroup(gl, entry, args.defaultProjectionData, 1, this.transitionProgress); }
    else this.renderGroup(gl, entry, args.defaultProjectionData, 0, 1);
    gl.disable(gl.POLYGON_OFFSET_FILL); gl.depthMask(true);
  }
}
