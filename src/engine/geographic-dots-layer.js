import { geographicIntensityAt } from './geography.js';
import { intensityToRadius, strongPrecipitationIntensity } from './precipitation-mapping.js';
import { hazardStateAppearance } from './hazard-renderer.js';
import { resolveHazardState } from './lod.js';

const COLORS = {
  rain: [0, 0.565, 1, 1],
  strong: [0, 0, 1, 1],
  storm: [1, 0, 1, 1],
  hail: [1, 0.831, 0, 1]
};

function mercatorCoordinate(longitude, latitude) {
  const clampedLatitude = Math.max(-85.05112878, Math.min(85.05112878, latitude));
  const latitudeRadians = clampedLatitude * Math.PI / 180;
  return [
    (longitude + 180) / 360,
    (1 - Math.log(Math.tan(Math.PI / 4 + latitudeRadians / 2)) / Math.PI) / 2
  ];
}

function appendVertex(vertices, longitude, latitude) {
  const [x, y] = mercatorCoordinate(longitude, latitude);
  // MapLibre's projection helper receives whole-world mercator coordinates
  // (0..1) for custom layers when supplied with tileMercatorCoords below.
  vertices.push(x, y);
}

function appendShape(vertices, longitude, latitude, radius, points) {
  const radians = latitude * Math.PI / 180;
  const longitudeScale = Math.max(0.16, Math.cos(radians));
  for (let index = 0; index < points.length; index++) {
    const current = points[index];
    const next = points[(index + 1) % points.length];
    appendVertex(vertices, longitude, latitude);
    appendVertex(vertices, longitude + current[0] * radius * 180 / Math.PI / longitudeScale, latitude + current[1] * radius * 180 / Math.PI);
    appendVertex(vertices, longitude + next[0] * radius * 180 / Math.PI / longitudeScale, latitude + next[1] * radius * 180 / Math.PI);
  }
}

function circularPoints(count) {
  return Array.from({ length: count }, (_, index) => {
    const angle = -Math.PI / 2 + index * Math.PI * 2 / count;
    return [Math.cos(angle), Math.sin(angle)];
  });
}

const CIRCLE = circularPoints(12);
const HAIL = circularPoints(6);
const STORM = circularPoints(8).map((point, index) => {
  const scale = index % 2 === 0 ? 1 : 0.38;
  return [point[0] * scale, point[1] * scale];
});

function compileShader(gl, type, source) {
  const shader = gl.createShader(type);
  gl.shaderSource(shader, source);
  gl.compileShader(shader);
  if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(shader) || 'Weather shader compilation failed.');
  return shader;
}

function makeProgram(gl, shaderData) {
  const vertexSource = `#version 300 es
${shaderData.vertexShaderPrelude}
${shaderData.define}
in vec2 a_pos;
void main() { gl_Position = projectTile(a_pos); }`;
  const fragmentSource = `#version 300 es
precision highp float;
uniform vec4 u_color;
out vec4 fragColor;
void main() { fragColor = u_color; }`;
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

export class GeographicDotsLayer {
  constructor() {
    this.id = 'geographic-weather-dots';
    this.type = 'custom';
    this.renderingMode = '3d';
    this.programs = new Map();
    this.geometry = { rain: new Float32Array(), strong: new Float32Array(), storm: new Float32Array(), hail: new Float32Array() };
    this.counts = { rain: 0, strong: 0, storm: 0, hail: 0 };
    this.samples = [];
    this.buffersDirty = true;
  }

  onAdd(map, gl) {
    this.map = map;
    this.gl = gl;
    this.buffers = Object.fromEntries(Object.keys(this.geometry).map((key) => [key, gl.createBuffer()]));
  }

  onRemove(map, gl) {
    for (const program of this.programs.values()) gl.deleteProgram(program);
    for (const buffer of Object.values(this.buffers || {})) gl.deleteBuffer(buffer);
  }

  setSamples(samples, time) {
    this.samples = samples;
    this.updateWeather(time);
  }

  updateWeather(time) {
    const vertices = { rain: [], strong: [], storm: [], hail: [] };
    for (const sample of this.samples) {
      const [longitude, latitude] = sample.vertex.lngLat;
      const value = geographicIntensityAt(longitude, latitude, time);
      const rainRadius = intensityToRadius(value.rain, sample.spacing, 'rain');
      if (rainRadius > 0) appendShape(vertices.rain, longitude, latitude, rainRadius, CIRCLE);
      const strongRadius = intensityToRadius(strongPrecipitationIntensity(value.rain), sample.spacing, 'rain');
      if (strongRadius > 0) appendShape(vertices.strong, longitude, latitude, strongRadius, CIRCLE);
      const appearance = hazardStateAppearance(value, resolveHazardState(value), sample.spacing);
      if (appearance.radius > 0) appendShape(vertices[appearance.type], longitude, latitude, appearance.radius, appearance.type === 'hail' ? HAIL : STORM);
    }
    for (const key of Object.keys(vertices)) {
      this.geometry[key] = new Float32Array(vertices[key]);
      this.counts[key] = this.geometry[key].length / 2;
    }
    this.buffersDirty = true;
    this.map?.triggerRepaint();
  }

  uploadBuffers(gl) {
    if (!this.buffersDirty || !this.buffers) return;
    for (const key of Object.keys(this.geometry)) {
      gl.bindBuffer(gl.ARRAY_BUFFER, this.buffers[key]);
      gl.bufferData(gl.ARRAY_BUFFER, this.geometry[key], gl.STREAM_DRAW);
    }
    this.buffersDirty = false;
  }

  render(gl, args) {
    this.uploadBuffers(gl);
    const shaderData = args.shaderData;
    let program = this.programs.get(shaderData.variantName);
    if (!program) {
      program = makeProgram(gl, shaderData);
      this.programs.set(shaderData.variantName, program);
    }
    gl.useProgram(program);
    const projection = args.defaultProjectionData;
    setMatrix(gl, program, 'u_matrix', projection.mainMatrix);
    setMatrix(gl, program, 'u_projection_fallback_matrix', projection.fallbackMatrix);
    setMatrix(gl, program, 'u_projection_matrix', projection.mainMatrix);
    const tileCoordinates = gl.getUniformLocation(program, 'u_projection_tile_mercator_coords');
    if (tileCoordinates) gl.uniform4f(tileCoordinates, ...projection.tileMercatorCoords);
    const clippingPlane = gl.getUniformLocation(program, 'u_projection_clipping_plane');
    if (clippingPlane && projection.clippingPlane) gl.uniform4f(clippingPlane, ...projection.clippingPlane);
    const transition = gl.getUniformLocation(program, 'u_projection_transition');
    if (transition) gl.uniform1f(transition, projection.projectionTransition);

    const position = gl.getAttribLocation(program, 'a_pos');
    const color = gl.getUniformLocation(program, 'u_color');
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
    gl.enable(gl.DEPTH_TEST);
    gl.depthMask(false);
    gl.enable(gl.POLYGON_OFFSET_FILL);
    gl.polygonOffset(-1, -1);
    for (const key of Object.keys(this.geometry)) {
      if (!this.counts[key]) continue;
      gl.bindBuffer(gl.ARRAY_BUFFER, this.buffers[key]);
      gl.enableVertexAttribArray(position);
      gl.vertexAttribPointer(position, 2, gl.FLOAT, false, 0, 0);
      gl.uniform4fv(color, COLORS[key]);
      gl.drawArrays(gl.TRIANGLES, 0, this.counts[key]);
    }
    gl.disable(gl.POLYGON_OFFSET_FILL);
    gl.depthMask(true);
  }
}
