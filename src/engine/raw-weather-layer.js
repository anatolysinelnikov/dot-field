import { lngLatToMercator } from './geographic-lod.js';
import { setGeographicProjection } from './geographic-layer-utils.js';

const COLORS = Object.freeze({
  precipitation: [0, 0.565, 1, 1],
  thunderstorm: [1, 0, 1, 1],
  hail: [1, 0.831, 0, 1]
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
  const precipitation = [];
  const thunderstorm = [];
  const hail = [];
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
      if (field.mmh[index] > 0) addCell(precipitation, west, east, south, north);
      if (hasStorm) {
        const insetEast = hasHail ? 0.48 : 0.88;
        addCell(thunderstorm, west, east, south, north, 0.12, insetEast, 0.12, 0.88);
      }
      if (hasHail) {
        const insetWest = hasStorm ? 0.52 : 0.12;
        addCell(hail, west, east, south, north, insetWest, 0.88, 0.12, 0.88);
      }
    }
  }
  return {
    precipitation: Float32Array.from(precipitation),
    thunderstorm: Float32Array.from(thunderstorm),
    hail: Float32Array.from(hail)
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
    this.buffers = {};
    for (const [type, vertices] of Object.entries(this.geometry)) {
      const buffer = gl.createBuffer();
      gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
      gl.bufferData(gl.ARRAY_BUFFER, vertices, gl.STATIC_DRAW);
      this.buffers[type] = buffer;
    }
  }

  onRemove(map, gl) {
    for (const entry of this.programs.values()) gl.deleteProgram(entry.program);
    for (const buffer of Object.values(this.buffers || {})) gl.deleteBuffer(buffer);
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

  draw(gl, program, type, color, projection) {
    const vertices = this.geometry[type];
    if (!vertices.length) return;
    gl.bindBuffer(gl.ARRAY_BUFFER, this.buffers[type]);
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
    this.draw(gl, program, 'precipitation', COLORS.precipitation, projection);
    if (this.phenomena) {
      this.draw(gl, program, 'thunderstorm', COLORS.thunderstorm, projection);
      this.draw(gl, program, 'hail', COLORS.hail, projection);
    }
  }
}
