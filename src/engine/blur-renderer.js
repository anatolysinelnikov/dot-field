import { BLUR_RASTER_SCALE, RAIN_MODERATE_MAX } from './config.js';
import { mix, smoothstep } from './math.js';
import { buildSmoothedWeatherGrid, interpolateSplineScalar, prepareSplineAxis } from './scalar-reconstruction.js';

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

// Preserve a soft zero edge while making the scalar field perceptible near
// the same low-strength regions where Dots begins drawing substantial marks.
// The fractional exponent gives the ramp a faster early buildup without
// flattening it into a threshold or changing the reconstructed field itself.
function visibleFieldOpacity(value, onset, core, exponent) {
  return Math.pow(smoothstep(onset, core, value), exponent);
}

// Keep the reconstructed hazard fields continuous, but give their nominal
// Dots/Squares activation levels a clearly visible opacity. The two smooth
// segments meet with zero slope, preserving the soft outer edge without
// creating a contour at the anchor.
function visibleHazardOpacity(value, onset, activation, core, activationOpacity) {
  if (value < activation) {
    return activationOpacity * Math.pow(smoothstep(onset, activation, value), 0.68);
  }
  return mix(activationOpacity, 1, smoothstep(activation, core, value));
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
      const rain = interpolateSplineScalar(grid.rain, grid, gridX, gridY, xSpline.weights, wxOffset, ySpline.weights, wyOffset);
      const storm = interpolateSplineScalar(grid.storm, grid, gridX, gridY, xSpline.weights, wxOffset, ySpline.weights, wyOffset);
      const hail = interpolateSplineScalar(grid.hail, grid, gridX, gridY, xSpline.weights, wxOffset, ySpline.weights, wyOffset);

      // The alpha ramp supplies the soft support edge. Color follows the
      // same moderate/strong blue hierarchy as the dot renderer.
      const rainOpacity = visibleFieldOpacity(rain, 0.006, 0.52, 0.66);
      const strong = smoothstep(RAIN_MODERATE_MAX, 0.9, rain);
      let pixel = { r: 0, g: mix(144, 0, strong), b: 255, a: rainOpacity };
      pixel = compositeField([255, 0, 255], visibleHazardOpacity(storm, 0.006, 0.075, 0.54, 0.36), pixel);
      pixel = compositeField([255, 212, 0], visibleHazardOpacity(hail, 0.010, 0.11, 0.44, 0.42), pixel);
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
