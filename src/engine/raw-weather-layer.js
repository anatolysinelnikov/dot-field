import { lngLatToMercator } from './geographic-lod.js';
import { setGeographicProjection } from './geographic-layer-utils.js';

const PRECIPITATION_BANDS = Object.freeze([
  { upper: 0.003, color: [232 / 255, 248 / 255, 1, 1] },
  { upper: 0.01, color: [200 / 255, 238 / 255, 1, 1] },
  { upper: 0.03, color: [147 / 255, 220 / 255, 1, 1] },
  { upper: 0.1, color: [88 / 255, 197 / 255, 1, 1] },
  { upper: 0.3, color: [34 / 255, 170 / 255, 1, 1] },
  { upper: 1, color: [0, 139 / 255, 1, 1] },
  { upper: 3, color: [0, 104 / 255, 1, 1] },
  { upper: 6, color: [0, 74 / 255, 1, 1] },
  { upper: 10, color: [0, 50 / 255, 222 / 255, 1] },
  { upper: 15, color: [0, 31 / 255, 175 / 255, 1] },
  { upper: 25, color: [0, 17 / 255, 116 / 255, 1] },
  { upper: Infinity, color: [0, 6 / 255, 61 / 255, 1] }
]);
const THUNDERSTORM_COLORS = Object.freeze({
  10: [138 / 255, 77 / 255, 1, 1],
  11: [192 / 255, 0, 1, 1],
  12: [1, 0, 1, 1]
});
const HAIL_COLORS = Object.freeze({
  16: [200 / 255, 154 / 255, 0, 1],
  17: [240 / 255, 192 / 255, 0, 1],
  18: [1, 212 / 255, 0, 1]
});

function compileShader(gl, type, source) {
  const shader = gl.createShader(type);
  gl.shaderSource(shader, source);
  gl.compileShader(shader);
  if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(shader) || 'RAW weather shader compilation failed.');
  return shader;
}

function makeProgram(gl, shaderData) {
  const vertexSource = [
    '#version 300 es',
    shaderData.vertexShaderPrelude,
    shaderData.define,
    'in vec2 a_position;\nvoid main() { gl_Position = projectTile(a_position); }'
  ].join('\n');
  const fragmentSource = [
    '#version 300 es',
    'precision highp float;',
    'uniform vec4 u_color;',
    'out vec4 fragColor;',
    'void main() { fragColor = u_color; }'
  ].join('\n');
  const program = gl.createProgram();
  gl.attachShader(program, compileShader(gl, gl.VERTEX_SHADER, vertexSource));
  gl.attachShader(program, compileShader(gl, gl.FRAGMENT_SHADER, fragmentSource));
  gl.linkProgram(program);
  if (!gl.getProgramParameter(program, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(program) || 'RAW weather shader linking failed.');
  return {
    program,
    position: gl.getAttribLocation(program, 'a_position'),
    color: gl.getUniformLocation(program, 'u_color'),
    matrix: gl.getUniformLocation(program, 'u_matrix'),
    fallbackMatrix: gl.getUniformLocation(program, 'u_projection_fallback_matrix'),
    projectionMatrix: gl.getUniformLocation(program, 'u_projection_matrix'),
    tileMercatorCoords: gl.getUniformLocation(program, 'u_projection_tile_mercator_coords'),
    clippingPlane: gl.getUniformLocation(program, 'u_projection_clipping_plane'),
    projectionTransition: gl.getUniformLocation(program, 'u_projection_transition')
  };
}

function addCell(vertices, west, east, south, north, insetWest = 0, insetEast = 1, insetSouth = 0, insetNorth = 1) {
  const cellWest = west + (east - west) * insetWest;
  const cellEast = west + (east - west) * insetEast;
  const cellSouth = south + (north - south) * insetSouth;
  const cellNorth = south + (north - south) * insetNorth;
  const southwest = lngLatToMercator(cellWest, cellSouth);
  const southeast = lngLatToMercator(cellEast, cellSouth);
  const northeast = lngLatToMercator(cellEast, cellNorth);
  const northwest = lngLatToMercator(cellWest, cellNorth);
  vertices.push(
    southwest[0], southwest[1], southeast[0], southeast[1], northeast[0], northeast[1],
    southwest[0], southwest[1], northeast[0], northeast[1], northwest[0], northwest[1]
  );
}

function buildGeometry(field) {
  const precipitation = PRECIPITATION_BANDS.map(() => []);
  const thunderstorm = Object.fromEntries(Object.keys(THUNDERSTORM_COLORS).map((code) => [code, []]));
  const hail = Object.fromEntries(Object.keys(HAIL_COLORS).map((code) => [code, []]));
  const width = field.longitudes.length;
  for (let latitudeIndex = 0; latitudeIndex < field.latitudes.length; latitudeIndex++) {
    const south = field.latitudeCellBounds[latitudeIndex];
    const north = field.latitudeCellBounds[latitudeIndex + 1];
    for (let longitudeIndex = 0; longitudeIndex < width; longitudeIndex++) {
      const index = field.index(longitudeIndex, latitudeIndex);
      const west = field.longitudeCellBounds[longitudeIndex];
      const east = field.longitudeCellBounds[longitudeIndex + 1];
      const hasStorm = field.thunderstormCode[index] !== 0;
      const hasHail = field.hailCode[index] !== 0;
      const mmh = field.mmh[index];
      if (mmh > 0) {
        const bandIndex = PRECIPITATION_BANDS.findIndex(({ upper }) => mmh < upper);
        addCell(precipitation[bandIndex], west, east, south, north);
      }
      if (hasStorm && thunderstorm[field.thunderstormCode[index]]) {
        const insetEast = hasHail ? 0.48 : 0.88;
        addCell(thunderstorm[field.thunderstormCode[index]], west, east, south, north, 0.12, insetEast, 0.12, 0.88);
      }
      if (hasHail && hail[field.hailCode[index]]) {
        const insetWest = hasStorm ? 0.52 : 0.12;
        addCell(hail[field.hailCode[index]], west, east, south, north, insetWest, 0.88, 0.12, 0.88);
      }
    }
  }
  return {
    precipitation: precipitation.map((vertices) => Float32Array.from(vertices)),
    thunderstorm: Object.fromEntries(Object.entries(thunderstorm).map(([code, vertices]) => [code, Float32Array.from(vertices)])),
    hail: Object.fromEntries(Object.entries(hail).map(([code, vertices]) => [code, Float32Array.from(vertices)]))
  };
}

export class RawWeatherLayer {
  constructor(field) {
    this.id = 'geographic-weather-raw';
    this.type = 'custom';
    this.renderingMode = '3d';
    this.field = field;
    this.geometry = buildGeometry(field);
    this.active = false;
    this.phenomena = true;
    this.programs = new Map();
  }

  onAdd(map, gl) {
    this.map = map;
    this.buffers = { precipitation: [], thunderstorm: {}, hail: {} };
    for (const [index, vertices] of this.geometry.precipitation.entries()) this.buffers.precipitation[index] = this.createBuffer(gl, vertices);
    for (const [code, vertices] of Object.entries(this.geometry.thunderstorm)) this.buffers.thunderstorm[code] = this.createBuffer(gl, vertices);
    for (const [code, vertices] of Object.entries(this.geometry.hail)) this.buffers.hail[code] = this.createBuffer(gl, vertices);
  }

  createBuffer(gl, vertices) {
    const buffer = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
    gl.bufferData(gl.ARRAY_BUFFER, vertices, gl.STATIC_DRAW);
    return buffer;
  }

  onRemove(map, gl) {
    for (const entry of this.programs.values()) gl.deleteProgram(entry.program);
    for (const buffer of this.buffers?.precipitation || []) gl.deleteBuffer(buffer);
    for (const buffer of Object.values(this.buffers?.thunderstorm || {})) gl.deleteBuffer(buffer);
    for (const buffer of Object.values(this.buffers?.hail || {})) gl.deleteBuffer(buffer);
  }

  setActive(active) {
    this.active = active;
    this.map?.triggerRepaint();
  }

  setPhenomena(phenomena) {
    this.phenomena = phenomena;
    this.map?.triggerRepaint();
  }

  programFor(gl, shaderData) {
    let program = this.programs.get(shaderData.variantName);
    if (!program) {
      program = makeProgram(gl, shaderData);
      this.programs.set(shaderData.variantName, program);
    }
    return program;
  }

  draw(gl, program, vertices, buffer, color, projection) {
    if (!vertices.length) return;
    gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
    gl.enableVertexAttribArray(program.position);
    gl.vertexAttribPointer(program.position, 2, gl.FLOAT, false, 0, 0);
    setGeographicProjection(gl, {
      matrix: program.matrix,
      fallbackMatrix: program.fallbackMatrix,
      projectionMatrix: program.projectionMatrix,
      tileMercatorCoords: program.tileMercatorCoords,
      clippingPlane: program.clippingPlane,
      projectionTransition: program.projectionTransition
    }, projection);
    gl.uniform4f(program.color, ...color);
    gl.drawArrays(gl.TRIANGLES, 0, vertices.length / 2);
    gl.disableVertexAttribArray(program.position);
  }

  render(gl, args) {
    if (!this.active) return;
    const program = this.programFor(gl, args.shaderData);
    gl.useProgram(program.program);
    gl.disable(gl.BLEND);
    gl.disable(gl.DEPTH_TEST);
    const projection = args.defaultProjectionData;
    for (let index = 0; index < this.geometry.precipitation.length; index++) {
      this.draw(gl, program, this.geometry.precipitation[index], this.buffers.precipitation[index], PRECIPITATION_BANDS[index].color, projection);
    }
    if (this.phenomena) {
      for (const [code, vertices] of Object.entries(this.geometry.thunderstorm)) {
        this.draw(gl, program, vertices, this.buffers.thunderstorm[code], THUNDERSTORM_COLORS[code], projection);
      }
      for (const [code, vertices] of Object.entries(this.geometry.hail)) {
        this.draw(gl, program, vertices, this.buffers.hail[code], HAIL_COLORS[code], projection);
      }
    }
  }
}
