import { setGeographicProjection } from './geographic-layer-utils.js';
import {
  DOTS_BASE_RAIN_MAX_RADIUS_FRACTION,
  DOTS_STRONG_RAIN_FULL_MMH,
  DOTS_STRONG_RAIN_ONSET_MMH,
  DOTS_STRONG_RAIN_SHAPE_ANCHORS,
  dotsStrongRainMmhToRadiusFraction,
  rainMmhToRadiusFraction,
  RAIN_VISIBILITY_SHADER,
  STRONG_RAIN_SHADER
} from './precipitation-mapping.js';
import { LOD_MORPH_SECONDS, RAIN_VISIBILITY_FLOOR_MMH } from './config.js';
import { sha256ArrayBuffer } from './sha256.js';
import { geographicHazardRadiusForSeverity } from './hazard-renderer.js';
import { mercatorGridLevelBoundary, zoomToMercatorGridLevel } from './geographic-lod.js';

export const TILED_RAIN_SCHEMA = 'dot-field-tiled-rain-v0';
export const TILED_RAIN_LOD_SCHEMA = 'dot-field-tiled-rain-lod-v1';
export const TILED_RAIN_WARP_SCHEMA = 'dot-field-tiled-rain-warp-v1';
export const TILED_RAIN_LOD_LEVEL = 13;
export const TILED_RAIN_LOD_LEVELS = Object.freeze([11, 12, 13, 14]);
export const TILED_RAIN_LOD_HYSTERESIS = 0.08;
export const TILED_RAIN_TILE_SIZE = 128;
export const TILED_RAIN_GRID_SIZE = 2 ** TILED_RAIN_LOD_LEVEL;
export const TILED_RAIN_WARP_HALO_SIZE = 13;
export const TILED_RAIN_WARP_STORED_SIZE = TILED_RAIN_TILE_SIZE + 2 * TILED_RAIN_WARP_HALO_SIZE;
// The LRU returns toward this target whenever the required target permits it.
const READY_CACHE_BLOCK_LIMIT = 320;
export const TILED_RAIN_MAX_CONCURRENT_FETCHES = 8;
const VIEWPORT_OVERSCAN_SAMPLES = 64;
const QUAD = new Float32Array([-1, -1, 1, -1, 1, 1, -1, -1, 1, 1, -1, 1]);
const CELL_VERTICES = new Float32Array([-0.5, -0.5, 0.5, -0.5, 0.5, 0.5, -0.5, -0.5, 0.5, 0.5, -0.5, 0.5]);
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
  return vertices;
}

const HAIL = new Float32Array(unitShape(circularPoints(6)));
const STORM_INNER_RATIO = 0.38;
const STORM = new Float32Array(unitShape(circularPoints(8).map((point, index) => {
  const scale = index % 2 === 0 ? 1 : STORM_INNER_RATIO;
  return [point[0] * scale, point[1] * scale];
})));
const COLORS = { rain: [0, 0.565, 1, 1], strong: [0, 0, 1, 1], storm: [1, 0, 1, 1], hail: [1, 0.831, 0, 1] };
const now = () => globalThis.performance?.now?.() ?? Date.now();
const smoothstep = (edge0, edge1, value) => {
  const t = Math.max(0, Math.min(1, (value - edge0) / (edge1 - edge0)));
  return t * t * (3 - 2 * t);
};

function clearError(message) {
  throw new Error(`Tiled rain asset validation failed: ${message}`);
}

function positiveInteger(value, name) {
  if (!Number.isInteger(value) || value <= 0) clearError(`${name} must be a positive integer.`);
  return value;
}

function resolveAssetUrl(manifestUrl, asset) {
  return new URL(asset, new URL(manifestUrl, globalThis.location?.href || manifestUrl)).href;
}

export function sourceFrameForTime(frameCount, time) {
  const position = Math.max(0, Math.min(1, Number.isFinite(time) ? time : 0)) * (frameCount - 1);
  const frame0 = Math.floor(position);
  const progress = position - frame0;
  return {
    frame0,
    frame1: progress === 0 ? frame0 : Math.min(frameCount - 1, frame0 + 1),
    progress
  };
}

export function selectTiledRainLod(value, fallback = TILED_RAIN_LOD_LEVEL) {
  if (value === undefined || value === null || value === '') return fallback;
  const level = Number(value);
  if (!Number.isInteger(level) || !TILED_RAIN_LOD_LEVELS.includes(level)) {
    throw new Error(`tiledRainLod must be one of ${TILED_RAIN_LOD_LEVELS.join(', ')}.`);
  }
  return level;
}

export function automaticTiledRainLod(logicalZoom, minLevel = 11, maxLevel = 14) {
  const unclamped = zoomToMercatorGridLevel(Number.isFinite(logicalZoom) ? logicalZoom : 0);
  return Math.max(minLevel, Math.min(maxLevel, unclamped));
}

// Automatic tiled LOD alone carries selection state.  The regular CPU
// renderer continues to use its nearest-level mapping without a dead band.
export function automaticTiledRainLodWithHysteresis(logicalZoom, selectedLevel, minLevel = 11, maxLevel = 14) {
  const zoom = Number.isFinite(logicalZoom) ? logicalZoom : 0;
  let level = TILED_RAIN_LOD_LEVELS.includes(selectedLevel)
    ? Math.max(minLevel, Math.min(maxLevel, selectedLevel))
    : automaticTiledRainLod(zoom, minLevel, maxLevel);
  while (level < maxLevel && zoom >= mercatorGridLevelBoundary(level) + TILED_RAIN_LOD_HYSTERESIS) level++;
  while (level > minLevel && zoom <= mercatorGridLevelBoundary(level - 1) - TILED_RAIN_LOD_HYSTERESIS) level--;
  return level;
}

// A fine 128-square tile belongs to exactly one coarse tile.  These helpers
// mirror the transition shader arithmetic and keep deterministic verification
// independent of WebGL.
export function tiledRainCoarseTileForFineTile(fineTileX, fineTileY) {
  return { x: Math.floor(fineTileX / 2), y: Math.floor(fineTileY / 2) };
}

export function tiledRainCoarseLocalForFineSample(fineTileX, fineTileY, fineLocalX, fineLocalY) {
  const shared = fineLocalX % 2 === 0 && fineLocalY % 2 === 0;
  return {
    shared,
    x: shared ? ((fineTileX & 1) * 64 + fineLocalX / 2) : null,
    y: shared ? ((fineTileY & 1) * 64 + fineLocalY / 2) : null
  };
}

export function tiledRainDotsMorphRadius(coarseRadius, fineRadius, refineProgress) {
  const progress = Math.max(0, Math.min(1, refineProgress));
  return Math.sqrt(Math.max(0, coarseRadius * coarseRadius + (fineRadius * fineRadius - coarseRadius * coarseRadius) * progress));
}

export function initialTiledRainLod(logicalZoom, override = null, motionWarp = false) {
  if (motionWarp) return TILED_RAIN_LOD_LEVEL;
  if (override === undefined || override === null || override === '') {
    return automaticTiledRainLod(logicalZoom);
  }
  return selectTiledRainLod(override);
}

export function tiledRainProgramCacheKey({
  motionWarp = false,
  motionWarpDebugMode = null,
  aggregateSummary = false,
  lodLevel = 'legacy',
  gridSize = TILED_RAIN_GRID_SIZE,
  variantName = 'unknown',
  presentationMode = 'dots',
  hazardsAvailable = false
} = {}) {
  const payloadKind = motionWarp ? 'motion' : aggregateSummary ? 'aggregate' : 'direct';
  return [
    payloadKind,
    `L${lodLevel}`,
    `grid${gridSize}`,
    variantName,
    presentationMode,
    motionWarpDebugMode || 'standard',
    hazardsAvailable ? 'hazards' : 'no-hazards'
  ].join(':');
}

export function adjacentTiledRainLod(currentLevel, desiredLevel) {
  if (!TILED_RAIN_LOD_LEVELS.includes(currentLevel) || !TILED_RAIN_LOD_LEVELS.includes(desiredLevel)) {
    throw new Error('Tiled rain LOD levels must be one of 11, 12, 13, or 14.');
  }
  if (currentLevel === desiredLevel) return currentLevel;
  return currentLevel + Math.sign(desiredLevel - currentLevel);
}

function qualifiedBlockKey(level, tileKey, blockIndex, multiLod) {
  return multiLod ? `${level}:${tileKey}:${blockIndex}` : `${tileKey}:${blockIndex}`;
}

function parseQualifiedBlockKey(key, multiLod) {
  const parts = key.split(':');
  if (multiLod) return { level: Number(parts.shift()), tileKey: parts.slice(0, 2).join(':'), blockIndex: Number(parts.at(-1)) };
  return { level: null, tileKey: parts.slice(0, 2).join(':'), blockIndex: Number(parts.at(-1)) };
}

function aggregateSummaryValid(summary) {
  return Number.isFinite(summary?.rainCoverage) && summary.rainCoverage >= 0;
}

export function aggregateDotsRadiusFractions(summary) {
  if (!aggregateSummaryValid(summary)) return { rain: 0, strong: 0, storm: 0, hail: 0 };
  return {
    rain: Math.sqrt(Math.max(0, summary.rainCoverage))
      * rainMmhToRadiusFraction(summary.rainWetMeanMmh),
    strong: Math.sqrt(Math.max(0, summary.strongCoverage))
      * dotsStrongRainMmhToRadiusFraction(summary.rainMaxMmh),
    storm: Math.sqrt(Math.max(0, summary.stormCoverage || 0))
      * geographicHazardRadiusForSeverity('storm', summary.stormMaxSeverity || 0, 1),
    hail: Math.sqrt(Math.max(0, summary.hailCoverage || 0))
      * geographicHazardRadiusForSeverity('hail', summary.hailMaxSeverity || 0, 1)
  };
}

export function aggregateDotsTemporalRadius(first, second, progress, type) {
  const firstValid = aggregateSummaryValid(first);
  const secondValid = aggregateSummaryValid(second);
  const firstRadius = aggregateDotsRadiusFractions(first)[type] || 0;
  const secondRadius = aggregateDotsRadiusFractions(second)[type] || 0;
  if (firstValid && secondValid) return Math.sqrt(firstRadius ** 2 + (secondRadius ** 2 - firstRadius ** 2) * Math.max(0, Math.min(1, progress)));
  return firstValid ? firstRadius : secondValid ? secondRadius : 0;
}

export function aggregateSquaresInputs(first, second, progress) {
  const firstValid = aggregateSummaryValid(first);
  const secondValid = aggregateSummaryValid(second);
  const keys = ['rainWetMeanMmh', 'rainCoverage', 'stormCoverage', 'stormMaxSeverity', 'hailCoverage', 'hailMaxSeverity'];
  const value = (key) => {
    const firstValue = firstValid ? Number(first?.[key]) || 0 : 0;
    const secondValue = secondValid ? Number(second?.[key]) || 0 : 0;
    return firstValid && secondValid ? firstValue * (1 - progress) + secondValue * progress : firstValid ? firstValue : secondValid ? secondValue : 0;
  };
  return Object.fromEntries(keys.map((key) => [key, value(key)]));
}

function validateManifest(manifest) {
  if (!manifest || manifest.schema !== TILED_RAIN_SCHEMA || manifest.version !== 0) clearError('schema/version is not supported.');
  if (manifest.lod_level !== TILED_RAIN_LOD_LEVEL) clearError('only L13 is supported.');
  if (manifest.tile_size !== TILED_RAIN_TILE_SIZE || manifest.grid_size !== TILED_RAIN_GRID_SIZE) clearError('tile/grid dimensions are invalid.');
  positiveInteger(manifest.frame_count, 'frame_count');
  positiveInteger(manifest.temporal_block_size, 'temporal_block_size');
  if (!Array.isArray(manifest.timestamps) || manifest.timestamps.length !== manifest.frame_count) clearError('timestamps do not match frame_count.');
  if (!Array.isArray(manifest.tiles) || !manifest.tiles.length) clearError('tiles are missing.');
  if (manifest.physical_units !== 'mm/h' || manifest.byte_order !== 'little-endian') clearError('physical units or byte order are invalid.');
  const hazards = manifest.hazards;
  if (hazards !== undefined) {
    if (hazards.available !== true || JSON.stringify(hazards.channels) !== JSON.stringify(['storm', 'hail'])) {
      clearError('hazard channel availability is invalid.');
    }
    if (hazards.encoding?.dtype !== 'UInt8' || hazards.encoding?.minimum !== 0 || hazards.encoding?.maximum !== 255
      || hazards.encoding?.decode !== 'code / 255') {
      clearError('hazard UInt8 encoding semantics are invalid.');
    }
    for (const channel of ['storm', 'hail']) {
      const anchors = hazards.severity_anchors?.[channel];
      const codes = channel === 'storm' ? [10, 11, 12] : [13, 14, 15];
      if (!anchors || !codes.every((code) => Number.isFinite(anchors[String(code)]))) {
        clearError(`${channel} severity anchors are invalid.`);
      }
    }
  }
  const validateHazardBlock = (descriptor, channel, blockKey, frameCount) => {
    if (descriptor === null || descriptor === undefined) return;
    if (typeof descriptor !== 'object' || typeof descriptor.asset !== 'string'
      || descriptor.sample_count !== TILED_RAIN_TILE_SIZE ** 2
      || descriptor.byte_length !== descriptor.sample_count * frameCount
      || !Number.isInteger(descriptor.gzip_byte_length) || descriptor.gzip_byte_length < 0) {
      clearError(`${channel} payload ${blockKey} is invalid.`);
    }
  };
  const encoding = manifest.encoding;
  if (!encoding || encoding.dtype !== 'UInt16' || encoding.nodata_code !== 0 || encoding.dry_code !== 1
    || encoding.positive_code_min !== 2 || encoding.positive_code_max !== 65535
    || encoding.positive_quantized_range !== 65534
    || !Number.isFinite(encoding.physical_max_mmh) || encoding.physical_max_mmh <= 0) {
    clearError('UInt16 encoding semantics are invalid.');
  }
  const seenTiles = new Set();
  const seenBlocks = new Set();
  for (const tile of manifest.tiles) {
    if (!Number.isInteger(tile.x) || !Number.isInteger(tile.y) || !Array.isArray(tile.blocks)) clearError('tile descriptor is invalid.');
    const tileKey = `${tile.x}:${tile.y}`;
    if (seenTiles.has(tileKey)) clearError(`duplicate tile ${tileKey}.`);
    seenTiles.add(tileKey);
    for (const block of tile.blocks) {
      const key = `${tileKey}:${block.index}`;
      if (!Number.isInteger(block.index) || !Number.isInteger(block.frame_start) || !Number.isInteger(block.frame_count)
        || block.frame_count < 1 || block.frame_start < 0 || block.frame_start + block.frame_count > manifest.frame_count
        || typeof block.asset !== 'string' || block.sample_count !== TILED_RAIN_TILE_SIZE ** 2
        || block.byte_length !== block.sample_count * block.frame_count * Uint16Array.BYTES_PER_ELEMENT) {
        clearError(`block ${key} is invalid.`);
      }
      validateHazardBlock(block.storm, 'storm', key, block.frame_count);
      validateHazardBlock(block.hail, 'hail', key, block.frame_count);
      if (seenBlocks.has(key)) clearError(`duplicate block ${key}.`);
      seenBlocks.add(key);
    }
  }
  manifest.hazardsAvailable = hazards?.available === true;
  return manifest;
}

function validateLodPayloadDescriptor(descriptor, name, frameCount, components, dtype) {
  if (!descriptor || typeof descriptor !== 'object'
    || typeof descriptor.asset !== 'string' || typeof descriptor.gzip_asset !== 'string'
    || descriptor.dtype !== dtype || descriptor.component_count !== components
    || descriptor.sample_count !== TILED_RAIN_TILE_SIZE ** 2
    || descriptor.frame_count !== frameCount
    || typeof descriptor.layout !== 'string' || !descriptor.layout.startsWith('frame-major;')
    || !Number.isInteger(descriptor.byte_length) || descriptor.byte_length < 0
    || !Number.isInteger(descriptor.gzip_byte_length) || descriptor.gzip_byte_length < 0) {
    clearError(`${name} payload descriptor is invalid.`);
  }
  const bytesPerComponent = dtype === 'Float16' || dtype === 'UInt16' ? 2 : 1;
  const expected = frameCount * descriptor.sample_count * components * bytesPerComponent;
  if (descriptor.byte_length !== expected) clearError(`${name} payload byte length is invalid.`);
  return descriptor;
}

function validateLodLevel(level, manifest) {
  if (!level || !TILED_RAIN_LOD_LEVELS.includes(level.level)) clearError('multi-LOD level is invalid.');
  const expectedKind = level.level < TILED_RAIN_LOD_LEVEL ? 'aggregate-summary' : 'direct';
  if (level.kind !== expectedKind || level.tile_size !== TILED_RAIN_TILE_SIZE) {
    clearError(`L${level.level} kind or tile size is invalid.`);
  }
  const grid = level.grid;
  const generated = grid?.generated_sample_bounds;
  const support = grid?.support_sample_bounds;
  if (!grid || grid.grid_size !== 2 ** level.level || !generated || !support
    || grid.width !== generated.max_i - generated.min_i + 1
    || grid.height !== generated.max_j - generated.min_j + 1
    || grid.count !== grid.width * grid.height) {
    clearError(`L${level.level} grid contract is invalid.`);
  }
  const tileBounds = level.tile_index_bounds;
  if (!tileBounds || tileBounds.min_x !== Math.floor(generated.min_i / TILED_RAIN_TILE_SIZE)
    || tileBounds.max_x !== Math.floor(generated.max_i / TILED_RAIN_TILE_SIZE)
    || tileBounds.min_y !== Math.floor(generated.min_j / TILED_RAIN_TILE_SIZE)
    || tileBounds.max_y !== Math.floor(generated.max_j / TILED_RAIN_TILE_SIZE)) {
    clearError(`L${level.level} tile bounds are invalid.`);
  }
  if (!Array.isArray(level.tiles) || level.tiles.length !== level.tile_count || level.tile_count < 1) {
    clearError(`L${level.level} tile descriptors are missing.`);
  }
  if (level.kind === 'aggregate-summary') {
    const planeA = level.encoding?.plane_a;
    const planeB = level.encoding?.plane_b;
    if (planeA?.dtype !== 'Float16'
      || JSON.stringify(planeA.components) !== JSON.stringify(['rainWetMeanMmh', 'rainMaxMmh', 'rainCoverage', 'strongCoverage'])
      || planeA.nodata_sentinel?.component !== 'rainCoverage'
      || planeA.nodata_sentinel.value !== -1
      || planeB?.dtype !== 'Float16'
      || JSON.stringify(planeB.components) !== JSON.stringify(['stormCoverage', 'stormMaxSeverity', 'hailCoverage', 'hailMaxSeverity'])
      || planeB.optional !== true || typeof planeB.absent_meaning !== 'string') {
      clearError(`L${level.level} aggregate encoding contract is invalid.`);
    }
  } else if (level.encoding?.rain?.dtype !== 'UInt16'
    || level.encoding.rain.nodata_code !== 0 || level.encoding.rain.dry_code !== 1
    || level.encoding.rain.positive_code_min !== 2 || level.encoding.rain.positive_code_max !== 65535
    || level.encoding.rain.positive_quantized_range !== 65534
    || !Number.isFinite(level.encoding.rain.physical_max_mmh) || level.encoding.rain.physical_max_mmh <= 0
    || level.encoding.hazards?.dtype !== 'UInt8' || level.encoding.hazards.decode !== 'code / 255') {
    clearError(`L${level.level} direct encoding contract is invalid.`);
  }
  const seenTiles = new Set();
  const expectedBlockCount = Math.ceil(manifest.frame_count / manifest.temporal_block_size);
  let hasHazardPayload = false;
  for (const tile of level.tiles) {
    if (!Number.isInteger(tile.x) || !Number.isInteger(tile.y) || !Array.isArray(tile.blocks)) {
      clearError(`L${level.level} tile descriptor is invalid.`);
    }
    const tileKey = `${tile.x}:${tile.y}`;
    if (seenTiles.has(tileKey) || tile.x < tileBounds.min_x || tile.x > tileBounds.max_x
      || tile.y < tileBounds.min_y || tile.y > tileBounds.max_y) clearError(`L${level.level} tile ${tileKey} is invalid.`);
    seenTiles.add(tileKey);
    if (tile.blocks.length !== expectedBlockCount) clearError(`L${level.level} tile ${tileKey} block count is invalid.`);
    for (const block of tile.blocks) {
      const expectedFrameCount = Math.min(manifest.temporal_block_size, manifest.frame_count - block.index * manifest.temporal_block_size);
      if (!Number.isInteger(block.index) || block.index < 0 || block.frame_start !== block.index * manifest.temporal_block_size
        || block.frame_count !== expectedFrameCount || block.frame_start + block.frame_count > manifest.frame_count) {
        clearError(`L${level.level} block ${tileKey}:${block.index} frame contract is invalid.`);
      }
      if (level.kind === 'aggregate-summary') {
        validateLodPayloadDescriptor(block.summary_a, `L${level.level} Summary A ${tileKey}:${block.index}`, block.frame_count, 4, 'Float16');
        if (block.summary_b !== null && block.summary_b !== undefined) {
          validateLodPayloadDescriptor(block.summary_b, `L${level.level} Summary B ${tileKey}:${block.index}`, block.frame_count, 4, 'Float16');
          hasHazardPayload = true;
        }
      } else {
        validateLodPayloadDescriptor(block.rain || block, `L${level.level} rain ${tileKey}:${block.index}`, block.frame_count, 1, 'UInt16');
        for (const channel of ['storm', 'hail']) {
          if (block[channel] !== null && block[channel] !== undefined) {
            validateLodPayloadDescriptor(block[channel], `L${level.level} ${channel} ${tileKey}:${block.index}`, block.frame_count, 1, 'UInt8');
            hasHazardPayload = true;
          }
        }
      }
    }
  }
  return Object.freeze({ ...level, hasHazardPayload });
}

export function validateTiledRainLodManifest(manifest) {
  if (!manifest || manifest.schema !== TILED_RAIN_LOD_SCHEMA || manifest.version !== 1) {
    clearError('multi-LOD schema/version is not supported.');
  }
  if (manifest.reference_level !== TILED_RAIN_LOD_LEVEL
    || manifest.level_range?.min !== TILED_RAIN_LOD_LEVELS[0]
    || manifest.level_range?.max !== TILED_RAIN_LOD_LEVELS.at(-1)
    || manifest.tile_size !== TILED_RAIN_TILE_SIZE
    || !Number.isInteger(manifest.temporal_block_size) || manifest.temporal_block_size <= 0
    || !Number.isInteger(manifest.frame_count) || manifest.frame_count <= 0
    || !Array.isArray(manifest.timestamps) || manifest.timestamps.length !== manifest.frame_count
    || manifest.physical_units !== 'mm/h' || manifest.byte_order !== 'little-endian'
    || typeof manifest.source_generation_id !== 'string' || !manifest.source_generation_id
    || typeof manifest.source_metadata_asset !== 'string') {
    clearError('multi-LOD common manifest contract is invalid.');
  }
  if (!Array.isArray(manifest.levels) || manifest.levels.length !== TILED_RAIN_LOD_LEVELS.length) {
    clearError('multi-LOD level list is invalid.');
  }
  const levels = new Map();
  for (const level of manifest.levels) {
    if (levels.has(level.level)) clearError(`duplicate multi-LOD level L${level.level}.`);
    const validated = validateLodLevel(level, manifest);
    levels.set(level.level, validated);
  }
  if (levels.size !== TILED_RAIN_LOD_LEVELS.length || TILED_RAIN_LOD_LEVELS.some((level) => !levels.has(level))) {
    clearError('multi-LOD levels are incomplete.');
  }
  return Object.freeze({ ...manifest, levels: Object.freeze([...levels.values()]) });
}

async function fetchJson(url) {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`Unable to load tiled rain manifest ${url} (${response.status}).`);
  try {
    return await response.json();
  } catch {
    clearError('manifest is not valid JSON.');
  }
}

async function fetchJsonWithBytes(url, description) {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`Unable to load ${description || 'JSON'} ${url} (${response.status}).`);
  const bytes = await response.arrayBuffer();
  try {
    return { value: JSON.parse(new TextDecoder().decode(bytes)), bytes };
  } catch {
    clearError(`${description || 'JSON'} is not valid JSON.`);
  }
}

async function loadAndValidateMultiLodDataset(manifestUrl, timing, lodLevel) {
  const manifest = validateTiledRainLodManifest(await fetchJson(manifestUrl));
  const selectedLevel = manifest.levels.find((level) => level.level === lodLevel);
  if (!selectedLevel) clearError(`multi-LOD level L${lodLevel} is not present.`);
  timing('tiled-rain-manifest-validation-complete');
  timing('tiled-rain-source-metadata-fetch-start');
  const sourceMetadata = await fetchJson(resolveAssetUrl(manifestUrl, manifest.source_metadata_asset));
  if (sourceMetadata.generation_id !== manifest.source_generation_id) {
    clearError(`source generation mismatch: manifest=${manifest.source_generation_id}, current=${sourceMetadata.generation_id || '<missing>'}.`);
  }
  timing('tiled-rain-source-generation-verified');
  const tiles = new Map(selectedLevel.tiles.map((tile) => [`${tile.x}:${tile.y}`, tile]));
  return Object.freeze({
    manifest,
    level: selectedLevel,
    lodLevel,
    manifestUrl,
    tiles,
    isMultiLod: true,
    sourceMetadata
  });
}

async function loadAndValidateDataset(manifestUrl, timing, lodLevel = TILED_RAIN_LOD_LEVEL) {
  timing('tiled-rain-manifest-fetch-start');
  const rawManifest = await fetchJson(manifestUrl);
  if (rawManifest?.schema === TILED_RAIN_LOD_SCHEMA) {
    return loadAndValidateMultiLodDataset(manifestUrl, timing, lodLevel);
  }
  const manifest = validateManifest(rawManifest);
  timing('tiled-rain-manifest-validation-complete');
  if (typeof manifest.source_generation_id !== 'string' || !manifest.source_generation_id) clearError('source_generation_id is missing.');
  if (typeof manifest.source_metadata_asset !== 'string') clearError('source_metadata_asset is missing.');
  timing('tiled-rain-source-metadata-fetch-start');
  const sourceMetadata = await fetchJson(resolveAssetUrl(manifestUrl, manifest.source_metadata_asset));
  if (sourceMetadata.generation_id !== manifest.source_generation_id) {
    clearError(`source generation mismatch: manifest=${manifest.source_generation_id}, current=${sourceMetadata.generation_id || '<missing>'}.`);
  }
  timing('tiled-rain-source-generation-verified');
  const tiles = new Map();
  for (const tile of manifest.tiles) tiles.set(`${tile.x}:${tile.y}`, tile);
  return Object.freeze({ manifest, manifestUrl, tiles, isMultiLod: false });
}

function validateMotionManifest(manifest) {
  if (!manifest || manifest.schema !== 'dot-field-tiled-rain-motion-v1' || manifest.version !== 1) {
    clearError('MotionField schema/version is not supported.');
  }
  if (manifest.rain_tile_size !== TILED_RAIN_TILE_SIZE || manifest.interval_count !== 18
    || !Array.isArray(manifest.intervals) || manifest.intervals.length !== manifest.interval_count) {
    clearError('MotionField temporal or tile dimensions are invalid.');
  }
  const motionGrid = deriveMotionGridContract(manifest);
  if (manifest.motion_grid?.anchor !== 'global L13 integer coordinate 0; independent of crop, tile, or viewport') {
    clearError('MotionField global grid anchoring is invalid.');
  }
  positiveInteger(manifest.motion_grid?.node_width, 'MotionField node_width');
  positiveInteger(manifest.motion_grid?.node_height, 'MotionField node_height');
  if (manifest.displacement?.maximum_absolute_component !== 12
    || manifest.encoding?.dtype !== 'Float32'
    || manifest.encoding?.byte_order !== 'little-endian') {
    clearError('MotionField displacement or encoding contract is invalid.');
  }
  const seen = new Set();
  for (const tile of manifest.tiles || []) {
    const expectedNodeXStart = (tile.x * TILED_RAIN_TILE_SIZE - manifest.motion_grid.node_x_start) / motionGrid.nodeSpacing;
    const expectedNodeYStart = (tile.y * TILED_RAIN_TILE_SIZE - manifest.motion_grid.node_y_start) / motionGrid.nodeSpacing;
    if (!Number.isInteger(tile.x) || !Number.isInteger(tile.y) || tile.node_width !== motionGrid.nodesPerTile || tile.node_height !== motionGrid.nodesPerTile
      || !Number.isInteger(tile.node_x_start) || !Number.isInteger(tile.node_y_start)
      || tile.node_x_start !== expectedNodeXStart || tile.node_y_start !== expectedNodeYStart
      || typeof tile.asset !== 'string' || typeof tile.gzip_asset !== 'string'
      || tile.byte_length !== manifest.interval_count * motionGrid.nodesPerTile * motionGrid.nodesPerTile * 3 * Float32Array.BYTES_PER_ELEMENT) {
      clearError('MotionField tile descriptor is invalid.');
    }
    const key = `${tile.x}:${tile.y}`;
    if (seen.has(key)) clearError(`duplicate MotionField tile ${key}.`);
    seen.add(key);
  }
  return manifest;
}

export function deriveMotionGridContract(manifest) {
  const grid = manifest?.motion_grid;
  const nodeSpacing = grid?.node_spacing_l13_samples;
  if (!Number.isInteger(nodeSpacing) || nodeSpacing <= 0
    || TILED_RAIN_TILE_SIZE % nodeSpacing !== 0
    || !Number.isInteger(grid?.node_x_start) || !Number.isInteger(grid?.node_y_start)) {
    clearError('MotionField node spacing or global node origin is invalid.');
  }
  return Object.freeze({
    nodeSpacing,
    nodesPerTile: TILED_RAIN_TILE_SIZE / nodeSpacing + 1,
    nodeXStart: grid.node_x_start,
    nodeYStart: grid.node_y_start
  });
}

function validateWarpManifest(manifest) {
  if (!manifest || manifest.schema !== TILED_RAIN_WARP_SCHEMA || manifest.version !== 1) {
    clearError('warp rain schema/version is not supported.');
  }
  if (manifest.lod_level !== TILED_RAIN_LOD_LEVEL || manifest.grid_size !== TILED_RAIN_GRID_SIZE
    || manifest.core_tile_size !== TILED_RAIN_TILE_SIZE || manifest.halo_size !== TILED_RAIN_WARP_HALO_SIZE
    || manifest.stored_footprint?.width !== TILED_RAIN_WARP_STORED_SIZE
    || manifest.stored_footprint?.height !== TILED_RAIN_WARP_STORED_SIZE) {
    clearError('warp rain grid, core, or halo dimensions are invalid.');
  }
  positiveInteger(manifest.frame_count, 'frame_count');
  if (!Array.isArray(manifest.timestamps) || manifest.timestamps.length !== manifest.frame_count
    || manifest.temporal_block_size !== 4) clearError('warp rain temporal blocking is invalid.');
  if (manifest.physical_units !== 'mm/h' || manifest.byte_order !== 'little-endian') clearError('warp rain units or byte order are invalid.');
  const sourceEncoding = manifest.encoding;
  if (!sourceEncoding || sourceEncoding.dtype !== 'UInt16' || sourceEncoding.nodata_code !== 0 || sourceEncoding.dry_code !== 1
    || sourceEncoding.positive_code_min !== 2 || sourceEncoding.positive_code_max !== 65535
    || sourceEncoding.positive_quantized_range !== 65534
    || !Number.isFinite(sourceEncoding.physical_max_mmh) || sourceEncoding.physical_max_mmh <= 0) {
    clearError('warp rain UInt16 encoding semantics are invalid.');
  }
  if (manifest.motion_displacement_bound_l13_samples !== 12
    || typeof manifest.source_tiled_rain_manifest !== 'string'
    || typeof manifest.source_motion_manifest !== 'string'
    || typeof manifest.source_tiled_rain_manifest_sha256 !== 'string'
    || typeof manifest.source_motion_manifest_sha256 !== 'string') {
    clearError('warp rain source identity binding is invalid.');
  }
  const seenTiles = new Set();
  const seenBlocks = new Set();
  for (const tile of manifest.tiles || []) {
    if (!Number.isInteger(tile.x) || !Number.isInteger(tile.y) || !Array.isArray(tile.blocks)) clearError('warp tile descriptor is invalid.');
    const tileKey = `${tile.x}:${tile.y}`;
    if (seenTiles.has(tileKey)) clearError(`duplicate warp tile ${tileKey}.`);
    seenTiles.add(tileKey);
    for (const block of tile.blocks) {
      const key = `${tileKey}:${block.index}`;
      if (!Number.isInteger(block.index) || !Number.isInteger(block.frame_start) || !Number.isInteger(block.frame_count)
        || block.frame_count < 1 || block.frame_start < 0 || block.frame_start + block.frame_count > manifest.frame_count
        || typeof block.asset !== 'string' || typeof block.gzip_asset !== 'string'
        || block.sample_count !== TILED_RAIN_WARP_STORED_SIZE ** 2
        || block.byte_length !== block.sample_count * block.frame_count * Uint16Array.BYTES_PER_ELEMENT) {
        clearError(`warp block ${key} is invalid.`);
      }
      if (seenBlocks.has(key)) clearError(`duplicate warp block ${key}.`);
      seenBlocks.add(key);
    }
  }
  return manifest;
}

async function loadAndValidateWarpDataset(manifestUrl, timing) {
  timing('tiled-rain-warp-manifest-fetch-start');
  const warpResponse = await fetchJsonWithBytes(manifestUrl, 'warp rain manifest');
  const manifest = validateWarpManifest(warpResponse.value);
  timing('tiled-rain-warp-manifest-validation-complete');
  const rainManifestUrl = resolveAssetUrl(manifestUrl, manifest.source_tiled_rain_manifest);
  const rainResponse = await fetchJsonWithBytes(rainManifestUrl, 'Phase 0A tiled rain manifest');
  const rainManifest = validateManifest(rainResponse.value);
  const rainManifestSha256 = await sha256ArrayBuffer(rainResponse.bytes);
  if (rainManifestSha256 !== manifest.source_tiled_rain_manifest_sha256) {
    clearError('warp rain is not bound to the exact Phase 0A manifest bytes.');
  }
  if (rainManifest.source_generation_id !== manifest.source_generation_id) {
    clearError('warp rain and Phase 0A source generation IDs differ.');
  }
  const sourceMetadataUrl = resolveAssetUrl(rainManifestUrl, rainManifest.source_metadata_asset);
  const sourceMetadata = await fetchJson(sourceMetadataUrl);
  if (sourceMetadata.generation_id !== manifest.source_generation_id) {
    clearError(`source generation mismatch: warp=${manifest.source_generation_id}, current=${sourceMetadata.generation_id || '<missing>'}.`);
  }
  const motionManifestUrl = resolveAssetUrl(manifestUrl, manifest.source_motion_manifest);
  const motionResponse = await fetchJsonWithBytes(motionManifestUrl, 'MotionField manifest');
  const motionManifest = validateMotionManifest(motionResponse.value);
  const motionManifestSha256 = await sha256ArrayBuffer(motionResponse.bytes);
  if (motionManifestSha256 !== manifest.source_motion_manifest_sha256) {
    clearError('warp rain is not bound to the exact MotionField manifest bytes.');
  }
  if (motionManifest.source_generation_id !== manifest.source_generation_id
    || motionManifest.source_tiled_rain_manifest_sha256 !== rainManifestSha256) {
    clearError('warp rain, MotionField, and Phase 0A source identities differ.');
  }
  if (motionManifest.interval_count !== manifest.frame_count - 1
    || JSON.stringify(motionManifest.intervals.map((interval) => interval.from)) !== JSON.stringify(manifest.timestamps.slice(0, -1))
    || JSON.stringify(motionManifest.intervals.map((interval) => interval.to)) !== JSON.stringify(manifest.timestamps.slice(1))) {
    clearError('warp rain and MotionField timestamps differ.');
  }
  const tiles = new Map();
  for (const tile of manifest.tiles) tiles.set(`${tile.x}:${tile.y}`, tile);
  const motionTiles = new Map();
  for (const tile of motionManifest.tiles || []) motionTiles.set(`${tile.x}:${tile.y}`, tile);
  if (motionTiles.size !== tiles.size || [...tiles.keys()].some((key) => !motionTiles.has(key))) {
    clearError('warp rain and MotionField tile identities differ.');
  }
  timing('tiled-rain-warp-source-identities-verified');
  return Object.freeze({
    manifest,
    manifestUrl,
    tiles,
    isMotionWarp: true,
    motionManifest,
    motionManifestUrl,
    rainManifestUrl,
    motionTiles,
    sourceMetadata,
    sourceTiledRainManifestSha256: rainManifestSha256,
    sourceMotionManifestSha256: motionManifestSha256
  });
}

export class TiledRainTileStore {
  constructor(dataset, { onTiming = null } = {}) {
    this.dataset = dataset;
    this.rootManifest = dataset.manifest;
    this.level = dataset.level || dataset.manifest;
    this.motionWarp = Boolean(dataset.isMotionWarp);
    this.multiLod = dataset.isMultiLod === true || Array.isArray(dataset.manifest?.levels);
    // Keep the selected level's runtime fields at the historical manifest
    // access path while retaining the multi-LOD root fields for diagnostics.
    this.manifest = dataset.level
      ? Object.freeze({ ...dataset.manifest, ...dataset.level })
      : dataset.manifest;
    this.levels = this.multiLod
      ? new Map(dataset.manifest.levels.map((level) => [Number(level.level), level]))
      : new Map([[this.level.level ?? this.level.lod_level ?? TILED_RAIN_LOD_LEVEL, this.level]]);
    this.tilesByLevel = new Map([...this.levels].map(([level, data]) => [
      level,
      new Map((data.tiles || []).map((tile) => [`${tile.x}:${tile.y}`, tile]))
    ]));
    this.tiles = dataset.tiles;
    this.aggregateSummary = this.level.kind === 'aggregate-summary';
    this.lodLevel = this.level.level ?? this.level.lod_level ?? TILED_RAIN_LOD_LEVEL;
    this.gridSize = this.level.grid?.grid_size ?? this.level.grid_size ?? TILED_RAIN_GRID_SIZE;
    this.physicalMaxMmh = this.multiLod
      ? (this.level.kind === 'direct' ? this.level.encoding.rain.physical_max_mmh : null)
      : this.manifest.encoding?.physical_max_mmh ?? null;
    this.hazardsAvailable = !this.motionWarp && (this.multiLod
      ? this.level.hasHazardPayload === true
      : this.manifest.hazardsAvailable === true);
    this.motionWarpDebugMode = this.motionWarp && dataset.motionWarpDebugMode === 'full' ? 'full' : null;
    this.motionManifest = dataset.motionManifest || null;
    this.motionGrid = this.motionManifest ? deriveMotionGridContract(this.motionManifest) : null;
    this.motionManifestUrl = dataset.motionManifestUrl || null;
    this.motionTiles = dataset.motionTiles || new Map();
    this.onTiming = typeof onTiming === 'function' ? onTiming : () => {};
    this.startedAt = now();
    this.blocks = new Map();
    this.lastUsed = 0;
    this.diagnosticsState = {
      sourceGenerationId: this.manifest.source_generation_id,
      visibleTileCount: 0,
      residentTileCount: 0,
      residentTileBlockCount: 0,
      pendingRequestCount: 0,
      lodLevel: this.lodLevel,
      payloadKind: this.aggregateSummary ? 'aggregate-summary' : 'direct',
      payloadDtype: this.aggregateSummary ? 'Float16 RGBA summary textures' : 'UInt16 rain / UInt8 hazards',
      logicalResidentPayloadBytes: 0,
      estimatedGpuPayloadBytes: 0,
      logicalUInt16ResidentBytes: 0,
      estimatedGpuTextureBytes: 0,
      hazardsAvailable: this.hazardsAvailable,
      logicalHazardResidentBytes: 0,
      estimatedHazardGpuBytes: 0,
      peakLogicalHazardResidentBytes: 0,
      peakEstimatedHazardGpuBytes: 0,
      haloRainLogicalResidentBytes: 0,
      estimatedHaloRainGpuBytes: 0,
      motionWarpActive: this.motionWarp,
      motionWarpDebugMode: this.motionWarpDebugMode,
      visibleMotionTilesReady: 0,
      currentMotionInterval: null,
      visibleUniqueMotionNodeCount: 0,
      visibleNonzeroConfidenceNodeCount: 0,
      visibleNonzeroConfidencePercentage: 0,
      visibleConfidenceMean: null,
      visibleConfidenceMedian: null,
      visibleConfidenceMax: null,
      visibleDisplacementMagnitudeMean: null,
      visibleDisplacementMagnitudeMedian: null,
      visibleDisplacementMagnitudeMax: null,
      visibleDxMin: null,
      visibleDxMax: null,
      visibleDyMin: null,
      visibleDyMax: null,
      warpManifestSourceGenerationId: this.motionWarp ? this.manifest.source_generation_id : null,
      warpManifestSourceTiledRainManifestSha256: this.motionWarp ? this.manifest.source_tiled_rain_manifest_sha256 : null,
      warpManifestSourceMotionManifestSha256: this.motionWarp ? this.manifest.source_motion_manifest_sha256 : null,
      motionManifestSha256: this.motionWarp ? dataset.sourceMotionManifestSha256 : null,
      motionManifestSourceTiledRainManifestSha256: this.motionWarp ? this.motionManifest.source_tiled_rain_manifest_sha256 : null,
      rainHaloSize: this.motionWarp ? TILED_RAIN_WARP_HALO_SIZE : 0,
      storedRainTextureDimensions: this.motionWarp ? [TILED_RAIN_WARP_STORED_SIZE, TILED_RAIN_WARP_STORED_SIZE] : [TILED_RAIN_TILE_SIZE, TILED_RAIN_TILE_SIZE],
      residentMotionTileCount: 0,
      pendingMotionTileCount: 0,
      logicalMotionResidentBytes: 0,
      estimatedMotionGpuBytes: 0,
      peakLogicalMotionResidentBytes: 0,
      peakEstimatedMotionGpuBytes: 0,
      motionRequestCount: 0,
      motionFetchCount: 0,
      motionUploadCount: 0,
      peakResidentMotionTileCount: 0,
      tileRequestCount: 0,
      tileFetchCount: 0,
      tileUploadCount: 0,
      latestGpuUploadMs: 0,
      cumulativeGpuUploadMs: 0,
      firstTiledWeatherVisibleMs: null,
      evictions: 0,
      staleDesiredStates: 0,
      sourceFrameStackFetched: false,
      peakResidentBlockCount: 0,
      peakLogicalUInt16ResidentBytes: 0,
      peakEstimatedGpuTextureBytes: 0,
      inFlightFetchCount: 0,
      queuedFetchCount: 0,
      abortedObsoleteRequestCount: 0,
      maxConcurrentFetches: TILED_RAIN_MAX_CONCURRENT_FETCHES,
      peakInFlightFetchCount: 0,
      gzipResponseCount: 0,
      identityResponseCount: 0,
      unknownEncodingResponseCount: 0,
      responseContentLengthBytes: 0,
      rainResponseContentLengthBytes: 0,
      motionResponseContentLengthBytes: 0,
      logicalFetchedBytes: 0,
      latestContentEncoding: null,
      lastError: null,
      rainBlockRequestCount: 0,
      rainBlockFetchCount: 0,
      motionLogicalFetchedBytes: 0,
      combinedWeatherFetchCount: 0,
      peakCombinedInFlightWeatherFetchCount: 0,
      stormResponseContentLengthBytes: 0,
      hailResponseContentLengthBytes: 0,
      stormFetchCount: 0,
      hailFetchCount: 0,
      logicalHazardFetchedBytes: 0
    };
    this.fetchQueue = [];
    this.inFlightFetchCount = 0;
    this.latestUsefulBlockKeys = new Set();
    this.latestUsefulMotionTileKeys = new Set();
    this.protectedBlockKeys = new Set();
    this.maxTargetBlocks = 0;
    this.levelDiagnosticsCounters = new Map([...this.levels.keys()].sort((left, right) => left - right).map((level) => [level, {
      blockRequestCount: 0,
      blockFetchCount: 0,
      gpuUploadCount: 0,
      evictionCount: 0
    }]));
    const payloadByteSizes = [...this.levels].flatMap(([level, levelData]) => {
      const levelHazardsAvailable = this.multiLod
        ? levelData.hasHazardPayload === true
        : this.hazardsAvailable;
      return [...(this.tilesByLevel.get(level)?.values() || [])].flatMap((tile) => tile.blocks.map((block) => {
        const primary = levelData.kind === 'aggregate-summary'
          ? block.summary_a
          : block.rain || block;
        const hazardBytes = levelHazardsAvailable
          ? levelData.kind === 'aggregate-summary'
            ? block.summary_b?.byte_length || 0
            : (block.storm?.byte_length || 0) + (block.hail?.byte_length || 0)
          : 0;
        const primaryBytes = primary?.byte_length || 0;
        return { primaryBytes, hazardBytes, combinedBytes: primaryBytes + hazardBytes };
      }));
    });
    this.maxBlockBytes = Math.max(0, ...payloadByteSizes.map(({ primaryBytes }) => primaryBytes));
    this.maxHazardBlockBytes = Math.max(0, ...payloadByteSizes.map(({ hazardBytes }) => hazardBytes));
    this.maxCombinedBlockBytes = Math.max(0, ...payloadByteSizes.map(({ combinedBytes }) => combinedBytes));
    this.effectiveReadyBlockLimit = Math.max(READY_CACHE_BLOCK_LIMIT, this.protectedBlockKeys.size);
    this.maxTrackedBlocks = this.effectiveReadyBlockLimit + TILED_RAIN_MAX_CONCURRENT_FETCHES;
    this.diagnosticsState.readyCacheBlockLimit = READY_CACHE_BLOCK_LIMIT;
    this.diagnosticsState.byteLimitLevelCount = this.levels.size;
    this.diagnosticsState.maxCombinedBlockBytes = this.maxCombinedBlockBytes;
    this.diagnosticsState.effectiveReadyBlockLimit = this.effectiveReadyBlockLimit;
    this.diagnosticsState.maxTargetBlockCount = this.maxTargetBlocks;
    this.diagnosticsState.readyCacheByteTarget = READY_CACHE_BLOCK_LIMIT * this.maxCombinedBlockBytes;
    this.diagnosticsState.effectiveCpuResidentByteLimit = this.effectiveReadyBlockLimit * this.maxCombinedBlockBytes;
    this.diagnosticsState.effectiveGpuResidentByteLimit = this.diagnosticsState.effectiveCpuResidentByteLimit;
    this.diagnosticsState.maxPendingBlocks = this.effectiveReadyBlockLimit + TILED_RAIN_MAX_CONCURRENT_FETCHES;
    this.diagnosticsState.maxTrackedBlocks = this.maxTrackedBlocks;
    this.diagnosticsState.trackedBlockCount = 0;
    this.diagnosticsState.peakTrackedBlockCount = 0;
  }

  primaryDescriptor(block) {
    if (this.aggregateSummary) return block?.summary_a || null;
    return block?.rain || block || null;
  }

  levelData(level = this.lodLevel) {
    const normalizedLevel = Number(level);
    const data = this.levels.get(normalizedLevel);
    if (data) return data;
    if (!this.multiLod) return this.level;
    throw new Error(`Tiled rain level L${level} is not present in the manifest.`);
  }

  activateLevel(level) {
    if (!this.multiLod || level === this.lodLevel) return this.level;
    const next = this.levelData(level);
    if (!next) throw new Error(`Tiled rain level L${level} is not present in the manifest.`);
    this.level = next;
    this.manifest = Object.freeze({ ...this.rootManifest, ...next });
    this.tiles = this.tilesByLevel.get(level);
    this.aggregateSummary = next.kind === 'aggregate-summary';
    this.lodLevel = level;
    this.gridSize = next.grid?.grid_size ?? next.grid_size ?? TILED_RAIN_GRID_SIZE;
    this.physicalMaxMmh = next.kind === 'direct' ? next.encoding.rain.physical_max_mmh : null;
    this.hazardsAvailable = !this.motionWarp && (this.multiLod ? next.hasHazardPayload === true : this.manifest.hazardsAvailable === true);
    this.diagnosticsState.lodLevel = level;
    this.diagnosticsState.payloadKind = this.aggregateSummary ? 'aggregate-summary' : 'direct';
    this.diagnosticsState.payloadDtype = this.aggregateSummary ? 'Float16 RGBA summary textures' : 'UInt16 rain / UInt8 hazards';
    return next;
  }

  secondaryDescriptor(block) {
    return this.aggregateSummary ? block?.summary_b || null : null;
  }

  primaryDescriptorForState(state) {
    return state.aggregateSummary ? state.descriptor?.summary_a || null : state.descriptor?.rain || state.descriptor || null;
  }

  secondaryDescriptorForState(state) {
    return state.aggregateSummary ? state.descriptor?.summary_b || null : null;
  }

  incrementLevelDiagnosticsCounter(state, name) {
    if (state?.kind !== 'rain') return;
    const counters = this.levelDiagnosticsCounters.get(Number(state.level ?? this.lodLevel));
    if (counters) counters[name]++;
  }

  levelDiagnostics() {
    this.updateMemoryDiagnostics();
    return [...this.levels].sort(([left], [right]) => left - right).map(([level, levelData]) => {
      const states = [...this.blocks.values()].filter((state) => Number(state.level ?? this.lodLevel) === level);
      const readyStates = states.filter((state) => state.status === 'ready');
      const pendingStates = states.filter((state) => state.status === 'queued' || state.status === 'pending');
      const protectedPrefix = this.multiLod ? `${level}:` : '';
      let logicalResidentPayloadBytes = 0;
      let estimatedGpuPayloadBytes = 0;
      for (const state of readyStates) {
        logicalResidentPayloadBytes += (state.payloads?.primary || state.payload)?.byteLength || 0;
        logicalResidentPayloadBytes += state.payloads?.secondary?.byteLength || 0;
        logicalResidentPayloadBytes += Object.values(state.hazardPayloads || {})
          .reduce((total, payload) => total + (payload?.byteLength || 0), 0);
        const frameCount = state.descriptor?.frame_count || 0;
        if (state.gpuTexture) {
          const storedSize = this.motionWarp ? TILED_RAIN_WARP_STORED_SIZE : TILED_RAIN_TILE_SIZE;
          estimatedGpuPayloadBytes += storedSize * storedSize * frameCount * (state.aggregateSummary ? 8 : 2);
        }
        if (state.summaryTexture) estimatedGpuPayloadBytes += TILED_RAIN_TILE_SIZE * TILED_RAIN_TILE_SIZE * frameCount * 8;
        estimatedGpuPayloadBytes += Object.values(state.hazardTextures || {})
          .reduce((total, texture) => total + (texture ? TILED_RAIN_TILE_SIZE * TILED_RAIN_TILE_SIZE * frameCount : 0), 0);
      }
      const counters = this.levelDiagnosticsCounters.get(level) || {};
      return {
        level,
        kind: levelData.kind || (this.motionWarp ? 'motion' : 'direct'),
        visibleTileCount: 0,
        readyBlockCount: readyStates.length,
        residentBlockCount: readyStates.length,
        protectedBlockCount: [...this.protectedBlockKeys].filter((key) => String(key).startsWith(protectedPrefix)).length,
        pendingBlockCount: pendingStates.length,
        inFlightBlockCount: states.filter((state) => state.status === 'pending').length,
        logicalResidentPayloadBytes,
        estimatedGpuPayloadBytes,
        blockRequestCount: counters.blockRequestCount || 0,
        blockFetchCount: counters.blockFetchCount || 0,
        gpuUploadCount: counters.gpuUploadCount || 0,
        evictionCount: counters.evictionCount || 0,
        endpointRole: null
      };
    });
  }

  descriptor(levelOrTileKey, tileOrBlockIndex, maybeBlockIndex) {
    const level = maybeBlockIndex === undefined ? this.lodLevel : levelOrTileKey;
    const tileKey = maybeBlockIndex === undefined ? levelOrTileKey : tileOrBlockIndex;
    const blockIndex = maybeBlockIndex === undefined ? tileOrBlockIndex : maybeBlockIndex;
    const tile = (this.tilesByLevel.get(Number(level)) || new Map()).get(tileKey);
    return tile?.blocks.find((block) => block.index === blockIndex) || null;
  }

  motionDescriptor(tileKey) {
    return this.motionTiles.get(tileKey) || null;
  }

  ensureBlock(levelOrTileKey, tileOrBlockIndex, maybeBlockIndex) {
    const level = maybeBlockIndex === undefined ? this.lodLevel : levelOrTileKey;
    const tileKey = maybeBlockIndex === undefined ? levelOrTileKey : tileOrBlockIndex;
    const blockIndex = maybeBlockIndex === undefined ? tileOrBlockIndex : maybeBlockIndex;
    const key = qualifiedBlockKey(level, tileKey, blockIndex, this.multiLod);
    let state = this.blocks.get(key);
    if (state?.status === 'ready') {
      state.lastUsed = ++this.lastUsed;
      return Promise.resolve(state);
    }
    if (state?.promise && !state.obsolete && state.status !== 'error' && state.status !== 'aborted') return state.promise;
    const descriptor = this.descriptor(level, tileKey, blockIndex);
    if (!descriptor) throw new Error(`Tiled rain block ${key} is not present in the manifest.`);
    if (!state || state.obsolete || state.status === 'error' || state.status === 'aborted') {
      state = {
        key, level, tileKey, blockIndex, descriptor, aggregateSummary: this.levelData(level).kind === 'aggregate-summary',
        hazardsAvailable: this.multiLod
          ? this.levelData(level).hasHazardPayload === true
          : this.hazardsAvailable,
        kind: 'rain', status: 'queued', lastUsed: ++this.lastUsed,
        payload: null, payloads: { primary: null, secondary: null },
        hazardPayloads: { storm: null, hail: null }, gpuTexture: null, summaryTexture: null,
        hazardTextures: { storm: null, hail: null }
      };
    }
    state.status = 'queued';
    state.obsolete = false;
    state.promise = new Promise((resolve, reject) => {
      state.resolve = resolve;
      state.reject = reject;
    });
    this.blocks.set(key, state);
    this.fetchQueue.push(state);
    this.diagnosticsState.pendingRequestCount++;
    this.diagnosticsState.queuedFetchCount++;
    this.pumpFetchQueue();
    return state.promise;
  }

  ensureMotionTile(tileKey) {
    const key = tileKey;
    let state = this.motionTilesState?.get(key);
    if (state?.status === 'ready') {
      state.lastUsed = ++this.lastUsed;
      return Promise.resolve(state);
    }
    if (state?.promise && !state.obsolete && state.status !== 'error' && state.status !== 'aborted') return state.promise;
    const descriptor = this.motionDescriptor(tileKey);
    if (!descriptor) throw new Error(`MotionField tile ${key} is not present in the manifest.`);
    if (!this.motionTilesState) this.motionTilesState = new Map();
    if (!state || state.obsolete || state.status === 'error' || state.status === 'aborted') {
      state = { key, tileKey, descriptor, kind: 'motion', status: 'queued', lastUsed: ++this.lastUsed, payload: null, gpuTexture: null };
    }
    state.status = 'queued';
    state.obsolete = false;
    state.promise = new Promise((resolve, reject) => {
      state.resolve = resolve;
      state.reject = reject;
    });
    this.motionTilesState.set(key, state);
    this.fetchQueue.push(state);
    this.diagnosticsState.pendingRequestCount++;
    this.diagnosticsState.pendingMotionTileCount++;
    this.diagnosticsState.queuedFetchCount++;
    this.pumpFetchQueue();
    return state.promise;
  }

  updateDesiredBlockKeys(usefulKeys, usefulMotionTileKeys = new Set()) {
    this.latestUsefulBlockKeys = new Set(usefulKeys);
    this.latestUsefulMotionTileKeys = new Set(usefulMotionTileKeys);
    for (const state of [...this.blocks.values(), ...(this.motionTilesState?.values() || [])]) {
      const useful = state.kind === 'motion'
        ? this.latestUsefulMotionTileKeys.has(state.key)
        : this.latestUsefulBlockKeys.has(state.key);
      if ((state.status === 'queued' || state.status === 'pending') && !useful) {
        this.abortObsoleteState(state);
      }
    }
    this.fetchQueue = this.fetchQueue.filter((state) => state.status === 'queued' && !state.obsolete);
    this.diagnosticsState.queuedFetchCount = this.fetchQueue.length;
    this.pumpFetchQueue();
  }

  abortObsoleteState(state) {
    if (state.obsolete || state.status === 'ready' || state.status === 'error') return;
    state.obsolete = true;
    this.diagnosticsState.abortedObsoleteRequestCount++;
    if (state.status === 'queued') {
      state.status = 'aborted';
      this.diagnosticsState.pendingRequestCount = Math.max(0, this.diagnosticsState.pendingRequestCount - 1);
      this.diagnosticsState.queuedFetchCount = Math.max(0, this.diagnosticsState.queuedFetchCount - 1);
      state.resolve?.(null);
      state.promise = null;
      if (state.kind === 'motion') {
        this.motionTilesState.delete(state.key);
        this.diagnosticsState.pendingMotionTileCount = Math.max(0, this.diagnosticsState.pendingMotionTileCount - 1);
      }
      else this.blocks.delete(state.key);
      return;
    }
    state.controller?.abort();
  }

  pumpFetchQueue() {
    while (this.inFlightFetchCount < TILED_RAIN_MAX_CONCURRENT_FETCHES && this.fetchQueue.length) {
      const state = this.fetchQueue.shift();
      this.diagnosticsState.queuedFetchCount = this.fetchQueue.length;
      if (!state || state.obsolete || state.status !== 'queued') continue;
      this.startFetch(state);
    }
  }

  fetchDescriptorPayload(state, descriptor, channel) {
    if (!descriptor) return Promise.resolve(null);
    const url = resolveAssetUrl(this.dataset.manifestUrl, descriptor.asset);
    return fetch(url, { signal: state.controller.signal }).then((response) => {
      if (!response.ok) throw new Error(`Unable to load tiled rain ${channel} payload ${url} (${response.status}).`);
      const contentEncoding = response.headers?.get?.('Content-Encoding')?.toLowerCase() || null;
      if (contentEncoding === 'gzip') this.diagnosticsState.gzipResponseCount++;
      else if (!contentEncoding || contentEncoding === 'identity') this.diagnosticsState.identityResponseCount++;
      else this.diagnosticsState.unknownEncodingResponseCount++;
      this.diagnosticsState.latestContentEncoding = contentEncoding || 'identity';
      const contentLength = Number(response.headers?.get?.('Content-Length'));
      if (Number.isFinite(contentLength) && contentLength >= 0) {
        this.diagnosticsState.responseContentLengthBytes += contentLength;
        if (!Number.isFinite(this.diagnosticsState[`${channel}ResponseContentLengthBytes`])) this.diagnosticsState[`${channel}ResponseContentLengthBytes`] = 0;
        this.diagnosticsState[`${channel}ResponseContentLengthBytes`] += contentLength;
      }
      return response.arrayBuffer();
    }).then((payload) => {
      if (payload.byteLength !== descriptor.byte_length) {
        throw new Error(`Tiled rain ${channel} payload ${state.key} byte length is ${payload.byteLength}, expected ${descriptor.byte_length}.`);
      }
      this.diagnosticsState.logicalFetchedBytes += payload.byteLength;
      if (channel === 'storm' || channel === 'hail') {
        this.diagnosticsState.logicalHazardFetchedBytes += payload.byteLength;
        this.diagnosticsState[`${channel}FetchCount`]++;
      }
      return payload;
    });
  }

  fetchHazardPayload(state, channel) {
    if (!state.hazardsAvailable || !state.descriptor[channel]) return Promise.resolve(null);
    return this.fetchDescriptorPayload(state, state.descriptor[channel], channel);
  }

  startFetch(state) {
    state.status = 'pending';
    state.controller = new AbortController();
    this.inFlightFetchCount++;
    this.diagnosticsState.inFlightFetchCount = this.inFlightFetchCount;
    this.diagnosticsState.peakInFlightFetchCount = Math.max(this.diagnosticsState.peakInFlightFetchCount, this.inFlightFetchCount);
    this.diagnosticsState.combinedWeatherFetchCount = this.inFlightFetchCount;
    this.diagnosticsState.peakCombinedInFlightWeatherFetchCount = Math.max(this.diagnosticsState.peakCombinedInFlightWeatherFetchCount, this.inFlightFetchCount);
    this.diagnosticsState.tileRequestCount++;
    this.incrementLevelDiagnosticsCounter(state, 'blockRequestCount');
    if (state.kind === 'motion') this.diagnosticsState.motionRequestCount++;
    else this.diagnosticsState.rainBlockRequestCount = (this.diagnosticsState.rainBlockRequestCount || 0) + 1;
    const assetManifestUrl = state.kind === 'motion' ? this.motionManifestUrl : this.dataset.manifestUrl;
    const payloadDescriptor = state.kind === 'motion' ? state.descriptor : this.primaryDescriptorForState(state);
    const url = resolveAssetUrl(assetManifestUrl, payloadDescriptor.asset);
    this.onTiming(`${state.kind === 'motion' ? 'tiled-rain-motion' : 'tiled-rain-block'}-${state.tileKey}${state.kind === 'motion' ? '' : `-${state.blockIndex}`}-fetch-start`);
    void fetch(url, { signal: state.controller.signal })
      .then((response) => {
        if (!response.ok) throw new Error(`Unable to load tiled rain block ${url} (${response.status}).`);
        const contentEncoding = response.headers?.get?.('Content-Encoding')?.toLowerCase() || null;
        if (contentEncoding === 'gzip') this.diagnosticsState.gzipResponseCount++;
        else if (!contentEncoding || contentEncoding === 'identity') this.diagnosticsState.identityResponseCount++;
        else this.diagnosticsState.unknownEncodingResponseCount++;
        this.diagnosticsState.latestContentEncoding = contentEncoding || 'identity';
        const contentLength = Number(response.headers?.get?.('Content-Length'));
        if (Number.isFinite(contentLength) && contentLength >= 0) {
          this.diagnosticsState.responseContentLengthBytes += contentLength;
          if (state.kind === 'motion') this.diagnosticsState.motionResponseContentLengthBytes += contentLength;
          else this.diagnosticsState.rainResponseContentLengthBytes += contentLength;
        }
        return response.arrayBuffer();
      })
      .then((payload) => {
        this.diagnosticsState.logicalFetchedBytes += payload.byteLength;
        const useful = state.kind === 'motion'
          ? this.latestUsefulMotionTileKeys.has(state.key)
          : this.latestUsefulBlockKeys.has(state.key);
        if (state.obsolete || !useful) {
          state.status = 'aborted';
          state.resolve(null);
          return null;
        }
        const expectedBytes = payloadDescriptor.byte_length;
        if (payload.byteLength !== expectedBytes) throw new Error(`${state.kind === 'motion' ? 'MotionField tile' : 'Tiled rain block'} ${state.key} byte length is ${payload.byteLength}, expected ${expectedBytes}.`);
        if (state.kind === 'rain' && state.aggregateSummary) {
          return this.fetchDescriptorPayload(state, this.secondaryDescriptorForState(state), 'summaryB')
            .then((secondary) => ({ primary: payload, secondary, storm: null, hail: null }));
        }
        if (state.kind === 'rain' && state.hazardsAvailable && !state.aggregateSummary) {
          return Promise.all(['storm', 'hail'].map((channel) => this.fetchHazardPayload(state, channel)))
            .then(([storm, hail]) => ({ primary: payload, secondary: null, storm, hail }));
        }
        return { primary: payload, secondary: null, storm: null, hail: null };
      })
      .then((payloads) => {
        if (!payloads) return null;
        const payload = payloads.primary;
        const useful = state.kind === 'motion'
          ? this.latestUsefulMotionTileKeys.has(state.key)
          : this.latestUsefulBlockKeys.has(state.key);
        if (state.obsolete || !useful) {
          state.status = 'aborted';
          state.resolve(null);
          return null;
        }
        state.payload = payload;
        state.payloads = { primary: payloads.primary, secondary: payloads.secondary };
        state.hazardPayloads = { storm: payloads.storm, hail: payloads.hail };
        state.status = 'ready';
        state.lastUsed = ++this.lastUsed;
        this.diagnosticsState.tileFetchCount++;
        this.incrementLevelDiagnosticsCounter(state, 'blockFetchCount');
        if (state.kind === 'motion') {
          this.diagnosticsState.motionFetchCount++;
          this.diagnosticsState.motionLogicalFetchedBytes = (this.diagnosticsState.motionLogicalFetchedBytes || 0) + payload.byteLength;
        } else {
          this.diagnosticsState.rainBlockFetchCount = (this.diagnosticsState.rainBlockFetchCount || 0) + 1;
        }
        if (state.kind !== 'motion') this.evict(this.protectedBlockKeys);
        this.onTiming(`${state.kind === 'motion' ? 'tiled-rain-motion' : 'tiled-rain-block'}-${state.tileKey}${state.kind === 'motion' ? '' : `-${state.blockIndex}`}-fetch-complete`);
        state.resolve(state);
        return state;
      })
      .catch((error) => {
        if (state.obsolete || error?.name === 'AbortError') {
          state.status = 'aborted';
          state.resolve(null);
          return null;
        }
        state.status = 'error';
        this.diagnosticsState.lastError = error instanceof Error ? error.message : String(error);
        state.reject(error);
        return null;
      })
      .finally(() => {
        this.inFlightFetchCount = Math.max(0, this.inFlightFetchCount - 1);
        this.diagnosticsState.inFlightFetchCount = this.inFlightFetchCount;
        this.diagnosticsState.combinedWeatherFetchCount = this.inFlightFetchCount;
        this.diagnosticsState.pendingRequestCount = Math.max(0, this.diagnosticsState.pendingRequestCount - 1);
        state.controller = null;
        state.promise = null;
        const stateMap = state.kind === 'motion' ? this.motionTilesState : this.blocks;
        if ((state.status === 'aborted' || state.status === 'error') && stateMap?.get(state.key) === state) {
          stateMap.delete(state.key);
        }
        if (state.kind === 'motion') this.diagnosticsState.pendingMotionTileCount = Math.max(0, this.diagnosticsState.pendingMotionTileCount - 1);
        this.updateMemoryDiagnostics();
        this.pumpFetchQueue();
      });
  }

  evict(keepKeys) {
    const candidates = [...this.blocks.values()]
      .filter((state) => state.status === 'ready' && !keepKeys.has(state.key))
      .sort((left, right) => left.lastUsed - right.lastUsed);
    let readyBlockCount = [...this.blocks.values()].filter((state) => state.status === 'ready').length;
    const readyCacheLimit = Math.max(READY_CACHE_BLOCK_LIMIT, keepKeys.size);
    this.effectiveReadyBlockLimit = readyCacheLimit;
    this.maxTrackedBlocks = readyCacheLimit + TILED_RAIN_MAX_CONCURRENT_FETCHES;
    this.diagnosticsState.effectiveReadyBlockLimit = readyCacheLimit;
    this.diagnosticsState.effectiveCpuResidentByteLimit = readyCacheLimit * this.maxCombinedBlockBytes;
    this.diagnosticsState.effectiveGpuResidentByteLimit = this.diagnosticsState.effectiveCpuResidentByteLimit;
    this.diagnosticsState.maxTrackedBlocks = this.maxTrackedBlocks;
    while (readyBlockCount > readyCacheLimit && candidates.length) {
      const state = candidates.shift();
      if (this.gl) {
        if (state.gpuTexture) this.gl.deleteTexture(state.gpuTexture);
        if (state.summaryTexture) this.gl.deleteTexture(state.summaryTexture);
        for (const texture of Object.values(state.hazardTextures || {})) if (texture) this.gl.deleteTexture(texture);
      }
      this.blocks.delete(state.key);
      readyBlockCount--;
      this.diagnosticsState.evictions++;
      this.incrementLevelDiagnosticsCounter(state, 'evictionCount');
    }
    this.updateMemoryDiagnostics();
  }

  setVisibleTileCount(count) {
    this.diagnosticsState.visibleTileCount = count;
  }

  setProtectedBlockKeys(keys) {
    this.protectedBlockKeys = new Set(keys);
    this.maxTargetBlocks = Math.max(this.maxTargetBlocks, this.protectedBlockKeys.size);
    this.diagnosticsState.currentTargetBlockCount = this.protectedBlockKeys.size;
    this.effectiveReadyBlockLimit = Math.max(READY_CACHE_BLOCK_LIMIT, this.protectedBlockKeys.size);
    this.diagnosticsState.effectiveReadyBlockLimit = this.effectiveReadyBlockLimit;
    this.diagnosticsState.maxTargetBlockCount = this.maxTargetBlocks;
    this.diagnosticsState.maxPendingBlocks = Math.max(
      this.diagnosticsState.maxPendingBlocks,
      this.effectiveReadyBlockLimit + TILED_RAIN_MAX_CONCURRENT_FETCHES
    );
    this.evict(this.protectedBlockKeys);
  }

  updateMemoryDiagnostics() {
    let bytes = 0;
    let secondaryBytes = 0;
    let gpuBytes = 0;
    let hazardBytes = 0;
    let hazardGpuBytes = 0;
    const tileKeys = new Set();
    for (const state of this.blocks.values()) {
      if (state.status !== 'ready') continue;
      tileKeys.add(state.tileKey);
      const primaryPayload = state.payloads?.primary || state.payload;
      const secondaryPayload = state.payloads?.secondary;
      bytes += primaryPayload?.byteLength || 0;
      secondaryBytes += secondaryPayload?.byteLength || 0;
      const storedSize = this.motionWarp ? TILED_RAIN_WARP_STORED_SIZE : TILED_RAIN_TILE_SIZE;
      const primaryBytesPerSample = state.aggregateSummary ? 8 : 2;
      gpuBytes += state.gpuTexture ? storedSize * storedSize * state.descriptor.frame_count * primaryBytesPerSample : 0;
      if (state.aggregateSummary) {
        gpuBytes += state.summaryTexture
          ? TILED_RAIN_TILE_SIZE * TILED_RAIN_TILE_SIZE * state.descriptor.frame_count * 8
          : 0;
      }
      if (!this.motionWarp) {
        hazardBytes += Object.values(state.hazardPayloads || {}).reduce((total, payload) => total + (payload?.byteLength || 0), 0);
        hazardGpuBytes += Object.values(state.hazardTextures || {}).reduce((total, texture) => total + (texture ? TILED_RAIN_TILE_SIZE * TILED_RAIN_TILE_SIZE * state.descriptor.frame_count : 0), 0);
      }
    }
    this.diagnosticsState.residentTileCount = tileKeys.size;
    this.diagnosticsState.residentTileBlockCount = [...this.blocks.values()].filter((state) => state.status === 'ready').length;
    this.diagnosticsState.logicalResidentPayloadBytes = bytes + secondaryBytes + hazardBytes;
    this.diagnosticsState.estimatedGpuPayloadBytes = gpuBytes + hazardGpuBytes;
    this.diagnosticsState.logicalUInt16ResidentBytes = [...this.blocks.values()]
      .filter((state) => state.status === 'ready' && !state.aggregateSummary)
      .reduce((total, state) => total + (state.payloads?.primary || state.payload)?.byteLength || 0, 0);
    this.diagnosticsState.estimatedGpuTextureBytes = gpuBytes;
    this.diagnosticsState.logicalHazardResidentBytes = hazardBytes;
    this.diagnosticsState.estimatedHazardGpuBytes = hazardGpuBytes;
    this.diagnosticsState.peakLogicalHazardResidentBytes = Math.max(this.diagnosticsState.peakLogicalHazardResidentBytes, hazardBytes);
    this.diagnosticsState.peakEstimatedHazardGpuBytes = Math.max(this.diagnosticsState.peakEstimatedHazardGpuBytes, hazardGpuBytes);
    this.diagnosticsState.haloRainLogicalResidentBytes = this.motionWarp ? bytes : 0;
    this.diagnosticsState.estimatedHaloRainGpuBytes = this.motionWarp ? gpuBytes : 0;
    this.diagnosticsState.peakResidentBlockCount = Math.max(this.diagnosticsState.peakResidentBlockCount, this.diagnosticsState.residentTileBlockCount);
    this.diagnosticsState.peakLogicalUInt16ResidentBytes = Math.max(this.diagnosticsState.peakLogicalUInt16ResidentBytes, this.diagnosticsState.logicalUInt16ResidentBytes);
    this.diagnosticsState.peakEstimatedGpuTextureBytes = Math.max(this.diagnosticsState.peakEstimatedGpuTextureBytes, gpuBytes);
    let motionBytes = 0;
    let motionGpuBytes = 0;
    let residentMotionTileCount = 0;
    for (const state of this.motionTilesState?.values() || []) {
      if (state.status !== 'ready') continue;
      residentMotionTileCount++;
      motionBytes += state.payload?.byteLength || 0;
      motionGpuBytes += state.gpuTexture
        ? this.motionGrid.nodesPerTile * (this.motionManifest.interval_count * this.motionGrid.nodesPerTile)
          * 4 * Float32Array.BYTES_PER_ELEMENT
        : 0;
    }
    this.diagnosticsState.residentMotionTileCount = residentMotionTileCount;
    this.diagnosticsState.logicalMotionResidentBytes = motionBytes;
    this.diagnosticsState.estimatedMotionGpuBytes = motionGpuBytes;
    this.diagnosticsState.peakResidentMotionTileCount = Math.max(this.diagnosticsState.peakResidentMotionTileCount, residentMotionTileCount);
    this.diagnosticsState.peakLogicalMotionResidentBytes = Math.max(this.diagnosticsState.peakLogicalMotionResidentBytes, motionBytes);
    this.diagnosticsState.peakEstimatedMotionGpuBytes = Math.max(this.diagnosticsState.peakEstimatedMotionGpuBytes, motionGpuBytes);
    this.diagnosticsState.trackedBlockCount = this.blocks.size;
    this.diagnosticsState.peakTrackedBlockCount = Math.max(this.diagnosticsState.peakTrackedBlockCount, this.blocks.size);
  }

  uploadBlock(gl, state) {
    if (state.gpuTexture) return state.gpuTexture;
    const started = now();
    const texture = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D_ARRAY, texture);
    gl.texParameteri(gl.TEXTURE_2D_ARRAY, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D_ARRAY, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D_ARRAY, gl.TEXTURE_WRAP_S, this.motionWarp ? gl.REPEAT : gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D_ARRAY, gl.TEXTURE_WRAP_T, this.motionWarp ? gl.REPEAT : gl.CLAMP_TO_EDGE);
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
    const payload = state.payloads?.primary || state.payload;
    if (state.aggregateSummary ?? this.aggregateSummary) {
      gl.texImage3D(
        gl.TEXTURE_2D_ARRAY, 0, gl.RGBA16F, TILED_RAIN_TILE_SIZE, TILED_RAIN_TILE_SIZE,
        state.descriptor.frame_count, 0, gl.RGBA, gl.HALF_FLOAT, new Uint16Array(payload)
      );
    } else {
      gl.texImage3D(
        gl.TEXTURE_2D_ARRAY, 0, gl.R16UI,
        this.motionWarp ? TILED_RAIN_WARP_STORED_SIZE : TILED_RAIN_TILE_SIZE,
        this.motionWarp ? TILED_RAIN_WARP_STORED_SIZE : TILED_RAIN_TILE_SIZE,
        state.descriptor.frame_count,
        0, gl.RED_INTEGER, gl.UNSIGNED_SHORT, new Uint16Array(payload)
      );
    }
    state.gpuTexture = texture;
    this.gl = gl;
    this.diagnosticsState.tileUploadCount++;
    this.incrementLevelDiagnosticsCounter(state, 'gpuUploadCount');
    this.diagnosticsState.latestGpuUploadMs = now() - started;
    this.diagnosticsState.cumulativeGpuUploadMs += this.diagnosticsState.latestGpuUploadMs;
    this.updateMemoryDiagnostics();
    return texture;
  }

  zeroHazardTexture(gl) {
    if (this.emptyHazardTexture) return this.emptyHazardTexture;
    const texture = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D_ARRAY, texture);
    gl.texParameteri(gl.TEXTURE_2D_ARRAY, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D_ARRAY, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D_ARRAY, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D_ARRAY, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
    gl.texImage3D(gl.TEXTURE_2D_ARRAY, 0, gl.R8, 1, 1, 1, 0, gl.RED, gl.UNSIGNED_BYTE, new Uint8Array(1));
    this.emptyHazardTexture = texture;
    this.gl = gl;
    return texture;
  }

  zeroSummaryTexture(gl) {
    if (this.emptySummaryTexture) return this.emptySummaryTexture;
    const texture = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D_ARRAY, texture);
    gl.texParameteri(gl.TEXTURE_2D_ARRAY, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D_ARRAY, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D_ARRAY, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D_ARRAY, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
    gl.texImage3D(gl.TEXTURE_2D_ARRAY, 0, gl.RGBA16F, 1, 1, 1, 0, gl.RGBA, gl.HALF_FLOAT, new Uint16Array(4));
    this.emptySummaryTexture = texture;
    this.gl = gl;
    return texture;
  }

  uploadSummaryBlock(gl, state) {
    if (!(state.aggregateSummary ?? this.aggregateSummary) || !state.payloads?.secondary || state.summaryTexture) return state.summaryTexture || null;
    const started = now();
    const texture = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D_ARRAY, texture);
    gl.texParameteri(gl.TEXTURE_2D_ARRAY, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D_ARRAY, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D_ARRAY, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D_ARRAY, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
    gl.texImage3D(
      gl.TEXTURE_2D_ARRAY, 0, gl.RGBA16F, TILED_RAIN_TILE_SIZE, TILED_RAIN_TILE_SIZE,
      state.descriptor.frame_count, 0, gl.RGBA, gl.HALF_FLOAT, new Uint16Array(state.payloads.secondary)
    );
    state.summaryTexture = texture;
    this.gl = gl;
    this.diagnosticsState.tileUploadCount++;
    this.incrementLevelDiagnosticsCounter(state, 'gpuUploadCount');
    this.diagnosticsState.latestGpuUploadMs = now() - started;
    this.diagnosticsState.cumulativeGpuUploadMs += this.diagnosticsState.latestGpuUploadMs;
    this.updateMemoryDiagnostics();
    return texture;
  }

  uploadHazardBlock(gl, state, channel) {
    if ((state.aggregateSummary ?? this.aggregateSummary)
      || !(state.hazardsAvailable ?? this.hazardsAvailable) || !state.hazardPayloads?.[channel]) return null;
    if (state.hazardTextures?.[channel]) return state.hazardTextures[channel];
    const started = now();
    const texture = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D_ARRAY, texture);
    gl.texParameteri(gl.TEXTURE_2D_ARRAY, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D_ARRAY, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D_ARRAY, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D_ARRAY, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
    gl.texImage3D(
      gl.TEXTURE_2D_ARRAY, 0, gl.R8,
      TILED_RAIN_TILE_SIZE, TILED_RAIN_TILE_SIZE, state.descriptor.frame_count,
      0, gl.RED, gl.UNSIGNED_BYTE, new Uint8Array(state.hazardPayloads[channel])
    );
    state.hazardTextures[channel] = texture;
    this.gl = gl;
    this.diagnosticsState.tileUploadCount++;
    this.incrementLevelDiagnosticsCounter(state, 'gpuUploadCount');
    this.diagnosticsState.latestGpuUploadMs = now() - started;
    this.diagnosticsState.cumulativeGpuUploadMs += this.diagnosticsState.latestGpuUploadMs;
    this.updateMemoryDiagnostics();
    return texture;
  }

  uploadMotionTile(gl, state) {
    if (state.gpuTexture) return state.gpuTexture;
    const started = now();
    const source = new Float32Array(state.payload);
    const nodeCount = this.motionGrid.nodesPerTile * this.motionGrid.nodesPerTile;
    const rgba = new Float32Array(this.motionManifest.interval_count * nodeCount * 4);
    for (let index = 0; index < this.motionManifest.interval_count * nodeCount; index++) {
      rgba[index * 4] = source[index * 3];
      rgba[index * 4 + 1] = source[index * 3 + 1];
      rgba[index * 4 + 2] = source[index * 3 + 2];
    }
    const texture = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, texture);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
    gl.texImage2D(
      gl.TEXTURE_2D, 0, gl.RGBA32F, this.motionGrid.nodesPerTile,
      this.motionManifest.interval_count * this.motionGrid.nodesPerTile,
      0, gl.RGBA, gl.FLOAT, rgba
    );
    state.gpuTexture = texture;
    this.gl = gl;
    this.diagnosticsState.motionUploadCount++;
    this.diagnosticsState.tileUploadCount++;
    this.diagnosticsState.latestGpuUploadMs = now() - started;
    this.diagnosticsState.cumulativeGpuUploadMs += this.diagnosticsState.latestGpuUploadMs;
    this.updateMemoryDiagnostics();
    return texture;
  }

  visibleMotionDiagnostics(tileKeys, interval) {
    const empty = {
      visibleMotionTilesReady: 0,
      currentMotionInterval: this.motionWarp ? interval : null,
      visibleUniqueMotionNodeCount: 0,
      visibleNonzeroConfidenceNodeCount: 0,
      visibleNonzeroConfidencePercentage: 0,
      visibleConfidenceMean: null,
      visibleConfidenceMedian: null,
      visibleConfidenceMax: null,
      visibleDisplacementMagnitudeMean: null,
      visibleDisplacementMagnitudeMedian: null,
      visibleDisplacementMagnitudeMax: null,
      visibleDxMin: null,
      visibleDxMax: null,
      visibleDyMin: null,
      visibleDyMax: null
    };
    if (!this.motionWarp) return empty;
    const nodes = new Map();
    let readyTileCount = 0;
    for (const tileKey of tileKeys) {
      const state = this.motionTilesState?.get(tileKey);
      if (state?.status !== 'ready') continue;
      readyTileCount++;
      const descriptor = state.descriptor;
      const values = new Float32Array(state.payload);
      for (let row = 0; row < descriptor.node_height; row++) {
        for (let column = 0; column < descriptor.node_width; column++) {
          const nodeX = this.motionGrid.nodeXStart
            + (descriptor.node_x_start + column) * this.motionGrid.nodeSpacing;
          const nodeY = this.motionGrid.nodeYStart
            + (descriptor.node_y_start + row) * this.motionGrid.nodeSpacing;
          const key = `${nodeX}:${nodeY}`;
          if (nodes.has(key)) continue;
          const offset = (interval * descriptor.node_width * descriptor.node_height
            + row * descriptor.node_width + column) * 3;
          nodes.set(key, {
            dx: values[offset],
            dy: values[offset + 1],
            confidence: values[offset + 2]
          });
        }
      }
    }
    const allNodes = [...nodes.values()];
    const nonzero = allNodes.filter((node) => Number.isFinite(node.confidence) && node.confidence > 0);
    const sorted = (values) => [...values].sort((left, right) => left - right);
    const median = (values) => {
      if (!values.length) return null;
      const ordered = sorted(values);
      const middle = Math.floor(ordered.length / 2);
      return ordered.length % 2 ? ordered[middle] : (ordered[middle - 1] + ordered[middle]) / 2;
    };
    const mean = (values) => values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : null;
    const confidenceValues = nonzero.map((node) => node.confidence);
    const magnitudeValues = nonzero
      .filter((node) => Number.isFinite(node.dx) && Number.isFinite(node.dy))
      .map((node) => Math.hypot(node.dx, node.dy));
    const dxValues = nonzero.map((node) => node.dx).filter(Number.isFinite);
    const dyValues = nonzero.map((node) => node.dy).filter(Number.isFinite);
    return {
      visibleMotionTilesReady: readyTileCount,
      currentMotionInterval: interval,
      visibleUniqueMotionNodeCount: allNodes.length,
      visibleNonzeroConfidenceNodeCount: nonzero.length,
      visibleNonzeroConfidencePercentage: allNodes.length ? (nonzero.length / allNodes.length) * 100 : 0,
      visibleConfidenceMean: mean(confidenceValues),
      visibleConfidenceMedian: median(confidenceValues),
      visibleConfidenceMax: confidenceValues.length ? Math.max(...confidenceValues) : null,
      visibleDisplacementMagnitudeMean: mean(magnitudeValues),
      visibleDisplacementMagnitudeMedian: median(magnitudeValues),
      visibleDisplacementMagnitudeMax: magnitudeValues.length ? Math.max(...magnitudeValues) : null,
      visibleDxMin: dxValues.length ? Math.min(...dxValues) : null,
      visibleDxMax: dxValues.length ? Math.max(...dxValues) : null,
      visibleDyMin: dyValues.length ? Math.min(...dyValues) : null,
      visibleDyMax: dyValues.length ? Math.max(...dyValues) : null
    };
  }

  diagnostics({ visibleMotionTileKeys = [], currentMotionInterval = 0 } = {}) {
    this.updateMemoryDiagnostics();
    return { ...this.diagnosticsState, ...this.visibleMotionDiagnostics(visibleMotionTileKeys, currentMotionInterval) };
  }
}

function strongRainShader() {
  const lines = [`float strongRain(float value) {`, `  if (value <= ${DOTS_STRONG_RAIN_ONSET_MMH.toFixed(6)}) return 0.0;`];
  for (let index = 1; index < DOTS_STRONG_RAIN_SHAPE_ANCHORS.length; index++) {
    const lower = DOTS_STRONG_RAIN_SHAPE_ANCHORS[index - 1];
    const upper = DOTS_STRONG_RAIN_SHAPE_ANCHORS[index];
    const threshold = DOTS_STRONG_RAIN_ONSET_MMH + upper.progress * (DOTS_STRONG_RAIN_FULL_MMH - DOTS_STRONG_RAIN_ONSET_MMH);
    const lowerThreshold = DOTS_STRONG_RAIN_ONSET_MMH + lower.progress * (DOTS_STRONG_RAIN_FULL_MMH - DOTS_STRONG_RAIN_ONSET_MMH);
    lines.push(`  if (value <= ${threshold.toFixed(6)}) {`);
    lines.push(`    float t = (value - ${lowerThreshold.toFixed(6)}) / ${(threshold - lowerThreshold).toFixed(6)};`);
    lines.push(`    return sqrt(mix(${(lower.radius * lower.radius).toFixed(6)}, ${(upper.radius * upper.radius).toFixed(6)}, clamp(t, 0.0, 1.0)));`);
    lines.push('  }');
  }
  lines.push(`  return ${DOTS_STRONG_RAIN_SHAPE_ANCHORS.at(-1).radius.toFixed(6)};`, '}');
  return lines.join('\n');
}

function compileShader(gl, type, source) {
  const shader = gl.createShader(type);
  gl.shaderSource(shader, source);
  gl.compileShader(shader);
  if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(shader) || 'Tiled rain shader compilation failed.');
  return shader;
}

function makeProgram(gl, shaderData, motionWarp, motionWarpDebugMode, hazardsAvailable, presentation = 'dots', aggregate = false, gridSize = TILED_RAIN_GRID_SIZE) {
  const squares = presentation === 'squares';
  const aggregateUniforms = aggregate ? [
    'uniform sampler2DArray u_summaryA; uniform sampler2DArray u_summaryB;',
    'uniform sampler2DArray u_hazardA; uniform sampler2DArray u_hazardB;',
    'uniform int u_hazardAvailableA; uniform int u_hazardAvailableB;'
  ] : [];
  const motionUniforms = motionWarp ? [
    'uniform sampler2D u_motion;',
    'uniform int u_frameA; uniform int u_frameB; uniform int u_motionInterval; uniform int u_motionWarpActive; uniform int u_rainHalo;',
    'uniform int u_motionNodeSpacing; uniform int u_motionNodesPerTile;'
  ] : [];
  const motionFunctions = motionWarp ? [
    'vec2 rainTap(uint code) { return vec2(decodeRain(code), code == 0u ? 0.0 : 1.0); }',
    'vec2 sampleRainFractional(usampler2DArray source, int frameLayer, vec2 coreCoordinate) {',
    '  vec2 stored = coreCoordinate + vec2(float(u_rainHalo)); vec2 base = floor(stored); vec2 fraction = fract(stored);',
    '  ivec2 origin = ivec2(base); float totalWeight = 0.0; float value = 0.0;',
    '  uint code00 = texelFetch(source, ivec3(origin, frameLayer), 0).r;',
    '  uint code10 = texelFetch(source, ivec3(origin + ivec2(1, 0), frameLayer), 0).r;',
    '  uint code01 = texelFetch(source, ivec3(origin + ivec2(0, 1), frameLayer), 0).r;',
    '  uint code11 = texelFetch(source, ivec3(origin + ivec2(1, 1), frameLayer), 0).r;',
    '  float weight00 = (1.0 - fraction.x) * (1.0 - fraction.y); float weight10 = fraction.x * (1.0 - fraction.y);',
    '  float weight01 = (1.0 - fraction.x) * fraction.y; float weight11 = fraction.x * fraction.y;',
    '  vec2 tap = rainTap(code00); if (tap.y > 0.0) { value += weight00 * tap.x; totalWeight += weight00; }',
    '  tap = rainTap(code10); if (tap.y > 0.0) { value += weight10 * tap.x; totalWeight += weight10; }',
    '  tap = rainTap(code01); if (tap.y > 0.0) { value += weight01 * tap.x; totalWeight += weight01; }',
    '  tap = rainTap(code11); if (tap.y > 0.0) { value += weight11 * tap.x; totalWeight += weight11; }',
    '  return totalWeight > 0.0 ? vec2(value / totalWeight, 1.0) : vec2(0.0);',
    '}',
    'vec3 interpolateMotion(vec2 coreCoordinate) {',
    '  vec2 nodeCoordinate = coreCoordinate / float(u_motionNodeSpacing); ivec2 lower = ivec2(floor(nodeCoordinate));',
    '  lower = clamp(lower, ivec2(0), ivec2(u_motionNodesPerTile - 2)); vec2 fraction = nodeCoordinate - vec2(lower);',
    '  vec2 flow = vec2(0.0); float confidence = 0.0;',
    '  for (int row = 0; row < 2; row++) for (int column = 0; column < 2; column++) {',
    '    float weight = (column == 0 ? 1.0 - fraction.x : fraction.x) * (row == 0 ? 1.0 - fraction.y : fraction.y);',
    '    vec4 node = texelFetch(u_motion, ivec2(lower.x + column, u_motionInterval * u_motionNodesPerTile + lower.y + row), 0);',
    '    flow += weight * node.z * node.xy; confidence += weight * node.z;',
    '  }',
    '  return confidence > 0.000001 ? vec3(flow / confidence, confidence) : vec3(0.0);',
    '}',
    'vec2 temporalNoDataMix(vec2 first, vec2 second, float progress) {',
    '  if (first.y > 0.0 && second.y > 0.0) return vec2(mix(first.x, second.x, progress), 1.0);',
    '  if (first.y > 0.0) return first; if (second.y > 0.0) return second; return vec2(0.0);',
    '}'
  ] : [];
  const motionRainSource = motionWarp ? [
    '  ivec2 rainCoordinate = ivec2(localX, localY) + ivec2(u_rainHalo);',
    '  uint codeA = texelFetch(u_rainA, ivec3(rainCoordinate, u_frameLayerA), 0).r;',
    '  uint codeB = texelFetch(u_rainB, ivec3(rainCoordinate, u_frameLayerB), 0).r;',
    '  bool validA = codeA != 0u; bool validB = codeB != 0u;',
    '  float rainA = decodeRain(codeA); float rainB = decodeRain(codeB);',
    '  float direct = validA && validB ? mix(rainA, rainB, u_temporalProgress) : validA ? rainA : validB ? rainB : 0.0;',
    '  float rain = direct;',
    '  if (u_motionWarpActive == 1 && u_frameA != u_frameB && u_temporalProgress > 0.0 && u_temporalProgress < 1.0) {',
    '    vec3 motion = interpolateMotion(vec2(float(localX), float(localY)));',
    '    if (motion.z > 0.000001 && (validA || validB)) {',
    '      vec2 warpedA = sampleRainFractional(u_rainA, u_frameLayerA, vec2(float(localX), float(localY)) - motion.xy * u_temporalProgress);',
    '      vec2 warpedB = sampleRainFractional(u_rainB, u_frameLayerB, vec2(float(localX), float(localY)) + motion.xy * (1.0 - u_temporalProgress));',
    '      vec2 warped = temporalNoDataMix(warpedA, warpedB, u_temporalProgress);',
    `      if (warped.y > 0.0) rain = ${motionWarpDebugMode === 'full' ? 'warped.x' : 'mix(direct, warped.x, motion.z)'};`,
    '    }',
    '  }'
  ] : [
    '  uint codeA = texelFetch(u_rainA, ivec3(localX, localY, u_frameLayerA), 0).r;',
    '  uint codeB = texelFetch(u_rainB, ivec3(localX, localY, u_frameLayerB), 0).r;',
    '  bool validA = codeA != 0u; bool validB = codeB != 0u;',
    '  float rainA = decodeRain(codeA); float rainB = decodeRain(codeB);',
    '  float rain = validA && validB ? mix(rainA, rainB, u_temporalProgress) : validA ? rainA : validB ? rainB : 0.0;'
  ];
  const squaresRainSource = motionWarp ? [
    ...motionRainSource,
    `  float rainCoverageA = validA && rainA >= ${RAIN_VISIBILITY_FLOOR_MMH.toFixed(6)} ? 1.0 : 0.0;`,
    `  float rainCoverageB = validB && rainB >= ${RAIN_VISIBILITY_FLOOR_MMH.toFixed(6)} ? 1.0 : 0.0;`,
    '  float rainCoverage = mix(rainCoverageA, rainCoverageB, u_temporalProgress);'
  ] : [
    '  uint codeA = texelFetch(u_rainA, ivec3(localX, localY, u_frameLayerA), 0).r;',
    '  uint codeB = texelFetch(u_rainB, ivec3(localX, localY, u_frameLayerB), 0).r;',
    '  bool validA = codeA != 0u; bool validB = codeB != 0u;',
    '  float rainA = decodeRain(codeA); float rainB = decodeRain(codeB);',
    '  float rain = validA && validB ? mix(rainA, rainB, u_temporalProgress) : validA ? rainA : validB ? rainB : 0.0;',
    `  float rainCoverageA = validA && rainA >= ${RAIN_VISIBILITY_FLOOR_MMH.toFixed(6)} ? 1.0 : 0.0;`,
    `  float rainCoverageB = validB && rainB >= ${RAIN_VISIBILITY_FLOOR_MMH.toFixed(6)} ? 1.0 : 0.0;`,
    '  float rainCoverage = mix(rainCoverageA, rainCoverageB, u_temporalProgress);'
  ];
  const aggregateSummarySource = [
    '  vec4 summaryA = texelFetch(u_summaryA, ivec3(localX, localY, u_frameLayerA), 0);',
    '  vec4 summaryB = texelFetch(u_summaryB, ivec3(localX, localY, u_frameLayerB), 0);',
    '  bool validA = summaryA.z >= -0.5; bool validB = summaryB.z >= -0.5;',
    '  vec4 hazardSummaryA = u_hazardAvailableA == 1 ? texelFetch(u_hazardA, ivec3(localX, localY, u_frameLayerA), 0) : vec4(0.0);',
    '  vec4 hazardSummaryB = u_hazardAvailableB == 1 ? texelFetch(u_hazardB, ivec3(localX, localY, u_frameLayerB), 0) : vec4(0.0);',
    '  float rainWetA = validA ? summaryA.x : 0.0; float rainWetB = validB ? summaryB.x : 0.0;',
    '  float rainMaxA = validA ? summaryA.y : 0.0; float rainMaxB = validB ? summaryB.y : 0.0;',
    '  float rainCoverageA = validA ? summaryA.z : 0.0; float rainCoverageB = validB ? summaryB.z : 0.0;',
    '  float strongCoverageA = validA ? summaryA.w : 0.0; float strongCoverageB = validB ? summaryB.w : 0.0;',
    '  float stormCoverageA = validA ? hazardSummaryA.x : 0.0; float stormCoverageB = validB ? hazardSummaryB.x : 0.0;',
    '  float stormMaxA = validA ? hazardSummaryA.y : 0.0; float stormMaxB = validB ? hazardSummaryB.y : 0.0;',
    '  float hailCoverageA = validA ? hazardSummaryA.z : 0.0; float hailCoverageB = validB ? hazardSummaryB.z : 0.0;',
    '  float hailMaxA = validA ? hazardSummaryA.w : 0.0; float hailMaxB = validB ? hazardSummaryB.w : 0.0;',
    '  float rainWet = validA && validB ? mix(rainWetA, rainWetB, u_temporalProgress) : validA ? rainWetA : validB ? rainWetB : 0.0;',
    '  float rainCoverage = validA && validB ? mix(rainCoverageA, rainCoverageB, u_temporalProgress) : validA ? rainCoverageA : validB ? rainCoverageB : 0.0;',
    '  float stormCoverage = validA && validB ? mix(stormCoverageA, stormCoverageB, u_temporalProgress) : validA ? stormCoverageA : validB ? stormCoverageB : 0.0;',
    '  float stormMax = validA && validB ? mix(stormMaxA, stormMaxB, u_temporalProgress) : validA ? stormMaxA : validB ? stormMaxB : 0.0;',
    '  float hailCoverage = validA && validB ? mix(hailCoverageA, hailCoverageB, u_temporalProgress) : validA ? hailCoverageA : validB ? hailCoverageB : 0.0;',
    '  float hailMax = validA && validB ? mix(hailMaxA, hailMaxB, u_temporalProgress) : validA ? hailMaxA : validB ? hailMaxB : 0.0;'
  ];
  const hazardUniforms = hazardsAvailable && !aggregate ? [
    'uniform sampler2DArray u_stormA; uniform sampler2DArray u_stormB; uniform sampler2DArray u_hailA; uniform sampler2DArray u_hailB;',
    'uniform int u_stormAvailableA; uniform int u_stormAvailableB; uniform int u_hailAvailableA; uniform int u_hailAvailableB;'
  ] : [];
  const hazardFunctions = (hazardsAvailable || aggregate) ? [
    'float sampleHazard(sampler2DArray source, int frameLayer, ivec2 coordinate, int available) { return available == 1 ? texelFetch(source, ivec3(coordinate, frameLayer), 0).r : 0.0; }',
    'float temporalHazard(float first, float second) { return mix(first, second, u_temporalProgress); }',
    'float stormRadius(float severity) { return severity <= 0.033750 ? 0.0 : mix(0.30, 0.72, pow(smoothstep(0.033750, 0.930000, severity), 0.47)); }',
    'float hailRadius(float severity) { return severity <= 0.049500 ? 0.0 : mix(0.34, 1.00, pow(smoothstep(0.049500, 0.930000, severity), 0.47)); }'
  ] : [];
  const hazardSource = squares
    ? (hazardsAvailable ? [
      '  float stormA = sampleHazard(u_stormA, u_frameLayerA, ivec2(localX, localY), u_stormAvailableA);',
      '  float stormB = sampleHazard(u_stormB, u_frameLayerB, ivec2(localX, localY), u_stormAvailableB);',
      '  float hailA = sampleHazard(u_hailA, u_frameLayerA, ivec2(localX, localY), u_hailAvailableA);',
      '  float hailB = sampleHazard(u_hailB, u_frameLayerB, ivec2(localX, localY), u_hailAvailableB);',
      '  float storm = temporalHazard(stormA, stormB);',
      '  float hail = temporalHazard(hailA, hailB);',
      '  float stormCoverage = mix(stormA > 0.0 ? 1.0 : 0.0, stormB > 0.0 ? 1.0 : 0.0, u_temporalProgress);',
      '  float hailCoverage = mix(hailA > 0.0 ? 1.0 : 0.0, hailB > 0.0 ? 1.0 : 0.0, u_temporalProgress);'
    ] : [
      '  float storm = 0.0; float hail = 0.0; float stormCoverage = 0.0; float hailCoverage = 0.0;'
    ])
    : (hazardsAvailable ? [
      '  float storm = temporalHazard(sampleHazard(u_stormA, u_frameLayerA, ivec2(localX, localY), u_stormAvailableA), sampleHazard(u_stormB, u_frameLayerB, ivec2(localX, localY), u_stormAvailableB));',
      '  float hail = temporalHazard(sampleHazard(u_hailA, u_frameLayerA, ivec2(localX, localY), u_hailAvailableA), sampleHazard(u_hailB, u_frameLayerB, ivec2(localX, localY), u_hailAvailableB));'
    ] : []);
  const hazardRadiusSource = hazardsAvailable ? [
    '  float radiusFraction = u_mode == 0 ? rainVisibility(rain) * ' + DOTS_BASE_RAIN_MAX_RADIUS_FRACTION.toFixed(6) + ' : u_mode == 1 ? strongRain(rain) : u_mode == 2 ? (hailRadius(hail) > 0.0 ? 0.0 : stormRadius(storm)) : hailRadius(hail);'
  ] : [
    `  float radiusFraction = u_mode == 0 ? rainVisibility(rain) * ${DOTS_BASE_RAIN_MAX_RADIUS_FRACTION.toFixed(6)} : strongRain(rain);`
  ];
  const aggregateDotsSource = [
    '  float rainRadiusA = validA ? sqrt(max(rainCoverageA, 0.0)) * rainVisibility(rainWetA) * ' + DOTS_BASE_RAIN_MAX_RADIUS_FRACTION.toFixed(6) + ' : 0.0;',
    '  float rainRadiusB = validB ? sqrt(max(rainCoverageB, 0.0)) * rainVisibility(rainWetB) * ' + DOTS_BASE_RAIN_MAX_RADIUS_FRACTION.toFixed(6) + ' : 0.0;',
    '  float strongRadiusA = validA ? sqrt(max(strongCoverageA, 0.0)) * strongRain(rainMaxA) : 0.0;',
    '  float strongRadiusB = validB ? sqrt(max(strongCoverageB, 0.0)) * strongRain(rainMaxB) : 0.0;',
    '  float stormRadiusA = validA ? sqrt(max(stormCoverageA, 0.0)) * stormRadius(stormMaxA) : 0.0;',
    '  float stormRadiusB = validB ? sqrt(max(stormCoverageB, 0.0)) * stormRadius(stormMaxB) : 0.0;',
    '  float hailRadiusA = validA ? sqrt(max(hailCoverageA, 0.0)) * hailRadius(hailMaxA) : 0.0;',
    '  float hailRadiusB = validB ? sqrt(max(hailCoverageB, 0.0)) * hailRadius(hailMaxB) : 0.0;',
    '  float radiusA = u_mode == 0 ? rainRadiusA : u_mode == 1 ? strongRadiusA : u_mode == 2 ? (hailRadiusA > 0.0 ? 0.0 : stormRadiusA) : hailRadiusA;',
    '  float radiusB = u_mode == 0 ? rainRadiusB : u_mode == 1 ? strongRadiusB : u_mode == 2 ? (hailRadiusB > 0.0 ? 0.0 : stormRadiusB) : hailRadiusB;',
    '  float radiusFraction = validA && validB ? sqrt(mix(radiusA * radiusA, radiusB * radiusB, u_temporalProgress)) : validA ? radiusA : validB ? radiusB : 0.0;'
  ];
  const vertexSource = squares ? [
    '#version 300 es', shaderData.vertexShaderPrelude,
    'precision highp float; precision highp int; precision highp sampler2DArray; precision highp usampler2DArray;',
    'in vec2 a_vertex;',
    'uniform vec2 u_tileOrigin;',
    ...(aggregate ? aggregateUniforms : ['uniform usampler2DArray u_rainA; uniform usampler2DArray u_rainB;']),
    'uniform int u_frameLayerA; uniform int u_frameLayerB; uniform float u_temporalProgress;',
    ...motionUniforms,
    ...hazardUniforms,
    'out vec2 v_rain; out vec4 v_hazards;',
    'uniform float u_physicalMaxMmh;',
    ...(aggregate ? [] : ['float decodeRain(uint code) { if (code == 0u || code == 1u) return 0.0; return (float(code) - 1.0) / 65534.0 * u_physicalMaxMmh; }']),
    ...motionFunctions,
    ...hazardFunctions,
    'void main() {',
    `  int localIndex = gl_InstanceID; int localX = localIndex % ${TILED_RAIN_TILE_SIZE}; int localY = localIndex / ${TILED_RAIN_TILE_SIZE};`,
    ...(aggregate ? aggregateSummarySource : squaresRainSource),
    ...(aggregate ? [] : hazardSource),
    ...(aggregate ? [
      '  v_rain = vec2(rainWet, rainCoverage);',
      '  v_hazards = vec4(stormCoverage, stormMax, hailCoverage, hailMax);'
    ] : [
      '  v_rain = vec2(rain, rainCoverage);',
      '  v_hazards = vec4(stormCoverage, storm, hailCoverage, hail);'
    ]),
    `  vec2 center = u_tileOrigin + vec2(float(localX), float(localY)) / ${gridSize}.0;`,
    `  gl_Position = projectTile(center + a_vertex / ${gridSize}.0);`,
    '}'
  ].join('\n') : [
    '#version 300 es', shaderData.vertexShaderPrelude,
    'precision highp float; precision highp int; precision highp sampler2DArray; precision highp usampler2DArray;',
    'in vec2 a_vertex;',
    'uniform vec2 u_tileOrigin;',
    ...(aggregate ? aggregateUniforms : ['uniform usampler2DArray u_rainA; uniform usampler2DArray u_rainB;']),
    'uniform int u_frameLayerA; uniform int u_frameLayerB; uniform float u_temporalProgress; uniform int u_mode;',
    ...motionUniforms,
    ...hazardUniforms,
    'out vec2 v_local; out float v_radius;',
    'uniform float u_physicalMaxMmh;',
    ...(aggregate ? [] : ['float decodeRain(uint code) { if (code == 0u || code == 1u) return 0.0; return (float(code) - 1.0) / 65534.0 * u_physicalMaxMmh; }']),
    ...motionFunctions,
    RAIN_VISIBILITY_SHADER,
    strongRainShader(),
    ...hazardFunctions,
    'void main() {',
    `  int localIndex = gl_InstanceID; int localX = localIndex % ${TILED_RAIN_TILE_SIZE}; int localY = localIndex / ${TILED_RAIN_TILE_SIZE};`,
    ...(aggregate ? aggregateSummarySource : motionRainSource),
    ...(aggregate ? [] : hazardSource),
    ...(aggregate ? aggregateDotsSource : hazardRadiusSource),
    `  v_radius = radiusFraction / ${gridSize}.0; v_local = a_vertex;`,
    `  vec2 center = u_tileOrigin + vec2(float(localX), float(localY)) / ${gridSize}.0;`,
    '  gl_Position = projectTile(center + a_vertex * v_radius);',
    '}'
  ].join('\n');
  const fragmentSource = squares ? [
    '#version 300 es', 'precision highp float; precision highp int;',
    'in vec2 v_rain; in vec4 v_hazards; uniform float u_opacity; uniform float u_hazardsVisible; out vec4 fragColor;',
    RAIN_VISIBILITY_SHADER,
    STRONG_RAIN_SHADER,
hazardsAvailable ? `float strength(float value, float threshold) { return smoothstep(threshold * 0.45, 0.93, value); }
void main() {
  float rain = rainVisibility(v_rain.x) * clamp(v_rain.y, 0.0, 1.0);
  float strong = strongRain(v_rain.x);
  vec3 color = mix(vec3(0.0, 0.565, 1.0), vec3(0.0, 0.0, 1.0), strong);
  float alpha = rain;
  float stormStrength = strength(v_hazards.y, 0.075);
  float storm = u_hazardsVisible * clamp(v_hazards.x, 0.0, 1.0) * stormStrength;
  if (storm > 0.0) { color = mix(color, vec3(1.0, 0.0, 1.0), mix(0.45, 1.0, pow(stormStrength, 0.47))); alpha = max(alpha, storm); }
  float hailStrength = strength(v_hazards.w, 0.11);
  float hail = u_hazardsVisible * clamp(v_hazards.z, 0.0, 1.0) * hailStrength;
  if (hail > 0.0) { color = mix(color, vec3(1.0, 0.831, 0.0), mix(0.5, 1.0, pow(hailStrength, 0.47))); alpha = max(alpha, hail); }
  fragColor = vec4(color, alpha * u_opacity);
}` : `void main() {
  float rain = rainVisibility(v_rain.x) * clamp(v_rain.y, 0.0, 1.0);
  float strong = strongRain(v_rain.x);
  vec3 color = mix(vec3(0.0, 0.565, 1.0), vec3(0.0, 0.0, 1.0), strong);
  fragColor = vec4(color, rain * u_opacity);
}`
  ].join('\n') : [
    '#version 300 es', 'precision highp float; precision highp int;', 'in vec2 v_local; in float v_radius; uniform vec4 u_color; uniform int u_mode; uniform float u_opacity; out vec4 fragColor;',
    'void main() { if (v_radius <= 0.0) discard; if (u_mode >= 2) { fragColor = vec4(u_color.rgb, u_color.a * u_opacity); return; } float distanceToCenter = length(v_local); float edge = fwidth(distanceToCenter); float alpha = 1.0 - smoothstep(1.0 - edge, 1.0 + edge, distanceToCenter); fragColor = vec4(u_color.rgb, u_color.a * alpha * u_opacity); }'
  ].join('\n');
  const program = gl.createProgram();
  gl.attachShader(program, compileShader(gl, gl.VERTEX_SHADER, vertexSource));
  gl.attachShader(program, compileShader(gl, gl.FRAGMENT_SHADER, fragmentSource));
  gl.linkProgram(program);
  if (!gl.getProgramParameter(program, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(program) || 'Tiled rain shader linking failed.');
  const locations = {
      vertex: gl.getAttribLocation(program, 'a_vertex'),
      tileOrigin: gl.getUniformLocation(program, 'u_tileOrigin'),
      rainA: gl.getUniformLocation(program, 'u_rainA'),
      rainB: gl.getUniformLocation(program, 'u_rainB'),
      summaryA: gl.getUniformLocation(program, 'u_summaryA'),
      summaryB: gl.getUniformLocation(program, 'u_summaryB'),
      hazardA: gl.getUniformLocation(program, 'u_hazardA'),
      hazardB: gl.getUniformLocation(program, 'u_hazardB'),
      hazardAvailableA: gl.getUniformLocation(program, 'u_hazardAvailableA'),
      hazardAvailableB: gl.getUniformLocation(program, 'u_hazardAvailableB'),
      frameLayerA: gl.getUniformLocation(program, 'u_frameLayerA'),
      frameLayerB: gl.getUniformLocation(program, 'u_frameLayerB'),
      temporalProgress: gl.getUniformLocation(program, 'u_temporalProgress'),
      physicalMaxMmh: gl.getUniformLocation(program, 'u_physicalMaxMmh'),
      mode: gl.getUniformLocation(program, 'u_mode'),
      color: gl.getUniformLocation(program, 'u_color'),
      opacity: gl.getUniformLocation(program, 'u_opacity'),
      hazardsVisible: gl.getUniformLocation(program, 'u_hazardsVisible'),
      matrix: gl.getUniformLocation(program, 'u_matrix'),
      fallbackMatrix: gl.getUniformLocation(program, 'u_projection_fallback_matrix'),
      projectionMatrix: gl.getUniformLocation(program, 'u_projection_matrix'),
      tileMercatorCoords: gl.getUniformLocation(program, 'u_projection_tile_mercator_coords'),
      clippingPlane: gl.getUniformLocation(program, 'u_projection_clipping_plane'),
      projectionTransition: gl.getUniformLocation(program, 'u_projection_transition')
  };
  if (hazardsAvailable) Object.assign(locations, {
    stormA: gl.getUniformLocation(program, 'u_stormA'),
    stormB: gl.getUniformLocation(program, 'u_stormB'),
    hailA: gl.getUniformLocation(program, 'u_hailA'),
    hailB: gl.getUniformLocation(program, 'u_hailB'),
    stormAvailableA: gl.getUniformLocation(program, 'u_stormAvailableA'),
    stormAvailableB: gl.getUniformLocation(program, 'u_stormAvailableB'),
    hailAvailableA: gl.getUniformLocation(program, 'u_hailAvailableA'),
    hailAvailableB: gl.getUniformLocation(program, 'u_hailAvailableB')
  });
  if (motionWarp) Object.assign(locations, {
    motion: gl.getUniformLocation(program, 'u_motion'),
    frameA: gl.getUniformLocation(program, 'u_frameA'),
    frameB: gl.getUniformLocation(program, 'u_frameB'),
    motionInterval: gl.getUniformLocation(program, 'u_motionInterval'),
    motionWarpActive: gl.getUniformLocation(program, 'u_motionWarpActive'),
    rainHalo: gl.getUniformLocation(program, 'u_rainHalo'),
    motionNodeSpacing: gl.getUniformLocation(program, 'u_motionNodeSpacing'),
    motionNodesPerTile: gl.getUniformLocation(program, 'u_motionNodesPerTile')
  });
  return { program, locations };
}

// This program deliberately exists beside the stable program.  It is compiled
// only for an adjacent tiled Dots transition; stable draws retain their exact
// shader, texture bindings, and submission cost.
function makeDotsTransitionProgram(gl, shaderData, lowerAggregate, fineAggregate, hazardsAvailable, lowerGridSize, fineGridSize) {
  const endpoint = (prefix, aggregate) => {
    if (aggregate) return [
      `uniform sampler2DArray u_${prefix}_summaryA; uniform sampler2DArray u_${prefix}_summaryB;`,
      `uniform sampler2DArray u_${prefix}_hazardA; uniform sampler2DArray u_${prefix}_hazardB;`,
      `uniform int u_${prefix}_hazardAvailableA; uniform int u_${prefix}_hazardAvailableB;`,
      `uniform int u_${prefix}_frameLayerA; uniform int u_${prefix}_frameLayerB;`,
      `float ${prefix}EndpointRadius(ivec2 coordinate) {`,
      `  vec4 summaryA = texelFetch(u_${prefix}_summaryA, ivec3(coordinate, u_${prefix}_frameLayerA), 0);`,
      `  vec4 summaryB = texelFetch(u_${prefix}_summaryB, ivec3(coordinate, u_${prefix}_frameLayerB), 0);`,
      '  bool validA = summaryA.z >= -0.5; bool validB = summaryB.z >= -0.5;',
      `  vec4 hazardA = u_${prefix}_hazardAvailableA == 1 ? texelFetch(u_${prefix}_hazardA, ivec3(coordinate, u_${prefix}_frameLayerA), 0) : vec4(0.0);`,
      `  vec4 hazardB = u_${prefix}_hazardAvailableB == 1 ? texelFetch(u_${prefix}_hazardB, ivec3(coordinate, u_${prefix}_frameLayerB), 0) : vec4(0.0);`,
      '  float rainA = validA ? sqrt(max(summaryA.z, 0.0)) * rainVisibility(summaryA.x) * ' + DOTS_BASE_RAIN_MAX_RADIUS_FRACTION.toFixed(6) + ' : 0.0;',
      '  float rainB = validB ? sqrt(max(summaryB.z, 0.0)) * rainVisibility(summaryB.x) * ' + DOTS_BASE_RAIN_MAX_RADIUS_FRACTION.toFixed(6) + ' : 0.0;',
      '  float strongA = validA ? sqrt(max(summaryA.w, 0.0)) * strongRain(summaryA.y) : 0.0;',
      '  float strongB = validB ? sqrt(max(summaryB.w, 0.0)) * strongRain(summaryB.y) : 0.0;',
      '  float stormA = validA ? sqrt(max(hazardA.x, 0.0)) * stormRadius(hazardA.y) : 0.0;',
      '  float stormB = validB ? sqrt(max(hazardB.x, 0.0)) * stormRadius(hazardB.y) : 0.0;',
      '  float hailA = validA ? sqrt(max(hazardA.z, 0.0)) * hailRadius(hazardA.w) : 0.0;',
      '  float hailB = validB ? sqrt(max(hazardB.z, 0.0)) * hailRadius(hazardB.w) : 0.0;',
      '  float radiusA = u_mode == 0 ? rainA : u_mode == 1 ? strongA : u_mode == 2 ? (hailA > 0.0 ? 0.0 : stormA) : hailA;',
      '  float radiusB = u_mode == 0 ? rainB : u_mode == 1 ? strongB : u_mode == 2 ? (hailB > 0.0 ? 0.0 : stormB) : hailB;',
      '  return validA && validB ? sqrt(mix(radiusA * radiusA, radiusB * radiusB, u_temporalProgress)) : validA ? radiusA : validB ? radiusB : 0.0;',
      '}'
    ];
    return [
      `uniform usampler2DArray u_${prefix}_rainA; uniform usampler2DArray u_${prefix}_rainB;`,
      `uniform int u_${prefix}_frameLayerA; uniform int u_${prefix}_frameLayerB; uniform float u_${prefix}_physicalMaxMmh;`,
      ...(hazardsAvailable ? [
        `uniform sampler2DArray u_${prefix}_stormA; uniform sampler2DArray u_${prefix}_stormB; uniform sampler2DArray u_${prefix}_hailA; uniform sampler2DArray u_${prefix}_hailB;`,
        `uniform int u_${prefix}_stormAvailableA; uniform int u_${prefix}_stormAvailableB; uniform int u_${prefix}_hailAvailableA; uniform int u_${prefix}_hailAvailableB;`
      ] : []),
      `float ${prefix}DecodeRain(uint code) { return code <= 1u ? 0.0 : (float(code) - 1.0) / 65534.0 * u_${prefix}_physicalMaxMmh; }`,
      `float ${prefix}EndpointRadius(ivec2 coordinate) {`,
      `  uint codeA = texelFetch(u_${prefix}_rainA, ivec3(coordinate, u_${prefix}_frameLayerA), 0).r; uint codeB = texelFetch(u_${prefix}_rainB, ivec3(coordinate, u_${prefix}_frameLayerB), 0).r;`,
      `  bool validA = codeA != 0u; bool validB = codeB != 0u; float rainA = ${prefix}DecodeRain(codeA); float rainB = ${prefix}DecodeRain(codeB);`,
      '  float rain = validA && validB ? mix(rainA, rainB, u_temporalProgress) : validA ? rainA : validB ? rainB : 0.0;',
      ...(hazardsAvailable ? [
        `  float storm = mix(u_${prefix}_stormAvailableA == 1 ? texelFetch(u_${prefix}_stormA, ivec3(coordinate, u_${prefix}_frameLayerA), 0).r : 0.0, u_${prefix}_stormAvailableB == 1 ? texelFetch(u_${prefix}_stormB, ivec3(coordinate, u_${prefix}_frameLayerB), 0).r : 0.0, u_temporalProgress);`,
        `  float hail = mix(u_${prefix}_hailAvailableA == 1 ? texelFetch(u_${prefix}_hailA, ivec3(coordinate, u_${prefix}_frameLayerA), 0).r : 0.0, u_${prefix}_hailAvailableB == 1 ? texelFetch(u_${prefix}_hailB, ivec3(coordinate, u_${prefix}_frameLayerB), 0).r : 0.0, u_temporalProgress);`,
        '  return u_mode == 0 ? rainVisibility(rain) * ' + DOTS_BASE_RAIN_MAX_RADIUS_FRACTION.toFixed(6) + ' : u_mode == 1 ? strongRain(rain) : u_mode == 2 ? (hailRadius(hail) > 0.0 ? 0.0 : stormRadius(storm)) : hailRadius(hail);'
      ] : [
        '  return u_mode == 0 ? rainVisibility(rain) * ' + DOTS_BASE_RAIN_MAX_RADIUS_FRACTION.toFixed(6) + ' : strongRain(rain);'
      ]),
      '}'
    ];
  };
  const vertexSource = [
    '#version 300 es', shaderData.vertexShaderPrelude,
    'precision highp float; precision highp int; precision highp sampler2DArray; precision highp usampler2DArray;',
    'in vec2 a_vertex; out vec2 v_local; out float v_radius;',
    'uniform vec2 u_fineTileOrigin; uniform ivec2 u_coarseLocalBase; uniform float u_temporalProgress; uniform float u_refineProgress; uniform int u_mode;',
    RAIN_VISIBILITY_SHADER, strongRainShader(),
    'float stormRadius(float severity) { return severity <= 0.033750 ? 0.0 : mix(0.30, 0.72, pow(smoothstep(0.033750, 0.930000, severity), 0.47)); }',
    'float hailRadius(float severity) { return severity <= 0.049500 ? 0.0 : mix(0.34, 1.00, pow(smoothstep(0.049500, 0.930000, severity), 0.47)); }',
    ...endpoint('coarse', lowerAggregate), ...endpoint('fine', fineAggregate),
    'void main() {',
    `  int localIndex = gl_InstanceID; int localX = localIndex % ${TILED_RAIN_TILE_SIZE}; int localY = localIndex / ${TILED_RAIN_TILE_SIZE};`,
    '  ivec2 fineLocal = ivec2(localX, localY); bool shared = (localX & 1) == 0 && (localY & 1) == 0;',
    '  float coarseRadius = shared ? coarseEndpointRadius(u_coarseLocalBase + fineLocal / 2) : 0.0;',
    '  float fineRadius = fineEndpointRadius(fineLocal);',
    '  float radiusFraction = sqrt(mix(coarseRadius * coarseRadius, fineRadius * fineRadius, u_refineProgress));',
    `  v_radius = radiusFraction / ${fineGridSize}.0; v_local = a_vertex;`,
    `  vec2 center = u_fineTileOrigin + vec2(float(localX), float(localY)) / ${fineGridSize}.0;`,
    '  gl_Position = projectTile(center + a_vertex * v_radius);',
    '}'
  ].join('\n');
  const fragmentSource = [
    '#version 300 es', 'precision highp float; precision highp int;',
    'in vec2 v_local; in float v_radius; uniform vec4 u_color; uniform int u_mode; out vec4 fragColor;',
    'void main() { if (v_radius <= 0.0) discard; if (u_mode >= 2) { fragColor = u_color; return; } float distanceToCenter = length(v_local); float edge = fwidth(distanceToCenter); float alpha = 1.0 - smoothstep(1.0 - edge, 1.0 + edge, distanceToCenter); fragColor = vec4(u_color.rgb, u_color.a * alpha); }'
  ].join('\n');
  const program = gl.createProgram();
  gl.attachShader(program, compileShader(gl, gl.VERTEX_SHADER, vertexSource));
  gl.attachShader(program, compileShader(gl, gl.FRAGMENT_SHADER, fragmentSource));
  gl.linkProgram(program);
  if (!gl.getProgramParameter(program, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(program) || 'Tiled rain Dots transition shader linking failed.');
  const locations = {
    fineTileOrigin: gl.getUniformLocation(program, 'u_fineTileOrigin'),
    coarseLocalBase: gl.getUniformLocation(program, 'u_coarseLocalBase'),
    temporalProgress: gl.getUniformLocation(program, 'u_temporalProgress'),
    refineProgress: gl.getUniformLocation(program, 'u_refineProgress'),
    mode: gl.getUniformLocation(program, 'u_mode'), color: gl.getUniformLocation(program, 'u_color'),
    matrix: gl.getUniformLocation(program, 'u_matrix'), fallbackMatrix: gl.getUniformLocation(program, 'u_projection_fallback_matrix'),
    projectionMatrix: gl.getUniformLocation(program, 'u_projection_matrix'), tileMercatorCoords: gl.getUniformLocation(program, 'u_projection_tile_mercator_coords'),
    clippingPlane: gl.getUniformLocation(program, 'u_projection_clipping_plane'), projectionTransition: gl.getUniformLocation(program, 'u_projection_transition')
  };
  for (const prefix of ['coarse', 'fine']) {
    for (const suffix of ['RainA', 'RainB', 'SummaryA', 'SummaryB', 'HazardA', 'HazardB', 'HazardAvailableA', 'HazardAvailableB', 'FrameLayerA', 'FrameLayerB', 'PhysicalMaxMmh', 'StormA', 'StormB', 'HailA', 'HailB', 'StormAvailableA', 'StormAvailableB', 'HailAvailableA', 'HailAvailableB']) {
      locations[`${prefix}${suffix}`] = gl.getUniformLocation(program, `u_${prefix}_${suffix[0].toLowerCase()}${suffix.slice(1)}`);
    }
  }
  locations.vertex = gl.getAttribLocation(program, 'a_vertex');
  return { program, locations };
}

export class TiledRainLayer {
  constructor(store, { onTiming = null, onCommit = null, onDiagnosticEvent = null } = {}) {
    this.id = 'tiled-rain';
    this.type = 'custom';
    this.renderingMode = '3d';
    this.store = store;
    this.hazardsAvailable = store.hazardsAvailable;
    this.onTiming = typeof onTiming === 'function' ? onTiming : () => {};
    this.onCommit = typeof onCommit === 'function' ? onCommit : () => {};
    this.onDiagnosticEvent = typeof onDiagnosticEvent === 'function' ? onDiagnosticEvent : () => {};
    this.programs = new Map();
    this.active = true;
    this.presentationMode = 'dots';
    this.hazardsVisible = true;
    this.viewportTileKeys = [];
    this.viewportBounds = null;
    this.stableLevel = store.lodLevel;
    this.desiredLevel = store.lodLevel;
    this.pendingLod = null;
    this.lodTransition = null;
    this.lodGeneration = 0;
    this.requestedFrame = sourceFrameForTime(store.manifest.frame_count, 0);
    this.committedFrame = null;
    this.requestGeneration = 0;
    this.desiredBlockKeys = new Set();
    this.map = null;
    this.firstVisibleReported = false;
  }

  endpointDiagnostics() {
    const roleByLevel = new Map();
    if (this.lodTransition) {
      roleByLevel.set(this.lodTransition.fromLevel, 'transition-from');
      roleByLevel.set(this.lodTransition.toLevel, 'transition-to');
    } else {
      roleByLevel.set(this.stableLevel, 'stable');
      if (this.pendingLod) roleByLevel.set(this.pendingLod.toLevel, 'preload-target');
    }
    return this.store.levelDiagnostics().map((entry) => ({
      ...entry,
      visibleTileCount: this.viewportBounds ? this.tileKeysForBounds(this.viewportBounds, entry.level).length : 0,
      endpointRole: roleByLevel.get(entry.level) || null
    }));
  }

  diagnosticEventDetails(details = {}) {
    const store = this.store.diagnostics();
    return {
      ...details,
      stableLevel: this.stableLevel,
      desiredLevel: this.desiredLevel,
      transition: this.lodTransition ? {
        fromLevel: this.lodTransition.fromLevel,
        toLevel: this.lodTransition.toLevel,
        progress: this.lodTransition.rawProgress
      } : null,
      currentSourceFramePair: this.committedFrame
        ? [this.committedFrame.frame0, this.committedFrame.frame1]
        : null,
      requestedSourceFramePair: [this.requestedFrame.frame0, this.requestedFrame.frame1],
      protectedBlockCount: this.store.protectedBlockKeys.size,
      trackedBlockCount: store.trackedBlockCount,
      trackedCpuBytes: store.logicalResidentPayloadBytes,
      estimatedGpuBytes: store.estimatedGpuPayloadBytes,
      endpointLevels: this.endpointDiagnostics()
    };
  }

  onAdd(map, gl) {
    if (!gl || typeof gl.texImage3D !== 'function' || typeof gl.drawArraysInstanced !== 'function') {
      throw new Error('Tiled rain Phase 0A requires a WebGL2 MapLibre context.');
    }
    this.map = map;
    this.gl = gl;
    this.vertexBuffer = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, this.vertexBuffer);
    gl.bufferData(gl.ARRAY_BUFFER, QUAD, gl.STATIC_DRAW);
    this.squareVertexBuffer = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, this.squareVertexBuffer);
    gl.bufferData(gl.ARRAY_BUFFER, CELL_VERTICES, gl.STATIC_DRAW);
    this.hazardVertexBuffers = { storm: gl.createBuffer(), hail: gl.createBuffer() };
    for (const [type, vertices] of Object.entries({ storm: STORM, hail: HAIL })) {
      gl.bindBuffer(gl.ARRAY_BUFFER, this.hazardVertexBuffers[type]);
      gl.bufferData(gl.ARRAY_BUFFER, vertices, gl.STATIC_DRAW);
    }
  }

  onRemove(map, gl) {
    for (const entry of this.programs.values()) gl.deleteProgram(entry.program);
    for (const state of this.store.blocks.values()) if (state.gpuTexture) gl.deleteTexture(state.gpuTexture);
    for (const state of this.store.blocks.values()) if (state.summaryTexture) gl.deleteTexture(state.summaryTexture);
    for (const state of this.store.blocks.values()) for (const texture of Object.values(state.hazardTextures || {})) if (texture) gl.deleteTexture(texture);
    if (this.store.emptyHazardTexture) gl.deleteTexture(this.store.emptyHazardTexture);
    if (this.store.emptySummaryTexture) gl.deleteTexture(this.store.emptySummaryTexture);
    for (const state of this.store.motionTilesState?.values() || []) if (state.gpuTexture) gl.deleteTexture(state.gpuTexture);
    if (this.vertexBuffer) gl.deleteBuffer(this.vertexBuffer);
    if (this.squareVertexBuffer) gl.deleteBuffer(this.squareVertexBuffer);
    for (const buffer of Object.values(this.hazardVertexBuffers || {})) if (buffer) gl.deleteBuffer(buffer);
  }

  tileKeysForBounds(bounds, level = this.stableLevel) {
    const levelData = this.store.levelData(level);
    const gridSize = levelData.grid?.grid_size ?? levelData.grid_size ?? TILED_RAIN_GRID_SIZE;
    const tiles = this.store.multiLod
      ? this.store.tilesByLevel.get(Number(level)) || new Map()
      : this.store.tiles;
    const minX = Math.floor((bounds.minX * gridSize - VIEWPORT_OVERSCAN_SAMPLES) / TILED_RAIN_TILE_SIZE);
    const maxX = Math.floor((bounds.maxX * gridSize + VIEWPORT_OVERSCAN_SAMPLES) / TILED_RAIN_TILE_SIZE);
    const minY = Math.floor((bounds.minY * gridSize - VIEWPORT_OVERSCAN_SAMPLES) / TILED_RAIN_TILE_SIZE);
    const maxY = Math.floor((bounds.maxY * gridSize + VIEWPORT_OVERSCAN_SAMPLES) / TILED_RAIN_TILE_SIZE);
    const indexBounds = levelData.tile_index_bounds;
    const keys = [];
    for (let y = Math.max(indexBounds.min_y, minY); y <= Math.min(indexBounds.max_y, maxY); y++) {
      for (let x = Math.max(indexBounds.min_x, minX); x <= Math.min(indexBounds.max_x, maxX); x++) {
        const key = `${x}:${y}`;
        if (tiles.has(key)) keys.push(key);
      }
    }
    return keys;
  }

  setViewportBounds(bounds) {
    if (!bounds) return;
    this.viewportBounds = bounds;
    const nextKeys = this.tileKeysForBounds(bounds, this.stableLevel);
    if (nextKeys.join(',') === this.viewportTileKeys.join(',') && !this.pendingLod && !this.lodTransition) return;
    this.viewportTileKeys = nextKeys;
    this.store.setVisibleTileCount(nextKeys.length);
    this.requestState();
  }

  setDesiredLod(level) {
    if (!this.store.multiLod) return;
    const nextLevel = selectTiledRainLod(level, this.stableLevel);
    const previousDesiredLevel = this.desiredLevel;
    this.desiredLevel = nextLevel;
    if (nextLevel !== previousDesiredLevel) {
      this.onDiagnosticEvent('tiled-lod-desired-change', this.diagnosticEventDetails({
        fromLevel: previousDesiredLevel,
        toLevel: nextLevel
      }));
    }
    if (nextLevel === this.stableLevel && !this.lodTransition) {
      if (this.pendingLod) {
        this.pendingLod = null;
        this.lodGeneration++;
        this.requestState();
      }
      return;
    }
    const transition = this.lodTransition;
    if (transition) {
      const direction = Math.sign(transition.toLevel - transition.fromLevel);
      if (nextLevel === transition.fromLevel || Math.sign(nextLevel - transition.toLevel) !== direction) {
        const progress = Math.max(0, Math.min(1, (now() - transition.start) / (LOD_MORPH_SECONDS * 1000)));
        const reversalFromLevel = transition.toLevel;
        const reversalToLevel = transition.fromLevel;
        transition.rawProgress = progress;
        this.lodTransition = {
          fromLevel: reversalFromLevel,
          toLevel: reversalToLevel,
          start: now() - (1 - progress) * LOD_MORPH_SECONDS * 1000,
          rawProgress: 1 - progress
        };
        this.pendingLod = null;
        this.lodGeneration++;
        this.onDiagnosticEvent('tiled-lod-transition-reversal', this.diagnosticEventDetails({
          fromLevel: reversalFromLevel,
          toLevel: reversalToLevel,
          previousProgress: progress,
          progress: 1 - progress
        }));
        this.requestState();
      }
      return;
    }
    if (this.pendingLod) {
      if (nextLevel !== this.pendingLod.toLevel) {
        this.pendingLod = null;
        this.lodGeneration++;
        this.requestState();
      }
      return;
    }
    this.beginLodPreload();
  }

  automaticDesiredLod(logicalZoom) {
    return automaticTiledRainLodWithHysteresis(logicalZoom, this.desiredLevel);
  }

  setAutomaticDesiredLod(logicalZoom) {
    this.setDesiredLod(this.automaticDesiredLod(logicalZoom));
  }

  beginLodPreload() {
    if (!this.store.multiLod || this.stableLevel === this.desiredLevel) return;
    const toLevel = adjacentTiledRainLod(this.stableLevel, this.desiredLevel);
    this.pendingLod = { fromLevel: this.stableLevel, toLevel, generation: ++this.lodGeneration, startedAt: now() };
    this.onDiagnosticEvent('tiled-lod-preload-start', this.diagnosticEventDetails({
      fromLevel: this.stableLevel,
      toLevel,
      desiredLevel: this.desiredLevel
    }));
    this.requestState();
  }

  updateLodTransition(timestamp = now()) {
    const transition = this.lodTransition;
    if (!transition) return false;
    const rawProgress = Math.max(0, Math.min(1, (timestamp - transition.start) / (LOD_MORPH_SECONDS * 1000)));
    transition.rawProgress = rawProgress;
    if (rawProgress < 1) {
      this.map?.triggerRepaint();
      return true;
    }
    this.stableLevel = transition.toLevel;
    this.lodTransition = null;
    this.store.activateLevel(this.stableLevel);
    this.viewportTileKeys = this.tileKeysForBounds(this.viewportBounds, this.stableLevel);
    this.store.setVisibleTileCount(this.viewportTileKeys.length);
    this.onDiagnosticEvent('tiled-lod-transition-complete', this.diagnosticEventDetails({
      fromLevel: transition.fromLevel,
      toLevel: transition.toLevel,
      progress: 1,
      transitionDurationMs: Math.max(0, timestamp - transition.start)
    }));
    this.onTiming('tiled-rain-lod-transition-end');
    this.requestState();
    if (this.desiredLevel !== this.stableLevel) this.beginLodPreload();
    return false;
  }

  setTime(time) {
    const next = sourceFrameForTime(this.store.manifest.frame_count, time);
    const previous = this.requestedFrame;
    const previousBlockA = Math.floor(previous.frame0 / this.store.manifest.temporal_block_size);
    const previousBlockB = Math.floor(previous.frame1 / this.store.manifest.temporal_block_size);
    const blockA = Math.floor(next.frame0 / this.store.manifest.temporal_block_size);
    const blockB = Math.floor(next.frame1 / this.store.manifest.temporal_block_size);
    const changed = next.frame0 !== previous.frame0 || next.frame1 !== previous.frame1 || next.progress !== previous.progress;
    this.requestedFrame = next;
    if (!changed) return;
    if (blockA !== previousBlockA || blockB !== previousBlockB || !this.canRenderFrame(next)) this.requestState();
    else this.commitFrame(next);
  }

  requestState() {
    if (this.store.multiLod) {
      this.requestMultiLodState();
      return;
    }
    const generation = ++this.requestGeneration;
    const requestedFrame = this.requestedFrame;
    const targetKeys = this.blockKeysForFrame(requestedFrame, this.viewportTileKeys);
    const fallbackKeys = this.committedFrame
      ? this.blockKeysForFrame(this.committedFrame, this.viewportTileKeys)
      : new Set();
    // Fallback is only prefetched when already resident. This keeps pending
    // work bounded to the newest target while preserving ordinary transitions.
    const residentFallbackKeys = [...fallbackKeys].filter((key) => this.store.blocks.get(key)?.status === 'ready');
    const usefulKeys = new Set([...targetKeys, ...residentFallbackKeys]);
    const targetMotionTileKeys = this.store.motionWarp ? new Set(this.viewportTileKeys) : new Set();
    this.desiredBlockKeys = targetKeys;
    this.store.setProtectedBlockKeys(targetKeys);
    this.store.updateDesiredBlockKeys(usefulKeys, targetMotionTileKeys);
    // Target blocks have priority. Fallback remains protected during ordinary
    // adjacent transitions, but can be evicted on a large jump so the ready
    // block ceiling remains hard.
    this.store.evict(targetKeys);

    const ensure = (keys) => [...keys].map((key) => {
      const separator = key.lastIndexOf(':');
      const tileKey = key.slice(0, separator);
      const blockIndex = Number(key.slice(separator + 1));
      return this.store.ensureBlock(tileKey, blockIndex);
    });
    const ensureMotion = (keys) => [...keys].map((key) => this.store.ensureMotionTile(key));
    void Promise.all([...ensure(targetKeys), ...ensureMotion(targetMotionTileKeys)])
      .then(() => {
        if (generation !== this.requestGeneration) {
          this.store.diagnosticsState.staleDesiredStates++;
          return;
        }
        if (!this.allBlocksReady(targetKeys) || !this.allMotionTilesReady(targetMotionTileKeys)) return;
        this.commitFrame(requestedFrame);
      })
      .catch((error) => {
        if (generation !== this.requestGeneration || error?.name === 'AbortError') return;
        console.error('Unable to load the required tiled rain state.', error);
        this.store.diagnosticsState.lastError = error instanceof Error ? error.message : String(error);
      });
    void Promise.all(ensure(residentFallbackKeys)).then(() => {
      if (generation === this.requestGeneration && this.committedFrame && this.canRenderFrame(this.committedFrame)) {
        this.map?.triggerRepaint();
      }
    }).catch((error) => {
      if (generation === this.requestGeneration && error?.name !== 'AbortError') {
        this.store.diagnosticsState.lastError = error instanceof Error ? error.message : String(error);
      }
    });
  }

  requestMultiLodState() {
    const generation = ++this.requestGeneration;
    const levels = new Set([this.stableLevel]);
    if (this.lodTransition) {
      levels.add(this.lodTransition.fromLevel);
      levels.add(this.lodTransition.toLevel);
    } else if (this.pendingLod) {
      levels.add(this.pendingLod.toLevel);
    }
    const requiredKeys = new Set();
    for (const level of levels) {
      const tileKeys = level === this.stableLevel && !this.lodTransition
        ? this.viewportTileKeys
        : this.tileKeysForBounds(this.viewportBounds, level);
      for (const key of this.blockKeysForFrame(this.requestedFrame, tileKeys, level)) requiredKeys.add(key);
    }
    this.desiredBlockKeys = requiredKeys;
    this.store.setProtectedBlockKeys(requiredKeys);
    this.store.updateDesiredBlockKeys(requiredKeys);
    this.store.evict(requiredKeys);
    const ensure = [...requiredKeys].map((key) => {
      const parsed = parseQualifiedBlockKey(key, true);
      return this.store.ensureBlock(parsed.level, parsed.tileKey, parsed.blockIndex);
    });
    void Promise.all(ensure).then(() => {
      if (generation !== this.requestGeneration) {
        this.store.diagnosticsState.staleDesiredStates++;
        return;
      }
      if (!this.allBlocksReady(requiredKeys)) return;
      if (this.pendingLod) {
        const pending = this.pendingLod;
        const pendingDirection = Math.sign(pending.toLevel - pending.fromLevel);
        if (pending.generation !== this.lodGeneration
          || pendingDirection * (this.desiredLevel - pending.fromLevel) < 1) return;
        if (!this.committedFrame) {
          this.committedFrame = this.requestedFrame;
          this.onCommit(this.committedFrame);
        }
        const preloadDurationMs = pending.startedAt === undefined ? null : Math.max(0, now() - pending.startedAt);
        this.onDiagnosticEvent('tiled-lod-preload-ready', this.diagnosticEventDetails({
          fromLevel: pending.fromLevel,
          toLevel: pending.toLevel,
          preloadDurationMs
        }));
        this.pendingLod = null;
        this.lodTransition = {
          fromLevel: pending.fromLevel,
          toLevel: pending.toLevel,
          start: now(),
          rawProgress: 0
        };
        this.onDiagnosticEvent('tiled-lod-transition-start', this.diagnosticEventDetails({
          fromLevel: pending.fromLevel,
          toLevel: pending.toLevel,
          progress: 0,
          preloadDurationMs
        }));
        this.onTiming(`tiled-rain-lod-transition-start-${pending.fromLevel}-${pending.toLevel}`);
        this.requestState();
      } else if (!this.committedFrame || this.requestedFrame.frame0 !== this.committedFrame.frame0
        || this.requestedFrame.frame1 !== this.committedFrame.frame1 || this.requestedFrame.progress !== this.committedFrame.progress) {
        this.commitFrame(this.requestedFrame);
      }
      this.map?.triggerRepaint();
    }).catch((error) => {
      if (generation !== this.requestGeneration || error?.name === 'AbortError') return;
      this.store.diagnosticsState.lastError = error instanceof Error ? error.message : String(error);
    });
  }

  blockKeysForFrame(frame, tileKeys, level = this.stableLevel) {
    const blockA = Math.floor(frame.frame0 / this.store.manifest.temporal_block_size);
    const blockB = Math.floor(frame.frame1 / this.store.manifest.temporal_block_size);
    return new Set(tileKeys.flatMap((tileKey) => [blockA, blockB]
      .filter((block, index, values) => values.indexOf(block) === index)
      .map((block) => qualifiedBlockKey(level, tileKey, block, this.store.multiLod))));
  }

  allBlocksReady(keys) {
    return [...keys].every((key) => this.store.blocks.get(key)?.status === 'ready');
  }

  allMotionTilesReady(keys) {
    return [...keys].every((key) => this.store.motionTilesState?.get(key)?.status === 'ready');
  }

  canRenderFrame(frame) {
    if (this.store.multiLod) {
      const levels = this.lodTransition ? [this.lodTransition.fromLevel, this.lodTransition.toLevel] : [this.stableLevel];
      return levels.every((level) => this.allBlocksReady(this.blockKeysForFrame(frame, this.tileKeysForBounds(this.viewportBounds, level), level)));
    }
    return this.allBlocksReady(this.blockKeysForFrame(frame, this.viewportTileKeys))
      && this.allMotionTilesReady(this.store.motionWarp ? new Set(this.viewportTileKeys) : new Set());
  }

  commitFrame(frame) {
    // Invalidate an older completion that may have raced a same-block direct
    // commit. The committed pair is always complete for the current viewport.
    this.requestGeneration++;
    this.committedFrame = frame;
    const targetKeys = this.store.multiLod
      ? new Set([...(this.lodTransition ? [this.lodTransition.fromLevel, this.lodTransition.toLevel] : [this.stableLevel])]
        .flatMap((level) => this.blockKeysForFrame(frame, this.tileKeysForBounds(this.viewportBounds, level), level)))
      : this.blockKeysForFrame(frame, this.viewportTileKeys);
    this.desiredBlockKeys = targetKeys;
    this.store.setProtectedBlockKeys(targetKeys);
    this.store.updateDesiredBlockKeys(targetKeys, this.store.motionWarp ? new Set(this.viewportTileKeys) : new Set());
    this.store.evict(targetKeys);
    this.map?.triggerRepaint();
    this.onCommit(this.committedFrame);
  }

  setActive(active) {
    this.active = Boolean(active);
    this.map?.triggerRepaint();
  }

  setPresentationMode(mode) {
    if (mode !== 'dots' && mode !== 'squares') return;
    if (this.presentationMode === mode) return;
    this.presentationMode = mode;
    this.map?.triggerRepaint();
  }

  setHazardsVisible(visible) {
    this.hazardsVisible = Boolean(visible);
    if (this.active) this.map?.triggerRepaint();
  }

  updateWeather(time) {
    this.setTime(time);
  }

  programsFor(gl, shaderData) {
    const cacheKey = tiledRainProgramCacheKey({
      motionWarp: this.store.motionWarp,
      motionWarpDebugMode: this.store.motionWarpDebugMode,
      aggregateSummary: this.store.aggregateSummary,
      lodLevel: this.store.lodLevel,
      gridSize: this.store.gridSize,
      variantName: shaderData.variantName,
      presentationMode: this.presentationMode,
      hazardsAvailable: this.hazardsAvailable
    });
    let program = this.programs.get(cacheKey);
    if (!program) {
      program = makeProgram(gl, shaderData, this.store.motionWarp, this.store.motionWarpDebugMode, this.hazardsAvailable, this.presentationMode, this.store.aggregateSummary, this.store.gridSize);
      this.programs.set(cacheKey, program);
    }
    return program;
  }

  transitionProgramsFor(gl, shaderData, lowerLevel, fineLevel, hazardsAvailable) {
    const lower = this.store.levelData(lowerLevel);
    const fine = this.store.levelData(fineLevel);
    const lowerGridSize = lower.grid?.grid_size ?? lower.grid_size;
    const fineGridSize = fine.grid?.grid_size ?? fine.grid_size;
    const cacheKey = ['dots-split-merge', shaderData.variantName, lowerLevel, fineLevel, lower.kind, fine.kind, hazardsAvailable ? 'hazards' : 'rain-only'].join(':');
    let program = this.programs.get(cacheKey);
    if (!program) {
      program = makeDotsTransitionProgram(gl, shaderData, lower.kind === 'aggregate-summary', fine.kind === 'aggregate-summary', hazardsAvailable, lowerGridSize, fineGridSize);
      this.programs.set(cacheKey, program);
    }
    return program;
  }

  transitionHazardsAvailable() {
    if (!this.lodTransition) return this.hazardsAvailable;
    return [this.lodTransition.fromLevel, this.lodTransition.toLevel]
      .some((level) => this.store.levelData(level).hasHazardPayload === true);
  }

  bindTransitionEndpoint(gl, locations, prefix, blockA, blockB, aggregate, textureUnit) {
    const set = (name, value) => gl.uniform1i(locations[`${prefix}${name}`], value);
    set('FrameLayerA', this.committedFrame.frame0 - blockA.descriptor.frame_start);
    set('FrameLayerB', this.committedFrame.frame1 - blockB.descriptor.frame_start);
    const bind = (unit, texture) => {
      gl.activeTexture(gl.TEXTURE0 + unit);
      gl.bindTexture(gl.TEXTURE_2D_ARRAY, texture);
    };
    if (aggregate) {
      set('SummaryA', textureUnit); set('SummaryB', textureUnit + 1); set('HazardA', textureUnit + 2); set('HazardB', textureUnit + 3);
      set('HazardAvailableA', blockA.payloads?.secondary ? 1 : 0); set('HazardAvailableB', blockB.payloads?.secondary ? 1 : 0);
      bind(textureUnit, blockA.gpuTexture || this.store.uploadBlock(gl, blockA));
      bind(textureUnit + 1, blockB.gpuTexture || this.store.uploadBlock(gl, blockB));
      bind(textureUnit + 2, blockA.summaryTexture || this.store.uploadSummaryBlock(gl, blockA) || this.store.zeroSummaryTexture(gl));
      bind(textureUnit + 3, blockB.summaryTexture || this.store.uploadSummaryBlock(gl, blockB) || this.store.zeroSummaryTexture(gl));
      // Summary-B uploads may have used the last primary endpoint unit.
      bind(textureUnit, blockA.gpuTexture);
      bind(textureUnit + 1, blockB.gpuTexture);
      return textureUnit + 4;
    }
    set('RainA', textureUnit); set('RainB', textureUnit + 1);
    gl.uniform1f(locations[`${prefix}PhysicalMaxMmh`], this.store.levelData(blockA.level).encoding.rain.physical_max_mmh);
    bind(textureUnit, blockA.gpuTexture || this.store.uploadBlock(gl, blockA));
    bind(textureUnit + 1, blockB.gpuTexture || this.store.uploadBlock(gl, blockB));
    const hazardBindings = [['StormA', blockA, 'storm'], ['StormB', blockB, 'storm'], ['HailA', blockA, 'hail'], ['HailB', blockB, 'hail']];
    for (let index = 0; index < hazardBindings.length; index++) {
      const [name, block, channel] = hazardBindings[index];
      const texture = this.store.uploadHazardBlock(gl, block, channel);
      set(name, textureUnit + 2 + index);
      set(`${name.replace(/[AB]$/, 'Available')}${name.at(-1)}`, texture ? 1 : 0);
      bind(textureUnit + 2 + index, texture || this.store.zeroHazardTexture(gl));
    }
    // First-time hazard uploads bind their source texture on the currently
    // active rain unit. Restore both integer endpoint bindings before draw.
    bind(textureUnit, blockA.gpuTexture);
    bind(textureUnit + 1, blockB.gpuTexture);
    return textureUnit + 6;
  }

  renderDotsTransition(gl, args, modes) {
    const transition = this.lodTransition;
    const lowerLevel = Math.min(transition.fromLevel, transition.toLevel);
    const fineLevel = Math.max(transition.fromLevel, transition.toLevel);
    const lower = this.store.levelData(lowerLevel);
    const fine = this.store.levelData(fineLevel);
    const lowerAggregate = lower.kind === 'aggregate-summary';
    const fineAggregate = fine.kind === 'aggregate-summary';
    const hazardsAvailable = this.transitionHazardsAvailable();
    const program = this.transitionProgramsFor(gl, args.shaderData, lowerLevel, fineLevel, hazardsAvailable);
    const fineGridSize = fine.grid?.grid_size ?? fine.grid_size;
    const blockAIndex = Math.floor(this.committedFrame.frame0 / this.store.manifest.temporal_block_size);
    const blockBIndex = Math.floor(this.committedFrame.frame1 / this.store.manifest.temporal_block_size);
    const fineTiles = this.tileKeysForBounds(this.viewportBounds, fineLevel);
    const renderable = [];
    for (const fineKey of fineTiles) {
      const fineTile = this.store.tilesByLevel.get(fineLevel)?.get(fineKey);
      const coarseCoordinates = tiledRainCoarseTileForFineTile(fineTile?.x, fineTile?.y);
      const coarseKey = `${coarseCoordinates.x}:${coarseCoordinates.y}`;
      const coarseTile = this.store.tilesByLevel.get(lowerLevel)?.get(coarseKey);
      const fineA = this.store.blocks.get(qualifiedBlockKey(fineLevel, fineKey, blockAIndex, true));
      const fineB = this.store.blocks.get(qualifiedBlockKey(fineLevel, fineKey, blockBIndex, true));
      const coarseA = this.store.blocks.get(qualifiedBlockKey(lowerLevel, coarseKey, blockAIndex, true));
      const coarseB = this.store.blocks.get(qualifiedBlockKey(lowerLevel, coarseKey, blockBIndex, true));
      if (fineTile && coarseTile && fineA?.status === 'ready' && fineB?.status === 'ready' && coarseA?.status === 'ready' && coarseB?.status === 'ready') {
        renderable.push({ fineTile, coarseTile, fineA, fineB, coarseA, coarseB });
      }
    }
    const eased = smoothstep(0, 1, transition.rawProgress);
    const refineProgress = transition.toLevel > transition.fromLevel ? eased : 1 - eased;
    for (const mode of modes) {
      for (const item of renderable) {
        const { locations } = program;
        gl.useProgram(program.program);
        setGeographicProjection(gl, locations, args.defaultProjectionData);
        gl.uniform2f(locations.fineTileOrigin, item.fineTile.x * TILED_RAIN_TILE_SIZE / fineGridSize, item.fineTile.y * TILED_RAIN_TILE_SIZE / fineGridSize);
        gl.uniform2i(locations.coarseLocalBase, (item.fineTile.x & 1) * 64, (item.fineTile.y & 1) * 64);
        gl.uniform1f(locations.temporalProgress, this.committedFrame.progress);
        gl.uniform1f(locations.refineProgress, refineProgress);
        gl.uniform1i(locations.mode, mode);
        gl.uniform4fv(locations.color, COLORS[['rain', 'strong', 'storm', 'hail'][mode]]);
        let unit = this.bindTransitionEndpoint(gl, locations, 'coarse', item.coarseA, item.coarseB, lowerAggregate, 0);
        this.bindTransitionEndpoint(gl, locations, 'fine', item.fineA, item.fineB, fineAggregate, unit);
        const vertexBuffer = mode === 2 ? this.hazardVertexBuffers.storm : mode === 3 ? this.hazardVertexBuffers.hail : this.vertexBuffer;
        const vertexCount = mode === 2 ? STORM.length / 2 : mode === 3 ? HAIL.length / 2 : 6;
        gl.bindBuffer(gl.ARRAY_BUFFER, vertexBuffer);
        gl.enableVertexAttribArray(locations.vertex);
        gl.vertexAttribPointer(locations.vertex, 2, gl.FLOAT, false, 0, 0);
        gl.drawArraysInstanced(gl.TRIANGLES, 0, vertexCount, TILED_RAIN_TILE_SIZE * TILED_RAIN_TILE_SIZE);
      }
    }
    return renderable.length;
  }

  renderPass(gl, program, projection, tile, blockA, blockB, mode, opacity = 1) {
    const { locations } = program;
    gl.useProgram(program.program);
    setGeographicProjection(gl, locations, projection);
    gl.uniform2f(
      locations.tileOrigin,
      (tile.x * TILED_RAIN_TILE_SIZE) / this.store.gridSize,
      (tile.y * TILED_RAIN_TILE_SIZE) / this.store.gridSize
    );
    if (this.store.aggregateSummary) {
      gl.uniform1i(locations.summaryA, 0);
      gl.uniform1i(locations.summaryB, 1);
      gl.uniform1i(locations.hazardA, 2);
      gl.uniform1i(locations.hazardB, 3);
      gl.uniform1i(locations.hazardAvailableA, blockA.payloads?.secondary ? 1 : 0);
      gl.uniform1i(locations.hazardAvailableB, blockB.payloads?.secondary ? 1 : 0);
    } else {
      gl.uniform1i(locations.rainA, 0);
      gl.uniform1i(locations.rainB, 1);
    }
    gl.uniform1i(locations.frameLayerA, this.committedFrame.frame0 - blockA.descriptor.frame_start);
    gl.uniform1i(locations.frameLayerB, this.committedFrame.frame1 - blockB.descriptor.frame_start);
    if (this.store.motionWarp) {
      gl.uniform1i(locations.frameA, this.committedFrame.frame0);
      gl.uniform1i(locations.frameB, this.committedFrame.frame1);
      gl.uniform1i(locations.rainHalo, TILED_RAIN_WARP_HALO_SIZE);
      gl.uniform1i(locations.motionWarpActive, 1);
    }
    gl.uniform1f(locations.temporalProgress, this.committedFrame.progress);
    if (!this.store.aggregateSummary) gl.uniform1f(locations.physicalMaxMmh, this.store.physicalMaxMmh);
    if (this.presentationMode === 'squares') {
      gl.uniform1f(locations.opacity, opacity);
      gl.uniform1f(locations.hazardsVisible, this.hazardsVisible ? 1 : 0);
    } else {
      gl.uniform1f(locations.opacity, opacity);
      gl.uniform1i(locations.mode, mode);
      const type = ['rain', 'strong', 'storm', 'hail'][mode];
      gl.uniform4fv(locations.color, COLORS[type]);
    }
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D_ARRAY, blockA.gpuTexture || this.store.uploadBlock(gl, blockA));
    if (this.store.aggregateSummary) {
      gl.activeTexture(gl.TEXTURE1);
      gl.bindTexture(gl.TEXTURE_2D_ARRAY, blockB.gpuTexture || this.store.uploadBlock(gl, blockB));
      gl.activeTexture(gl.TEXTURE2);
      gl.bindTexture(gl.TEXTURE_2D_ARRAY, blockA.summaryTexture || this.store.uploadSummaryBlock(gl, blockA));
      gl.activeTexture(gl.TEXTURE3);
      gl.bindTexture(gl.TEXTURE_2D_ARRAY, blockB.summaryTexture || this.store.uploadSummaryBlock(gl, blockB));
    } else {
      gl.activeTexture(gl.TEXTURE1);
      gl.bindTexture(gl.TEXTURE_2D_ARRAY, blockB.gpuTexture || this.store.uploadBlock(gl, blockB));
    }
    if (!this.store.aggregateSummary && this.hazardsAvailable) {
      const hazardBindings = [
        ['stormA', blockA, 'storm', 2, 'stormAvailableA'],
        ['stormB', blockB, 'storm', 3, 'stormAvailableB'],
        ['hailA', blockA, 'hail', 4, 'hailAvailableA'],
        ['hailB', blockB, 'hail', 5, 'hailAvailableB']
      ];
      for (const [uniform, block, channel, textureUnit, availableUniform] of hazardBindings) {
        const texture = this.store.uploadHazardBlock(gl, block, channel);
        gl.uniform1i(locations[uniform], textureUnit);
        gl.uniform1i(locations[availableUniform], texture ? 1 : 0);
        gl.activeTexture(gl[`TEXTURE${textureUnit}`]);
        gl.bindTexture(gl.TEXTURE_2D_ARRAY, texture || this.store.zeroHazardTexture(gl));
      }
      // A first-time hazard upload binds on whichever texture unit was active.
      // Restore both integer rain endpoints after those uploads before drawing.
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D_ARRAY, blockA.gpuTexture);
      gl.activeTexture(gl.TEXTURE1);
      gl.bindTexture(gl.TEXTURE_2D_ARRAY, blockB.gpuTexture);
    }
    if (this.store.motionWarp) {
      const motionState = this.store.motionTilesState.get(`${tile.x}:${tile.y}`);
      gl.uniform1i(locations.motion, 2);
      gl.uniform1i(locations.motionInterval, Math.min(this.committedFrame.frame0, this.store.motionManifest.interval_count - 1));
      gl.uniform1i(locations.motionNodeSpacing, this.store.motionGrid.nodeSpacing);
      gl.uniform1i(locations.motionNodesPerTile, this.store.motionGrid.nodesPerTile);
      gl.activeTexture(gl.TEXTURE2);
      gl.bindTexture(gl.TEXTURE_2D, motionState.gpuTexture || this.store.uploadMotionTile(gl, motionState));
    }
    const vertexBuffer = this.presentationMode === 'squares'
      ? this.squareVertexBuffer
      : mode === 2 ? this.hazardVertexBuffers.storm : mode === 3 ? this.hazardVertexBuffers.hail : this.vertexBuffer;
    const vertexCount = this.presentationMode === 'squares'
      ? CELL_VERTICES.length / 2
      : mode === 2 ? STORM.length / 2 : mode === 3 ? HAIL.length / 2 : 6;
    gl.bindBuffer(gl.ARRAY_BUFFER, vertexBuffer);
    gl.enableVertexAttribArray(locations.vertex);
    gl.vertexAttribPointer(locations.vertex, 2, gl.FLOAT, false, 0, 0);
    gl.drawArraysInstanced(gl.TRIANGLES, 0, vertexCount, TILED_RAIN_TILE_SIZE * TILED_RAIN_TILE_SIZE);
  }

  renderLevel(gl, args, level, opacity, modes) {
    this.store.activateLevel(level);
    const tileKeys = this.tileKeysForBounds(this.viewportBounds, level);
    const blockAIndex = Math.floor(this.committedFrame.frame0 / this.store.manifest.temporal_block_size);
    const blockBIndex = Math.floor(this.committedFrame.frame1 / this.store.manifest.temporal_block_size);
    const renderableTiles = [];
    for (const tileKey of tileKeys) {
      const tile = this.store.tilesByLevel.get(Number(level))?.get(tileKey)
        || (!this.store.multiLod ? this.store.tiles.get(tileKey) : null);
      const blockA = this.store.blocks.get(qualifiedBlockKey(level, tileKey, blockAIndex, this.store.multiLod));
      const blockB = this.store.blocks.get(qualifiedBlockKey(level, tileKey, blockBIndex, this.store.multiLod));
      const motionTile = this.store.motionWarp ? this.store.motionTilesState?.get(tileKey) : null;
      if (!tile || blockA?.status !== 'ready' || blockB?.status !== 'ready'
        || (this.store.motionWarp && motionTile?.status !== 'ready')) continue;
      renderableTiles.push({ tile, blockA, blockB });
    }
    const program = this.programsFor(gl, args.shaderData);
    for (const mode of modes) {
      for (const { tile, blockA, blockB } of renderableTiles) {
        this.renderPass(gl, program, args.defaultProjectionData, tile, blockA, blockB, mode, opacity);
      }
    }
    return renderableTiles.length;
  }

  render(gl, args) {
    if (!this.active) return;
    if (!this.committedFrame) return;
    this.updateLodTransition(now());
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
    gl.enable(gl.DEPTH_TEST);
    gl.depthMask(false);
    const modes = this.presentationMode === 'squares' ? [0] : [0, 1, ...(this.hazardsAvailable && this.hazardsVisible ? [2, 3] : [])];
    const endpoints = this.store.multiLod && this.lodTransition
      ? [
        [this.lodTransition.fromLevel, 1 - smoothstep(0, 1, this.lodTransition.rawProgress)],
        [this.lodTransition.toLevel, smoothstep(0, 1, this.lodTransition.rawProgress)]
      ]
      : [[this.stableLevel, 1]];
    let rendered = 0;
    if (this.presentationMode === 'squares') {
      gl.enable(gl.POLYGON_OFFSET_FILL);
      gl.polygonOffset(-1, -1);
      for (const [level, opacity] of endpoints) rendered += this.renderLevel(gl, args, level, opacity, modes);
      gl.disable(gl.POLYGON_OFFSET_FILL);
    } else if (this.store.multiLod && this.lodTransition) {
      // One fine-grid representation procedurally samples both endpoints.
      // There is no independent endpoint-grid opacity fade for Dots.
      rendered += this.renderDotsTransition(gl, args, modes);
    } else {
      // Keep rain -> strong -> storm -> hail ordering across both complete
      // endpoint representations during a multi-LOD fade.
      for (const mode of modes) {
        for (const [level, opacity] of endpoints) rendered += this.renderLevel(gl, args, level, opacity, [mode]);
      }
    }
    this.store.activateLevel(this.stableLevel);
    gl.depthMask(true);
    if (rendered && !this.firstVisibleReported) {
      this.firstVisibleReported = true;
      this.store.diagnosticsState.firstTiledWeatherVisibleMs = now() - this.store.startedAt;
      this.onTiming('tiled-rain-first-weather-visible');
    }
  }

  diagnostics() {
    const frame = this.committedFrame || this.requestedFrame;
    const blockA = Math.floor(frame.frame0 / this.store.manifest.temporal_block_size);
    const blockB = Math.floor(frame.frame1 / this.store.manifest.temporal_block_size);
    const currentMotionInterval = this.store.motionWarp
      ? Math.min(frame.frame0, this.store.motionManifest.interval_count - 1)
      : null;
    return {
      ...this.store.diagnostics({
        visibleMotionTileKeys: this.viewportTileKeys,
        currentMotionInterval: currentMotionInterval ?? 0
      }),
      active: this.active,
      presentationMode: this.presentationMode,
      hazardsAvailable: this.hazardsAvailable,
      hazardsVisible: this.hazardsVisible,
      visibleTileCount: this.viewportTileKeys.length,
      currentSourceFramePair: [frame.frame0, frame.frame1],
      temporalProgress: frame.progress,
      requestedSourceFramePair: [this.requestedFrame.frame0, this.requestedFrame.frame1],
      requestedTemporalProgress: this.requestedFrame.progress,
      committedSourceFramePair: this.committedFrame ? [this.committedFrame.frame0, this.committedFrame.frame1] : null,
      temporalCommitPending: !this.committedFrame
        || this.requestedFrame.frame0 !== this.committedFrame.frame0
        || this.requestedFrame.frame1 !== this.committedFrame.frame1
        || this.requestedFrame.progress !== this.committedFrame.progress,
      currentTemporalBlocks: [blockA, blockB],
      endpointLevels: this.endpointDiagnostics(),
      lodLevel: this.stableLevel,
      stableLevel: this.stableLevel,
      desiredLevel: this.desiredLevel,
      lodTransition: this.lodTransition ? {
        fromLevel: this.lodTransition.fromLevel,
        toLevel: this.lodTransition.toLevel,
        progress: this.lodTransition.rawProgress,
        easedProgress: smoothstep(0, 1, this.lodTransition.rawProgress)
      } : null,
      lodPreloadPending: this.pendingLod ? {
        fromLevel: this.pendingLod.fromLevel,
        toLevel: this.pendingLod.toLevel,
        elapsedMs: Math.max(0, now() - this.pendingLod.startedAt)
      } : null,
      payloadKind: this.store.aggregateSummary ? 'aggregate-summary' : 'direct',
      payloadDtype: this.store.aggregateSummary ? 'Float16 RGBA summary textures' : 'UInt16 rain / UInt8 hazards',
      gridSize: this.store.gridSize,
      spacing: 1 / this.store.gridSize,
      tileSize: TILED_RAIN_TILE_SIZE,
      proceduralInstancesPerTile: TILED_RAIN_TILE_SIZE * TILED_RAIN_TILE_SIZE
    };
  }
}

// Compatibility alias for existing tiled-rain probes and callers.
export const TiledRainDotsLayer = TiledRainLayer;

export function beginTiledRainLoad(manifestUrl, { onTiming = null, motionWarp = false, motionWarpDebugMode = null, lodLevel = TILED_RAIN_LOD_LEVEL } = {}) {
  const timing = typeof onTiming === 'function' ? onTiming : () => {};
  const debugMode = motionWarp && motionWarpDebugMode === 'full' ? 'full' : null;
  const selectedLodLevel = motionWarp ? TILED_RAIN_LOD_LEVEL : selectTiledRainLod(lodLevel);
  const metadataReady = (motionWarp
    ? loadAndValidateWarpDataset(manifestUrl, timing)
    : loadAndValidateDataset(manifestUrl, timing, selectedLodLevel)).then((dataset) => {
    const store = new TiledRainTileStore({ ...dataset, motionWarpDebugMode: debugMode }, { onTiming: timing });
    return Object.freeze({
      isTiledRain: true,
      frameCount: dataset.manifest.frame_count,
      timestamps: dataset.manifest.timestamps,
      generationId: dataset.manifest.source_generation_id,
      hazardsAvailable: !dataset.isMotionWarp && dataset.manifest.hazardsAvailable === true,
      tileStore: store
    });
  });
  return {
    metadataReady,
    async loadSequence() {
      return metadataReady;
    },
    async prepareInitialPlaybackBuffer() {
      await metadataReady;
      return { frameIndices: [] };
    },
    setBackgroundPrefetchPaused() {},
    diagnostics() {
      return null;
    }
  };
}
