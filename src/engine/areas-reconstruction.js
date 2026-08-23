// Areas needs a smoother reconstruction than the L14 cell bilinear path, but
// it must retain the source samples exactly and cannot introduce B-spline-like
// ringing around small hazards. This uses separable monotone cubic Hermite
// interpolation (PCHIP-style harmonic slopes) on one fixed dense lattice.
export const AREA_RECONSTRUCTION_SUBDIVISIONS = 2;

function endpointSlope(first, second, third) {
  const firstDelta = second - first;
  const secondDelta = third - second;
  let slope = (3 * firstDelta - secondDelta) * 0.5;
  if (slope * firstDelta <= 0) return 0;
  if (firstDelta * secondDelta < 0 && Math.abs(slope) > Math.abs(3 * firstDelta)) slope = 3 * firstDelta;
  return slope;
}

function monotoneSlope(first, second, third) {
  const previous = second - first;
  const next = third - second;
  return previous * next <= 0 ? 0 : 2 * previous * next / (previous + next);
}

function sourceRowSlope(source, offset, width, column) {
  if (column === 0) return endpointSlope(source[offset], source[offset + 1], source[offset + 2]);
  if (column === width - 1) return -endpointSlope(source[offset + width - 1], source[offset + width - 2], source[offset + width - 3]);
  return monotoneSlope(source[offset + column - 1], source[offset + column], source[offset + column + 1]);
}

function horizontalColumnSlope(horizontal, width, height, row, column) {
  if (row === 0) return endpointSlope(horizontal[column], horizontal[width + column], horizontal[width * 2 + column]);
  if (row === height - 1) return -endpointSlope(horizontal[row * width + column], horizontal[(row - 1) * width + column], horizontal[(row - 2) * width + column]);
  return monotoneSlope(horizontal[(row - 1) * width + column], horizontal[row * width + column], horizontal[(row + 1) * width + column]);
}

function hermite(first, second, firstSlope, secondSlope, progress) {
  const squared = progress * progress;
  const cubed = squared * progress;
  return (2 * cubed - 3 * squared + 1) * first
    + (cubed - 2 * squared + progress) * firstSlope
    + (-2 * cubed + 3 * squared) * second
    + (cubed - squared) * secondSlope;
}

function clampCell(value, first, second, third, fourth) {
  const minimum = Math.min(first, second, third, fourth, 0);
  const maximum = Math.max(first, second, third, fourth, 0);
  return Math.max(minimum, Math.min(maximum, value));
}

export function createAreasReconstructionWorkspace(sourceWidth, sourceHeight, subdivisions = AREA_RECONSTRUCTION_SUBDIVISIONS) {
  const width = (sourceWidth - 1) * subdivisions + 1;
  const height = (sourceHeight - 1) * subdivisions + 1;
  return {
    sourceWidth,
    sourceHeight,
    subdivisions,
    width,
    height,
    horizontal: new Float32Array(width * sourceHeight),
    horizontalSlopes: new Float64Array(sourceWidth * sourceHeight),
    verticalSlopes: new Float64Array(width * sourceHeight),
    denseSourceColumns: Uint16Array.from({ length: width }, (_, column) => Math.min(sourceWidth - 2, Math.floor(column / subdivisions)))
  };
}

// Writes one scalar channel into an interleaved texture buffer. Original L14
// nodes are copied exactly; only between-node values are cubic reconstructed.
export function reconstructAreasChannel(source, workspace, target, targetChannel, targetStride) {
  const { sourceWidth, sourceHeight, subdivisions, width, height, horizontal, horizontalSlopes, verticalSlopes, denseSourceColumns } = workspace;

  for (let row = 0; row < sourceHeight; row++) {
    const sourceOffset = row * sourceWidth;
    const horizontalOffset = row * width;
    for (let column = 0; column < sourceWidth; column++) horizontalSlopes[sourceOffset + column] = sourceRowSlope(source, sourceOffset, sourceWidth, column);
    for (let column = 0; column < sourceWidth; column++) horizontal[horizontalOffset + column * subdivisions] = source[sourceOffset + column];
    for (let column = 0; column < sourceWidth - 1; column++) {
      const first = source[sourceOffset + column];
      const second = source[sourceOffset + column + 1];
      const firstSlope = horizontalSlopes[sourceOffset + column];
      const secondSlope = horizontalSlopes[sourceOffset + column + 1];
      for (let step = 1; step < subdivisions; step++) {
        const value = hermite(first, second, firstSlope, secondSlope, step / subdivisions);
        horizontal[horizontalOffset + column * subdivisions + step] = Math.max(Math.min(first, second), Math.min(Math.max(first, second), value));
      }
    }
  }

  for (let row = 0; row < sourceHeight; row++) {
    for (let column = 0; column < width; column++) verticalSlopes[row * width + column] = horizontalColumnSlope(horizontal, width, sourceHeight, row, column);
  }
  for (let column = 0; column < width; column++) {
    for (let row = 0; row < sourceHeight; row++) target[(row * subdivisions * width + column) * targetStride + targetChannel] = horizontal[row * width + column];
    for (let row = 0; row < sourceHeight - 1; row++) {
      const first = horizontal[row * width + column];
      const second = horizontal[(row + 1) * width + column];
      const firstSlope = verticalSlopes[row * width + column];
      const secondSlope = verticalSlopes[(row + 1) * width + column];
      const sourceColumn = denseSourceColumns[column];
      const topOffset = row * sourceWidth + sourceColumn;
      const bottomOffset = topOffset + sourceWidth;
      for (let step = 1; step < subdivisions; step++) {
        const value = hermite(first, second, firstSlope, secondSlope, step / subdivisions);
        target[((row * subdivisions + step) * width + column) * targetStride + targetChannel] = clampCell(
          value,
          source[topOffset], source[topOffset + 1], source[bottomOffset], source[bottomOffset + 1]
        );
      }
    }
  }

  return { width, height };
}

export function reconstructAreasChannels(channels, workspace, target, targetStride = 4) {
  reconstructAreasChannel(channels.rain, workspace, target, 0, targetStride);
  reconstructAreasChannel(channels.storm, workspace, target, 1, targetStride);
  reconstructAreasChannel(channels.hail, workspace, target, 2, targetStride);
  return workspace;
}
