import { BASE_GRID, BLUR_RASTER_SCALE, RAIN_MODERATE_MAX, SCALAR_SMOOTH_RADIUS, SCALAR_SMOOTH_SIGMA } from './config.js';
import { clamp, mix, smoothstep } from './math.js';
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

function buildSmoothedWeatherGrid(bounds, t, travelX) {
  const step = 1 / BASE_GRID;
  const padding = SCALAR_SMOOTH_RADIUS + 3;
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
  const stormSource = new Float32Array(rainSource.length);
  const hailSource = new Float32Array(rainSource.length);

  for (let row = 0; row < height; row++) {
    const y = (startJ + row + 0.5) * step;
    const offset = row * width;
    for (let column = 0; column < width; column++) {
      const x = (startI + column + 0.5) * step;
      const value = intensityAt(x, y, t, travelX);
      const index = offset + column;
      rainSource[index] = value.rain;
      stormSource[index] = value.storm;
      hailSource[index] = value.hail;
    }
  }

  return {
    rain: smoothScalarGrid(rainSource, width, height),
    storm: smoothScalarGrid(stormSource, width, height),
    hail: smoothScalarGrid(hailSource, width, height),
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

function prepareSplineAxis(length, screenLength, center, scale, gridStart, step) {
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

function compositeField(color, opacity, pixel) {
  if (opacity <= 0) return pixel;
  const outputAlpha = opacity + pixel.a * (1 - opacity);
  return {
    r: (color[0] * opacity + pixel.r * pixel.a * (1 - opacity)) / outputAlpha,
    g: (color[1] * opacity + pixel.g * pixel.a * (1 - opacity)) / outputAlpha,
    b: (color[2] * opacity + pixel.b * pixel.a * (1 - opacity)) / outputAlpha,
    a: outputAlpha
  };
}

export function renderBlurredFields(ctx, precipitationCanvas, precipitationCtx, viewport, t, travelX, fieldPixels, centerX, centerY) {
  const bounds = viewport.bounds;
  const grid = buildSmoothedWeatherGrid(bounds, t, travelX);
  const rasterWidth = Math.max(1, Math.ceil(viewport.width * BLUR_RASTER_SCALE));
  const rasterHeight = Math.max(1, Math.ceil(viewport.height * BLUR_RASTER_SCALE));
  if (precipitationCanvas.width !== rasterWidth || precipitationCanvas.height !== rasterHeight) {
    precipitationCanvas.width = rasterWidth;
    precipitationCanvas.height = rasterHeight;
  }

  const worldScale = fieldPixels * viewport.zoom;
  const xSpline = prepareSplineAxis(rasterWidth, viewport.width, centerX, worldScale, grid.startI, grid.step);
  const ySpline = prepareSplineAxis(rasterHeight, viewport.height, centerY, worldScale, grid.startJ, grid.step);
  const image = precipitationCtx.createImageData(rasterWidth, rasterHeight);
  const pixels = image.data;

  for (let py = 0; py < rasterHeight; py++) {
    const gridY = ySpline.indices[py];
    const wyOffset = py * 4;
    for (let px = 0; px < rasterWidth; px++) {
      const gridX = xSpline.indices[px];
      const wxOffset = px * 4;
      let rain = 0;
      let storm = 0;
      let hail = 0;

      for (let ky = 0; ky < 4; ky++) {
        const sampleY = clamp(gridY + ky, 0, grid.height - 1);
        const rowOffset = sampleY * grid.width;
        let rainRow = 0;
        let stormRow = 0;
        let hailRow = 0;
        for (let kx = 0; kx < 4; kx++) {
          const sampleX = clamp(gridX + kx, 0, grid.width - 1);
          const sampleIndex = rowOffset + sampleX;
          const weight = xSpline.weights[wxOffset + kx];
          rainRow += grid.rain[sampleIndex] * weight;
          stormRow += grid.storm[sampleIndex] * weight;
          hailRow += grid.hail[sampleIndex] * weight;
        }
        const yWeight = ySpline.weights[wyOffset + ky];
        rain += rainRow * yWeight;
        storm += stormRow * yWeight;
        hail += hailRow * yWeight;
      }

      // The alpha ramp supplies the soft support edge. Color follows the
      // same moderate/strong blue hierarchy as the dot renderer.
      const rainOpacity = smoothstep(0.008, 0.58, rain);
      const strong = smoothstep(RAIN_MODERATE_MAX, 0.9, rain);
      let pixel = { r: 0, g: mix(144, 0, strong), b: 255, a: rainOpacity };
      pixel = compositeField([255, 0, 255], smoothstep(0.012, 0.72, storm), pixel);
      pixel = compositeField([255, 212, 0], smoothstep(0.018, 0.62, hail), pixel);
      const pixelOffset = (py * rasterWidth + px) * 4;
      pixels[pixelOffset] = Math.round(pixel.r);
      pixels[pixelOffset + 1] = Math.round(pixel.g);
      pixels[pixelOffset + 2] = Math.round(pixel.b);
      pixels[pixelOffset + 3] = Math.round(pixel.a * 255);
    }
  }

  precipitationCtx.putImageData(image, 0, 0);
  ctx.save();
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(precipitationCanvas, 0, 0, viewport.width, viewport.height);
  ctx.restore();
}
