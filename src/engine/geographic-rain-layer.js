import { prepareGeographicFieldFrame, geographicPreparedIntensityAt, geographicToSynthetic } from './geography.js';
import { setGeographicProjection } from './geographic-layer-utils.js';
import { GeographicSymbolPyramid } from './geographic-symbol-pyramid.js';
import { smoothstep } from './math.js';

// Metres. MapLibre 5.24's projectTileFor3D accepts this altitude directly and
// turns it into a radial Globe offset, so the cloud base follows the Earth.
const COLUMN_BOTTOM_METRES = 180;
const COLUMN_TOP_METRES = 10000;
const L14_SPACING = 1 / (2 ** 14);
const RAIN_DROPLETS_PER_L14_CELL = 1.7;
const MAX_DROPLETS_PER_SAMPLE = 512;
const CELL_FOOTPRINT = 0.9;
const PLASTIC_RATIO = 1.3247179572447458;
const INSTANCE_STRIDE = 8;
const INSTANCE_BYTES = INSTANCE_STRIDE * Float32Array.BYTES_PER_ELEMENT;
const FLAT_INSTANCE_STRIDE = 4;
const FLAT_INSTANCE_BYTES = FLAT_INSTANCE_STRIDE * Float32Array.BYTES_PER_ELEMENT;
const FLAT_TYPES = ['rain', 'strong'];
const FLAT_COLORS = { rain: [0, 0.565, 1, 1], strong: [0, 0, 1, 1] };
const QUAD = new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]);

function hashUnit(canonicalX, canonicalY, slot, salt) {
  let value = (canonicalX * 73856093) ^ (canonicalY * 19349663) ^ (slot * 83492791) ^ salt;
  value = Math.imul(value ^ (value >>> 16), 2246822519);
  value = Math.imul(value ^ (value >>> 13), 3266489917);
  return ((value ^ (value >>> 16)) >>> 0) / 4294967296;
}

function fract(value) { return value - Math.floor(value); }

function dropletCount(sample, strength) {
  const areaScale = (sample.spacing / L14_SPACING) ** 2;
  const expected = strength * RAIN_DROPLETS_PER_L14_CELL * areaScale;
  const whole = Math.floor(expected);
  const fractional = expected - whole;
  const extra = hashUnit(sample.canonicalX, sample.canonicalY, 0, 0x7f4a7c15) < fractional ? 1 : 0;
  return Math.min(MAX_DROPLETS_PER_SAMPLE, whole + extra);
}

function lowDiscrepancyCellPosition(sample, slot) {
  const start = Math.floor(hashUnit(sample.canonicalX, sample.canonicalY, 0, 0x94d049bb) * 8192);
  const index = start + slot + 1;
  // R2 sequence with a per-cell Cranley-Patterson shift avoids a repeated
  // miniature pattern while keeping candidates evenly distributed.
  const x = fract(index / PLASTIC_RATIO + hashUnit(sample.canonicalX, sample.canonicalY, 0, 0x2545f491));
  const y = fract(index / (PLASTIC_RATIO * PLASTIC_RATIO) + hashUnit(sample.canonicalX, sample.canonicalY, 0, 0x369dea0f));
  return [0.5 + (x - 0.5) * CELL_FOOTPRINT, 0.5 + (y - 0.5) * CELL_FOOTPRINT];
}

function gridDimensions(samples) {
  let columns = 1;
  while (columns < samples.length && samples[columns].canonicalY === samples[0].canonicalY) columns++;
  return { columns, rows: samples.length / columns };
}

function bilinear(topLeft, topRight, bottomLeft, bottomRight, u, v) {
  return topLeft * (1 - u) * (1 - v)
    + topRight * u * (1 - v)
    + bottomLeft * (1 - u) * v
    + bottomRight * u * v;
}

function compileShader(gl, type, source) {
  const shader = gl.createShader(type);
  gl.shaderSource(shader, source);
  gl.compileShader(shader);
  if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(shader) || '3D rain shader compilation failed.');
  return shader;
}

function makeStreakProgram(gl, shaderData) {
  const vertexSource = [
    '#version 300 es', shaderData.vertexShaderPrelude, shaderData.define,
    `in vec2 a_vertex;\nin vec2 a_center;\nin float a_phase;\nin float a_length;\nin float a_width;\nin float a_opacity;\nin float a_speedFactor;\nin float a_topOpacity;\nuniform vec2 u_pixelsToClip;\nuniform float u_transitionOpacity;\nuniform float u_fallingCycles;\nout vec2 v_local;\nout float v_opacity;\nout float v_topOpacity;\nvoid main() {\n  float verticalPhase = fract(a_phase - u_fallingCycles * a_speedFactor);\n  float altitude = ${COLUMN_BOTTOM_METRES}.0 + verticalPhase * (${COLUMN_TOP_METRES - COLUMN_BOTTOM_METRES}.0 - a_length);\n  vec4 lower = projectTileFor3D(a_center, altitude);\n  vec4 upper = projectTileFor3D(a_center, altitude + a_length);\n  vec2 lowerNdc = lower.xy / lower.w;\n  vec2 upperNdc = upper.xy / upper.w;\n  vec2 direction = upperNdc - lowerNdc;\n  float directionLength = length(direction);\n  vec2 side = directionLength > 0.000001 ? vec2(-direction.y, direction.x) / directionLength : vec2(1.0, 0.0);\n  float along = (a_vertex.y + 1.0) * 0.5;\n  vec4 point = mix(lower, upper, along);\n  vec2 ndc = mix(lowerNdc, upperNdc, along) + side * a_vertex.x * a_width * u_pixelsToClip;\n  gl_Position = vec4(ndc * point.w, point.z, point.w);\n  v_local = a_vertex;\n  v_opacity = a_opacity * u_transitionOpacity;\n  v_topOpacity = a_topOpacity;\n}`
  ].join('\n');
  const fragmentSource = [
    '#version 300 es', 'precision highp float;', 'in vec2 v_local;\nin float v_opacity;\nin float v_topOpacity;\nout vec4 fragColor;',
    'void main() {\n  vec2 q = abs(v_local) - vec2(0.72, 0.72);\n  float distanceToCapsule = length(max(q, 0.0)) - 0.28;\n  float edge = max(fwidth(distanceToCapsule), 0.012);\n  float alpha = 1.0 - smoothstep(-edge, edge, distanceToCapsule);\n  float trailOpacity = mix(1.0, v_topOpacity, smoothstep(-1.0, 1.0, v_local.y));\n  fragColor = vec4(0.20, 0.66, 1.0, alpha * trailOpacity * v_opacity);\n}'
  ].join('\n');
  const program = gl.createProgram();
  gl.attachShader(program, compileShader(gl, gl.VERTEX_SHADER, vertexSource));
  gl.attachShader(program, compileShader(gl, gl.FRAGMENT_SHADER, fragmentSource));
  gl.linkProgram(program);
  if (!gl.getProgramParameter(program, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(program) || '3D rain shader linking failed.');
  return {
    program,
    locations: Object.fromEntries(['a_vertex', 'a_center', 'a_phase', 'a_length', 'a_width', 'a_opacity', 'a_speedFactor', 'a_topOpacity', 'u_pixelsToClip', 'u_transitionOpacity', 'u_fallingCycles', 'u_matrix', 'u_projection_fallback_matrix', 'u_projection_matrix', 'u_projection_tile_mercator_coords', 'u_projection_clipping_plane', 'u_projection_transition'].map((name) => [name, name.startsWith('a_') ? gl.getAttribLocation(program, name) : gl.getUniformLocation(program, name)]))
  };
}

function makeFlatProgram(gl, shaderData) {
  const vertexSource = [
    '#version 300 es', shaderData.vertexShaderPrelude, shaderData.define,
    'in vec2 a_vertex;\nin vec2 a_center;\nin float a_radius;\nin float a_opacity;\nout vec2 v_local;\nout float v_opacity;\nuniform float u_transitionOpacity;\nvoid main() {\n  gl_Position = projectTile(a_center + a_vertex * a_radius);\n  v_local = a_vertex;\n  v_opacity = a_opacity * u_transitionOpacity;\n}'
  ].join('\n');
  const fragmentSource = [
    '#version 300 es', 'precision highp float;', 'in vec2 v_local;\nin float v_opacity;\nuniform vec4 u_color;\nout vec4 fragColor;',
    'void main() {\n  float distanceToCenter = length(v_local);\n  float edge = fwidth(distanceToCenter);\n  float alpha = 1.0 - smoothstep(1.0 - edge, 1.0 + edge, distanceToCenter);\n  fragColor = vec4(u_color.rgb, u_color.a * alpha * v_opacity);\n}'
  ].join('\n');
  const program = gl.createProgram();
  gl.attachShader(program, compileShader(gl, gl.VERTEX_SHADER, vertexSource));
  gl.attachShader(program, compileShader(gl, gl.FRAGMENT_SHADER, fragmentSource));
  gl.linkProgram(program);
  if (!gl.getProgramParameter(program, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(program) || 'Flat rain shader linking failed.');
  return {
    program,
    locations: Object.fromEntries(['a_vertex', 'a_center', 'a_radius', 'a_opacity', 'u_color', 'u_transitionOpacity', 'u_matrix', 'u_projection_fallback_matrix', 'u_projection_matrix', 'u_projection_tile_mercator_coords', 'u_projection_clipping_plane', 'u_projection_transition'].map((name) => [name, name.startsWith('a_') ? gl.getAttribLocation(program, name) : gl.getUniformLocation(program, name)]))
  };
}

class InstanceWriter {
  constructor() { this.values = new Float32Array(); this.length = 0; }
  reset() { this.length = 0; }
  push(centerX, centerY, phase, length, width, opacity, speedFactor, topOpacity) {
    const next = this.length + INSTANCE_STRIDE;
    if (next > this.values.length) {
      const values = new Float32Array(Math.max(next, this.values.length * 2, 1024));
      values.set(this.values);
      this.values = values;
    }
    this.values.set([centerX, centerY, phase, length, width, opacity, speedFactor, topOpacity], this.length);
    this.length = next;
  }
  finish() { return this.values.subarray(0, this.length); }
}

class FlatInstanceWriter {
  constructor() { this.values = new Float32Array(); this.length = 0; }
  reset() { this.length = 0; }
  push(centerX, centerY, radius, opacity) {
    const next = this.length + FLAT_INSTANCE_STRIDE;
    if (next > this.values.length) {
      const values = new Float32Array(Math.max(next, this.values.length * 2, 256));
      values.set(this.values);
      this.values = values;
    }
    this.values.set([centerX, centerY, radius, opacity], this.length);
    this.length = next;
  }
  finish() { return this.values.subarray(0, this.length); }
}

function isFlatLevel(samples) { return samples.length && samples[0].level <= 12; }

export class GeographicRainLayer {
  constructor() {
    this.id = 'geographic-3d-rain';
    this.type = 'custom';
    this.renderingMode = '3d';
    this.samples = [];
    this.transition = null;
    this.transitionProgress = 1;
    this.writer = new InstanceWriter();
    this.flatWriters = Object.fromEntries(FLAT_TYPES.map((type) => [type, new FlatInstanceWriter()]));
    this.flatPyramid = new GeographicSymbolPyramid();
    this.streakInstances = { current: new Float32Array(), from: new Float32Array(), to: new Float32Array() };
    this.flatInstances = Object.fromEntries(FLAT_TYPES.map((type) => [type, { current: new Float32Array(), from: new Float32Array(), to: new Float32Array() }]));
    this.streakCounts = { current: 0, from: 0, to: 0 };
    this.flatCounts = Object.fromEntries(FLAT_TYPES.map((type) => [type, { current: 0, from: 0, to: 0 }]));
    this.streakBufferCapacity = { current: 0, from: 0, to: 0 };
    this.flatBufferCapacity = Object.fromEntries(FLAT_TYPES.map((type) => [type, { current: 0, from: 0, to: 0 }]));
    this.buffersDirty = true;
    this.fixedFrame = null;
    this.fallingCycles = 0;
  }

  onAdd(map, gl) {
    this.map = map;
    this.quadBuffer = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, this.quadBuffer);
    gl.bufferData(gl.ARRAY_BUFFER, QUAD, gl.STATIC_DRAW);
    this.streakBuffers = Object.fromEntries(Object.keys(this.streakInstances).map((key) => [key, gl.createBuffer()]));
    this.flatBuffers = Object.fromEntries(FLAT_TYPES.map((type) => [type, Object.fromEntries(['current', 'from', 'to'].map((key) => [key, gl.createBuffer()]))]));
  }

  onRemove(map, gl) {
    if (this.programs) for (const entry of this.programs.values()) { gl.deleteProgram(entry.streak.program); gl.deleteProgram(entry.flat.program); }
    const flatBuffers = FLAT_TYPES.flatMap((type) => Object.values(this.flatBuffers?.[type] || {}));
    for (const buffer of [...Object.values(this.streakBuffers || {}), ...flatBuffers, this.quadBuffer]) if (buffer) gl.deleteBuffer(buffer);
  }

  setFixedWeatherTime(time) { this.fixedFrame = prepareGeographicFieldFrame(time); }

  setSamples(samples) {
    this.samples = samples;
    this.transition = null;
    if (isFlatLevel(samples)) this.setFlatInstances('current', this.buildFlatInstances(samples));
    else this.setStreakInstances('current', this.buildInstances(samples));
    this.buffersDirty = true;
    this.map?.triggerRepaint();
  }

  setTransition(fromSamples, toSamples, progress = 0) {
    this.samples = toSamples;
    this.transition = { fromSamples, toSamples };
    this.transitionProgress = progress;
    if (isFlatLevel(fromSamples)) this.setFlatInstances('from', this.buildFlatInstances(fromSamples));
    else this.setStreakInstances('from', this.buildInstances(fromSamples));
    if (isFlatLevel(toSamples)) this.setFlatInstances('to', this.buildFlatInstances(toSamples));
    else this.setStreakInstances('to', this.buildInstances(toSamples));
    this.buffersDirty = true;
    this.map?.triggerRepaint();
  }

  setTransitionProgress(progress) { this.transitionProgress = progress; this.map?.triggerRepaint(); }
  setFallingCycles(cycles) { this.fallingCycles = cycles; this.map?.triggerRepaint(); }

  setStreakInstances(key, instances) {
    this.streakInstances[key] = instances;
    this.streakCounts[key] = instances.length / INSTANCE_STRIDE;
    for (const type of FLAT_TYPES) { this.flatInstances[type][key] = new Float32Array(); this.flatCounts[type][key] = 0; }
  }

  setFlatInstances(key, instances) {
    for (const type of FLAT_TYPES) {
      this.flatInstances[type][key] = instances[type];
      this.flatCounts[type][key] = instances[type].length / FLAT_INSTANCE_STRIDE;
    }
    this.streakInstances[key] = new Float32Array();
    this.streakCounts[key] = 0;
  }

  buildInstances(samples) {
    if (!this.fixedFrame || !samples.length) return new Float32Array();
    const value = { rain: 0, storm: 0, hail: 0 };
    const rain = new Float32Array(samples.length);
    for (let index = 0; index < samples.length; index++) {
      const point = geographicToSynthetic(...samples[index].lngLat);
      geographicPreparedIntensityAt(this.fixedFrame, point, value);
      rain[index] = value.rain;
    }
    const { columns, rows } = gridDimensions(samples);
    this.writer.reset();
    for (let row = 0; row < rows - 1; row++) {
      for (let column = 0; column < columns - 1; column++) {
        const topLeftIndex = row * columns + column;
        const sample = samples[topLeftIndex];
        const rain00 = rain[topLeftIndex];
        const rain10 = rain[topLeftIndex + 1];
        const rain01 = rain[topLeftIndex + columns];
        const rain11 = rain[topLeftIndex + columns + 1];
        const averageStrength = smoothstep(0.035, 0.90, (rain00 + rain10 + rain01 + rain11) * 0.25);
        if (averageStrength <= 0) continue;
        const count = dropletCount(sample, averageStrength);
        for (let slot = 0; slot < count; slot++) {
          const [u, v] = lowDiscrepancyCellPosition(sample, slot);
          const localRain = bilinear(rain00, rain10, rain01, rain11, u, v);
          const strength = smoothstep(0.035, 0.90, localRain);
          if (strength <= 0) continue;
          const selector = hashUnit(sample.canonicalX, sample.canonicalY, slot, 0x9e3779b9);
          if (selector > Math.min(1, strength / averageStrength)) continue;
          const phase = hashUnit(sample.canonicalX, sample.canonicalY, slot, 0x85ebca6b);
          const variation = hashUnit(sample.canonicalX, sample.canonicalY, slot, 0xc2b2ae35);
          const opacityVariation = hashUnit(sample.canonicalX, sample.canonicalY, slot, 0x27d4eb2f);
          const speedFactor = 0.85 + hashUnit(sample.canonicalX, sample.canonicalY, slot, 0x165667b1) * 0.3;
          const topOpacity = hashUnit(sample.canonicalX, sample.canonicalY, slot, 0xd3a2646c) * 0.2;
          // The field is cached only at shared grid corners. This position is a
          // stable low-discrepancy candidate inside the reconstructed cell.
          const scatterX = u * sample.spacing;
          const scatterY = v * sample.spacing;
          const length = 145 + strength * 370 + variation * 95;
          const width = 0.85 + strength * 1.35 + variation * 0.3;
          const opacity = (0.24 + strength * 0.58) * (0.78 + opacityVariation * 0.22);
          this.writer.push(sample.mercator[0] + scatterX, sample.mercator[1] + scatterY, phase, length, width, opacity, speedFactor, topOpacity);
        }
      }
    }
    return this.writer.finish();
  }

  buildFlatInstances(samples) {
    const empty = Object.fromEntries(FLAT_TYPES.map((type) => [type, new Float32Array()]));
    if (!this.fixedFrame || !samples.length) return empty;
    const level = samples[0].level;
    const state = this.flatPyramid.evaluate([level], this.fixedFrame)[level];
    const anchors = this.flatPyramid.levels.get(level).anchors;
    for (const type of FLAT_TYPES) this.flatWriters[type].reset();
    for (let index = 0; index < samples.length; index++) {
      const anchorIndex = index * 2;
      for (const [type, radiusKey] of [['rain', 'rainRadius'], ['strong', 'strongRadius']]) {
        const radius = state[radiusKey][index];
        if (radius > 0) this.flatWriters[type].push(anchors[anchorIndex], anchors[anchorIndex + 1], radius, 1);
      }
    }
    return Object.fromEntries(FLAT_TYPES.map((type) => [type, this.flatWriters[type].finish()]));
  }

  uploadBuffers(gl) {
    if (!this.buffersDirty) return;
    for (const key of Object.keys(this.streakInstances)) {
      const bytes = this.streakInstances[key].byteLength;
      gl.bindBuffer(gl.ARRAY_BUFFER, this.streakBuffers[key]);
      if (bytes > this.streakBufferCapacity[key]) {
        gl.bufferData(gl.ARRAY_BUFFER, bytes, gl.STATIC_DRAW);
        this.streakBufferCapacity[key] = bytes;
      }
      if (bytes) gl.bufferSubData(gl.ARRAY_BUFFER, 0, this.streakInstances[key]);
    }
    for (const type of FLAT_TYPES) for (const key of ['current', 'from', 'to']) {
      const bytes = this.flatInstances[type][key].byteLength;
      gl.bindBuffer(gl.ARRAY_BUFFER, this.flatBuffers[type][key]);
      if (bytes > this.flatBufferCapacity[type][key]) {
        gl.bufferData(gl.ARRAY_BUFFER, bytes, gl.STATIC_DRAW);
        this.flatBufferCapacity[type][key] = bytes;
      }
      if (bytes) gl.bufferSubData(gl.ARRAY_BUFFER, 0, this.flatInstances[type][key]);
    }
    this.buffersDirty = false;
  }

  renderStreakGroup(gl, entry, projection, key, opacity) {
    if (!this.streakCounts[key] || opacity <= 0) return;
    const { locations } = entry;
    gl.useProgram(entry.program);
    setGeographicProjection(gl, { matrix: locations.u_matrix, fallbackMatrix: locations.u_projection_fallback_matrix, projectionMatrix: locations.u_projection_matrix, tileMercatorCoords: locations.u_projection_tile_mercator_coords, clippingPlane: locations.u_projection_clipping_plane, projectionTransition: locations.u_projection_transition }, projection);
    gl.uniform2f(locations.u_pixelsToClip, 2 / gl.drawingBufferWidth, 2 / gl.drawingBufferHeight);
    gl.uniform1f(locations.u_transitionOpacity, opacity);
    gl.uniform1f(locations.u_fallingCycles, this.fallingCycles);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.quadBuffer);
    gl.enableVertexAttribArray(locations.a_vertex);
    gl.vertexAttribPointer(locations.a_vertex, 2, gl.FLOAT, false, 0, 0);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.streakBuffers[key]);
    for (const [location, size, offset] of [[locations.a_center, 2, 0], [locations.a_phase, 1, 8], [locations.a_length, 1, 12], [locations.a_width, 1, 16], [locations.a_opacity, 1, 20], [locations.a_speedFactor, 1, 24], [locations.a_topOpacity, 1, 28]]) {
      gl.enableVertexAttribArray(location);
      gl.vertexAttribPointer(location, size, gl.FLOAT, false, INSTANCE_BYTES, offset);
      gl.vertexAttribDivisor(location, 1);
    }
    gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
    gl.drawArraysInstanced(gl.TRIANGLE_STRIP, 0, 4, this.streakCounts[key]);
    for (const location of [locations.a_center, locations.a_phase, locations.a_length, locations.a_width, locations.a_opacity, locations.a_speedFactor, locations.a_topOpacity]) gl.vertexAttribDivisor(location, 0);
  }

  renderFlatGroup(gl, entry, projection, key, opacity) {
    if (opacity <= 0) return;
    const { locations } = entry;
    gl.useProgram(entry.program);
    setGeographicProjection(gl, { matrix: locations.u_matrix, fallbackMatrix: locations.u_projection_fallback_matrix, projectionMatrix: locations.u_projection_matrix, tileMercatorCoords: locations.u_projection_tile_mercator_coords, clippingPlane: locations.u_projection_clipping_plane, projectionTransition: locations.u_projection_transition }, projection);
    gl.uniform1f(locations.u_transitionOpacity, opacity);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.quadBuffer);
    gl.enableVertexAttribArray(locations.a_vertex);
    gl.vertexAttribPointer(locations.a_vertex, 2, gl.FLOAT, false, 0, 0);
    for (const type of FLAT_TYPES) {
      if (!this.flatCounts[type][key]) continue;
      gl.bindBuffer(gl.ARRAY_BUFFER, this.flatBuffers[type][key]);
      for (const [location, size, offset] of [[locations.a_center, 2, 0], [locations.a_radius, 1, 8], [locations.a_opacity, 1, 12]]) {
        gl.enableVertexAttribArray(location);
        gl.vertexAttribPointer(location, size, gl.FLOAT, false, FLAT_INSTANCE_BYTES, offset);
        gl.vertexAttribDivisor(location, 1);
      }
      gl.uniform4fv(locations.u_color, FLAT_COLORS[type]);
      gl.drawArraysInstanced(gl.TRIANGLE_STRIP, 0, 4, this.flatCounts[type][key]);
      for (const location of [locations.a_center, locations.a_radius, locations.a_opacity]) gl.vertexAttribDivisor(location, 0);
    }
  }

  render(gl, args) {
    this.uploadBuffers(gl);
    this.programs ||= new Map();
    let programs = this.programs.get(args.shaderData.variantName);
    if (!programs) {
      programs = { streak: makeStreakProgram(gl, args.shaderData), flat: makeFlatProgram(gl, args.shaderData) };
      this.programs.set(args.shaderData.variantName, programs);
    }
    gl.enable(gl.BLEND);
    gl.enable(gl.DEPTH_TEST);
    gl.depthMask(false);
    if (this.transition) {
      this.renderFlatGroup(gl, programs.flat, args.defaultProjectionData, 'from', 1 - this.transitionProgress);
      this.renderStreakGroup(gl, programs.streak, args.defaultProjectionData, 'from', 1 - this.transitionProgress);
      this.renderFlatGroup(gl, programs.flat, args.defaultProjectionData, 'to', this.transitionProgress);
      this.renderStreakGroup(gl, programs.streak, args.defaultProjectionData, 'to', this.transitionProgress);
    } else {
      this.renderFlatGroup(gl, programs.flat, args.defaultProjectionData, 'current', 1);
      this.renderStreakGroup(gl, programs.streak, args.defaultProjectionData, 'current', 1);
    }
    gl.depthMask(true);
  }
}
