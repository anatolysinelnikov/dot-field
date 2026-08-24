import { prepareGeographicFieldFrame } from './geography.js';
import { setGeographicProjection } from './geographic-layer-utils.js';
import { GeographicSymbolPyramid } from './geographic-symbol-pyramid.js';
import { clamp, smoothstep } from './math.js';

// Deliberately exaggerated visual composition for the main-compatible camera.
const COLUMN_BOTTOM_METRES = 150;
const COLUMN_TOP_METRES = 15000;
const DROP_WIDTH_OF_DOT_DIAMETER = 0.60;
const MAX_DROP_WIDTH_OF_SPACING = 0.60;
const DROP_HEIGHT_OF_WIDTH = 1.65;
const MIN_FORESHORTENED_HEIGHT = 0.52;
const EMITTER_RATE_BASE = 1.0;
const EMITTER_RATE_MAX = 1.45;
const EMITTER_RATE_COVERAGE_START = 0.04;
const EMITTER_RATE_COVERAGE_END = 0.86;
const EMITTER_RATE_IDENTITY_MIN = 0.95;
const EMITTER_RATE_IDENTITY_MAX = 1.05;
const EVENT_SEQUENCE_LENGTH = 8;
const RADIAL_REFERENCE_METRES = 100;
const EARTH_CIRCUMFERENCE_METRES = 40075016.68557849;
const INSTANCE_STRIDE = 9;
const INSTANCE_BYTES = INSTANCE_STRIDE * Float32Array.BYTES_PER_ELEMENT;
const QUAD = new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]);

function fract(value) { return value - Math.floor(value); }
function hashUnit(x, y, slot, salt) {
  let value = (x * 73856093) ^ (y * 19349663) ^ (slot * 83492791) ^ salt;
  value = Math.imul(value ^ (value >>> 16), 2246822519);
  value = Math.imul(value ^ (value >>> 13), 3266489917);
  return ((value ^ (value >>> 16)) >>> 0) / 4294967296;
}
function emitterRateForCoverage(coverage) {
  const magnitude = smoothstep(EMITTER_RATE_COVERAGE_START, EMITTER_RATE_COVERAGE_END, clamp(coverage, 0, 1));
  return EMITTER_RATE_BASE + magnitude * (EMITTER_RATE_MAX - EMITTER_RATE_BASE);
}
function compileShader(gl, type, source) {
  const shader = gl.createShader(type);
  gl.shaderSource(shader, source);
  gl.compileShader(shader);
  if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(shader) || '3D dot-rain shader compilation failed.');
  return shader;
}
function makeTeardropProgram(gl, shaderData) {
  const vertexSource = [
    '#version 300 es', shaderData.vertexShaderPrelude, shaderData.define,
    `in vec2 a_vertex;
in vec2 a_center;
in float a_phase;
in float a_speed;
in float a_rainRadius;
in float a_sampleSpacing;
in float a_sizeVariation;
in float a_strongFraction;
in float a_eventOffset;
uniform vec2 u_pixelsToClip;
uniform float u_transitionOpacity;
uniform float u_fallingCycles;
out vec2 v_local;
out float v_dark;
out float v_opacity;
out float v_foreshortening;
void main() {
  float verticalPhase = fract(a_phase - u_fallingCycles * a_speed);
  float eventIndex = floor(u_fallingCycles * a_speed + 1.0 - a_phase);
  float eventSlot = mod(eventIndex * 5.0 + a_eventOffset, ${EVENT_SEQUENCE_LENGTH}.0);
  float eventDark = step(eventSlot + 0.5, a_strongFraction * ${EVENT_SEQUENCE_LENGTH}.0);
  float altitude = ${COLUMN_BOTTOM_METRES}.0 + verticalPhase * ${COLUMN_TOP_METRES - COLUMN_BOTTOM_METRES}.0;
  vec4 center = projectTileFor3D(a_center, altitude);
  vec4 radial = projectTileFor3D(a_center, altitude + ${RADIAL_REFERENCE_METRES}.0);
  vec2 centerNdc = center.xy / center.w;
  vec2 radialDirection = radial.xy / radial.w - centerNdc;
  float radialLength = length(radialDirection);
  vec2 up = radialLength > 0.000001 ? radialDirection / radialLength : vec2(0.0, 1.0);
  vec2 side = vec2(-up.y, up.x);
  float latitude = atan(sinh((0.5 - a_center.y) * 6.28318530718));
  float metresPerMercatorUnit = ${EARTH_CIRCUMFERENCE_METRES} * max(0.001, abs(cos(latitude)));
  float tangentOffset = ${RADIAL_REFERENCE_METRES}.0 / metresPerMercatorUnit;
  vec4 tangentX = projectTileFor3D(a_center + vec2(tangentOffset, 0.0), altitude);
  vec4 tangentY = projectTileFor3D(a_center + vec2(0.0, tangentOffset), altitude);
  vec2 tangentXDirection = tangentX.xy / tangentX.w - centerNdc;
  vec2 tangentYDirection = tangentY.xy / tangentY.w - centerNdc;
  float tangentLength = max(length(tangentXDirection), length(tangentYDirection));
  float foreshortening = tangentLength > 0.000001 ? clamp(radialLength / tangentLength, 0.0, 1.0) : 1.0;
  float maxWidthWorld = a_sampleSpacing * ${MAX_DROP_WIDTH_OF_SPACING};
  float nominalWidthWorld = a_rainRadius * 2.0 * ${DROP_WIDTH_OF_DOT_DIAMETER};
  float widthWorld = min(min(nominalWidthWorld, maxWidthWorld) * a_sizeVariation, maxWidthWorld);
  float sideTangentLength = length(vec2(dot(tangentXDirection, side), dot(tangentYDirection, side)));
  float widthPixels = max(0.75, sideTangentLength * (widthWorld * 0.5 / tangentOffset) / length(u_pixelsToClip));
  float heightPixels = widthPixels * ${DROP_HEIGHT_OF_WIDTH} * mix(${MIN_FORESHORTENED_HEIGHT}, 1.0, foreshortening);
  vec2 ndc = centerNdc + side * a_vertex.x * widthPixels * u_pixelsToClip + up * a_vertex.y * heightPixels * u_pixelsToClip;
  gl_Position = vec4(ndc * center.w, center.z, center.w);
  v_local = a_vertex;
  v_dark = eventDark;
  v_opacity = u_transitionOpacity;
  v_foreshortening = foreshortening;
}`
  ].join('\n');
  const fragmentSource = [
    '#version 300 es', 'precision highp float;',
    'in vec2 v_local;\nin float v_dark;\nin float v_opacity;\nin float v_foreshortening;\nout vec4 fragColor;',
    `void main() {
  // Lower circular bulb plus upper triangle: point faces away from Earth.
  vec2 bulb = v_local - vec2(0.0, -0.34);
  float bulbDistance = length(bulb) - 0.66;
  float triangleHalfWidth = 0.66 * clamp((1.0 - v_local.y) / 1.34, 0.0, 1.0);
  float triangleDistance = max(abs(v_local.x) - triangleHalfWidth, max(-v_local.y - 0.34, v_local.y - 1.0));
  float shapeDistance = mix(bulbDistance, min(bulbDistance, triangleDistance), v_foreshortening);
  float edge = max(fwidth(shapeDistance), 0.012);
  float alpha = 1.0 - smoothstep(-edge, edge, shapeDistance);
  vec3 color = mix(vec3(0.0, 0.565, 1.0), vec3(0.0, 0.0, 1.0), v_dark);
  fragColor = vec4(color, alpha * v_opacity);
}`
  ].join('\n');
  const program = gl.createProgram();
  gl.attachShader(program, compileShader(gl, gl.VERTEX_SHADER, vertexSource));
  gl.attachShader(program, compileShader(gl, gl.FRAGMENT_SHADER, fragmentSource));
  gl.linkProgram(program);
  if (!gl.getProgramParameter(program, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(program) || '3D dot-rain shader linking failed.');
  return { program, locations: Object.fromEntries(['a_vertex', 'a_center', 'a_phase', 'a_speed', 'a_rainRadius', 'a_sampleSpacing', 'a_sizeVariation', 'a_strongFraction', 'a_eventOffset', 'u_pixelsToClip', 'u_transitionOpacity', 'u_fallingCycles', 'u_matrix', 'u_projection_fallback_matrix', 'u_projection_matrix', 'u_projection_tile_mercator_coords', 'u_projection_clipping_plane', 'u_projection_transition'].map((name) => [name, name.startsWith('a_') ? gl.getAttribLocation(program, name) : gl.getUniformLocation(program, name)])) };
}
class InstanceWriter {
  constructor() { this.values = new Float32Array(); this.length = 0; }
  reset() { this.length = 0; }
  push(...values) {
    const next = this.length + INSTANCE_STRIDE;
    if (next > this.values.length) { const buffer = new Float32Array(Math.max(next, this.values.length * 2, 1024)); buffer.set(this.values); this.values = buffer; }
    this.values.set(values, this.length); this.length = next;
  }
  finish() { return this.values.slice(0, this.length); }
}
function has3DRain(samples) { return samples.length && samples[0].level >= 13; }

export class GeographicRainLayer {
  constructor() {
    this.id = 'geographic-3d-rain'; this.type = 'custom'; this.renderingMode = '3d';
    this.pyramid = new GeographicSymbolPyramid(); this.samples = []; this.transition = null; this.transitionProgress = 1;
    this.writer = new InstanceWriter();
    this.dropInstances = { current: new Float32Array(), from: new Float32Array(), to: new Float32Array() };
    this.dropCounts = { current: 0, from: 0, to: 0 }; this.populationStats = { current: null, from: null, to: null };
    this.dropBufferCapacity = { current: 0, from: 0, to: 0 }; this.buffersDirty = true; this.fixedFrame = null; this.fallingCycles = 0;
  }
  onAdd(map, gl) {
    this.map = map; this.quadBuffer = gl.createBuffer(); gl.bindBuffer(gl.ARRAY_BUFFER, this.quadBuffer); gl.bufferData(gl.ARRAY_BUFFER, QUAD, gl.STATIC_DRAW);
    this.dropBuffers = Object.fromEntries(Object.keys(this.dropInstances).map((key) => [key, gl.createBuffer()]));
  }
  onRemove(map, gl) {
    if (this.programs) for (const program of this.programs.values()) gl.deleteProgram(program.program);
    for (const buffer of [...Object.values(this.dropBuffers || {}), this.quadBuffer]) if (buffer) gl.deleteBuffer(buffer);
  }
  setFixedWeatherTime(time) { this.fixedFrame = prepareGeographicFieldFrame(time); }
  setSamples(samples) {
    this.samples = samples; this.transition = null;
    this.setDropInstances('current', has3DRain(samples) ? this.buildInstances(samples) : { instances: new Float32Array(), stats: null });
    this.buffersDirty = true; this.map?.triggerRepaint();
  }
  setTransition(fromSamples, toSamples, progress = 0) {
    this.samples = toSamples; this.transition = { fromSamples, toSamples }; this.transitionProgress = progress;
    this.setDropInstances('from', has3DRain(fromSamples) ? this.buildInstances(fromSamples) : { instances: new Float32Array(), stats: null });
    this.setDropInstances('to', has3DRain(toSamples) ? this.buildInstances(toSamples) : { instances: new Float32Array(), stats: null });
    this.buffersDirty = true; this.map?.triggerRepaint();
  }
  setTransitionProgress(progress) { this.transitionProgress = progress; this.map?.triggerRepaint(); }
  setFallingCycles(cycles) { this.fallingCycles = cycles; this.map?.triggerRepaint(); }
  setDropInstances(key, result) { this.dropInstances[key] = result.instances; this.dropCounts[key] = result.instances.length / INSTANCE_STRIDE; this.populationStats[key] = result.stats; }
  buildInstances(samples) {
    if (!this.fixedFrame || !samples.length) return { instances: new Float32Array(), stats: null };
    const level = samples[0].level;
    const state = this.pyramid.evaluate([level], this.fixedFrame)[level];
    const { anchors, samples: pyramidSamples } = this.pyramid.levels.get(level);
    const stats = { level, emitters: 0, drops: 0 };
    this.writer.reset();
    for (let index = 0; index < state.rainRadius.length; index++) {
      const rainRadius = state.rainRadius[index]; if (rainRadius <= 0) continue;
      const sample = pyramidSamples[index];
      const strongFraction = rainRadius > 0 ? clamp(state.strongRadius[index] ** 2 / (rainRadius ** 2), 0, 1) : 0;
      const basePhase = hashUnit(sample.canonicalX, sample.canonicalY, 0, 0x85ebca6b);
      const coverage = sample.spacing > 0 ? rainRadius / sample.spacing : 0;
      const magnitudeRate = emitterRateForCoverage(coverage);
      const identityRate = EMITTER_RATE_IDENTITY_MIN + hashUnit(sample.canonicalX, sample.canonicalY, 0, 0x165667b1) * (EMITTER_RATE_IDENTITY_MAX - EMITTER_RATE_IDENTITY_MIN);
      const speed = magnitudeRate * identityRate;
      const sizeVariation = 0.9 + hashUnit(sample.canonicalX, sample.canonicalY, 0, 0x27d4eb2f) * 0.2;
      const eventOffset = Math.floor(hashUnit(sample.canonicalX, sample.canonicalY, 0, 0x4cf5ad43) * EVENT_SEQUENCE_LENGTH);
      this.writer.push(anchors[index * 2], anchors[index * 2 + 1], fract(basePhase), speed, rainRadius, sample.spacing, sizeVariation, strongFraction, eventOffset);
      stats.emitters++; stats.drops++;
    }
    return { instances: this.writer.finish(), stats };
  }
  uploadBuffers(gl) {
    if (!this.buffersDirty) return;
    for (const key of Object.keys(this.dropInstances)) {
      const bytes = this.dropInstances[key].byteLength; gl.bindBuffer(gl.ARRAY_BUFFER, this.dropBuffers[key]);
      if (bytes > this.dropBufferCapacity[key]) { gl.bufferData(gl.ARRAY_BUFFER, bytes, gl.STATIC_DRAW); this.dropBufferCapacity[key] = bytes; }
      if (bytes) gl.bufferSubData(gl.ARRAY_BUFFER, 0, this.dropInstances[key]);
    }
    this.buffersDirty = false;
  }
  renderDropGroup(gl, entry, projection, key, opacity) {
    if (!this.dropCounts[key] || opacity <= 0) return;
    const { locations } = entry; gl.useProgram(entry.program);
    setGeographicProjection(gl, { matrix: locations.u_matrix, fallbackMatrix: locations.u_projection_fallback_matrix, projectionMatrix: locations.u_projection_matrix, tileMercatorCoords: locations.u_projection_tile_mercator_coords, clippingPlane: locations.u_projection_clipping_plane, projectionTransition: locations.u_projection_transition }, projection);
    gl.uniform2f(locations.u_pixelsToClip, 2 / gl.drawingBufferWidth, 2 / gl.drawingBufferHeight); gl.uniform1f(locations.u_transitionOpacity, opacity); gl.uniform1f(locations.u_fallingCycles, this.fallingCycles);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.quadBuffer); gl.enableVertexAttribArray(locations.a_vertex); gl.vertexAttribPointer(locations.a_vertex, 2, gl.FLOAT, false, 0, 0);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.dropBuffers[key]);
    for (const [location, size, offset] of [[locations.a_center, 2, 0], [locations.a_phase, 1, 8], [locations.a_speed, 1, 12], [locations.a_rainRadius, 1, 16], [locations.a_sampleSpacing, 1, 20], [locations.a_sizeVariation, 1, 24], [locations.a_strongFraction, 1, 28], [locations.a_eventOffset, 1, 32]]) { gl.enableVertexAttribArray(location); gl.vertexAttribPointer(location, size, gl.FLOAT, false, INSTANCE_BYTES, offset); gl.vertexAttribDivisor(location, 1); }
    gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA); gl.drawArraysInstanced(gl.TRIANGLE_STRIP, 0, 4, this.dropCounts[key]);
    for (const location of [locations.a_center, locations.a_phase, locations.a_speed, locations.a_rainRadius, locations.a_sampleSpacing, locations.a_sizeVariation, locations.a_strongFraction, locations.a_eventOffset]) gl.vertexAttribDivisor(location, 0);
  }
  render(gl, args) {
    this.uploadBuffers(gl); this.programs ||= new Map(); let program = this.programs.get(args.shaderData.variantName);
    if (!program) { program = makeTeardropProgram(gl, args.shaderData); this.programs.set(args.shaderData.variantName, program); }
    gl.enable(gl.BLEND); gl.enable(gl.DEPTH_TEST); gl.depthMask(false);
    if (this.transition) { this.renderDropGroup(gl, program, args.defaultProjectionData, 'from', 1 - this.transitionProgress); this.renderDropGroup(gl, program, args.defaultProjectionData, 'to', this.transitionProgress); } else this.renderDropGroup(gl, program, args.defaultProjectionData, 'current', 1);
    gl.depthMask(true);
  }
}
