import { prepareGeographicFieldFrame } from './geography.js';
import { geographicTemporalFrameAt, setGeographicProjection, TEMPORAL_FRAME_COUNT } from './geographic-layer-utils.js';
import { lngLatToMercator } from './geographic-lod.js';
import { geographicHazardRadii } from './hazard-renderer.js';
import { intensityToRadius, strongPrecipitationIntensity } from './precipitation-mapping.js';
import {
  GeographicSymbolPyramid,
  REFERENCE_GRID_LEVEL,
  STORM_INNER_RATIO,
  evaluateDirect,
  reduceCenteredState
} from './geographic-symbol-pyramid.js';

const COLORS = { rain: [0, 0.565, 1, 1], strong: [0, 0, 1, 1], storm: [1, 0, 1, 1], hail: [1, 0.831, 0, 1] };
const INSTANCE_STRIDE = 8;
const INSTANCE_BYTES = INSTANCE_STRIDE * Float32Array.BYTES_PER_ELEMENT;
const WEATHER_TYPES = ['rain', 'strong', 'storm', 'hail'];
const RADIUS_KEYS = { rain: 'rainRadius', strong: 'strongRadius', storm: 'stormRadius', hail: 'hailRadius' };
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

const HAIL = unitShape(circularPoints(6));
const STORM = unitShape(circularPoints(8).map((point, index) => {
  const scale = index % 2 === 0 ? 1 : STORM_INNER_RATIO;
  return [point[0] * scale, point[1] * scale];
}));

export function areaLinearRadius(startRadius, endRadius, progress) {
  return Math.sqrt(startRadius * startRadius + (endRadius * endRadius - startRadius * startRadius) * progress);
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

function sourceAxisSpacing(axis, index, project) {
  const previous = index > 0 ? Math.abs(project(axis[index], axis[index - 1])) : 0;
  const next = index + 1 < axis.length ? Math.abs(project(axis[index + 1], axis[index])) : 0;
  if (!previous) return next;
  if (!next) return previous;
  return (previous + next) / 2;
}

function sourceDiagnosticGeometry(field) {
  const longitudeCount = field.longitudes.length;
  const latitudeCount = field.latitudes.length;
  const anchors = new Float64Array(longitudeCount * latitudeCount * 2);
  const spacing = new Float64Array(longitudeCount * latitudeCount);
  for (let latitudeIndex = 0; latitudeIndex < latitudeCount; latitudeIndex++) {
    const latitude = field.latitudes[latitudeIndex];
    for (let longitudeIndex = 0; longitudeIndex < longitudeCount; longitudeIndex++) {
      const index = field.index(longitudeIndex, latitudeIndex);
      const [x, y] = lngLatToMercator(field.longitudes[longitudeIndex], latitude);
      const dx = sourceAxisSpacing(field.longitudes, longitudeIndex, (left, right) => (
        lngLatToMercator(left, latitude)[0] - lngLatToMercator(right, latitude)[0]
      ));
      const dy = sourceAxisSpacing(field.latitudes, latitudeIndex, (upper, lower) => (
        lngLatToMercator(field.longitudes[longitudeIndex], upper)[1]
          - lngLatToMercator(field.longitudes[longitudeIndex], lower)[1]
      ));
      anchors[index * 2] = x;
      anchors[index * 2 + 1] = y;
      spacing[index] = Math.sqrt(dx * dy);
    }
  }
  return { anchors, spacing };
}

function makeDotsState(length, reusable) {
  if (reusable?.rainRadius.length === length) return reusable;
  return {
    rainRadius: new Float64Array(length),
    strongRadius: new Float64Array(length),
    stormRadius: new Float64Array(length),
    hailRadius: new Float64Array(length)
  };
}

function evaluateSource(field, geometry, reusable) {
  const state = makeDotsState(geometry.spacing.length, reusable);
  const value = { rain: 0, storm: 0, hail: 0 };
  const hazard = { stormRadius: 0, hailRadius: 0 };
  for (let index = 0; index < geometry.spacing.length; index++) {
    value.rain = field.rain[index];
    value.storm = field.storm[index];
    value.hail = field.hail[index];
    const spacing = geometry.spacing[index];
    state.rainRadius[index] = intensityToRadius(value.rain, spacing, 'rain');
    state.strongRadius[index] = intensityToRadius(strongPrecipitationIntensity(value.rain), spacing, 'rain');
    geographicHazardRadii(value, spacing, hazard);
    state.stormRadius[index] = hazard.stormRadius;
    state.hailRadius[index] = hazard.hailRadius;
  }
  return state;
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
  constructor() {
    this.id = 'geographic-weather-dots';
    this.type = 'custom';
    this.renderingMode = '3d';
    this.programs = new Map();
    this.instances = { rain: new Float32Array(), strong: new Float32Array(), storm: new Float32Array(), hail: new Float32Array() };
    this.instanceWriters = { rain: new InstanceWriter(), strong: new InstanceWriter(), storm: new InstanceWriter(), hail: new InstanceWriter() };
    this.counts = { rain: 0, strong: 0, storm: 0, hail: 0 };
    this.bufferCapacity = { rain: 0, strong: 0, storm: 0, hail: 0 };
    this.pyramid = new GeographicSymbolPyramid();
    this.samples = [];
    this.transition = null;
    this.transitionProgress = 1;
    this.temporal = null;
    this.temporalProgress = 0;
    this.buffersDirty = true;
    this.active = true;
    this.diagnostic = null;
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

  activeLevels() {
    if (this.transition) return [this.transition.fromSamples[0].level, this.transition.toSamples[0].level];
    return this.samples.length ? [this.samples[0].level] : [];
  }

  evaluateKeyframe(index, reusableStates = null) {
    if (this.diagnostic) return this.evaluateDiagnosticKeyframe(index, reusableStates);
    const time = index / TEMPORAL_FRAME_COUNT;
    return this.pyramid.evaluate(this.activeLevels(), prepareGeographicFieldFrame(time), reusableStates);
  }

  evaluateDiagnosticKeyframe(index, reusableState = null) {
    const diagnostic = this.diagnostic;
    if (diagnostic.variant === 'source') return evaluateSource(diagnostic.field, diagnostic.geometry, reusableState);
    const frame = prepareGeographicFieldFrame(index / TEMPORAL_FRAME_COUNT);
    if (diagnostic.variant === 'l13-reduced-grid' || diagnostic.variant === 'l13-reduced-production') {
      diagnostic.reusableStates = this.pyramid.evaluate([13], frame, diagnostic.reusableStates);
      return diagnostic.reusableStates[13];
    }
    if (diagnostic.variant === 'l13-centered') {
      diagnostic.reusableStates = this.pyramid.evaluate([14], frame, diagnostic.reusableStates);
      return reduceCenteredState(
        this.pyramid.levels.get(13),
        diagnostic.reusableStates[14],
        this.pyramid.centeredContributionsFor(),
        reusableState
      );
    }
    return evaluateDirect(this.pyramid.levels.get(diagnostic.level), frame, reusableState);
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

  rebuildDiagnosticTemporal(time) {
    const frame = geographicTemporalFrameAt(time);
    const nextIndex = (frame.index + 1) % TEMPORAL_FRAME_COUNT;
    this.diagnostic.reusableStates = null;
    const frames0 = this.evaluateDiagnosticKeyframe(frame.index);
    const pyramidStates0 = this.diagnostic.reusableStates;
    this.diagnostic.reusableStates = null;
    const frames1 = this.evaluateDiagnosticKeyframe(nextIndex);
    this.temporal = {
      index: frame.index,
      nextIndex,
      frames0,
      frames1,
      pyramidStates0,
      pyramidStates1: this.diagnostic.reusableStates
    };
    this.temporalProgress = frame.progress;
    this.rebuildInstances();
  }

  setSamples(samples, time) {
    this.samples = samples;
    this.transition = null;
    if (this.active) {
      if (this.diagnostic) this.rebuildDiagnosticTemporal(time);
      else this.rebuildTemporal(time);
    }
    else this.temporal = null;
  }

  setDiagnosticVariant(variant, field, time) {
    if (!variant) {
      this.diagnostic = null;
      this.temporal = null;
      if (this.active) this.rebuildTemporal(time);
      return;
    }
    this.diagnostic = {
      variant,
      field,
      level: variant === 'l14-direct' ? 14 : variant === 'source' ? null : 13,
      geometry: variant === 'source' ? sourceDiagnosticGeometry(field) : null,
      reusableStates: null
    };
    this.diagnostic.anchors = variant === 'source'
      ? this.diagnostic.geometry.anchors
      : this.pyramid.levels.get(this.diagnostic.level)[variant === 'l13-reduced-production' ? 'anchors' : 'gridAnchors'];
    if (this.active) this.rebuildDiagnosticTemporal(time);
  }

  setActive(active) {
    this.active = active;
    this.map?.triggerRepaint();
  }

  setTransition(fromSamples, toSamples, time, progress = 0) {
    this.samples = toSamples;
    this.transition = { fromSamples, toSamples };
    this.transitionProgress = progress;
    if (this.active) {
      if (this.diagnostic) this.rebuildDiagnosticTemporal(time);
      else this.rebuildTemporal(time);
    }
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
        if (this.diagnostic?.variant === 'l13-reduced-grid'
          || this.diagnostic?.variant === 'l13-reduced-production'
          || this.diagnostic?.variant === 'l13-centered') {
          this.diagnostic.reusableStates = this.temporal.pyramidStates0;
        }
        this.temporal.frames0 = this.temporal.frames1;
        this.temporal.frames1 = this.evaluateKeyframe(this.temporal.nextIndex, reusableStates);
        this.temporal.pyramidStates0 = this.temporal.pyramidStates1;
        this.temporal.pyramidStates1 = this.diagnostic?.variant === 'l13-reduced-grid'
          || this.diagnostic?.variant === 'l13-reduced-production'
          || this.diagnostic?.variant === 'l13-centered'
          ? this.diagnostic.reusableStates
          : null;
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
    if (this.diagnostic) {
      for (const type of WEATHER_TYPES) {
        this.setInstances(type, buildSameLevelTemporalInstances(frames0, frames1, this.diagnostic.anchors, RADIUS_KEYS[type], this.instanceWriters[type]));
      }
    } else if (!this.transition) {
      const level = this.samples[0].level;
      const anchors = this.pyramid.levels.get(level).anchors;
      for (const type of WEATHER_TYPES) {
        this.setInstances(type, buildSameLevelTemporalInstances(frames0[level], frames1[level], anchors, RADIUS_KEYS[type], this.instanceWriters[type]));
      }
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

      for (const type of WEATHER_TYPES) {
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
    }

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
    this.renderInstances(gl, programs.hazard, args.defaultProjectionData, ['storm', 'hail']);
    gl.disable(gl.POLYGON_OFFSET_FILL);
    gl.depthMask(true);
  }
}
