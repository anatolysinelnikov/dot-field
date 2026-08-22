import { GeographicSymbolPyramid, STORM_INNER_RATIO } from './geographic-symbol-pyramid.js';

const COLORS = { rain: [0, 0.565, 1, 1], strong: [0, 0, 1, 1], storm: [1, 0, 1, 1], hail: [1, 0.831, 0, 1] };
const QUAD = new Float32Array([-1, -1, 1, -1, 1, 1, -1, -1, 1, 1, -1, 1]);

function circularPoints(count) {
  return Array.from({ length: count }, (_, index) => {
    const angle = -Math.PI / 2 + index * Math.PI * 2 / count;
    return [Math.cos(angle), Math.sin(angle)];
  });
}
const HAIL = circularPoints(6);
const STORM = circularPoints(8).map((point, index) => {
  const scale = index % 2 === 0 ? 1 : STORM_INNER_RATIO;
  return [point[0] * scale, point[1] * scale];
});

function appendShape(vertices, centerX, centerY, radius, points) {
  for (let index = 0; index < points.length; index++) {
    const current = points[index];
    const next = points[(index + 1) % points.length];
    vertices.push(centerX, centerY, centerX + current[0] * radius, centerY + current[1] * radius, centerX + next[0] * radius, centerY + next[1] * radius);
  }
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
    circle
      ? 'in vec2 a_corner;\nin vec2 a_center;\nin float a_startRadius;\nin float a_endRadius;\nuniform float u_transition;\nout vec2 v_local;\nvoid main() {\n  v_local = a_corner;\n  float radius = mix(a_startRadius, a_endRadius, u_transition);\n  gl_Position = projectTile(a_center + a_corner * radius);\n}'
      : 'in vec2 a_pos;\nvoid main() { gl_Position = projectTile(a_pos); }'
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

function circleRadii(symbols) {
  const result = { rain: new Map(), strong: new Map() };
  for (const symbol of symbols.values()) {
    if (symbol.rainRadius > 0) result.rain.set(symbol.id, { sample: symbol.sample, radius: symbol.rainRadius });
    if (symbol.strongRadius > 0) result.strong.set(symbol.id, { sample: symbol.sample, radius: symbol.strongRadius });
  }
  return result;
}

function makeEndpoint(symbols) {
  return {
    circles: circleRadii(symbols),
    hazards: [...symbols.values()].filter((symbol) => symbol.hazardType).map((symbol) => ({
      id: symbol.id, sample: symbol.sample, type: symbol.hazardType, radius: symbol.hazardRadius
    }))
  };
}

function joinCircles(from, to) {
  const values = [];
  for (const id of new Set([...from.keys(), ...to.keys()])) {
    const start = from.get(id);
    const end = to.get(id);
    const sample = end?.sample || start.sample;
    values.push(sample.mercator[0], sample.mercator[1], start?.radius || 0, end?.radius || 0);
  }
  return new Float32Array(values);
}

function makeHazardGeometry(hazards, type) {
  const vertices = [];
  for (const hazard of hazards) {
    if (hazard.type === type) appendShape(vertices, hazard.sample.mercator[0], hazard.sample.mercator[1], hazard.radius, type === 'hail' ? HAIL : STORM);
  }
  return new Float32Array(vertices);
}

export class GeographicDotsLayer {
  constructor() {
    this.id = 'geographic-weather-dots';
    this.type = 'custom';
    this.renderingMode = '3d';
    this.programs = new Map();
    this.instances = { rain: new Float32Array(), strong: new Float32Array() };
    this.geometry = { storm: { from: new Float32Array(), to: new Float32Array() }, hail: { from: new Float32Array(), to: new Float32Array() } };
    this.counts = { rain: 0, strong: 0, storm: { from: 0, to: 0 }, hail: { from: 0, to: 0 } };
    this.pyramid = new GeographicSymbolPyramid();
    this.representations = new Map();
    this.samples = [];
    this.transition = null;
    this.transitionProgress = 1;
    this.buffersDirty = true;
  }

  onAdd(map, gl) {
    this.map = map;
    this.buffers = { storm: { from: gl.createBuffer(), to: gl.createBuffer() }, hail: { from: gl.createBuffer(), to: gl.createBuffer() } };
    this.instanceBuffers = { rain: gl.createBuffer(), strong: gl.createBuffer() };
    this.quadBuffer = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, this.quadBuffer);
    gl.bufferData(gl.ARRAY_BUFFER, QUAD, gl.STATIC_DRAW);
  }

  onRemove(map, gl) {
    for (const entry of this.programs.values()) { gl.deleteProgram(entry.circle); gl.deleteProgram(entry.polygon); }
    for (const type of ['storm', 'hail']) for (const side of ['from', 'to']) gl.deleteBuffer(this.buffers?.[type]?.[side]);
    for (const buffer of [...Object.values(this.instanceBuffers || {}), this.quadBuffer]) if (buffer) gl.deleteBuffer(buffer);
  }

  setSamples(samples, time) {
    this.samples = samples;
    this.transition = null;
    this.representations = this.pyramid.evaluate(time);
    const data = makeEndpoint(this.representations.get(samples[0].level));
    this.setEndpointVisual(data, data, 1);
  }

  setTransition(fromSamples, toSamples, time, progress = 0) {
    this.samples = toSamples;
    this.transition = { fromSamples, toSamples };
    this.representations = this.pyramid.evaluate(time);
    this.setEndpointVisual(
      makeEndpoint(this.representations.get(fromSamples[0].level)),
      makeEndpoint(this.representations.get(toSamples[0].level)),
      progress
    );
  }

  setTransitionProgress(progress) {
    this.transitionProgress = progress;
    this.map?.triggerRepaint();
  }

  setEndpointVisual(from, to, progress) {
    for (const type of ['rain', 'strong']) {
      this.instances[type] = joinCircles(from.circles[type], to.circles[type]);
      this.counts[type] = this.instances[type].length / 4;
    }
    for (const type of ['storm', 'hail']) {
      this.geometry[type].from = makeHazardGeometry(from.hazards, type);
      this.geometry[type].to = makeHazardGeometry(to.hazards, type);
      this.counts[type].from = this.geometry[type].from.length / 2;
      this.counts[type].to = this.geometry[type].to.length / 2;
    }
    this.transitionProgress = progress;
    this.buffersDirty = true;
    this.map?.triggerRepaint();
  }

  updateWeather(time) {
    if (this.transition) this.setTransition(this.transition.fromSamples, this.transition.toSamples, time, this.transitionProgress);
    else this.setSamples(this.samples, time);
  }

  uploadBuffers(gl) {
    if (!this.buffersDirty || !this.buffers) return;
    for (const type of ['storm', 'hail']) for (const side of ['from', 'to']) {
      gl.bindBuffer(gl.ARRAY_BUFFER, this.buffers[type][side]);
      gl.bufferData(gl.ARRAY_BUFFER, this.geometry[type][side], gl.STREAM_DRAW);
    }
    for (const type of ['rain', 'strong']) {
      gl.bindBuffer(gl.ARRAY_BUFFER, this.instanceBuffers[type]);
      gl.bufferData(gl.ARRAY_BUFFER, this.instances[type], gl.STREAM_DRAW);
    }
    this.buffersDirty = false;
  }

  programsFor(gl, shaderData) {
    let programs = this.programs.get(shaderData.variantName);
    if (!programs) {
      programs = { circle: makeProgram(gl, shaderData, 'circle'), polygon: makeProgram(gl, shaderData, 'polygon') };
      this.programs.set(shaderData.variantName, programs);
    }
    return programs;
  }

  renderCircles(gl, program, projection) {
    gl.useProgram(program);
    setProjection(gl, program, projection);
    gl.uniform1f(gl.getUniformLocation(program, 'u_transition'), this.transitionProgress);
    const corner = gl.getAttribLocation(program, 'a_corner');
    const center = gl.getAttribLocation(program, 'a_center');
    const startRadius = gl.getAttribLocation(program, 'a_startRadius');
    const endRadius = gl.getAttribLocation(program, 'a_endRadius');
    const color = gl.getUniformLocation(program, 'u_color');
    gl.bindBuffer(gl.ARRAY_BUFFER, this.quadBuffer);
    gl.enableVertexAttribArray(corner);
    gl.vertexAttribPointer(corner, 2, gl.FLOAT, false, 0, 0);
    for (const type of ['rain', 'strong']) {
      if (!this.counts[type]) continue;
      gl.bindBuffer(gl.ARRAY_BUFFER, this.instanceBuffers[type]);
      gl.enableVertexAttribArray(center);
      gl.vertexAttribPointer(center, 2, gl.FLOAT, false, 16, 0);
      gl.vertexAttribDivisor(center, 1);
      gl.enableVertexAttribArray(startRadius);
      gl.vertexAttribPointer(startRadius, 1, gl.FLOAT, false, 16, 8);
      gl.vertexAttribDivisor(startRadius, 1);
      gl.enableVertexAttribArray(endRadius);
      gl.vertexAttribPointer(endRadius, 1, gl.FLOAT, false, 16, 12);
      gl.vertexAttribDivisor(endRadius, 1);
      gl.uniform4fv(color, COLORS[type]);
      gl.drawArraysInstanced(gl.TRIANGLES, 0, 6, this.counts[type]);
    }
    gl.vertexAttribDivisor(center, 0);
    gl.vertexAttribDivisor(startRadius, 0);
    gl.vertexAttribDivisor(endRadius, 0);
  }

  renderPolygons(gl, program, projection) {
    gl.useProgram(program);
    setProjection(gl, program, projection);
    const position = gl.getAttribLocation(program, 'a_pos');
    const color = gl.getUniformLocation(program, 'u_color');
    for (const type of ['storm', 'hail']) for (const side of ['from', 'to']) {
      const alpha = side === 'from' ? 1 - this.transitionProgress : this.transitionProgress;
      if (!alpha || !this.counts[type][side]) continue;
      gl.bindBuffer(gl.ARRAY_BUFFER, this.buffers[type][side]);
      gl.enableVertexAttribArray(position);
      gl.vertexAttribPointer(position, 2, gl.FLOAT, false, 0, 0);
      gl.uniform4fv(color, [...COLORS[type].slice(0, 3), alpha]);
      gl.drawArrays(gl.TRIANGLES, 0, this.counts[type][side]);
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
    this.renderCircles(gl, programs.circle, args.defaultProjectionData);
    this.renderPolygons(gl, programs.polygon, args.defaultProjectionData);
    gl.disable(gl.POLYGON_OFFSET_FILL);
    gl.depthMask(true);
  }
}
