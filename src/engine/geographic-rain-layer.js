import { prepareGeographicFieldFrame, geographicPreparedIntensityAt, geographicToSynthetic } from './geography.js';
import { setGeographicProjection } from './geographic-layer-utils.js';
import { smoothstep } from './math.js';

// Metres. MapLibre 5.24's projectTileFor3D accepts this altitude directly and
// turns it into a radial Globe offset, so the cloud base follows the Earth.
const COLUMN_BOTTOM_METRES = 180;
const COLUMN_TOP_METRES = 10000;
const SCATTER_FOOTPRINT = 0.72;
const SLOT_CAPACITY = Object.freeze({ 10: 24, 11: 24, 12: 24, 13: 12, 14: 4 });
const INSTANCE_STRIDE = 6;
const INSTANCE_BYTES = INSTANCE_STRIDE * Float32Array.BYTES_PER_ELEMENT;
const QUAD = new Float32Array([-1, -1, 1, -1, 1, 1, -1, -1, 1, 1, -1, 1]);

function hashUnit(canonicalX, canonicalY, slot, salt) {
  let value = (canonicalX * 73856093) ^ (canonicalY * 19349663) ^ (slot * 83492791) ^ salt;
  value = Math.imul(value ^ (value >>> 16), 2246822519);
  value = Math.imul(value ^ (value >>> 13), 3266489917);
  return ((value ^ (value >>> 16)) >>> 0) / 4294967296;
}

function compileShader(gl, type, source) {
  const shader = gl.createShader(type);
  gl.shaderSource(shader, source);
  gl.compileShader(shader);
  if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(shader) || '3D rain shader compilation failed.');
  return shader;
}

function makeProgram(gl, shaderData) {
  const vertexSource = [
    '#version 300 es', shaderData.vertexShaderPrelude, shaderData.define,
    'in vec2 a_vertex;\nin vec2 a_center;\nin float a_altitude;\nin float a_length;\nin float a_width;\nin float a_opacity;\nuniform vec2 u_pixelsToClip;\nuniform float u_transitionOpacity;\nout vec2 v_local;\nout float v_opacity;\nvoid main() {\n  vec4 lower = projectTileFor3D(a_center, a_altitude);\n  vec4 upper = projectTileFor3D(a_center, a_altitude + a_length);\n  vec2 lowerNdc = lower.xy / lower.w;\n  vec2 upperNdc = upper.xy / upper.w;\n  vec2 direction = upperNdc - lowerNdc;\n  float directionLength = length(direction);\n  vec2 side = directionLength > 0.000001 ? vec2(-direction.y, direction.x) / directionLength : vec2(1.0, 0.0);\n  float along = (a_vertex.y + 1.0) * 0.5;\n  vec4 point = mix(lower, upper, along);\n  vec2 ndc = mix(lowerNdc, upperNdc, along) + side * a_vertex.x * a_width * u_pixelsToClip;\n  gl_Position = vec4(ndc * point.w, point.z, point.w);\n  v_local = a_vertex;\n  v_opacity = a_opacity * u_transitionOpacity;\n}'
  ].join('\n');
  const fragmentSource = [
    '#version 300 es', 'precision highp float;', 'in vec2 v_local;\nin float v_opacity;\nout vec4 fragColor;',
    'void main() {\n  vec2 q = abs(v_local) - vec2(0.72, 0.72);\n  float distanceToCapsule = length(max(q, 0.0)) - 0.28;\n  float edge = max(fwidth(distanceToCapsule), 0.012);\n  float alpha = 1.0 - smoothstep(-edge, edge, distanceToCapsule);\n  fragColor = vec4(0.20, 0.66, 1.0, alpha * v_opacity);\n}'
  ].join('\n');
  const program = gl.createProgram();
  gl.attachShader(program, compileShader(gl, gl.VERTEX_SHADER, vertexSource));
  gl.attachShader(program, compileShader(gl, gl.FRAGMENT_SHADER, fragmentSource));
  gl.linkProgram(program);
  if (!gl.getProgramParameter(program, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(program) || '3D rain shader linking failed.');
  return {
    program,
    locations: Object.fromEntries(['a_vertex', 'a_center', 'a_altitude', 'a_length', 'a_width', 'a_opacity', 'u_pixelsToClip', 'u_transitionOpacity', 'u_matrix', 'u_projection_fallback_matrix', 'u_projection_matrix', 'u_projection_tile_mercator_coords', 'u_projection_clipping_plane', 'u_projection_transition'].map((name) => [name, name.startsWith('a_') ? gl.getAttribLocation(program, name) : gl.getUniformLocation(program, name)]))
  };
}

class InstanceWriter {
  constructor() { this.values = new Float32Array(); this.length = 0; }
  reset() { this.length = 0; }
  push(centerX, centerY, altitude, length, width, opacity) {
    const next = this.length + INSTANCE_STRIDE;
    if (next > this.values.length) {
      const values = new Float32Array(Math.max(next, this.values.length * 2, 1024));
      values.set(this.values);
      this.values = values;
    }
    this.values.set([centerX, centerY, altitude, length, width, opacity], this.length);
    this.length = next;
  }
  finish() { return this.values.subarray(0, this.length); }
}

export class GeographicRainLayer {
  constructor() {
    this.id = 'geographic-3d-rain';
    this.type = 'custom';
    this.renderingMode = '3d';
    this.samples = [];
    this.transition = null;
    this.transitionProgress = 1;
    this.writer = new InstanceWriter();
    this.instances = { current: new Float32Array(), from: new Float32Array(), to: new Float32Array() };
    this.counts = { current: 0, from: 0, to: 0 };
    this.bufferCapacity = { current: 0, from: 0, to: 0 };
    this.buffersDirty = true;
    this.fixedFrame = null;
  }

  onAdd(map, gl) {
    this.map = map;
    this.quadBuffer = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, this.quadBuffer);
    gl.bufferData(gl.ARRAY_BUFFER, QUAD, gl.STATIC_DRAW);
    this.instanceBuffers = Object.fromEntries(Object.keys(this.instances).map((key) => [key, gl.createBuffer()]));
  }

  onRemove(map, gl) {
    if (this.programs) for (const entry of this.programs.values()) gl.deleteProgram(entry.program);
    for (const buffer of [...Object.values(this.instanceBuffers || {}), this.quadBuffer]) if (buffer) gl.deleteBuffer(buffer);
  }

  setFixedWeatherTime(time) { this.fixedFrame = prepareGeographicFieldFrame(time); }

  setSamples(samples) {
    this.samples = samples;
    this.transition = null;
    this.instances.current = this.buildInstances(samples);
    this.counts.current = this.instances.current.length / INSTANCE_STRIDE;
    this.buffersDirty = true;
    this.map?.triggerRepaint();
  }

  setTransition(fromSamples, toSamples, progress = 0) {
    this.samples = toSamples;
    this.transition = { fromSamples, toSamples };
    this.transitionProgress = progress;
    this.instances.from = this.buildInstances(fromSamples);
    this.instances.to = this.buildInstances(toSamples);
    this.counts.from = this.instances.from.length / INSTANCE_STRIDE;
    this.counts.to = this.instances.to.length / INSTANCE_STRIDE;
    this.buffersDirty = true;
    this.map?.triggerRepaint();
  }

  setTransitionProgress(progress) { this.transitionProgress = progress; this.map?.triggerRepaint(); }

  buildInstances(samples) {
    if (!this.fixedFrame || !samples.length) return new Float32Array();
    const capacity = SLOT_CAPACITY[samples[0].level];
    const value = { rain: 0, storm: 0, hail: 0 };
    this.writer.reset();
    for (const sample of samples) {
      const point = geographicToSynthetic(...sample.lngLat);
      geographicPreparedIntensityAt(this.fixedFrame, point, value);
      const strength = smoothstep(0.035, 0.90, value.rain);
      if (strength <= 0) continue;
      for (let slot = 0; slot < capacity; slot++) {
        const selector = hashUnit(sample.canonicalX, sample.canonicalY, slot, 0x9e3779b9);
        if (selector > strength) continue;
        const phase = hashUnit(sample.canonicalX, sample.canonicalY, slot, 0x85ebca6b);
        const variation = hashUnit(sample.canonicalX, sample.canonicalY, slot, 0xc2b2ae35);
        const opacityVariation = hashUnit(sample.canonicalX, sample.canonicalY, slot, 0x27d4eb2f);
        // The field stays evaluated at the fixed sample center. These two
        // stable slot offsets only distribute rendered rain inside its cell.
        const scatterX = (hashUnit(sample.canonicalX, sample.canonicalY, slot, 0x165667b1) - 0.5) * sample.spacing * SCATTER_FOOTPRINT;
        const scatterY = (hashUnit(sample.canonicalX, sample.canonicalY, slot, 0xd3a2646c) - 0.5) * sample.spacing * SCATTER_FOOTPRINT;
        const length = 145 + strength * 370 + variation * 95;
        const altitude = COLUMN_BOTTOM_METRES + phase * Math.max(1, COLUMN_TOP_METRES - COLUMN_BOTTOM_METRES - length);
        const width = 0.85 + strength * 1.35 + variation * 0.3;
        const opacity = (0.24 + strength * 0.58) * (0.78 + opacityVariation * 0.22);
        this.writer.push(sample.mercator[0] + scatterX, sample.mercator[1] + scatterY, altitude, length, width, opacity);
      }
    }
    return this.writer.finish();
  }

  uploadBuffers(gl) {
    if (!this.buffersDirty) return;
    for (const key of Object.keys(this.instances)) {
      const bytes = this.instances[key].byteLength;
      gl.bindBuffer(gl.ARRAY_BUFFER, this.instanceBuffers[key]);
      if (bytes > this.bufferCapacity[key]) {
        gl.bufferData(gl.ARRAY_BUFFER, bytes, gl.STATIC_DRAW);
        this.bufferCapacity[key] = bytes;
      }
      if (bytes) gl.bufferSubData(gl.ARRAY_BUFFER, 0, this.instances[key]);
    }
    this.buffersDirty = false;
  }

  renderGroup(gl, entry, projection, key, opacity) {
    if (!this.counts[key] || opacity <= 0) return;
    const { locations } = entry;
    gl.useProgram(entry.program);
    setGeographicProjection(gl, { matrix: locations.u_matrix, fallbackMatrix: locations.u_projection_fallback_matrix, projectionMatrix: locations.u_projection_matrix, tileMercatorCoords: locations.u_projection_tile_mercator_coords, clippingPlane: locations.u_projection_clipping_plane, projectionTransition: locations.u_projection_transition }, projection);
    gl.uniform2f(locations.u_pixelsToClip, 2 / gl.drawingBufferWidth, 2 / gl.drawingBufferHeight);
    gl.uniform1f(locations.u_transitionOpacity, opacity);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.quadBuffer);
    gl.enableVertexAttribArray(locations.a_vertex);
    gl.vertexAttribPointer(locations.a_vertex, 2, gl.FLOAT, false, 0, 0);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.instanceBuffers[key]);
    for (const [location, size, offset] of [[locations.a_center, 2, 0], [locations.a_altitude, 1, 8], [locations.a_length, 1, 12], [locations.a_width, 1, 16], [locations.a_opacity, 1, 20]]) {
      gl.enableVertexAttribArray(location);
      gl.vertexAttribPointer(location, size, gl.FLOAT, false, INSTANCE_BYTES, offset);
      gl.vertexAttribDivisor(location, 1);
    }
    gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
    gl.drawArraysInstanced(gl.TRIANGLES, 0, 6, this.counts[key]);
    for (const location of [locations.a_center, locations.a_altitude, locations.a_length, locations.a_width, locations.a_opacity]) gl.vertexAttribDivisor(location, 0);
  }

  render(gl, args) {
    this.uploadBuffers(gl);
    this.programs ||= new Map();
    let entry = this.programs.get(args.shaderData.variantName);
    if (!entry) { entry = makeProgram(gl, args.shaderData); this.programs.set(args.shaderData.variantName, entry); }
    gl.enable(gl.BLEND);
    gl.enable(gl.DEPTH_TEST);
    gl.depthMask(false);
    if (this.transition) {
      this.renderGroup(gl, entry, args.defaultProjectionData, 'from', 1 - this.transitionProgress);
      this.renderGroup(gl, entry, args.defaultProjectionData, 'to', this.transitionProgress);
    } else this.renderGroup(gl, entry, args.defaultProjectionData, 'current', 1);
    gl.depthMask(true);
  }
}
