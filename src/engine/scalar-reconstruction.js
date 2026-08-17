import { BASE_GRID, SCALAR_SMOOTH_RADIUS, SCALAR_SMOOTH_SIGMA } from './config.js';
import { clamp } from './math.js';
import { intensityAt } from './field.js';

function gaussianKernel(radius, sigma) {
  const kernel = new Float32Array(radius * 2 + 1);
  let sum = 0;
  for (let i = -radius; i <= radius; i++) {
    const weight = Math.exp(-(i * i) / (2 * sigma * sigma));
    kernel[i + radius] = weight;
    sum += weight;
  }
  for (let i = 0; i < kernel.length; i++) kernel[i] /= sum;
  return kernel;
}

const scalarSmoothKernel = gaussianKernel(SCALAR_SMOOTH_RADIUS, SCALAR_SMOOTH_SIGMA);
const DEFAULT_LAYERS = ['rain', 'storm', 'hail'];

function smoothScalarGrid(source, width, height) {
  const horizontal = new Float32Array(source.length);
  const smoothed = new Float32Array(source.length);

  for (let row = 0; row < height; row++) {
    const offset = row * width;
    for (let column = 0; column < width; column++) {
      let value = 0;
      for (let k = -SCALAR_SMOOTH_RADIUS; k <= SCALAR_SMOOTH_RADIUS; k++) {
        const sampleColumn = clamp(column + k, 0, width - 1);
        value += source[offset + sampleColumn] * scalarSmoothKernel[k + SCALAR_SMOOTH_RADIUS];
      }
      horizontal[offset + column] = value;
    }
  }

  for (let row = 0; row < height; row++) {
    const offset = row * width;
    for (let column = 0; column < width; column++) {
      let value = 0;
      for (let k = -SCALAR_SMOOTH_RADIUS; k <= SCALAR_SMOOTH_RADIUS; k++) {
        const sampleRow = clamp(row + k, 0, height - 1);
        value += horizontal[sampleRow * width + column] * scalarSmoothKernel[k + SCALAR_SMOOTH_RADIUS];
      }
      smoothed[offset + column] = value;
    }
  }

  return smoothed;
}

export function createBoxBlurBuffers(length) {
  return {
    horizontal: new Float32Array(length),
    first: new Float32Array(length),
    second: new Float32Array(length)
  };
}

function boxBlurHorizontal(source, target, width, height, radius) {
  const windowSize = radius * 2 + 1;
  for (let row = 0; row < height; row++) {
    const offset = row * width;
    let sum = source[offset] * (radius + 1);
    for (let column = 1; column <= radius; column++) {
      sum += source[offset + Math.min(column, width - 1)];
    }
    for (let column = 0; column < width; column++) {
      target[offset + column] = sum / windowSize;
      const removed = Math.max(0, column - radius);
      const added = Math.min(width - 1, column + radius + 1);
      sum += source[offset + added] - source[offset + removed];
    }
  }
}

function boxBlurVertical(source, target, width, height, radius) {
  const windowSize = radius * 2 + 1;
  for (let column = 0; column < width; column++) {
    let sum = source[column] * (radius + 1);
    for (let row = 1; row <= radius; row++) {
      sum += source[Math.min(row, height - 1) * width + column];
    }
    for (let row = 0; row < height; row++) {
      target[row * width + column] = sum / windowSize;
      const removed = Math.max(0, row - radius);
      const added = Math.min(height - 1, row + radius + 1);
      sum += source[added * width + column] - source[removed * width + column];
    }
  }
}

// A fixed number of separable box passes approximates a smooth low-pass
// while using running sums, so work does not grow with the requested radius.
export function fastBoxBlurScalarGrid(source, width, height, radius, passes, buffers) {
  if (radius <= 0 || passes <= 0) return source;
  let current = source;
  for (let pass = 0; pass < passes; pass++) {
    boxBlurHorizontal(current, buffers.horizontal, width, height, radius);
    const target = pass % 2 === 0 ? buffers.first : buffers.second;
    boxBlurVertical(buffers.horizontal, target, width, height, radius);
    current = target;
  }
  return current;
}

export function buildSmoothedWeatherGrid(bounds, t, travelX, layers = DEFAULT_LAYERS, extraPadding = 0) {
  const step = 1 / BASE_GRID;
  const padding = SCALAR_SMOOTH_RADIUS + 3 + extraPadding;
  // intensityAt has compact empty-space rejection. Intersecting the visible
  // world with that support prevents very low zooms from allocating a huge
  // all-zero lattice while retaining enough padding for both filters.
  const minX = Math.max(bounds.minX, travelX - 0.92);
  const maxX = Math.min(bounds.maxX, travelX + 0.92);
  const minY = Math.max(bounds.minY, -0.26);
  const maxY = Math.min(bounds.maxY, 1.26);
  const startI = Math.floor(minX / step - 0.5) - padding;
  const endI = Math.ceil(maxX / step - 0.5) + padding;
  const startJ = Math.floor(minY / step - 0.5) - padding;
  const endJ = Math.ceil(maxY / step - 0.5) + padding;
  const width = endI - startI + 1;
  const height = endJ - startJ + 1;
  const rainSource = new Float32Array(width * height);
  const includeStorm = layers.includes('storm');
  const includeHail = layers.includes('hail');
  const stormSource = includeStorm ? new Float32Array(rainSource.length) : null;
  const hailSource = includeHail ? new Float32Array(rainSource.length) : null;

  for (let row = 0; row < height; row++) {
    const y = (startJ + row + 0.5) * step;
    const offset = row * width;
    for (let column = 0; column < width; column++) {
      const x = (startI + column + 0.5) * step;
      const value = intensityAt(x, y, t, travelX);
      const index = offset + column;
      rainSource[index] = value.rain;
      if (stormSource) stormSource[index] = value.storm;
      if (hailSource) hailSource[index] = value.hail;
    }
  }

  return {
    rain: smoothScalarGrid(rainSource, width, height),
    storm: stormSource ? smoothScalarGrid(stormSource, width, height) : null,
    hail: hailSource ? smoothScalarGrid(hailSource, width, height) : null,
    width,
    height,
    startI,
    startJ,
    step
  };
}

function cubicBSplineWeights(t) {
  const t2 = t * t;
  const t3 = t2 * t;
  const mt = 1 - t;
  return [
    mt * mt * mt / 6,
    (3 * t3 - 6 * t2 + 4) / 6,
    (-3 * t3 + 3 * t2 + 3 * t + 1) / 6,
    t3 / 6
  ];
}

export function prepareSplineAxis(length, screenLength, center, scale, gridStart, step) {
  const indices = new Int32Array(length);
  const weights = new Float32Array(length * 4);
  for (let pixel = 0; pixel < length; pixel++) {
    const screenPosition = (pixel + 0.5) / length * screenLength;
    const world = 0.5 + (screenPosition - center) / scale;
    const gridPosition = world / step - 0.5 - gridStart;
    const base = Math.floor(gridPosition);
    indices[pixel] = base - 1;
    weights.set(cubicBSplineWeights(gridPosition - base), pixel * 4);
  }
  return { indices, weights };
}

export function interpolateSplineScalar(source, grid, gridX, gridY, xWeights, xOffset, yWeights, yOffset) {
  let value = 0;
  for (let ky = 0; ky < 4; ky++) {
    const sampleY = clamp(gridY + ky, 0, grid.height - 1);
    const rowOffset = sampleY * grid.width;
    let row = 0;
    for (let kx = 0; kx < 4; kx++) {
      const sampleX = clamp(gridX + kx, 0, grid.width - 1);
      row += source[rowOffset + sampleX] * xWeights[xOffset + kx];
    }
    value += row * yWeights[yOffset + ky];
  }
  return value;
}

// World-space sampling keeps contour geometry independent of the viewport
// raster and the adaptive dot LOD.
export function interpolateSplineScalarAt(source, grid, x, y) {
  const gridX = x / grid.step - 0.5 - grid.startI;
  const gridY = y / grid.step - 0.5 - grid.startJ;
  const baseX = Math.floor(gridX);
  const baseY = Math.floor(gridY);
  const tx = gridX - baseX;
  const ty = gridY - baseY;
  const tx2 = tx * tx;
  const tx3 = tx2 * tx;
  const ty2 = ty * ty;
  const ty3 = ty2 * ty;
  const x0 = (1 - tx) * (1 - tx) * (1 - tx) / 6;
  const x1 = (3 * tx3 - 6 * tx2 + 4) / 6;
  const x2 = (-3 * tx3 + 3 * tx2 + 3 * tx + 1) / 6;
  const x3 = tx3 / 6;
  const y0 = (1 - ty) * (1 - ty) * (1 - ty) / 6;
  const y1 = (3 * ty3 - 6 * ty2 + 4) / 6;
  const y2 = (-3 * ty3 + 3 * ty2 + 3 * ty + 1) / 6;
  const y3 = ty3 / 6;
  let value = 0;

  for (let ky = 0; ky < 4; ky++) {
    const sampleY = clamp(baseY - 1 + ky, 0, grid.height - 1);
    const rowOffset = sampleY * grid.width;
    const yWeight = ky === 0 ? y0 : ky === 1 ? y1 : ky === 2 ? y2 : y3;
    let row = 0;
    for (let kx = 0; kx < 4; kx++) {
      const sampleX = clamp(baseX - 1 + kx, 0, grid.width - 1);
      const xWeight = kx === 0 ? x0 : kx === 1 ? x1 : kx === 2 ? x2 : x3;
      row += source[rowOffset + sampleX] * xWeight;
    }
    value += row * yWeight;
  }

  return value;
}

// Samples multiple channels on the same spline lattice while sharing the
// world-to-grid coordinate and B-spline weight calculation.
export function interpolateSplineScalarsAt(sources, grid, x, y, target) {
  const gridX = x / grid.step - 0.5 - grid.startI;
  const gridY = y / grid.step - 0.5 - grid.startJ;
  const baseX = Math.floor(gridX);
  const baseY = Math.floor(gridY);
  const tx = gridX - baseX;
  const ty = gridY - baseY;
  const tx2 = tx * tx;
  const tx3 = tx2 * tx;
  const ty2 = ty * ty;
  const ty3 = ty2 * ty;
  const x0 = (1 - tx) * (1 - tx) * (1 - tx) / 6;
  const x1 = (3 * tx3 - 6 * tx2 + 4) / 6;
  const x2 = (-3 * tx3 + 3 * tx2 + 3 * tx + 1) / 6;
  const x3 = tx3 / 6;
  const y0 = (1 - ty) * (1 - ty) * (1 - ty) / 6;
  const y1 = (3 * ty3 - 6 * ty2 + 4) / 6;
  const y2 = (-3 * ty3 + 3 * ty2 + 3 * ty + 1) / 6;
  const y3 = ty3 / 6;
  const sampleX0 = clamp(baseX - 1, 0, grid.width - 1);
  const sampleX1 = clamp(baseX, 0, grid.width - 1);
  const sampleX2 = clamp(baseX + 1, 0, grid.width - 1);
  const sampleX3 = clamp(baseX + 2, 0, grid.width - 1);
  const row0 = clamp(baseY - 1, 0, grid.height - 1) * grid.width;
  const row1 = clamp(baseY, 0, grid.height - 1) * grid.width;
  const row2 = clamp(baseY + 1, 0, grid.height - 1) * grid.width;
  const row3 = clamp(baseY + 2, 0, grid.height - 1) * grid.width;

  for (let sourceIndex = 0; sourceIndex < sources.length; sourceIndex++) {
    const source = sources[sourceIndex];
    const value0 = source[row0 + sampleX0] * x0 + source[row0 + sampleX1] * x1
      + source[row0 + sampleX2] * x2 + source[row0 + sampleX3] * x3;
    const value1 = source[row1 + sampleX0] * x0 + source[row1 + sampleX1] * x1
      + source[row1 + sampleX2] * x2 + source[row1 + sampleX3] * x3;
    const value2 = source[row2 + sampleX0] * x0 + source[row2 + sampleX1] * x1
      + source[row2 + sampleX2] * x2 + source[row2 + sampleX3] * x3;
    const value3 = source[row3 + sampleX0] * x0 + source[row3 + sampleX1] * x1
      + source[row3 + sampleX2] * x2 + source[row3 + sampleX3] * x3;
    target[sourceIndex] = value0 * y0 + value1 * y1 + value2 * y2 + value3 * y3;
  }
}
