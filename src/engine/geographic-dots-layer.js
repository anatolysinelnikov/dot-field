import { prepareGeographicFieldFrame } from './geography.js';
import { geographicTemporalFrameAt, setGeographicProjection, TEMPORAL_FRAME_COUNT } from './geographic-layer-utils.js';
import { GeographicSymbolPyramid, REFERENCE_GRID_LEVEL, STORM_INNER_RATIO } from './geographic-symbol-pyramid.js';
import { DEFAULT_DOTS_HAZARD_SIZE_MAPPING } from './hazard-renderer.js';

const COLORS = {
  rain: [0, 0.565, 1, 1],
  strong: [0, 0, 1, 1],
  storm: [1, 0, 1, 1],
  hail: [1, 0.831, 0, 1],
  squall1: [1, 0.52, 0, 1],
  squall2: [1, 0.52, 0, 1],
  squall3: [1, 0.52, 0, 1],
  hurricane: [0.86, 0.015, 0.08, 1]
};
const INSTANCE_STRIDE = 8;
const INSTANCE_BYTES = INSTANCE_STRIDE * Float32Array.BYTES_PER_ELEMENT;
const HAZARD_INSTANCE_STRIDE = 22;
const HAZARD_INSTANCE_BYTES = HAZARD_INSTANCE_STRIDE * Float32Array.BYTES_PER_ELEMENT;
const WEATHER_TYPES = ['rain', 'strong', 'storm', 'hail', 'squall1', 'squall2', 'squall3', 'hurricane'];
const HAZARD_TYPES = ['storm', 'hail', 'squall1', 'squall2', 'squall3', 'hurricane'];
const HAZARD_CHANNELS = ['storm', 'hail', 'squall', 'hurricane'];
const HAZARD_ONSETS = { storm: 0.075 * 0.45, hail: 0.11 * 0.45, squall: 0.08 * 0.45, hurricane: 0.18 * 0.45 };
const RADIUS_KEYS = {
  rain: 'rainRadius',
  strong: 'strongRadius'
};
const QUAD = new Float32Array([-1, -1, 1, -1, 1, 1, -1, -1, 1, 1, -1, 1]);

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

function ribbonTriangles(left, right) {
  const vertices = [];
  for (let index = 0; index < left.length - 1; index++) {
    vertices.push(
      left[index][0], left[index][1], right[index][0], right[index][1], left[index + 1][0], left[index + 1][1],
      right[index][0], right[index][1], right[index + 1][0], right[index + 1][1], left[index + 1][0], left[index + 1][1]
    );
  }
  return vertices;
}

function filledRegularGlyph(sides, radius) {
  return unitShape(circularPoints(sides).map(point => [point[0] * radius, point[1] * radius]));
}

const HAIL = filledRegularGlyph(3, 1);
const STORM = unitShape(circularPoints(8).map((point, index) => {
  const scale = index % 2 === 0 ? 1 : STORM_INNER_RATIO;
  return [point[0] * scale, point[1] * scale];
}));
const SQUALL_1 = filledRegularGlyph(4, 1);
const SQUALL_2 = filledRegularGlyph(4, 1);
const SQUALL_3 = filledRegularGlyph(4, 1);
const HURRICANE = QUAD;

export function areaLinearRadius(startRadius, endRadius, progress) {
  return Math.sqrt(startRadius * startRadius + (endRadius * endRadius - startRadius * startRadius) * progress);
}

class InstanceWriter {
  constructor(stride = INSTANCE_STRIDE) {
    this.stride = stride;
    this.values = new Float32Array();
    this.length = 0;
  }

  reset() {
    this.length = 0;
  }

  push(...valuesToWrite) {
    const nextLength = this.length + this.stride;
    if (nextLength > this.values.length) {
      const capacity = Math.max(nextLength, this.values.length * 2, 256);
      const values = new Float32Array(capacity);
      values.set(this.values);
      this.values = values;
    }
    const offset = this.length;
    this.values.set(valuesToWrite, offset);
    this.length = nextLength;
  }

  finish() {
    return this.values.subarray(0, this.length);
  }
}

function hasTemporalRadius(radius0, radius1, radius2 = 0, radius3 = 0) {
  return radius0 > 0 || radius1 > 0 || radius2 > 0 || radius3 > 0;
}

function buildHierarchicalTemporalInstances(coarseTime0, fineTime0, coarseTime1, fineTime1, coarseAnchors, fineAnchors, childIndices, radiusKey, refining, writer) {
  writer.reset();
  for (let parentIndex = 0; parentIndex < coarseTime0[radiusKey].length; parentIndex++) {
    const parentRadius0 = coarseTime0[radiusKey][parentIndex];
    const parentRadius1 = coarseTime1[radiusKey][parentIndex];
    const parentAnchorIndex = parentIndex * 2;
    if (hasTemporalRadius(parentRadius0, parentRadius1)) {
      if (refining) writer.push(coarseAnchors[parentAnchorIndex], coarseAnchors[parentAnchorIndex + 1], coarseAnchors[parentAnchorIndex], coarseAnchors[parentAnchorIndex + 1], parentRadius0, parentRadius1, 0, 0);
      else writer.push(coarseAnchors[parentAnchorIndex], coarseAnchors[parentAnchorIndex + 1], coarseAnchors[parentAnchorIndex], coarseAnchors[parentAnchorIndex + 1], 0, 0, parentRadius0, parentRadius1);
    }

    for (const childIndex of childIndices[parentIndex]) {
      const childRadius0 = fineTime0[radiusKey][childIndex];
      const childRadius1 = fineTime1[radiusKey][childIndex];
      if (!hasTemporalRadius(childRadius0, childRadius1)) continue;
      const childAnchorIndex = childIndex * 2;
      if (refining) writer.push(coarseAnchors[parentAnchorIndex], coarseAnchors[parentAnchorIndex + 1], fineAnchors[childAnchorIndex], fineAnchors[childAnchorIndex + 1], 0, 0, childRadius0, childRadius1);
      else writer.push(fineAnchors[childAnchorIndex], fineAnchors[childAnchorIndex + 1], coarseAnchors[parentAnchorIndex], coarseAnchors[parentAnchorIndex + 1], childRadius0, childRadius1, 0, 0);
    }
  }
  return writer.finish();
}

function buildSameLevelTemporalInstances(time0, time1, anchors, radiusKey, writer) {
  writer.reset();
  const radii0 = time0[radiusKey];
  const radii1 = time1[radiusKey];
  for (let index = 0; index < radii0.length; index++) {
    const radius0 = radii0[index];
    const radius1 = radii1[index];
    if (!hasTemporalRadius(radius0, radius1)) continue;
    const anchorIndex = index * 2;
    writer.push(anchors[anchorIndex], anchors[anchorIndex + 1], anchors[anchorIndex], anchors[anchorIndex + 1], radius0, radius1, radius0, radius1);
  }
  return writer.finish();
}

function buildDirectTemporalInstances(fromTime0, toTime0, fromTime1, toTime1, fromAnchors, toAnchors, pairs, fromIsLower, radiusKey, writer) {
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
    const startAnchors = fromIndex < 0 ? toAnchors : fromAnchors;
    const startAnchorIndex = (fromIndex < 0 ? toIndex : fromIndex) * 2;
    const endAnchors = toIndex < 0 ? fromAnchors : toAnchors;
    const endAnchorIndex = (toIndex < 0 ? fromIndex : toIndex) * 2;
    writer.push(startAnchors[startAnchorIndex], startAnchors[startAnchorIndex + 1], endAnchors[endAnchorIndex], endAnchors[endAnchorIndex + 1], fromRadius0, fromRadius1, toRadius0, toRadius1);
  }
  return writer.finish();
}

function hazardValue(state, channel, index) {
  return state && index >= 0 ? state.hazardValues[channel][index] : 0;
}

function hasHazardValues(state, index) {
  if (!state || index < 0) return false;
  return HAZARD_CHANNELS.some((channel) => hazardValue(state, channel, index) > HAZARD_ONSETS[channel]);
}

function pushHazardInstance(writer, startAnchors, startIndex, endAnchors, endIndex,
  startState0, startState1, endState0, endState1, startSpacing, endSpacing) {
  const startAnchorIndex = startIndex * 2;
  const endAnchorIndex = endIndex * 2;
  writer.push(
    startAnchors[startAnchorIndex], startAnchors[startAnchorIndex + 1],
    endAnchors[endAnchorIndex], endAnchors[endAnchorIndex + 1],
    ...HAZARD_CHANNELS.map((channel) => hazardValue(startState0, channel, startIndex)),
    ...HAZARD_CHANNELS.map((channel) => hazardValue(startState1, channel, startIndex)),
    ...HAZARD_CHANNELS.map((channel) => hazardValue(endState0, channel, endIndex)),
    ...HAZARD_CHANNELS.map((channel) => hazardValue(endState1, channel, endIndex)),
    startSpacing, endSpacing
  );
}

function buildSameLevelHazardInstances(time0, time1, anchors, spacing, writer) {
  writer.reset();
  for (let index = 0; index < time0.hazardValues.storm.length; index++) {
    if (!hasHazardValues(time0, index) && !hasHazardValues(time1, index)) continue;
    pushHazardInstance(writer, anchors, index, anchors, index, time0, time1, time0, time1, spacing, spacing);
  }
  return writer.finish();
}

function buildHierarchicalHazardInstances(coarseTime0, fineTime0, coarseTime1, fineTime1,
  coarseAnchors, fineAnchors, childIndices, coarseSpacing, fineSpacing, refining, writer) {
  writer.reset();
  for (let parentIndex = 0; parentIndex < coarseTime0.hazardValues.storm.length; parentIndex++) {
    const parentActive = hasHazardValues(coarseTime0, parentIndex) || hasHazardValues(coarseTime1, parentIndex);
    if (parentActive) {
      if (refining) {
        pushHazardInstance(writer, coarseAnchors, parentIndex, coarseAnchors, parentIndex,
          coarseTime0, coarseTime1, null, null, coarseSpacing, coarseSpacing);
      } else {
        pushHazardInstance(writer, coarseAnchors, parentIndex, coarseAnchors, parentIndex,
          null, null, coarseTime0, coarseTime1, coarseSpacing, coarseSpacing);
      }
    }

    for (const childIndex of childIndices[parentIndex]) {
      const childActive = hasHazardValues(fineTime0, childIndex) || hasHazardValues(fineTime1, childIndex);
      if (!childActive) continue;
      if (refining) {
        pushHazardInstance(writer, coarseAnchors, parentIndex, fineAnchors, childIndex,
          null, null, fineTime0, fineTime1, coarseSpacing, fineSpacing);
      } else {
        pushHazardInstance(writer, fineAnchors, childIndex, coarseAnchors, parentIndex,
          fineTime0, fineTime1, null, null, fineSpacing, coarseSpacing);
      }
    }
  }
  return writer.finish();
}

function buildDirectHazardInstances(fromTime0, toTime0, fromTime1, toTime1,
  fromAnchors, toAnchors, pairs, fromIsLower, fromSpacing, toSpacing, writer) {
  writer.reset();
  for (let index = 0; index < pairs.length; index += 2) {
    const lowerIndex = pairs[index];
    const higherIndex = pairs[index + 1];
    const fromIndex = fromIsLower ? lowerIndex : higherIndex;
    const toIndex = fromIsLower ? higherIndex : lowerIndex;
    if (!hasHazardValues(fromTime0, fromIndex) && !hasHazardValues(fromTime1, fromIndex)
      && !hasHazardValues(toTime0, toIndex) && !hasHazardValues(toTime1, toIndex)) continue;
    const startAnchors = fromIndex < 0 ? toAnchors : fromAnchors;
    const startIndex = fromIndex < 0 ? toIndex : fromIndex;
    const endAnchors = toIndex < 0 ? fromAnchors : toAnchors;
    const endIndex = toIndex < 0 ? fromIndex : toIndex;
    pushHazardInstance(writer, startAnchors, startIndex, endAnchors, endIndex,
      fromTime0, fromTime1, toTime0, toTime1,
      fromIndex < 0 ? toSpacing : fromSpacing, toIndex < 0 ? fromSpacing : toSpacing);
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
  const hazardVertex = `in vec2 a_vertex;
in vec2 a_startCenter;
in vec2 a_endCenter;
in vec4 a_startHazard0;
in vec4 a_startHazard1;
in vec4 a_endHazard0;
in vec4 a_endHazard1;
in float a_startSpacing;
in float a_endSpacing;
uniform float u_temporalProgress;
uniform float u_lodTransition;
uniform int u_hazardType;
uniform vec2 u_stormSize;
uniform vec2 u_hailSize;
uniform vec2 u_squallSize;
flat out int v_winner;
float strength(float value, float threshold) { return smoothstep(threshold * 0.45, 0.93, value); }
int squallGrade(float value) { return value >= 0.72 ? 3 : value >= 0.38 ? 2 : 1; }
int hazardWinner(vec4 values) {
  if (strength(values.w, 0.18) > 0.0) return 6;
  if (strength(values.z, 0.08) > 0.0) return 2 + squallGrade(values.z);
  if (strength(values.y, 0.11) > 0.0) return 2;
  if (strength(values.x, 0.075) > 0.0) return 1;
  return 0;
}
float threeGradeSize(float minimum, float maximum, float progress) {
  float midpoint = (minimum + maximum) * 0.5;
  return progress <= 0.5 ? mix(minimum, midpoint, progress * 2.0) : mix(midpoint, maximum, (progress - 0.5) * 2.0);
}
float hazardRadius(int winner, vec4 values, float spacing) {
  if (winner == 6) return spacing * 0.5;
  if (winner == 5 || winner == 4 || winner == 3) {
    float grade = float(squallGrade(values.z));
    float gradeStart = grade == 3.0 ? 0.72 : grade == 2.0 ? 0.38 : 0.08;
    float gradeEnd = grade == 3.0 ? 1.0 : grade == 2.0 ? 0.72 : 0.38;
    float gradeProgress = clamp((values.z - gradeStart) / (gradeEnd - gradeStart), 0.0, 1.0);
    float gradeProgression = (grade - 1.0 + pow(gradeProgress, 0.45)) / 2.0;
    return spacing * threeGradeSize(u_squallSize.x, u_squallSize.y, gradeProgression);
  }
  if (winner == 2) return spacing * mix(u_hailSize.x, u_hailSize.y, pow(strength(values.y, 0.11), 0.47));
  return spacing * threeGradeSize(u_stormSize.x, u_stormSize.y, pow(strength(values.x, 0.075), 0.47));
}
void main() {
  vec4 startValues = mix(a_startHazard0, a_startHazard1, u_temporalProgress);
  vec4 endValues = mix(a_endHazard0, a_endHazard1, u_temporalProgress);
  vec4 values = mix(startValues, endValues, u_lodTransition);
  int startWinner = hazardWinner(startValues);
  int endWinner = hazardWinner(endValues);
  int winner = hazardWinner(values);
  float startRadius = hazardRadius(startWinner, startValues, a_startSpacing);
  float endRadius = hazardRadius(endWinner, endValues, a_endSpacing);
  float radius = startWinner == endWinner ? sqrt(mix(startRadius * startRadius, endRadius * endRadius, u_lodTransition)) : hazardRadius(winner, values, mix(a_startSpacing, a_endSpacing, u_lodTransition));
  vec2 center = mix(a_startCenter, a_endCenter, u_lodTransition);
  v_winner = winner;
  gl_Position = projectTile(center + a_vertex * radius);
}`;
  const vertexSource = ['#version 300 es', shaderData.vertexShaderPrelude, shaderData.define, circle ? `in vec2 a_vertex;
in vec2 a_startCenter;
in vec2 a_endCenter;
in float a_startTime0;
in float a_startTime1;
in float a_endTime0;
in float a_endTime1;
uniform float u_temporalProgress;
uniform float u_lodTransition;
out vec2 v_local;
float temporalRadius(float radius0, float radius1) { return sqrt(mix(radius0 * radius0, radius1 * radius1, u_temporalProgress)); }
void main() {
  float startRadius = temporalRadius(a_startTime0, a_startTime1);
  float endRadius = temporalRadius(a_endTime0, a_endTime1);
  float radius = sqrt(mix(startRadius * startRadius, endRadius * endRadius, u_lodTransition));
  vec2 center = mix(a_startCenter, a_endCenter, u_lodTransition);
  v_local = a_vertex;
  gl_Position = projectTile(center + a_vertex * radius);
}` : hazardVertex].join('\n');
  const fragmentSource = [
    '#version 300 es', 'precision highp float;', 'uniform vec4 u_color;',
    circle ? 'in vec2 v_local;' : 'flat in int v_winner;\nuniform int u_hazardType;', 'out vec4 fragColor;',
    circle
      ? 'void main() {\n  float distanceToCenter = length(v_local);\n  float edge = fwidth(distanceToCenter);\n  float alpha = 1.0 - smoothstep(1.0 - edge, 1.0 + edge, distanceToCenter);\n  fragColor = vec4(u_color.rgb, u_color.a * alpha);\n}'
      : 'void main() { if (v_winner != u_hazardType) discard; fragColor = u_color; }'
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
      startHazard0: gl.getAttribLocation(program, 'a_startHazard0'),
      startHazard1: gl.getAttribLocation(program, 'a_startHazard1'),
      endHazard0: gl.getAttribLocation(program, 'a_endHazard0'),
      endHazard1: gl.getAttribLocation(program, 'a_endHazard1'),
      startSpacing: gl.getAttribLocation(program, 'a_startSpacing'),
      endSpacing: gl.getAttribLocation(program, 'a_endSpacing'),
      color: gl.getUniformLocation(program, 'u_color'),
      temporalProgress: gl.getUniformLocation(program, 'u_temporalProgress'),
      lodTransition: gl.getUniformLocation(program, 'u_lodTransition'),
      hazardType: gl.getUniformLocation(program, 'u_hazardType'),
      stormSize: gl.getUniformLocation(program, 'u_stormSize'),
      hailSize: gl.getUniformLocation(program, 'u_hailSize'),
      squallSize: gl.getUniformLocation(program, 'u_squallSize'),
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
  constructor() {
    this.id = 'geographic-weather-dots';
    this.type = 'custom';
    this.renderingMode = '3d';
    this.programs = new Map();
    this.instances = Object.fromEntries(WEATHER_TYPES.map((type) => [type, new Float32Array()]));
    this.instanceWriters = Object.fromEntries(WEATHER_TYPES.map((type) => [type, new InstanceWriter()]));
    this.counts = Object.fromEntries(WEATHER_TYPES.map((type) => [type, 0]));
    this.bufferCapacity = Object.fromEntries(WEATHER_TYPES.map((type) => [type, 0]));
    this.hazardInstances = new Float32Array();
    this.hazardInstanceWriter = new InstanceWriter(HAZARD_INSTANCE_STRIDE);
    this.hazardCount = 0;
    this.hazardBufferCapacity = 0;
    this.hazardSizeMapping = DEFAULT_DOTS_HAZARD_SIZE_MAPPING;
    this.pyramid = new GeographicSymbolPyramid();
    this.samples = [];
    this.transition = null;
    this.transitionProgress = 1;
    this.temporal = null;
    this.temporalProgress = 0;
    this.buffersDirty = true;
    this.active = true;
    this.hazardsOnly = false;
  }

  onAdd(map, gl) {
    this.map = map;
    this.instanceBuffers = Object.fromEntries(WEATHER_TYPES.map((type) => [type, gl.createBuffer()]));
    this.hazardInstanceBuffer = gl.createBuffer();
    this.vertexBuffers = Object.fromEntries(WEATHER_TYPES.map((type) => [type, gl.createBuffer()]));
    const verticesByType = { rain: QUAD, strong: QUAD, storm: STORM, hail: HAIL, squall1: SQUALL_1, squall2: SQUALL_2, squall3: SQUALL_3, hurricane: HURRICANE };
    for (const type of WEATHER_TYPES) {
      const vertices = verticesByType[type];
      gl.bindBuffer(gl.ARRAY_BUFFER, this.vertexBuffers[type]);
      gl.bufferData(gl.ARRAY_BUFFER, vertices, gl.STATIC_DRAW);
    }
  }

  onRemove(map, gl) {
    for (const programs of this.programs.values()) { gl.deleteProgram(programs.circle.program); gl.deleteProgram(programs.hazard.program); }
    for (const buffer of [...Object.values(this.instanceBuffers || {}), this.hazardInstanceBuffer, ...Object.values(this.vertexBuffers || {})]) if (buffer) gl.deleteBuffer(buffer);
  }

  activeLevels() {
    if (this.transition) return [this.transition.fromSamples[0].level, this.transition.toSamples[0].level];
    return this.samples.length ? [this.samples[0].level] : [];
  }

  evaluateKeyframe(index, reusableStates = null) {
    const time = index / TEMPORAL_FRAME_COUNT;
    return this.pyramid.evaluate(this.activeLevels(), prepareGeographicFieldFrame(time), reusableStates);
  }

  rebuildTemporal(time) {
    const frame = geographicTemporalFrameAt(time);
    const nextIndex = (frame.index + 1) % TEMPORAL_FRAME_COUNT;
    this.temporal = {
      index: frame.index,
      nextIndex,
      frames0: this.evaluateKeyframe(frame.index),
      frames1: this.evaluateKeyframe(nextIndex)
    };
    this.temporalProgress = frame.progress;
    this.rebuildInstances();
  }

  setSamples(samples, time) {
    this.samples = samples;
    this.transition = null;
    if (this.active) this.rebuildTemporal(time);
    else this.temporal = null;
  }

  setActive(active) {
    this.active = active;
    this.map?.triggerRepaint();
  }

  setPresentation(hazardsOnly) {
    this.hazardsOnly = hazardsOnly;
    this.map?.triggerRepaint();
  }

  setTransition(fromSamples, toSamples, time, progress = 0) {
    this.samples = toSamples;
    this.transition = { fromSamples, toSamples };
    this.transitionProgress = progress;
    if (this.active) this.rebuildTemporal(time);
    else this.temporal = null;
  }

  setTransitionProgress(progress) {
    this.transitionProgress = progress;
    this.map?.triggerRepaint();
  }

  updateWeather(time) {
    if (!this.samples.length) return;
    const frame = geographicTemporalFrameAt(time);
    if (!this.temporal || frame.index !== this.temporal.index) {
      if (this.temporal && frame.index === this.temporal.nextIndex) {
        this.temporal.index = frame.index;
        this.temporal.nextIndex = (frame.index + 1) % TEMPORAL_FRAME_COUNT;
        const reusableStates = this.temporal.frames0;
        this.temporal.frames0 = this.temporal.frames1;
        this.temporal.frames1 = this.evaluateKeyframe(this.temporal.nextIndex, reusableStates);
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
    const { frames0, frames1 } = this.temporal;
    if (!this.transition) {
      const level = this.samples[0].level;
      const anchors = this.pyramid.levels.get(level).anchors;
      for (const type of ['rain', 'strong']) {
        this.setInstances(type, buildSameLevelTemporalInstances(frames0[level], frames1[level], anchors, RADIUS_KEYS[type], this.instanceWriters[type]));
      }
      this.hazardInstances = buildSameLevelHazardInstances(
        frames0[level], frames1[level], anchors, this.pyramid.levels.get(level).samples[0].spacing, this.hazardInstanceWriter
      );
    } else {
      const fromLevel = this.transition.fromSamples[0].level;
      const toLevel = this.transition.toSamples[0].level;
      const hierarchical = isHierarchicalTransition(fromLevel, toLevel);
      const refining = toLevel > fromLevel;
      const coarseLevel = refining ? fromLevel : toLevel;
      const fineLevel = refining ? toLevel : fromLevel;
      const pairs = hierarchical ? null : this.pyramid.directPairsFor(Math.min(fromLevel, toLevel), Math.max(fromLevel, toLevel));
      const fromIsLower = fromLevel < toLevel;
      const coarseAnchors = this.pyramid.levels.get(coarseLevel).anchors;
      const fineAnchors = this.pyramid.levels.get(fineLevel).anchors;
      const fromAnchors = this.pyramid.levels.get(fromLevel).anchors;
      const toAnchors = this.pyramid.levels.get(toLevel).anchors;

      for (const type of ['rain', 'strong']) {
        const data = hierarchical
          ? buildHierarchicalTemporalInstances(
            frames0[coarseLevel],
            frames0[fineLevel],
            frames1[coarseLevel],
            frames1[fineLevel],
            coarseAnchors,
            fineAnchors,
            this.pyramid.parents.get(fineLevel).childIndices,
            RADIUS_KEYS[type],
            refining,
            this.instanceWriters[type]
          )
          : buildDirectTemporalInstances(
            frames0[fromLevel],
            frames0[toLevel],
            frames1[fromLevel],
            frames1[toLevel],
            fromAnchors,
            toAnchors,
            pairs,
            fromIsLower,
            RADIUS_KEYS[type],
            this.instanceWriters[type]
          );
        this.setInstances(type, data);
      }

      this.hazardInstances = hierarchical
        ? buildHierarchicalHazardInstances(
          frames0[coarseLevel], frames0[fineLevel], frames1[coarseLevel], frames1[fineLevel],
          coarseAnchors, fineAnchors, this.pyramid.parents.get(fineLevel).childIndices,
          this.pyramid.levels.get(coarseLevel).samples[0].spacing,
          this.pyramid.levels.get(fineLevel).samples[0].spacing,
          refining, this.hazardInstanceWriter
        )
        : buildDirectHazardInstances(
          frames0[fromLevel], frames0[toLevel], frames1[fromLevel], frames1[toLevel],
          fromAnchors, toAnchors, pairs, fromIsLower,
          this.pyramid.levels.get(fromLevel).samples[0].spacing,
          this.pyramid.levels.get(toLevel).samples[0].spacing,
          this.hazardInstanceWriter
        );
    }

    this.hazardCount = this.hazardInstances.length / HAZARD_INSTANCE_STRIDE;

    this.buffersDirty = true;
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
    const hazardBytes = this.hazardInstances.byteLength;
    gl.bindBuffer(gl.ARRAY_BUFFER, this.hazardInstanceBuffer);
    if (hazardBytes > this.hazardBufferCapacity) {
      gl.bufferData(gl.ARRAY_BUFFER, hazardBytes, gl.STREAM_DRAW);
      this.hazardBufferCapacity = hazardBytes;
    }
    if (hazardBytes) gl.bufferSubData(gl.ARRAY_BUFFER, 0, this.hazardInstances);
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
      const vertexCount = type === 'rain' || type === 'strong'
        ? 6
        : (type === 'storm' ? STORM.length : type === 'hail' ? HAIL.length : type === 'squall1' ? SQUALL_1.length : type === 'squall2' ? SQUALL_2.length : type === 'squall3' ? SQUALL_3.length : HURRICANE.length) / 2;
      gl.drawArraysInstanced(gl.TRIANGLES, 0, vertexCount, this.counts[type]);
    }

    for (const location of [locations.startCenter, locations.endCenter, locations.startTime0, locations.startTime1, locations.endTime0, locations.endTime1]) {
      gl.vertexAttribDivisor(location, 0);
    }
  }

  renderHazardInstances(gl, entry, projection) {
    if (!this.hazardCount) return;
    const { program, locations } = entry;
    gl.useProgram(program);
    setGeographicProjection(gl, locations, projection);
    gl.uniform1f(locations.temporalProgress, this.temporalProgress);
    gl.uniform1f(locations.lodTransition, this.transitionProgress);
    gl.uniform2f(locations.stormSize, this.hazardSizeMapping.storm.min, this.hazardSizeMapping.storm.max);
    gl.uniform2f(locations.hailSize, this.hazardSizeMapping.hail.min, this.hazardSizeMapping.hail.max);
    gl.uniform2f(locations.squallSize, this.hazardSizeMapping.squall.min, this.hazardSizeMapping.squall.max);

    gl.bindBuffer(gl.ARRAY_BUFFER, this.hazardInstanceBuffer);
    for (const location of [locations.startCenter, locations.endCenter, locations.startHazard0, locations.startHazard1, locations.endHazard0, locations.endHazard1, locations.startSpacing, locations.endSpacing]) {
      gl.enableVertexAttribArray(location);
      gl.vertexAttribDivisor(location, 1);
    }
    gl.vertexAttribPointer(locations.startCenter, 2, gl.FLOAT, false, HAZARD_INSTANCE_BYTES, 0);
    gl.vertexAttribPointer(locations.endCenter, 2, gl.FLOAT, false, HAZARD_INSTANCE_BYTES, 8);
    gl.vertexAttribPointer(locations.startHazard0, 4, gl.FLOAT, false, HAZARD_INSTANCE_BYTES, 16);
    gl.vertexAttribPointer(locations.startHazard1, 4, gl.FLOAT, false, HAZARD_INSTANCE_BYTES, 32);
    gl.vertexAttribPointer(locations.endHazard0, 4, gl.FLOAT, false, HAZARD_INSTANCE_BYTES, 48);
    gl.vertexAttribPointer(locations.endHazard1, 4, gl.FLOAT, false, HAZARD_INSTANCE_BYTES, 64);
    gl.vertexAttribPointer(locations.startSpacing, 1, gl.FLOAT, false, HAZARD_INSTANCE_BYTES, 80);
    gl.vertexAttribPointer(locations.endSpacing, 1, gl.FLOAT, false, HAZARD_INSTANCE_BYTES, 84);

    for (const type of HAZARD_TYPES) {
      gl.bindBuffer(gl.ARRAY_BUFFER, this.vertexBuffers[type]);
      gl.enableVertexAttribArray(locations.vertex);
      gl.vertexAttribPointer(locations.vertex, 2, gl.FLOAT, false, 0, 0);
      gl.uniform1i(locations.hazardType, type === 'storm' ? 1 : type === 'hail' ? 2 : type === 'squall1' ? 3 : type === 'squall2' ? 4 : type === 'squall3' ? 5 : 6);
      gl.uniform4fv(locations.color, COLORS[type]);
      const vertexCount = type === 'storm' ? STORM.length : type === 'hail' ? HAIL.length : type.startsWith('squall') ? SQUALL_1.length : HURRICANE.length;
      gl.drawArraysInstanced(gl.TRIANGLES, 0, vertexCount / 2, this.hazardCount);
    }

    for (const location of [locations.startCenter, locations.endCenter, locations.startHazard0, locations.startHazard1, locations.endHazard0, locations.endHazard1, locations.startSpacing, locations.endSpacing]) {
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
    if (!this.hazardsOnly) this.renderInstances(gl, programs.circle, args.defaultProjectionData, ['rain', 'strong']);
    this.renderHazardInstances(gl, programs.hazard, args.defaultProjectionData);
    gl.disable(gl.POLYGON_OFFSET_FILL);
    gl.depthMask(true);
  }
}
