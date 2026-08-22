import { GeographicSymbolPyramid, REFERENCE_GRID_LEVEL, STORM_INNER_RATIO } from './geographic-symbol-pyramid.js';

const COLORS = { rain: [0, 0.565, 1, 1], strong: [0, 0, 1, 1], storm: [1, 0, 1, 1], hail: [1, 0.831, 0, 1] };
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

function pushInstance(values, startAnchor, endAnchor, startRadius, endRadius) {
  values.push(startAnchor[0], startAnchor[1], endAnchor[0], endAnchor[1], startRadius, endRadius);
}

export function buildHierarchicalTransitionInstances(coarseSymbols, fineSymbols, childIndices, radiusFor, refining) {
  const values = [];
  for (let parentIndex = 0; parentIndex < coarseSymbols.length; parentIndex++) {
    const parent = coarseSymbols[parentIndex];
    const parentRadius = radiusFor(parent);
    if (parentRadius > 0) {
      if (refining) pushInstance(values, parent.anchor, parent.anchor, parentRadius, 0);
      else pushInstance(values, parent.anchor, parent.anchor, 0, parentRadius);
    }
    for (const childIndex of childIndices[parentIndex]) {
      const child = fineSymbols[childIndex];
      const childRadius = radiusFor(child);
      if (childRadius <= 0) continue;
      if (refining) pushInstance(values, parent.anchor, child.anchor, 0, childRadius);
      else pushInstance(values, child.anchor, parent.anchor, childRadius, 0);
    }
  }
  return new Float32Array(values);
}

function buildDirectTransitionInstances(fromSymbols, toSymbols, radiusFor) {
  const from = new Map(fromSymbols.map((symbol) => [symbol.id, symbol]));
  const to = new Map(toSymbols.map((symbol) => [symbol.id, symbol]));
  const values = [];
  for (const id of new Set([...from.keys(), ...to.keys()])) {
    const start = from.get(id);
    const end = to.get(id);
    const startRadius = start ? radiusFor(start) : 0;
    const endRadius = end ? radiusFor(end) : 0;
    if (startRadius <= 0 && endRadius <= 0) continue;
    pushInstance(values, start?.anchor || end.anchor, end?.anchor || start.anchor, startRadius, endRadius);
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
    'in vec2 a_vertex;\nin vec2 a_startCenter;\nin vec2 a_endCenter;\nin float a_startRadius;\nin float a_endRadius;\nuniform float u_transition;',
    circle ? 'out vec2 v_local;' : '',
    'void main() {\n  float radius = sqrt(mix(a_startRadius * a_startRadius, a_endRadius * a_endRadius, u_transition));\n  vec2 center = mix(a_startCenter, a_endCenter, u_transition);\n  ' + (circle ? 'v_local = a_vertex;\n  ' : '') + 'gl_Position = projectTile(center + a_vertex * radius);\n}'
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
  return program;
}

function setMatrix(gl, program, name, value) {
  const location = gl.getUniformLocation(program, name);
  if (location && value) gl.uniformMatrix4fv(location, false, value);
}

function setProjection(gl, program, projection) {
  setMatrix(gl, program, 'u_matrix', projection.mainMatrix);
  setMatrix(gl, program, 'u_projection_fallback_matrix', projection.fallbackMatrix);
  setMatrix(gl, program, 'u_projection_matrix', projection.mainMatrix);
  const tiles = gl.getUniformLocation(program, 'u_projection_tile_mercator_coords');
  if (tiles) gl.uniform4f(tiles, ...projection.tileMercatorCoords);
  const plane = gl.getUniformLocation(program, 'u_projection_clipping_plane');
  if (plane && projection.clippingPlane) gl.uniform4f(plane, ...projection.clippingPlane);
  const transition = gl.getUniformLocation(program, 'u_projection_transition');
  if (transition) gl.uniform1f(transition, projection.projectionTransition);
}

function isHierarchicalTransition(from, to) {
  return Math.abs(from.level - to.level) === 1 && Math.max(from.level, to.level) <= REFERENCE_GRID_LEVEL;
}

function transitionInstances(from, to, pyramid, radiusFor) {
  if (!isHierarchicalTransition(from, to)) return buildDirectTransitionInstances(from.symbols, to.symbols, radiusFor);
  const refining = to.level > from.level;
  const coarse = refining ? from : to;
  const fine = refining ? to : from;
  return buildHierarchicalTransitionInstances(
    coarse.symbols,
    fine.symbols,
    pyramid.parents.get(fine.level).childIndices,
    radiusFor,
    refining
  );
}

function makeEndpoint(level, symbols) {
  return { level, symbols };
}

export class GeographicDotsLayer {
  constructor() {
    this.id = 'geographic-weather-dots';
    this.type = 'custom';
    this.renderingMode = '3d';
    this.programs = new Map();
    this.instances = { rain: new Float32Array(), strong: new Float32Array(), storm: new Float32Array(), hail: new Float32Array() };
    this.counts = { rain: 0, strong: 0, storm: 0, hail: 0 };
    this.pyramid = new GeographicSymbolPyramid();
    this.representations = new Map();
    this.samples = [];
    this.transition = null;
    this.transitionProgress = 1;
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
    for (const programs of this.programs.values()) { gl.deleteProgram(programs.circle); gl.deleteProgram(programs.hazard); }
    for (const buffer of [...Object.values(this.instanceBuffers || {}), ...Object.values(this.vertexBuffers || {})]) if (buffer) gl.deleteBuffer(buffer);
  }

  setSamples(samples, time) {
    this.samples = samples;
    this.transition = null;
    const level = samples[0].level;
    this.representations = this.pyramid.evaluate([level], time);
    const endpoint = makeEndpoint(level, this.representations.get(level));
    this.setEndpointVisual(endpoint, endpoint, 1);
  }

  setTransition(fromSamples, toSamples, time, progress = 0) {
    this.samples = toSamples;
    this.transition = { fromSamples, toSamples };
    const fromLevel = fromSamples[0].level;
    const toLevel = toSamples[0].level;
    this.representations = this.pyramid.evaluate([fromLevel, toLevel], time);
    this.setEndpointVisual(
      makeEndpoint(fromLevel, this.representations.get(fromLevel)),
      makeEndpoint(toLevel, this.representations.get(toLevel)),
      progress
    );
  }

  setTransitionProgress(progress) {
    this.transitionProgress = progress;
    this.map?.triggerRepaint();
  }

  setEndpointVisual(from, to, progress) {
    this.instances.rain = transitionInstances(from, to, this.pyramid, (symbol) => symbol.rainRadius);
    this.instances.strong = transitionInstances(from, to, this.pyramid, (symbol) => symbol.strongRadius);
    this.instances.storm = transitionInstances(from, to, this.pyramid, (symbol) => symbol.hazardType === 'storm' ? symbol.hazardRadius : 0);
    this.instances.hail = transitionInstances(from, to, this.pyramid, (symbol) => symbol.hazardType === 'hail' ? symbol.hazardRadius : 0);
    for (const type of ['rain', 'strong', 'storm', 'hail']) this.counts[type] = this.instances[type].length / 6;
    this.transitionProgress = progress;
    this.buffersDirty = true;
    this.map?.triggerRepaint();
  }

  updateWeather(time) {
    if (this.transition) this.setTransition(this.transition.fromSamples, this.transition.toSamples, time, this.transitionProgress);
    else this.setSamples(this.samples, time);
  }

  uploadBuffers(gl) {
    if (!this.buffersDirty || !this.instanceBuffers) return;
    for (const type of ['rain', 'strong', 'storm', 'hail']) {
      gl.bindBuffer(gl.ARRAY_BUFFER, this.instanceBuffers[type]);
      gl.bufferData(gl.ARRAY_BUFFER, this.instances[type], gl.STREAM_DRAW);
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

  renderInstances(gl, program, projection, types) {
    gl.useProgram(program);
    setProjection(gl, program, projection);
    gl.uniform1f(gl.getUniformLocation(program, 'u_transition'), this.transitionProgress);
    const vertex = gl.getAttribLocation(program, 'a_vertex');
    const startCenter = gl.getAttribLocation(program, 'a_startCenter');
    const endCenter = gl.getAttribLocation(program, 'a_endCenter');
    const startRadius = gl.getAttribLocation(program, 'a_startRadius');
    const endRadius = gl.getAttribLocation(program, 'a_endRadius');
    const color = gl.getUniformLocation(program, 'u_color');

    for (const type of types) {
      if (!this.counts[type]) continue;
      gl.bindBuffer(gl.ARRAY_BUFFER, this.vertexBuffers[type]);
      gl.enableVertexAttribArray(vertex);
      gl.vertexAttribPointer(vertex, 2, gl.FLOAT, false, 0, 0);
      gl.bindBuffer(gl.ARRAY_BUFFER, this.instanceBuffers[type]);
      gl.enableVertexAttribArray(startCenter);
      gl.vertexAttribPointer(startCenter, 2, gl.FLOAT, false, 24, 0);
      gl.vertexAttribDivisor(startCenter, 1);
      gl.enableVertexAttribArray(endCenter);
      gl.vertexAttribPointer(endCenter, 2, gl.FLOAT, false, 24, 8);
      gl.vertexAttribDivisor(endCenter, 1);
      gl.enableVertexAttribArray(startRadius);
      gl.vertexAttribPointer(startRadius, 1, gl.FLOAT, false, 24, 16);
      gl.vertexAttribDivisor(startRadius, 1);
      gl.enableVertexAttribArray(endRadius);
      gl.vertexAttribPointer(endRadius, 1, gl.FLOAT, false, 24, 20);
      gl.vertexAttribDivisor(endRadius, 1);
      gl.uniform4fv(color, COLORS[type]);
      gl.drawArraysInstanced(gl.TRIANGLES, 0, type === 'rain' || type === 'strong' ? 6 : ((type === 'storm' ? STORM.length : HAIL.length) / 2), this.counts[type]);
    }

    gl.vertexAttribDivisor(startCenter, 0);
    gl.vertexAttribDivisor(endCenter, 0);
    gl.vertexAttribDivisor(startRadius, 0);
    gl.vertexAttribDivisor(endRadius, 0);
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
