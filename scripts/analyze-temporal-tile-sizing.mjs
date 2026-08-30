import { gzipSync } from 'node:zlib';
import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const scriptDirectory = dirname(fileURLToPath(import.meta.url));
const repositoryRoot = resolve(scriptDirectory, '..');
const currentMetadataPath = resolve(repositoryRoot, 'data/generated/current/metadata.json');
const metadata = JSON.parse(await readFile(currentMetadataPath, 'utf8'));
const generationId = metadata.generation_id;
if (!generationId) throw new Error('current metadata has no generation_id');
const generationRoot = resolve(repositoryRoot, 'data/generated', generationId);
const generationMetadata = JSON.parse(await readFile(resolve(generationRoot, 'metadata.json'), 'utf8'));
if (generationMetadata.generation_id !== generationId) throw new Error('current metadata does not resolve to the expected immutable generation');

const grid = generationMetadata.spatial_grid;
const rainFrames = await Promise.all(generationMetadata.rain.frame_assets.map(async (asset) => {
  const buffer = await readFile(new URL(asset, pathToFileURL(`${generationRoot}/`)));
  if (buffer.byteLength !== generationMetadata.rain.frame_byte_length) throw new Error(`unexpected rain frame byte length: ${asset}`);
  return new Float32Array(buffer.buffer, buffer.byteOffset, buffer.byteLength / 4);
}));
const supportBuffer = await readFile(new URL(generationMetadata.support_mask.asset, pathToFileURL(`${generationRoot}/`)));
const support = new Uint8Array(supportBuffer);
const motionAssets = await Promise.all(generationMetadata.motion.interval_assets.map(async (asset) => {
  const buffer = await readFile(new URL(asset, pathToFileURL(`${generationRoot}/`)));
  return new Float32Array(buffer.buffer, buffer.byteOffset, buffer.byteLength / 4);
}));

const width = grid.width;
const height = grid.height;
const frameCount = rainFrames.length;
const motion = generationMetadata.motion;
const motionCells = motion.grid_width * motion.grid_height;
const motionComponentNames = ['forwardX', 'forwardY', 'backwardX', 'backwardY'];
const tileSizes = [64, 128, 256];
const RAIN_BYTES_PER_SAMPLE = 2;
const MOTION_BYTES_PER_NODE = 4 * 4;
const MAX_GRID_SIZE = 2 ** 15;
const COARSE_STEP = 2 ** 5;
const COARSE_MERCATOR_STEP = 1 / 2 ** 10;
const SUPPORT = {
  minX: Math.max(0, Math.floor(lngLatToMercator(grid.weather_support.west, grid.weather_support.south)[0] * MAX_GRID_SIZE) - 1),
  maxX: Math.min(MAX_GRID_SIZE, Math.ceil(lngLatToMercator(grid.weather_support.east, grid.weather_support.north)[0] * MAX_GRID_SIZE) + 1),
  minY: Math.max(0, Math.floor(lngLatToMercator(grid.weather_support.east, grid.weather_support.north)[1] * MAX_GRID_SIZE) - 1),
  maxY: Math.min(MAX_GRID_SIZE, Math.ceil(lngLatToMercator(grid.weather_support.west, grid.weather_support.south)[1] * MAX_GRID_SIZE) + 1)
};

function lngLatToMercator(longitude, latitude) {
  const radians = Math.max(-85.05112878, Math.min(85.05112878, latitude)) * Math.PI / 180;
  return [(longitude + 180) / 360, (1 - Math.log(Math.tan(Math.PI / 4 + radians / 2)) / Math.PI) / 2];
}
function mercatorToLngLat(x, y) {
  return [x * 360 - 180, Math.atan(Math.sinh(Math.PI * (1 - 2 * y))) * 180 / Math.PI];
}
function percent(a, b) { return b ? a * 100 / b : 0; }
function mib(bytes) { return bytes / 1048576; }
function supportBit(index) { return (support[index >> 3] & (1 << (index & 7))) !== 0; }
function half(value) {
  // Deterministic IEEE-754 binary16 round-to-nearest-even conversion. The
  // dataset maximum is well within binary16's finite range.
  const input = new Float32Array([value]);
  const bits = new Uint32Array(input.buffer)[0];
  const sign = (bits >>> 16) & 0x8000;
  let exponent = (bits >>> 23) & 0xff;
  let mantissa = bits & 0x7fffff;
  if (exponent === 0xff) return sign | (mantissa ? 0x7e00 : 0x7c00);
  exponent -= 127;
  if (exponent < -14) {
    if (exponent < -24) return sign;
    mantissa |= 0x800000;
    const shift = -exponent - 14;
    let result = mantissa >> (shift + 13);
    const remainder = mantissa & ((1 << (shift + 13)) - 1);
    const halfway = 1 << (shift + 12);
    if (remainder > halfway || (remainder === halfway && (result & 1))) result++;
    return sign | result;
  }
  if (exponent > 15) return sign | 0x7c00;
  let result = sign | ((exponent + 15) << 10) | (mantissa >> 13);
  const remainder = mantissa & 0x1fff;
  if (remainder > 0x1000 || (remainder === 0x1000 && (result & 1))) {
    result++;
    if ((result & 0x7c00) === 0x7c00) return sign | 0x7c00;
  }
  return result;
}
function rainPayload(startX, startY, storedWidth, storedHeight) {
  const payload = Buffer.alloc(storedWidth * storedHeight * frameCount * 2);
  let offset = 0;
  for (const frame of rainFrames) {
    for (let y = startY; y < startY + storedHeight; y++) {
      for (let x = startX; x < startX + storedWidth; x++) {
        payload.writeUInt16LE(half(frame[y * width + x]), offset);
        offset += 2;
      }
    }
  }
  return payload;
}
function tileDescriptors(size, halo) {
  const result = [];
  for (let y = 0; y < height; y += size) for (let x = 0; x < width; x += size) {
    const interiorWidth = Math.min(size, width - x);
    const interiorHeight = Math.min(size, height - y);
    const startX = Math.max(0, x - halo);
    const startY = Math.max(0, y - halo);
    const endX = Math.min(width, x + interiorWidth + halo);
    const endY = Math.min(height, y + interiorHeight + halo);
    let nonEmpty = false;
    for (let row = y; row < y + interiorHeight && !nonEmpty; row++) for (let col = x; col < x + interiorWidth; col++) {
      if (supportBit(row * width + col)) { nonEmpty = true; break; }
    }
    const motionStartX = Math.max(0, Math.floor(x / motion.grid_spacing_source_nodes));
    const motionEndX = Math.min(motion.grid_width - 1, Math.ceil((x + interiorWidth) / motion.grid_spacing_source_nodes));
    const motionStartY = Math.max(0, Math.floor(y / motion.grid_spacing_source_nodes));
    const motionEndY = Math.min(motion.grid_height - 1, Math.ceil((y + interiorHeight) / motion.grid_spacing_source_nodes));
    result.push({ x, y, interiorWidth, interiorHeight, storedWidth: endX - startX, storedHeight: endY - startY, startX, startY, nonEmpty,
      motionWidth: motionEndX - motionStartX + 1, motionHeight: motionEndY - motionStartY + 1 });
  }
  return result;
}
function motionPayload(tile) {
  const payload = Buffer.alloc(tile.motionWidth * tile.motionHeight * motion.interval_count * MOTION_BYTES_PER_NODE);
  let offset = 0;
  for (const interval of motionAssets) {
    for (let y = Math.floor(tile.y / motion.grid_spacing_source_nodes); y <= Math.min(motion.grid_height - 1, Math.ceil((tile.y + tile.interiorHeight) / motion.grid_spacing_source_nodes)); y++) {
      for (let x = Math.floor(tile.x / motion.grid_spacing_source_nodes); x <= Math.min(motion.grid_width - 1, Math.ceil((tile.x + tile.interiorWidth) / motion.grid_spacing_source_nodes)); x++) {
        const node = y * motion.grid_width + x;
        for (let component = 0; component < 4; component++) { payload.writeFloatLE(interval[component * motionCells + node], offset); offset += 4; }
      }
    }
  }
  return payload;
}

const displacement = motionComponentNames.map((name, component) => {
  const values = motionAssets.flatMap((interval) => Array.from(interval.subarray(component * motionCells, (component + 1) * motionCells), Math.abs));
  const absolute = values.map(Math.abs).sort((a, b) => a - b);
  return { name, maxAbsolute: Math.max(...absolute), p95Absolute: absolute[Math.floor((absolute.length - 1) * .95)], meanAbsolute: absolute.reduce((a, b) => a + b, 0) / absolute.length };
});
const globalComponentMax = Math.max(...displacement.map((item) => item.maxAbsolute));
const globalHalo = Math.ceil(globalComponentMax) + 1;
const maximumVectorMagnitude = Math.max(...motionAssets.flatMap((interval) => Array.from({ length: motionCells }, (_, node) => Math.max(
  Math.hypot(interval[node], interval[motionCells + node]),
  Math.hypot(interval[motionCells * 2 + node], interval[motionCells * 3 + node])
))));
const intervalHalos = motionAssets.map((_, intervalIndex) => {
  const max = Math.max(...motionComponentNames.map((_, component) => {
    const values = motionAssets[intervalIndex].subarray(component * motionCells, (component + 1) * motionCells);
    return Math.max(...Array.from(values, Math.abs));
  }));
  return { interval: intervalIndex, maximumAbsoluteDisplacement: max, requiredRainHalo: Math.ceil(max) + 1 };
});
const frameHalos = Array.from({ length: frameCount }, (_, frameIndex) => {
  const adjacent = [intervalHalos[frameIndex - 1]?.requiredRainHalo, intervalHalos[frameIndex]?.requiredRainHalo].filter(Number.isFinite);
  return Math.max(...adjacent);
});

const results = [];
for (const size of tileSizes) {
  const tiles = tileDescriptors(size, globalHalo);
  const nonEmpty = tiles.filter((tile) => tile.nonEmpty);
  const payloads = nonEmpty.map((tile) => ({ tile, rain: rainPayload(tile.startX, tile.startY, tile.storedWidth, tile.storedHeight), motion: motionPayload(tile) }));
  const rainRaw = payloads.reduce((sum, item) => sum + item.rain.byteLength, 0);
  const rainGzip = payloads.reduce((sum, item) => sum + gzipSync(item.rain, { level: 9 }).byteLength, 0);
  const motionRaw = payloads.reduce((sum, item) => sum + item.motion.byteLength, 0);
  const motionGzip = payloads.reduce((sum, item) => sum + gzipSync(item.motion, { level: 9 }).byteLength, 0);
  const nominalStoredSamples = (size + 2 * globalHalo) ** 2;
  const interiorSamples = size ** 2;
  const intervalSpecificRaw = nonEmpty.reduce((sum, tile) => sum + frameHalos.reduce((frameSum, halo) => {
    const storedWidth = Math.min(width, tile.x + tile.interiorWidth + halo) - Math.max(0, tile.x - halo);
    const storedHeight = Math.min(height, tile.y + tile.interiorHeight + halo) - Math.max(0, tile.y - halo);
    return frameSum + storedWidth * storedHeight * 2;
  }, 0), 0);
  results.push({
    tileInterior: `${size}x${size}`, size, requiredHalo: globalHalo,
    nominalStoredDimensions: `${size + 2 * globalHalo}x${size + 2 * globalHalo}`,
    allTimeRainRawBytesPerNominalTile: nominalStoredSamples * frameCount * RAIN_BYTES_PER_SAMPLE,
    allTimeRainGzipBytesPerNominalTile: Math.round(rainGzip / Math.max(1, nonEmpty.length)),
    motionBytesPerNominalTile: (Math.ceil(size / motion.grid_spacing_source_nodes) + 1) ** 2 * motion.interval_count * MOTION_BYTES_PER_NODE,
    haloOverheadPercent: percent(nominalStoredSamples - interiorSamples, interiorSamples),
    geometricTileCount: tiles.length, sequenceUnionNonEmptyTileCount: nonEmpty.length,
    emptyTileCount: tiles.length - nonEmpty.length,
    fullDomainRainRawBytes: tiles.reduce((sum, tile) => sum + tile.storedWidth * tile.storedHeight * frameCount * 2, 0),
    usefulProviderDomainRainRawBytes: rainRaw,
    intervalSpecificHaloRainRawBytes: intervalSpecificRaw,
    frameRequiredHalos: frameHalos,
    sequenceWideHaloExtraBytes: rainRaw - intervalSpecificRaw,
    sequenceWideHaloExtraPercent: percent(rainRaw - intervalSpecificRaw, intervalSpecificRaw),
    allNonEmptyRainGzipBytes: rainGzip, allNonEmptyMotionRawBytes: motionRaw, allNonEmptyMotionGzipBytes: motionGzip,
    combinedGzipBytes: rainGzip + motionGzip,
    motionToRainRawPercent: percent(motionRaw, rainRaw), motionToRainGzipPercent: percent(motionGzip, rainGzip),
    compressionRatio: (rainRaw + motionRaw) / Math.max(1, rainGzip + motionGzip),
    nominalRainBytesPerTile: nominalStoredSamples * frameCount * 2,
    nominalInteriorBytesPerTile: interiorSamples * frameCount * 2
  });
}

function canonicalWindowForViewport({ widthCss, heightCss, zoom, center }) {
  const world = 512 * 2 ** zoom;
  const xSpan = widthCss / world;
  const ySpan = heightCss / world;
  const [cx, cy] = lngLatToMercator(center[0], center[1]);
  const bounds = { minX: cx - xSpan / 2, maxX: cx + xSpan / 2, minY: cy - ySpan / 2, maxY: cy + ySpan / 2 };
  const spanX = Math.max(bounds.maxX - bounds.minX, 1 / MAX_GRID_SIZE);
  const spanY = Math.max(bounds.maxY - bounds.minY, 1 / MAX_GRID_SIZE);
  const raw = { minX: (bounds.minX - spanX * .25 - COARSE_MERCATOR_STEP) * MAX_GRID_SIZE, maxX: (bounds.maxX + spanX * .25 + COARSE_MERCATOR_STEP) * MAX_GRID_SIZE, minY: (bounds.minY - spanY * .25 - COARSE_MERCATOR_STEP) * MAX_GRID_SIZE, maxY: (bounds.maxY + spanY * .25 + COARSE_MERCATOR_STEP) * MAX_GRID_SIZE };
  const snap = (min, max, supportMin, supportMax) => [Math.max(supportMin, Math.floor(min / COARSE_STEP) * COARSE_STEP), Math.min(supportMax, Math.ceil(max / COARSE_STEP) * COARSE_STEP)];
  const [minX, maxX] = snap(raw.minX, raw.maxX, SUPPORT.minX, SUPPORT.maxX);
  const [minY, maxY] = snap(raw.minY, raw.maxY, SUPPORT.minY, SUPPORT.maxY);
  const corners = [mercatorToLngLat(minX / MAX_GRID_SIZE, minY / MAX_GRID_SIZE), mercatorToLngLat(maxX / MAX_GRID_SIZE, maxY / MAX_GRID_SIZE)];
  return { canonicalWindow: { minX, maxX, minY, maxY }, sourceFootprint: sourceFootprint(corners) };
}
function sourceFootprint(corners) {
  const west = Math.max(grid.longitude_start, Math.min(corners[0][0], corners[1][0]));
  const east = Math.min(grid.longitude_start + (width - 1) * grid.longitude_spacing, Math.max(corners[0][0], corners[1][0]));
  const south = Math.max(grid.latitude_start, Math.min(corners[0][1], corners[1][1]));
  const north = Math.min(grid.latitude_start + (height - 1) * grid.latitude_spacing, Math.max(corners[0][1], corners[1][1]));
  return { minX: Math.max(0, Math.floor((west - grid.longitude_start) / grid.longitude_spacing)), maxX: Math.min(width - 1, Math.ceil((east - grid.longitude_start) / grid.longitude_spacing)), minY: Math.max(0, Math.floor((south - grid.latitude_start) / grid.latitude_spacing)), maxY: Math.min(height - 1, Math.ceil((north - grid.latitude_start) / grid.latitude_spacing)) };
}
const viewportScenarios = [
  { name: 'initial/default desktop', widthCss: 1440, heightCss: 900, zoom: 5.8, center: [45.03, 43.35] },
  { name: 'GPU experiment representative L14 window', widthCss: 1440, heightCss: 900, zoom: 5.8, center: [45.03, 43.35] },
  { name: 'compact/mobile', widthCss: 390, heightCss: 844, zoom: 5.8, center: [45.03, 43.35] },
  { name: 'conservative practical current view', widthCss: 1024, heightCss: 768, zoom: 3.0, center: [45.03, 43.35] }
];
const residency = viewportScenarios.map((scenario) => {
  const footprint = canonicalWindowForViewport(scenario).sourceFootprint;
  return { ...scenario, footprint, candidates: results.map((result) => {
    const tiles = tileDescriptors(result.size, globalHalo).filter((tile) => tile.nonEmpty && tile.x < footprint.maxX + 1 && tile.x + tile.interiorWidth > footprint.minX && tile.y < footprint.maxY + 1 && tile.y + tile.interiorHeight > footprint.minY);
    const rainRaw = tiles.reduce((sum, tile) => sum + tile.storedWidth * tile.storedHeight * frameCount * 2, 0);
    const payloads = tiles.map((tile) => ({ rain: rainPayload(tile.startX, tile.startY, tile.storedWidth, tile.storedHeight), motion: motionPayload(tile) }));
    const rainGzip = payloads.reduce((sum, item) => sum + gzipSync(item.rain, { level: 9 }).byteLength, 0);
    const motionRaw = payloads.reduce((sum, item) => sum + item.motion.byteLength, 0);
    const motionGzip = payloads.reduce((sum, item) => sum + gzipSync(item.motion, { level: 9 }).byteLength, 0);
    return { tileInterior: result.tileInterior, tileCount: tiles.length, interiorProviderNodes: tiles.reduce((sum, tile) => sum + tile.interiorWidth * tile.interiorHeight, 0), duplicatedHaloNodes: tiles.reduce((sum, tile) => sum + tile.storedWidth * tile.storedHeight - tile.interiorWidth * tile.interiorHeight, 0), temporalSourceRainRawBytes: rainRaw, motionRawBytes: motionRaw, combinedGpuTemporalSourceRawBytes: rainRaw + motionRaw, coldLoadGzipBytes: rainGzip + motionGzip, requestCount: tiles.length * 2 };
  }) };
});

console.log(JSON.stringify({ dataset: { generationId, sourceFilename: generationMetadata.source.filename, generationRoot, sequenceStart: generationMetadata.time.sequence_start, sequenceEnd: generationMetadata.time.sequence_end, frameCount, sourceDimensions: [width, height], sourceGridSpacingDegrees: [grid.longitude_spacing, grid.latitude_spacing], physicalUnits: generationMetadata.rain.physical_units, unionDistinctNonzeroNodes: generationMetadata.rain.union_distinct_nonzero_nodes }, motion: { dimensions: [motion.grid_width, motion.grid_height], intervals: motion.interval_count, spacingSourceNodes: motion.grid_spacing_source_nodes, encoding: 'RGBA32F, four Float32 components in forwardXY then backwardXY order', currentBytesPerInterval: motion.interval_byte_length, allIntervalsRawBytes: motion.interval_byte_length * motion.interval_count, displacement, maximumAbsoluteByAxis: { x: Math.max(displacement[0].maxAbsolute, displacement[2].maxAbsolute), y: Math.max(displacement[1].maxAbsolute, displacement[3].maxAbsolute) }, maximumVectorMagnitude, maximumMagnitudeUpperBound: Math.hypot(Math.max(displacement[0].maxAbsolute, displacement[2].maxAbsolute), Math.max(displacement[1].maxAbsolute, displacement[3].maxAbsolute)), intervalHalos, globalRainHalo: globalHalo, motionHalo: 'none beyond the tile-local bilinear stencil; tile motion node ranges include floor(start/spacing)..ceil(end/spacing)' }, tiles: results, residency, baseline: { fullDomainR16FRainBytes: width * height * frameCount * 2, fullDomainFloat32RainBytes: width * height * frameCount * 4, supportMaskBytes: supportBuffer.byteLength }, methodology: { rainLayout: 'time-major, row-major tile interiors plus fixed source-grid halo; each sample encoded as IEEE-754 binary16 preserving mm/h values', gzip: 'node:zlib gzip level 9', emptyTileRule: 'sequence-wide support bit in tile interior; support mask is already expanded by motion search radius', requestModel: 'two requests per resident tile: one rain payload and one motion payload; payloads are independent of timeline position', viewportModel: 'current app 25% envelope expansion + one L10 interval + outward L10 snap, applied to deterministic center/zoom viewport footprints; screen-lattice/globe horizon effects require device measurement' } }, null, 2));
