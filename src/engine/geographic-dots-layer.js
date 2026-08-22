import { LOOP_SECONDS } from './config.js';
import { prepareGeographicFieldFrame } from './geography.js';
import { GeographicSymbolPyramid, REFERENCE_GRID_LEVEL, STORM_INNER_RATIO } from './geographic-symbol-pyramid.js';

const COLORS = { rain: [0, 0.565, 1, 1], strong: [0, 0, 1, 1], storm: [1, 0, 1, 1], hail: [1, 0.831, 0, 1] };
const TEMPORAL_FRAME_SECONDS = 0.1;
const TEMPORAL_FRAME_COUNT = Math.round(LOOP_SECONDS / TEMPORAL_FRAME_SECONDS);
const INSTANCE_STRIDE = 8;
const INSTANCE_BYTES = INSTANCE_STRIDE * Float32Array.BYTES_PER_ELEMENT;
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

function pushInstance(values, startAnchor, endAnchor, startTime0, startTime1, endTime0, endTime1) {
  values.push(startAnchor[0], startAnchor[1], endAnchor[0], endAnchor[1], startTime0, startTime1, endTime0, endTime1);
}

function hasTemporalRadius(radius0, radius1, radius2 = 0, radius3 = 0) {
  return radius0 > 0 || radius1 > 0 || radius2 > 0 || radius3 > 0;
}

export function buildHierarchicalTemporalInstances(coarseTime0, fineTime0, coarseTime1, fineTime1, childIndices, radiusFor, refining) {
  const values = [];
  for (let parentIndex = 0; parentIndex < coarseTime0.length; parentIndex++) {
    const parent0 = coarseTime0[parentIndex];
    const parent1 = coarseTime1[parentIndex];
    const parentRadius0 = radiusFor(parent0);
    const parentRadius1 = radiusFor(parent1);
    if (hasTemporalRadius(parentRadius0, parentRadius1)) {
      if (refining) pushInstance(values, parent0.anchor, parent0.anchor, parentRadius0, parentRadius1, 0, 0);
      else pushInstance(values, parent0.anchor, parent0.anchor, 0, 0, parentRadius0, parentRadius1);
    }

    for (const childIndex of childIndices[parentIndex]) {
      const child0 = fineTime0[childIndex];
      const child1 = fineTime1[childIndex];
      const childRadius0 = radiusFor(child0);
      const childRadius1 = radiusFor(child1);
      if (!hasTemporalRadius(childRadius0, childRadius1)) continue;
      if (refining) pushInstance(values, parent0.anchor, child0.anchor, 0, 0, childRadius0, childRadius1);
      else pushInstance(values, child0.anchor, parent0.anchor, childRadius0, childRadius1, 0, 0);
    }
  }
  return new Float32Array(values);
}

function buildSameLevelTemporalInstances(symbolsTime0, symbolsTime1, radiusFor) {
  const values = [];
  for (let index = 0; index < symbolsTime0.length; index++) {
    const symbol0 = symbolsTime0[index];
    const symbol1 = symbolsTime1[index];
    const radius0 = radiusFor(symbol0);
    const radius1 = radiusFor(symbol1);
    if (hasTemporalRadius(radius0, radius1)) pushInstance(values, symbol0.anchor, symbol0.anchor, radius0, radius1, radius0, radius1);
  }
  return new Float32Array(values);
}

function buildDirectTemporalInstances(fromTime0, toTime0, fromTime1, toTime1, pairs, fromIsLower, radiusFor) {
  const values = [];
  for (let index = 0; index < pairs.length; index += 2) {
    const lowerIndex = pairs[index];
    const higherIndex = pairs[index + 1];
    const fromIndex = fromIsLower ? lowerIndex : higherIndex;
    const toIndex = fromIsLower ? higherIndex : lowerIndex;
    const from0 = fromIndex < 0 ? null : fromTime0[fromIndex];
    const to0 = toIndex < 0 ? null : toTime0[toIndex];
    const from1 = fromIndex < 0 ? null : fromTime1[fromIndex];
    const to1 = toIndex < 0 ? null : toTime1[toIndex];
    const fromRadius0 = from0 ? radiusFor(from0) : 0;
    const fromRadius1 = from1 ? radiusFor(from1) : 0;
    const toRadius0 = to0 ? radiusFor(to0) : 0;
    const toRadius1 = to1 ? radiusFor(to1) : 0;
    if (!hasTemporalRadius(fromRadius0, fromRadius1, toRadius0, toRadius1)) continue;
    pushInstance(values, from0?.anchor || from1?.anchor || to0.anchor, to0?.anchor || to1?.anchor || from0.anchor, fromRadius0, fromRadius1, toRadius0, toRadius1);
  }
  return new Float32Array(values);
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

function setMatrix(gl, location, value) {
  if (location && value) gl.uniformMatrix4fv(location, false, value);
}

function setProjection(gl, locations, projection) {
  setMatrix(gl, locations.matrix, projection.mainMatrix);
  setMatrix(gl, locations.fallbackMatrix, projection.fallbackMatrix);
  setMatrix(gl, locations.projectionMatrix, projection.mainMatrix);
  if (locations.tileMercatorCoords) gl.uniform4f(locations.tileMercatorCoords, ...projection.tileMercatorCoords);
  if (locations.clippingPlane && projection.clippingPlane) gl.uniform4f(locations.clippingPlane, ...projection.clippingPlane);
  if (locations.projectionTransition) gl.uniform1f(locations.projectionTransition, projection.projectionTransition);
}

function isHierarchicalTransition(fromLevel, toLevel) {
  return Math.abs(fromLevel - toLevel) === 1 && Math.max(fromLevel, toLevel) <= REFERENCE_GRID_LEVEL;
}

function temporalFrameAt(time) {
  const wrapped = ((time % 1) + 1) % 1;
  const rawScaled = wrapped * TEMPORAL_FRAME_COUNT;
  const scaled = Math.abs(rawScaled - Math.round(rawScaled)) < 1e-9 ? Math.round(rawScaled) : rawScaled;
  const index = Math.floor(scaled) % TEMPORAL_FRAME_COUNT;
  return { index, progress: scaled - Math.floor(scaled) };
}

export class GeographicDotsLayer {
  constructor() {
    this.id = 'geographic-weather-dots';
    this.type = 'custom';
    this.renderingMode = '3d';
    this.programs = new Map();
    this.instances = { rain: new Float32Array(), strong: new Float32Array(), storm: new Float32Array(), hail: new Float32Array() };
    this.counts = { rain: 0, strong: 0, storm: 0, hail: 0 };
    this.bufferCapacity = { rain: 0, strong: 0, storm: 0, hail: 0 };
    this.pyramid = new GeographicSymbolPyramid();
    this.samples = [];
    this.transition = null;
    this.transitionProgress = 1;
    this.temporal = null;
    this.temporalProgress = 0;
    this.buffersDirty = true;
  }

  onAdd(map, gl) {
    this.map = map;
    this.instanceBuffers = Object.fromEntries(['rain', 'strong', 'storm', 'hail'].map((type) => [type, gl.createBuffer()]));
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

  evaluateKeyframe(index) {
    const time = index / TEMPORAL_FRAME_COUNT;
    return this.pyramid.evaluate(this.activeLevels(), prepareGeographicFieldFrame(time));
  }

  rebuildTemporal(time) {
    const frame = temporalFrameAt(time);
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
    this.rebuildTemporal(time);
  }

  setTransition(fromSamples, toSamples, time, progress = 0) {
    this.samples = toSamples;
    this.transition = { fromSamples, toSamples };
    this.transitionProgress = progress;
    this.rebuildTemporal(time);
  }

  setTransitionProgress(progress) {
    this.transitionProgress = progress;
    this.map?.triggerRepaint();
  }

  updateWeather(time) {
    if (!this.samples.length) return;
    const frame = temporalFrameAt(time);
    if (!this.temporal || frame.index !== this.temporal.index) {
      if (this.temporal && frame.index === this.temporal.nextIndex) {
        this.temporal.index = frame.index;
        this.temporal.nextIndex = (frame.index + 1) % TEMPORAL_FRAME_COUNT;
        this.temporal.frames0 = this.temporal.frames1;
        this.temporal.frames1 = this.evaluateKeyframe(this.temporal.nextIndex);
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
    const radiusFor = {
      rain: (symbol) => symbol.rainRadius,
      strong: (symbol) => symbol.strongRadius,
      storm: (symbol) => symbol.hazardType === 'storm' ? symbol.hazardRadius : 0,
      hail: (symbol) => symbol.hazardType === 'hail' ? symbol.hazardRadius : 0
    };

    if (!this.transition) {
      const level = this.samples[0].level;
      for (const type of ['rain', 'strong', 'storm', 'hail']) {
        this.setInstances(type, buildSameLevelTemporalInstances(frames0.get(level), frames1.get(level), radiusFor[type]));
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

      for (const type of ['rain', 'strong', 'storm', 'hail']) {
        const data = hierarchical
          ? buildHierarchicalTemporalInstances(
            frames0.get(coarseLevel),
            frames0.get(fineLevel),
            frames1.get(coarseLevel),
            frames1.get(fineLevel),
            this.pyramid.parents.get(fineLevel).childIndices,
            radiusFor[type],
            refining
          )
          : buildDirectTemporalInstances(
            frames0.get(fromLevel),
            frames0.get(toLevel),
            frames1.get(fromLevel),
            frames1.get(toLevel),
            pairs,
            fromIsLower,
            radiusFor[type]
          );
        this.setInstances(type, data);
      }
    }

    this.buffersDirty = true;
    this.map?.triggerRepaint();
  }

  uploadBuffers(gl) {
    if (!this.buffersDirty || !this.instanceBuffers) return;
    for (const type of ['rain', 'strong', 'storm', 'hail']) {
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
    setProjection(gl, locations, projection);
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
