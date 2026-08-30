import { LOD_MORPH_SECONDS, LOOP_SECONDS } from './engine/config.js';
import { clamp, smoothstep } from './engine/math.js';
import { ACTIVE_REAL_WEATHER_METADATA_URL, beginActiveWeatherLoad, prepareGeographicSamplingGeometry, WEATHER_REGION } from './engine/geography.js';
import { residentSourceFrameIntervals } from './timeline-residency.js';
import {
  MAX_LOGICAL_SAMPLING_ZOOM,
  canonicalWindowFromMercatorBounds,
  canonicalWindowContains,
  canonicalWindowsEqual,
  GeographicLodTopology,
  lngLatToMercator,
  logicalZoomLatitudeAdjustment,
  lodRangeForStableLevel,
  rawZoomForLogicalSamplingZoom,
  zoomToMercatorGridLevel
} from './engine/geographic-lod.js';
import { GeographicDotsLayer } from './engine/geographic-dots-layer.js';
import { GeographicSquaresLayer } from './engine/geographic-squares-layer.js';
import { GeographicWeatherPyramid } from './engine/geographic-weather-pyramid.js';
import { GpuMotionReconstructor } from './engine/gpu-motion-reconstruction.js';
import { GpuTemporalTileReconstructor } from './engine/gpu-temporal-tile-reconstruction.js';
import { RawWeatherLayer } from './engine/raw-weather-layer.js';
import { geographicTemporalFrameAt, TEMPORAL_FRAME_COUNT } from './engine/geographic-layer-utils.js';
import { createRuntimeDiagnostics } from './runtime-diagnostics.js';
import { createRuntimeCadenceDiagnostics } from './runtime-cadence-diagnostics.js';

const applicationStartupAt = performance.now();
const startupTimings = Object.create(null);
function markStartup(name) {
  if (startupTimings[name] !== undefined) return startupTimings[name];
  const elapsedMs = performance.now() - applicationStartupAt;
  startupTimings[name] = elapsedMs;
  performance.mark(`dot-field:${name}`);
  console.info(`[dot-field startup] ${name}: ${elapsedMs.toFixed(1)}ms`);
  return elapsedMs;
}
window.__dotFieldStartup = { startedAt: applicationStartupAt, timings: startupTimings };
markStartup('app-module-start');

const MAX_SAMPLING_LATITUDE = 85;
const COMPACT_MAP_SHORT_SIDE = 680;
const COMPACT_MIN_ZOOM = 1.5;
const LARGE_MIN_ZOOM = 3.0;
const playPause = document.querySelector('#playPause');
const timeSlider = document.querySelector('#timeSlider');
const timelineResidency = document.querySelector('#timelineResidency');
const resetView = document.querySelector('#resetView');
const zoomIn = document.querySelector('#zoomIn');
const zoomOut = document.querySelector('#zoomOut');
const renderModeSelector = document.querySelector('#renderModeSelector');
const renderModeButtons = [...renderModeSelector.querySelectorAll('[data-render-mode]')];
const hazards = document.querySelector('#hazards');
const weatherTimestampValue = document.querySelector('#weatherTimestampValue');
const weatherTimezone = document.querySelector('#weatherTimezone');
const lodDiagnostics = document.querySelector('#lodDiagnostics');
const rawTooltip = document.querySelector('#rawTooltip');
const rawTooltipContent = document.querySelector('#rawTooltipContent');

const mapContainer = document.querySelector('#map');
const shortSide = Math.min(
  mapContainer.clientWidth,
  mapContainer.clientHeight
);

const initialMinZoom =
  shortSide <= COMPACT_MAP_SHORT_SIDE
    ? COMPACT_MIN_ZOOM
    : LARGE_MIN_ZOOM;

if (!window.maplibregl) throw new Error('MapLibre GL JS did not load.');

markStartup('weather-load-start');
let activeWeatherField = null;
let rawWeatherField = null;
let sourceFrameCount = 1;
let sourceTimestamps = [];
let timelineResidencyEnabled = false;
const gpuMotionExperimentEnabled = new URLSearchParams(window.location.search).get('gpuMotion') === '1';
const gpuMotionTilesExperimentEnabled = gpuMotionExperimentEnabled && new URLSearchParams(window.location.search).get('gpuMotionTiles') === '1';
const gpuWeatherExperimentEnabled = new URLSearchParams(window.location.search).get('gpuWeather') === '1';
const GPU_WEATHER_LEVEL = 14;
let gpuMotionReconstructor = null;
let gpuMotionTileReconstructor = null;
let gpuWeatherTileReconstructor = null;
let gpuWeatherGeometry = null;
let gpuWeatherLevelData = null;
let gpuWeatherUsingGpu = false;
let gpuWeatherFallbackReason = gpuWeatherExperimentEnabled ? 'not initialized' : null;
let gpuWeatherInitializationPromise = null;
let gpuWeatherInitializationGeneration = 0;
let gpuWeatherKeyframes = null;
const gpuWeatherTimelineStats = {
  temporalChanges: 0,
  sourceNetworkRequests: 0,
  sourceRainUploads: 0,
  sourceMotionUploads: 0,
  cpuWeatherSampleCount: 0,
  cpuMotionReconstructionSamples: 0,
  mappedBufferUploads: 0,
  lastUpdateMs: 0,
  rendererPairChanges: 0,
  physicalKeyframeReconstructionDraws: 0,
  reusedPhysicalKeyframes: 0,
  presentationUpdates: 0,
  repaintRequests: 0
};

function updateTimelineResidency(residentSourceFrameIndices = []) {
  const intervals = timelineResidencyEnabled
    ? residentSourceFrameIntervals(residentSourceFrameIndices, sourceFrameCount)
    : [];
  timelineResidency.replaceChildren(...intervals.map(({ start, end }) => {
    const segment = document.createElement('span');
    segment.className = 'timeline-residency-segment';
    segment.style.left = `${start * 100}%`;
    segment.style.width = `${(end - start) * 100}%`;
    return segment;
  }));
}

const temporalDiagnostic = new URLSearchParams(window.location.search).get('temporal') === 'linear' ? 'linear' : 'motion';
const weatherLoad = beginActiveWeatherLoad({ onTiming: markStartup, onResidencyChange: updateTimelineResidency, temporalMode: temporalDiagnostic });

async function loadMapTilerKey() {
  try {
    markStartup('maptiler-config-fetch-start');
    const response = await fetch('./config.local.json', { cache: 'no-store' });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const config = await response.json();
    if (typeof config.maptilerKey !== 'string' || !config.maptilerKey.trim()) throw new Error('maptilerKey is missing');
    markStartup('maptiler-config-fetch-complete');
    return config.maptilerKey.trim();
  } catch {
    console.error('MapTiler local configuration is missing or invalid. Expected config.local.json with a non-empty maptilerKey.');
    throw new Error('MapTiler local configuration is missing or invalid.');
  }
}

const mapTilerKeyPromise = loadMapTilerKey();
const mapTilerKey = await mapTilerKeyPromise;
const MAP_STYLE = `https://api.maptiler.com/maps/dataviz-v4-dark/style.json?key=${encodeURIComponent(mapTilerKey)}`;

const MAPTILER_GEOGRAPHIC_LABEL_IDS = [
  'Continent labels',
  'Country labels disputed',
  'Country labels',
  'State labels',
  'City labels',
  'Capital city labels',
  'Town labels',
  'Village labels',
  'Place labels'
];
const MAPTILER_ADMIN_BOUNDARY_IDS = ['Other border', 'Disputed border', 'Country border'];
const MAPTILER_WATER_LABEL_IDS = [
  'Ocean labels',
  'Bay labels (lines)',
  'Bay labels',
  'Strait labels',
  'Sea labels',
  'Sea labels (lines)',
  'Pond labels',
  'Lake labels'
];
const MAPTILER_WATER_WASH_ID = 'geographic-water-wash';
const MAPTILER_WATER_BOUNDARY_ID = 'geographic-water-boundaries';
const MAPTILER_WATER_TINT_ID = 'geographic-water-tint';
const REFERENCE_LATITUDE = WEATHER_REGION.center[1];
const INITIAL_RAW_MAX_ZOOM = rawZoomForLogicalSamplingZoom(
  MAX_LOGICAL_SAMPLING_ZOOM,
  REFERENCE_LATITUDE,
  REFERENCE_LATITUDE
);

markStartup('maplibre-constructor');
const map = new window.maplibregl.Map({
  container: 'map',
  style: MAP_STYLE,
  center: WEATHER_REGION.center,
  zoom: WEATHER_REGION.initialZoom,
  minZoom: initialMinZoom,
  maxZoom: INITIAL_RAW_MAX_ZOOM,
  maxPitch: 75,
  attributionControl: false,
  canvasContextAttributes: { antialias: true }
});
map.addControl(new window.maplibregl.AttributionControl({ compact: true }), 'top-right');

const state = {
  playing: false,
  time: 0,
  lastFrame: performance.now(),
  scrubbing: false,
  levelData: null,
  lod: { level: null, leafCount: 0 },
  desiredLevel: null,
  lodTransition: null,
  logicalSamplingZoom: WEATHER_REGION.initialZoom,
  camera: null,
  canonicalWindow: null,
  pendingCanonicalWindow: null,
  canonicalWindowRebuilds: 0,
  canonicalWindowRebuildLastMs: 0,
  canonicalWindowRebuildSamples: [],
  rawMaxZoom: INITIAL_RAW_MAX_ZOOM,
  resettingView: false,
  mapReady: false,
  styleReady: false,
  basemapReady: false,
  weatherReady: false,
  weatherQueued: false,
  playbackReady: false,
  playbackStalled: false,
  playbackPendingRequirementKey: null,
  playbackHorizonKey: null,
  renderMode: 'raw',
  hazardsVisible: true,
  rawFrameIndex: 0,
  rawTimeChanged: false
};
let geographicWeatherPyramid = null;
let weatherLayer = null;
let squaresLayer = null;
let rawLayer = null;
let geographicLayers = [];
const VALID_RENDER_MODES = new Set(['raw', 'dots', 'squares']);
let lastMapErrorSignature = '';
let weatherSequencePromise = null;
let basemapFallbackTimer = null;
let weatherRequestGeneration = 0;

const diagnosticsEnabled = new URLSearchParams(window.location.search).get('diagnostics') === '1';
const queryParameters = new URLSearchParams(window.location.search);
const cadenceEnabled = queryParameters.get('cadence') === '1';
const requestedPlaybackRate = Number(queryParameters.get('playbackRate'));
const diagnosticPlaybackRate = cadenceEnabled && Number.isFinite(requestedPlaybackRate) && requestedPlaybackRate > 0 && requestedPlaybackRate <= 1
  ? requestedPlaybackRate : 1;
const runtimeCadence = createRuntimeCadenceDiagnostics({ enabled: cadenceEnabled, playbackRate: diagnosticPlaybackRate });

function numericSummary(values) {
  if (!values.length) return { count: 0, lastMs: 0, meanMs: 0, p95Ms: 0, maxMs: 0 };
  const sorted = [...values].sort((left, right) => left - right);
  return {
    count: values.length,
    lastMs: values[values.length - 1],
    meanMs: values.reduce((total, value) => total + value, 0) / values.length,
    p95Ms: sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * 0.95) - 1)],
    maxMs: Math.max(...values)
  };
}

function diagnosticsEnvironment() {
  const canvas = map.getCanvas?.() || null;
  const gl = map.painter?.context?.gl || canvas?.getContext?.('webgl2') || canvas?.getContext?.('webgl') || null;
  const canvasRect = canvas?.getBoundingClientRect?.();
  const contextAttributes = gl?.getContextAttributes?.() || null;
  return {
    canvasElement: canvas,
    viewportCss: { width: window.innerWidth, height: window.innerHeight },
    devicePixelRatio: window.devicePixelRatio,
    mapCanvasCss: {
      width: canvasRect?.width || mapContainer.clientWidth,
      height: canvasRect?.height || mapContainer.clientHeight
    },
    mapCanvasBacking: { width: canvas?.width || null, height: canvas?.height || null },
    webglDrawingBuffer: { width: gl?.drawingBufferWidth || null, height: gl?.drawingBufferHeight || null },
    webglContextAttributes: contextAttributes ? {
      alpha: contextAttributes.alpha,
      antialias: contextAttributes.antialias,
      depth: contextAttributes.depth,
      failIfMajorPerformanceCaveat: contextAttributes.failIfMajorPerformanceCaveat,
      premultipliedAlpha: contextAttributes.premultipliedAlpha,
      preserveDrawingBuffer: contextAttributes.preserveDrawingBuffer,
      stencil: contextAttributes.stencil
    } : null,
    maxTextureSize: gl ? gl.getParameter(gl.MAX_TEXTURE_SIZE) : null,
    maxRenderbufferSize: gl ? gl.getParameter(gl.MAX_RENDERBUFFER_SIZE) : null
  };
}

function gpuWeatherRequestedAtCurrentLevel() {
  return gpuWeatherExperimentEnabled
    && state.lod.level === GPU_WEATHER_LEVEL
    && !state.lodTransition
    && (state.renderMode === 'dots' || state.renderMode === 'squares')
    && Boolean(activeWeatherField?.motion)
    && !gpuWeatherFallbackReason?.startsWith('GPU weather initialization failed');
}

function gpuWeatherGl() {
  return map.painter?.context?.gl || null;
}

function disableGpuWeatherPath(time = state.time / LOOP_SECONDS, reason = null) {
  if (weatherLayer?.gpuWeatherMode) weatherLayer.setGpuWeatherMode(false, time);
  if (squaresLayer?.gpuWeatherMode) squaresLayer.setGpuWeatherMode(false, time);
  gpuWeatherUsingGpu = false;
  gpuWeatherKeyframes = null;
  gpuWeatherInitializationGeneration += 1;
  if (reason) gpuWeatherFallbackReason = reason;
}

async function initializeGpuWeatherPath() {
  if (!gpuWeatherRequestedAtCurrentLevel() || !activeWeatherField) return null;
  const initializationGeneration = gpuWeatherInitializationGeneration;
  const levelData = state.levelData;
  const gl = gpuWeatherGl();
  if (!levelData || levelData.level !== GPU_WEATHER_LEVEL) return null;
  if (!gl) throw new Error('MapLibre WebGL2 context is unavailable.');
  const frame = activeWeatherField.prepareFrame(state.time / LOOP_SECONDS);
  if (gpuWeatherLevelData !== levelData) {
    gpuWeatherTileReconstructor?.destroy();
    gpuWeatherTileReconstructor = null;
    gpuWeatherGeometry = prepareGeographicSamplingGeometry(frame, levelData, null);
    gpuWeatherLevelData = levelData;
  }
  if (!gpuWeatherTileReconstructor) {
    gpuWeatherTileReconstructor = await GpuTemporalTileReconstructor.create({
      metadataUrl: ACTIVE_REAL_WEATHER_METADATA_URL,
      generationId: activeWeatherField.generationId,
      geometry: gpuWeatherGeometry,
      sequence: activeWeatherField,
      gl
    });
  }
  await gpuWeatherTileReconstructor.ensureResident();
  if (initializationGeneration !== gpuWeatherInitializationGeneration
    || state.levelData !== levelData || !gpuWeatherRequestedAtCurrentLevel()) return null;
  if (!gpuWeatherUsingGpu) {
    weatherLayer.setGpuWeatherMode(true, state.time / LOOP_SECONDS);
    squaresLayer.setGpuWeatherMode(true, state.time / LOOP_SECONDS);
    gpuWeatherUsingGpu = true;
    gpuWeatherFallbackReason = null;
  }
  const result = updateGpuWeatherTime(state.time / LOOP_SECONDS);
  return result;
}

function setGpuWeatherPresentation(frame, physicalA, physicalB) {
  const source = {
    textureA: physicalA.texture,
    textureB: physicalB.texture,
    progress: frame.progress,
    width: state.levelData.width,
    height: state.levelData.height,
    format: 'R16F',
    levelData: state.levelData,
    reconstructor: gpuWeatherTileReconstructor
  };
  weatherLayer.setGpuWeatherSource(source, { requestRepaint: false });
  squaresLayer.setGpuWeatherSource(source, { requestRepaint: false });
  gpuWeatherTimelineStats.presentationUpdates++;
  map.triggerRepaint();
  gpuWeatherTimelineStats.repaintRequests++;
  return source;
}

function updateGpuWeatherTime(normalizedTime) {
  if (!gpuWeatherRequestedAtCurrentLevel()) return false;
  if (!gpuWeatherUsingGpu || !gpuWeatherTileReconstructor?.layout) {
    if (!gpuWeatherInitializationPromise) {
      gpuWeatherInitializationPromise = initializeGpuWeatherPath().finally(() => {
        gpuWeatherInitializationPromise = null;
      });
    }
    void gpuWeatherInitializationPromise.then(() => {}).catch((error) => {
      disableGpuWeatherPath(normalizedTime, `GPU weather initialization failed: ${error instanceof Error ? error.message : String(error)}`);
      void requestWeatherTime(normalizedTime);
    });
    return true;
  }
  const started = performance.now();
  const frame = geographicTemporalFrameAt(normalizedTime);
  if (gpuWeatherKeyframes?.a.index === frame.index && gpuWeatherKeyframes?.b.index === frame.nextIndex) {
    gpuWeatherKeyframes.progress = frame.progress;
    gpuWeatherTimelineStats.temporalChanges++;
    gpuWeatherTimelineStats.lastUpdateMs = performance.now() - started;
    setGpuWeatherPresentation(frame, gpuWeatherKeyframes.a, gpuWeatherKeyframes.b);
    return gpuWeatherKeyframes;
  }
  const desired = [frame.index, frame.nextIndex];
  const previous = gpuWeatherKeyframes ? [gpuWeatherKeyframes.a, gpuWeatherKeyframes.b] : [];
  const next = [null, null];
  const usedSlots = new Set();
  for (let position = 0; position < desired.length; position++) {
    const reused = previous.find((entry) => entry.index === desired[position] && !usedSlots.has(entry.slot));
    if (!reused) continue;
    next[position] = reused;
    usedSlots.add(reused.slot);
    gpuWeatherTimelineStats.reusedPhysicalKeyframes++;
  }
  for (let position = 0; position < desired.length; position++) {
    if (position === 1 && desired[1] === desired[0]) {
      next[position] = next[0];
      gpuWeatherTimelineStats.reusedPhysicalKeyframes++;
      continue;
    }
    if (next[position]) continue;
    const slot = usedSlots.has(0) ? 1 : 0;
    const physicalFrame = activeWeatherField.prepareFrame(desired[position] / TEMPORAL_FRAME_COUNT);
    gpuWeatherTileReconstructor.update(physicalFrame, { measureGpu: diagnosticsEnabled, targetSlot: slot });
    next[position] = { index: desired[position], slot, texture: gpuWeatherTileReconstructor.outputs[slot] };
    usedSlots.add(slot);
    gpuWeatherTimelineStats.physicalKeyframeReconstructionDraws++;
  }
  gpuWeatherKeyframes = { a: next[0], b: next[1], progress: frame.progress };
  gpuWeatherTimelineStats.temporalChanges++;
  gpuWeatherTimelineStats.rendererPairChanges++;
  gpuWeatherTimelineStats.lastUpdateMs = performance.now() - started;
  return setGpuWeatherPresentation(frame, next[0], next[1]);
}

function gpuWeatherDiagnostics() {
  const tile = gpuWeatherTileReconstructor?.diagnostics() || null;
  return {
    enabled: gpuWeatherExperimentEnabled,
    active: gpuWeatherUsingGpu,
    path: gpuWeatherUsingGpu ? 'GPU weather experimental' : 'CPU reference',
    fallbackReason: gpuWeatherFallbackReason,
    supportedLod: GPU_WEATHER_LEVEL,
    currentTarget: gpuWeatherTileReconstructor ? {
      width: gpuWeatherTileReconstructor.width,
      height: gpuWeatherTileReconstructor.height,
      format: 'R16F',
      byteEstimate: gpuWeatherTileReconstructor.width * gpuWeatherTileReconstructor.height * 2,
      workingSetByteEstimate: gpuWeatherTileReconstructor.width * gpuWeatherTileReconstructor.height * 4
    } : null,
    reconstruction: gpuWeatherTileReconstructor ? {
      drawCount: tile.gpu.drawCount,
      latestGpuPassMs: tile.gpu.latestPassMs,
      mainThreadSubmissionMs: gpuWeatherTimelineStats.lastUpdateMs,
      keyframes: gpuWeatherKeyframes ? {
        a: gpuWeatherKeyframes.a.index,
        b: gpuWeatherKeyframes.b.index,
        progress: gpuWeatherKeyframes.progress
      } : null
    } : null,
    timeline: { ...gpuWeatherTimelineStats },
    residency: tile
  };
}

function diagnosticsSnapshot() {
  let source = weatherLoad.diagnostics();
  const raw = rawLayer?.diagnostics() || null;
  const dots = weatherLayer?.diagnostics() || null;
  const squares = squaresLayer?.diagnostics() || null;
  const pyramid = geographicWeatherPyramid?.snapshot() || null;
  const sourceResidentBytes = source?.residentSourceBytes || 0;
  const trackedCpuBytes = (raw?.totalCpuGeometryBytes || 0)
    + (dots?.cpuBytes || 0)
    + (squares?.cpuBytes || 0)
    + (pyramid?.knownTypedArrayBytes || 0);
  const estimatedGpuBufferBytes = (raw?.estimatedGpuBufferBytes || 0)
    + (dots?.estimatedGpuBufferBytes || 0)
    + (squares?.estimatedGpuBufferBytes || 0)
    + (dots?.gpuWeather?.currentFieldBytes || 0);
  if (source && raw) {
    const rawFrameIndex = raw.sourceFrameIndex;
    const sourceFrame = Number.isInteger(rawFrameIndex) ? activeWeatherField?.sourceFrames?.get?.(rawFrameIndex) : null;
    const rawFramePayload = raw?.sourceFramePayloadBytes || 0;
    source = {
      ...source,
      rawLayerExactFrameIndex: rawFrameIndex,
      rawLayerExactFrameBytes: rawFramePayload,
      rawLayerExactFrameOutsideCache: Number.isInteger(rawFrameIndex)
        && activeWeatherField?.isSourceFrameAvailable
        && !activeWeatherField.isSourceFrameAvailable(rawFrameIndex),
      rawExactFrameSharedSourcePayload: Boolean(sourceFrame && rawLayer?.field?.mmh === sourceFrame),
      rawExactFrameDuplicatePayload: Boolean(sourceFrame && rawLayer?.field?.mmh !== sourceFrame)
    };
  }
  let center = null;
  try {
    const point = map.getCenter();
    center = { longitude: point.lng, latitude: point.lat };
  } catch {
    // The initial map can briefly exist before its camera is ready.
  }
  return {
    state: {
      activeRenderMode: state.renderMode,
      playing: state.playing,
      scrubbing: state.scrubbing,
      normalizedAnimationTime: state.time / LOOP_SECONDS,
      rawFrameIndex: state.rawFrameIndex,
      playbackStalled: state.playbackStalled
    },
    camera: {
      center,
      rawZoom: map.getZoom?.() ?? null,
      logicalWeatherZoom: state.logicalSamplingZoom,
      pitch: map.getPitch?.() ?? null,
      bearing: map.getBearing?.() ?? null
    },
    lod: {
      stableLevel: state.lod.level,
      transition: state.lodTransition ? {
        fromLevel: state.lodTransition.fromLevel,
        toLevel: state.lodTransition.toLevel,
        progress: state.lodTransition.rawProgress
      } : null,
      leafCount: state.levelData?.count || 0
    },
    canonicalWindow: {
      rebuilds: state.canonicalWindowRebuilds,
      lastMs: state.canonicalWindowRebuildLastMs,
      timings: numericSummary(state.canonicalWindowRebuildSamples)
    },
    source,
    renderers: { raw, dots, squares },
    pyramid,
    gpuMotion: gpuMotionExperimentEnabled ? (gpuMotionTilesExperimentEnabled
      ? gpuMotionTileReconstructor?.diagnostics() || { active: false, reason: 'not initialized' }
      : gpuMotionReconstructor?.diagnostics() || { active: false, reason: 'not initialized' }) : null,
    gpuWeather: gpuWeatherExperimentEnabled ? gpuWeatherDiagnostics() : null,
    memory: {
      sourceResidentBytes,
      rawCpuGeometryBytes: raw?.totalCpuGeometryBytes || 0,
      trackedCpuBytes,
      estimatedGpuBufferBytes,
      experimentalTemporalSourceGpuBytes: gpuWeatherDiagnostics().residency?.temporalSourceGpuByteEstimate || 0,
      experimentalCurrentFieldGpuBytes: gpuWeatherDiagnostics().currentTarget?.byteEstimate || 0,
      representationGpuBytes: (dots?.estimatedGpuBufferBytes || 0) + (squares?.estimatedGpuBufferBytes || 0)
    }
  };
}

const runtimeDiagnostics = createRuntimeDiagnostics({
  enabled: diagnosticsEnabled,
  getSnapshot: diagnosticsSnapshot,
  getEnvironment: diagnosticsEnvironment
});
if (runtimeCadence) window.__dotFieldCadence = runtimeCadence;
const diagnosticsHud = runtimeDiagnostics?.attachHud(lodDiagnostics) || null;
if (runtimeDiagnostics) window.__dotFieldDiagnostics = runtimeDiagnostics;

for (const control of [...renderModeButtons, hazards, timeSlider, playPause]) control.disabled = true;

function activateWeatherField(field) {
  activeWeatherField = field;
  sourceFrameCount = Number.isInteger(field.frameCount) ? field.frameCount : 1;
  timelineResidencyEnabled = Number.isInteger(field.frameCount) && field.frameCount > 1;
  updateTimelineResidency(weatherLoad.diagnostics()?.residentSourceFrameIndices || []);
  rawWeatherField = typeof field.exactSourceFrameAt === 'function'
    ? field.exactSourceFrameAt(0)
    : field.rawFrame;
  sourceTimestamps = Array.isArray(field.timestamps) ? field.timestamps : [];
  rawLayer = new RawWeatherLayer(rawWeatherField);
  state.weatherReady = true;
  for (const control of [...renderModeButtons, hazards, timeSlider]) control.disabled = false;
  markStartup('first-weather-ready');
  tryInitializeWeatherLayer();
  if (field.frameCount === undefined) {
    state.playbackReady = true;
    markStartup('playback-ready');
    return;
  }
  markStartup('initial-playback-buffer-start');
  void weatherLoad.prepareInitialPlaybackBuffer().then(({ frameIndices } = {}) => {
    state.playbackReady = true;
    markStartup('initial-playback-buffer-ready');
    markStartup('playback-ready');
    window.__dotFieldStartup.initialPlaybackBufferFrames = frameIndices || [];
    if (state.renderMode !== 'raw') playPause.disabled = false;
  }).catch((error) => console.error('Unable to prepare the initial playback weather buffer.', error));
}

function startWeatherSequence(trigger) {
  if (weatherSequencePromise) return weatherSequencePromise;
  if (basemapFallbackTimer !== null) {
    window.clearTimeout(basemapFallbackTimer);
    basemapFallbackTimer = null;
  }
  markStartup(`first-source-frame-trigger-${trigger}`);
  markStartup('first-source-frame-request-start');
  weatherSequencePromise = weatherLoad.loadSequence();
  void weatherSequencePromise.then((field) => {
    markStartup('first-source-frame-ready');
    activateWeatherField(field);
  }).catch((error) => {
    console.error('Unable to load weather data.', error);
  });
  return weatherSequencePromise;
}

// Metadata may load ahead of the basemap. Generated real-weather assets are
// required; surface discovery failures immediately while keeping the first
// source-frame request gated by basemap readiness.
void weatherLoad.metadataReady.catch((error) => {
  console.error('Unable to load weather metadata.', error);
});

const TIMESTAMP_MONTHS = Object.freeze(['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']);
let displayUtcOffsetHours = Number(weatherTimezone.value);
let lastRenderedDisplayKey = null;

function providerTimestampParts(timestamp) {
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2})(?:\.(\d+))?)?/.exec(timestamp || '');
  if (!match) return null;
  return {
    year: Number(match[1]),
    month: Number(match[2]),
    day: Number(match[3]),
    hour: Number(match[4]),
    minute: Number(match[5]),
    second: Number(match[6] || 0),
    millisecond: Number((match[7] || '').slice(0, 3).padEnd(3, '0') || 0)
  };
}

function providerTimestampMilliseconds(timestamp) {
  const parts = providerTimestampParts(timestamp);
  if (parts) return Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute, parts.second, parts.millisecond);
  const parsed = Date.parse(timestamp || '');
  return Number.isFinite(parsed) ? parsed : null;
}

function utcOffsetLabel(offsetHours) {
  if (offsetHours === 0) return 'UTC';
  return `UTC${offsetHours > 0 ? '+' : '−'}${Math.abs(offsetHours)}`;
}

function formatDisplayTimestamp(milliseconds, offsetHours = displayUtcOffsetHours) {
  if (milliseconds === null) return '—';
  const date = new Date(milliseconds + offsetHours * 60 * 60 * 1000);
  return `${String(date.getUTCDate()).padStart(2, '0')} ${TIMESTAMP_MONTHS[date.getUTCMonth()]} ${String(date.getUTCHours()).padStart(2, '0')}:${String(date.getUTCMinutes()).padStart(2, '0')}`;
}

function updateTimestampDisplay(milliseconds) {
  const timestampMinute = milliseconds === null ? null : Math.floor(milliseconds / 60000);
  const displayKey = `${timestampMinute ?? 'empty'}:${displayUtcOffsetHours}`;
  if (displayKey === lastRenderedDisplayKey) return;
  weatherTimestampValue.textContent = `${formatDisplayTimestamp(milliseconds)} ${utcOffsetLabel(displayUtcOffsetHours)}`;
  lastRenderedDisplayKey = displayKey;
}

function sourceFrameIndexForNormalizedTime(normalizedTime) {
  if (sourceFrameCount <= 1) return 0;
  return Math.round(clamp(normalizedTime, 0, 1) * (sourceFrameCount - 1));
}

function normalizedTimeForSourceFrame(frameIndex) {
  return sourceFrameCount <= 1 ? 0 : frameIndex / (sourceFrameCount - 1);
}

function updateTimestamp() {
  if (!sourceTimestamps.length) {
    updateTimestampDisplay(null);
    return;
  }
  let timestampMilliseconds;
  if (state.renderMode === 'raw') {
    timestampMilliseconds = providerTimestampMilliseconds(sourceTimestamps[state.rawFrameIndex]);
  } else {
    const sourcePosition = clamp(state.time / LOOP_SECONDS, 0, 1) * (sourceTimestamps.length - 1);
    const frame0 = Math.floor(sourcePosition);
    const frame1 = Math.min(frame0 + 1, sourceTimestamps.length - 1);
    const progress = sourcePosition - frame0;
    const time0 = providerTimestampMilliseconds(sourceTimestamps[frame0]);
    const time1 = providerTimestampMilliseconds(sourceTimestamps[frame1]);
    timestampMilliseconds = time0 === null || time1 === null
      ? time0
      : time0 + (time1 - time0) * progress;
  }
  updateTimestampDisplay(timestampMilliseconds);
}

weatherTimezone.addEventListener('change', () => {
  displayUtcOffsetHours = Number(weatherTimezone.value);
  updateTimestamp();
});

function cameraState() {
  return {
    rawZoom: map.getZoom(),
    latitude: clamp(map.getCenter().lat, -MAX_SAMPLING_LATITUDE, MAX_SAMPLING_LATITUDE)
  };
}

function rebaseCamera() {
  state.camera = cameraState();
}

function visibleMercatorBounds() {
  const coordinates = [];
  const mapBounds = map.getBounds();
  if (mapBounds) {
    coordinates.push(
      [mapBounds.getWest(), mapBounds.getSouth()],
      [mapBounds.getWest(), mapBounds.getNorth()],
      [mapBounds.getEast(), mapBounds.getSouth()],
      [mapBounds.getEast(), mapBounds.getNorth()]
    );
  }

  // Globe bounds can be optimistic near the horizon under pitch or rotation.
  // Include a deterministic screen lattice so the envelope covers the visible
  // viewport even when the projected footprint is not rectangular in lng/lat.
  const columns = 4;
  const rows = 4;
  for (let row = 0; row <= rows; row++) {
    for (let column = 0; column <= columns; column++) {
      const point = map.unproject([
        mapContainer.clientWidth * column / columns,
        mapContainer.clientHeight * row / rows
      ]);
      if (point && Number.isFinite(point.lng) && Number.isFinite(point.lat)) coordinates.push([point.lng, point.lat]);
    }
  }

  const mercators = coordinates
    .filter(([longitude, latitude]) => Number.isFinite(longitude) && Number.isFinite(latitude))
    .map(([longitude, latitude]) => lngLatToMercator(longitude, latitude));
  if (!mercators.length) return null;
  return {
    minX: Math.min(...mercators.map(([x]) => x)),
    maxX: Math.max(...mercators.map(([x]) => x)),
    minY: Math.min(...mercators.map(([, y]) => y)),
    maxY: Math.max(...mercators.map(([, y]) => y))
  };
}

function applyCanonicalWindow(canonicalWindow) {
  if (canonicalWindowsEqual(canonicalWindow, state.canonicalWindow)) return false;
  if (state.lodTransition) {
    state.pendingCanonicalWindow = canonicalWindow;
    return false;
  }
  if (gpuWeatherUsingGpu) disableGpuWeatherPath(state.time / LOOP_SECONDS, 'viewport changed; rebuilding L14 GPU residency');
  const started = performance.now();
  if (!geographicWeatherPyramid.setCanonicalWindow(canonicalWindow)) {
    // The initial camera envelope may equal the fixed-support topology. Record
    // that resolved window even when no topology allocation was necessary.
    state.canonicalWindow = canonicalWindow;
    state.pendingCanonicalWindow = null;
    return false;
  }
  state.canonicalWindow = canonicalWindow;
  state.pendingCanonicalWindow = null;
  state.canonicalWindowRebuilds += 1;
  weatherLayer.setTopology(geographicWeatherPyramid.topology);
  squaresLayer.setTopology(geographicWeatherPyramid.topology);
  if (state.lod.level === null) return true;
  commitLevelData(state.lod.level, geographicWeatherPyramid.levelDataFor(state.lod.level));
  state.canonicalWindowRebuildLastMs = performance.now() - started;
  state.canonicalWindowRebuildSamples.push(state.canonicalWindowRebuildLastMs);
  if (state.canonicalWindowRebuildSamples.length > 120) state.canonicalWindowRebuildSamples.shift();
  runtimeDiagnostics?.recordEvent('canonical-window-replacement', {
    rebuildCount: state.canonicalWindowRebuilds,
    durationMs: state.canonicalWindowRebuildLastMs
  });
  updateLodDiagnostics();
  return true;
}

function applyStableTopologyRange(level) {
  const range = lodRangeForStableLevel(level);
  if (!geographicWeatherPyramid.setLevelRange(range)) return false;
  weatherLayer.setTopology(geographicWeatherPyramid.topology);
  squaresLayer.setTopology(geographicWeatherPyramid.topology);
  commitLevelData(level, geographicWeatherPyramid.levelDataFor(level));
  return true;
}

function updateCanonicalWindow() {
  if (!state.mapReady) return;
  const bounds = visibleMercatorBounds();
  if (!bounds) return;
  const candidate = canonicalWindowFromMercatorBounds(bounds);
  if (canonicalWindowsEqual(candidate, state.canonicalWindow)) {
    state.pendingCanonicalWindow = null;
    return;
  }
  if (canonicalWindowContains(state.canonicalWindow, candidate)) {
    state.pendingCanonicalWindow = null;
    return;
  }
  applyCanonicalWindow(candidate);
}

function updateLodDiagnostics() {
  const zoom = state.logicalSamplingZoom.toFixed(2);
  const transition = state.lodTransition;
  const level = transition
    ? `${transition.fromLevel} → ${transition.toLevel}`
    : state.lod.level === null ? '—' : state.lod.level;
  const value = `Zoom ${zoom} · LOD ${level}`;
  if (diagnosticsHud) diagnosticsHud.setBaseText(value);
  else lodDiagnostics.textContent = value;
  lodDiagnostics.dataset.windowRebuilds = String(state.canonicalWindowRebuilds);
}

function updateRawMapMaxZoom(latitude) {
  const nextRawMaxZoom = rawZoomForLogicalSamplingZoom(
    MAX_LOGICAL_SAMPLING_ZOOM,
    latitude,
    REFERENCE_LATITUDE
  );
  if (!Number.isFinite(nextRawMaxZoom) || Math.abs(nextRawMaxZoom - state.rawMaxZoom) < 1e-6) return;
  state.rawMaxZoom = nextRawMaxZoom;
  map.setMaxZoom(nextRawMaxZoom);
}

function updateLogicalSamplingZoom() {
  const next = cameraState();
  updateRawMapMaxZoom(next.latitude);
  if (state.resettingView) {
    state.camera = next;
    updateResetViewControl();
    updateLodDiagnostics();
    return;
  }
  const previous = state.camera;
  if (!previous) {
    state.camera = next;
    updateLodDiagnostics();
    return;
  }
  let delta = next.rawZoom - previous.rawZoom;
  delta -= logicalZoomLatitudeAdjustment(next.latitude, previous.latitude);
  if (Number.isFinite(delta)) {
    state.logicalSamplingZoom = Math.min(MAX_LOGICAL_SAMPLING_ZOOM, state.logicalSamplingZoom + delta);
  }
  state.camera = next;
  updateCanonicalWindow();
  rebuildSamples(zoomToMercatorGridLevel(state.logicalSamplingZoom));
  updateLodDiagnostics();
}

function commitLevelData(level, levelData) {
  if (level !== GPU_WEATHER_LEVEL && gpuWeatherUsingGpu) {
    disableGpuWeatherPath(state.time / LOOP_SECONDS, `CPU reference fallback outside L${GPU_WEATHER_LEVEL}`);
  }
  state.lod = { level };
  state.levelData = levelData;
  weatherLayer.setLevelData(levelData, state.time / LOOP_SECONDS);
  squaresLayer.setLevelData(levelData, state.time / LOOP_SECONDS);
  updateLodDiagnostics();
  if (level === GPU_WEATHER_LEVEL && gpuWeatherExperimentEnabled
    && (state.renderMode === 'dots' || state.renderMode === 'squares')) {
    void requestWeatherTime(state.time / LOOP_SECONDS);
  }
}

function installGpuWeatherExperiment() {
  if (!gpuWeatherExperimentEnabled || window.__dotFieldGpuWeather) return;
  window.__dotFieldGpuWeather = {
    diagnostics: gpuWeatherDiagnostics,
    async warmup(normalizedTime = state.time / LOOP_SECONDS) {
      if (!gpuWeatherRequestedAtCurrentLevel()) throw new Error('GPU weather is supported only for active stable L14 Dots/Squares.');
      return initializeGpuWeatherPath().then(() => updateGpuWeatherTime(normalizedTime));
    },
    update(normalizedTime = state.time / LOOP_SECONDS) {
      if (!gpuWeatherRequestedAtCurrentLevel()) throw new Error('GPU weather is supported only for active stable L14 Dots/Squares.');
      return updateGpuWeatherTime(normalizedTime);
    },
    async rapidScrub() {
      const results = [];
      for (const time of [0, 1, .3, .9, .1, .7]) {
        await this.warmup(time);
        results.push({ time, ...gpuWeatherDiagnostics() });
      }
      return results;
    }
  };
  console.info('GPU weather Dots/Squares experiment available at ?gpuWeather=1 (stable L14 only; CPU fallback elsewhere).');
}

// This is intentionally opt-in. It exercises the existing canonical L14
// geometry without changing Dots/Squares evaluation or their CPU fallback.
function installGpuMotionExperiment() {
  if (!gpuMotionExperimentEnabled || window.__dotFieldGpuMotion) return;
  if (gpuMotionTilesExperimentEnabled) {
    window.__dotFieldGpuMotion = {
      tiled: true,
      diagnostics() { return gpuMotionTileReconstructor?.diagnostics() || { active: false, reason: 'not initialized' }; },
      async run(normalizedTime = state.time / LOOP_SECONDS, { measureGpu = true } = {}) {
        if (!activeWeatherField?.motion) throw new Error('Motion weather assets are not available.');
        const frame = activeWeatherField.prepareFrame(normalizedTime);
        const levelData = new GeographicLodTopology(state.canonicalWindow, { minLevel: 13, maxLevel: 14 }).levels.get(14);
        const geometry = prepareGeographicSamplingGeometry(frame, levelData, gpuMotionTileReconstructor?.geometry || null);
        if (!gpuMotionTileReconstructor || gpuMotionTileReconstructor.geometry !== geometry) {
          gpuMotionTileReconstructor?.destroy();
          gpuMotionTileReconstructor = await GpuTemporalTileReconstructor.create({
            metadataUrl: ACTIVE_REAL_WEATHER_METADATA_URL,
            generationId: activeWeatherField.generationId,
            geometry,
            sequence: activeWeatherField
          });
        }
        await gpuMotionTileReconstructor.ensureResident();
        return gpuMotionTileReconstructor.update(frame, { measureGpu });
      },
      validate(normalizedTime = state.time / LOOP_SECONDS, options = {}) {
        return this.run(normalizedTime, { measureGpu: false }).then(() => gpuMotionTileReconstructor.validate(activeWeatherField.prepareFrame(normalizedTime), options));
      },
      readback() {
        if (!gpuMotionTileReconstructor) throw new Error('Tiled GPU reconstruction has not run yet.');
        return gpuMotionTileReconstructor.readback();
      },
      async rapidScrub() {
        const results = [];
        for (const time of [0, 1, .3, .9, .1, .7]) results.push({ time, ...(await this.run(time)) });
        return results;
      }
    };
    console.info('GPU temporal-tile residency experiment available at window.__dotFieldGpuMotion (experimental; CPU remains active).');
    return;
  }
  window.__dotFieldGpuMotion = {
    diagnostics() { return gpuMotionReconstructor?.diagnostics() || { active: false, reason: 'not initialized' }; },
    run(normalizedTime = state.time / LOOP_SECONDS, { measureGpu = true } = {}) {
      if (!activeWeatherField?.motion) throw new Error('Motion weather assets are not available.');
      const frame = activeWeatherField.prepareFrame(normalizedTime);
      for (const index of activeWeatherField.requiredSourceFrames(normalizedTime)) {
        if (!activeWeatherField.isSourceFrameAvailable(index)) throw new Error(`Source frame ${index} is not resident yet.`);
      }
      // The live display range can omit L14 at lower zooms. The experiment
      // owns a matching current-window L14 descriptor instead of changing
      // live renderer topology merely to benchmark it.
      const levelData = new GeographicLodTopology(state.canonicalWindow, { minLevel: 13, maxLevel: 14 }).levels.get(14);
      const geometry = prepareGeographicSamplingGeometry(frame, levelData, gpuMotionReconstructor?.geometry || null);
      if (!gpuMotionReconstructor || gpuMotionReconstructor.geometry !== geometry) {
        gpuMotionReconstructor?.destroy();
        const created = GpuMotionReconstructor.create({ sequence: activeWeatherField, geometry });
        if (!created.active) return { active: false, reason: created.reason };
        gpuMotionReconstructor = created.value;
      }
      return gpuMotionReconstructor.update(frame, { measureGpu });
    },
    validate(normalizedTime = state.time / LOOP_SECONDS, options = {}) {
      this.run(normalizedTime, { measureGpu: false });
      return gpuMotionReconstructor.validate(activeWeatherField.prepareFrame(normalizedTime), options);
    },
    readback() {
      if (!gpuMotionReconstructor) throw new Error('GPU reconstruction has not run yet.');
      return gpuMotionReconstructor.readback();
    },
    validateSuite() {
      const times = [0, 1 / 18, .5 / 18, .25, .347, .5, .777, 1];
      return times.map((time) => this.validate(time));
    },
    rapidScrub() {
      return [0, 1, .3, .9, .1, .7].map((time) => ({ time, ...this.run(time) }));
    }
  };
  console.info('GPU motion experiment available at window.__dotFieldGpuMotion (experimental; CPU remains active).');
}

function tryInitializeWeatherLayer() {
  if (state.mapReady || !state.styleReady || !state.weatherReady) return;
  const initialBounds = visibleMercatorBounds();
  if (!initialBounds) throw new Error('Initial camera bounds are unavailable for weather topology initialization.');
  const initialLevel = zoomToMercatorGridLevel(state.logicalSamplingZoom);
  const initialWindow = canonicalWindowFromMercatorBounds(initialBounds);
  geographicWeatherPyramid = new GeographicWeatherPyramid(
    Float32Array,
    new GeographicLodTopology(initialWindow, lodRangeForStableLevel(initialLevel))
  );
  weatherLayer = new GeographicDotsLayer(geographicWeatherPyramid);
  squaresLayer = new GeographicSquaresLayer(geographicWeatherPyramid);
  geographicLayers = [rawLayer, squaresLayer, weatherLayer];
  state.canonicalWindow = initialWindow;
  const styleLayers = map.getStyle().layers || [];
  const firstSymbol = styleLayers.find((layer) => layer.type === 'symbol');
  for (const layer of geographicLayers) {
    if (!map.getLayer(layer.id)) map.addLayer(layer, firstSymbol?.id);
  }

  const waterLayer = styleLayers.find((layer) => layer.id === 'Water' && layer.type === 'fill');
  if (map.getLayer(MAPTILER_WATER_WASH_ID)) map.removeLayer(MAPTILER_WATER_WASH_ID);

  const nativeWaterShadow = styleLayers.find((layer) => layer.id === 'Water shadow');
  if (nativeWaterShadow && map.getLayer(nativeWaterShadow.id)) {
    map.setLayoutProperty(nativeWaterShadow.id, 'visibility', 'none');
  }

  if (waterLayer && !map.getLayer(MAPTILER_WATER_TINT_ID)) {
    try {
      map.addLayer({
        id: MAPTILER_WATER_TINT_ID,
        type: 'fill',
        source: waterLayer.source,
        'source-layer': waterLayer['source-layer'],
        ...(waterLayer.minzoom === undefined ? {} : { minzoom: waterLayer.minzoom }),
        ...(waterLayer.maxzoom === undefined ? {} : { maxzoom: waterLayer.maxzoom }),
        filter: waterLayer.filter,
        paint: {
          'fill-color': '#000000',
          'fill-opacity': 0.16,
          ...(waterLayer.paint?.['fill-translate'] === undefined ? {} : { 'fill-translate': waterLayer.paint['fill-translate'] }),
          ...(waterLayer.paint?.['fill-translate-anchor'] === undefined ? {} : { 'fill-translate-anchor': waterLayer.paint['fill-translate-anchor'] })
        }
      }, weatherLayer.id);
    } catch (error) {
      console.warn('MapTiler water-tint context is unavailable.', error instanceof Error ? error.message : error);
    }
  }

  if (waterLayer && !map.getLayer(MAPTILER_WATER_BOUNDARY_ID)) {
    try {
      map.addLayer({
        id: MAPTILER_WATER_BOUNDARY_ID,
        type: 'line',
        source: waterLayer.source,
        'source-layer': waterLayer['source-layer'],
        ...(waterLayer.minzoom === undefined ? {} : { minzoom: waterLayer.minzoom }),
        ...(waterLayer.maxzoom === undefined ? {} : { maxzoom: waterLayer.maxzoom }),
        filter: waterLayer.filter,
        paint: {
          'line-color': '#707070',
          'line-opacity': 0.75,
          'line-width': 1,
          'line-blur': 0,
          'line-offset': 0,
          ...(waterLayer.paint?.['fill-translate'] === undefined ? {} : { 'line-translate': waterLayer.paint['fill-translate'] }),
          ...(waterLayer.paint?.['fill-translate-anchor'] === undefined ? {} : { 'line-translate-anchor': waterLayer.paint['fill-translate-anchor'] })
        }
      }, weatherLayer.id);
    } catch (error) {
      console.warn('MapTiler water-boundary context is unavailable.', error instanceof Error ? error.message : error);
    }
  }

  const regionalBoundaryLayer = styleLayers.find((layer) => layer.id === 'Other border');
  if (regionalBoundaryLayer && map.getLayer(regionalBoundaryLayer.id)) {
    map.setLayerZoomRange(regionalBoundaryLayer.id, regionalBoundaryLayer.minzoom ?? 0, 24);
  }

  const upperContextIds = new Set([
    ...MAPTILER_WATER_LABEL_IDS,
    ...MAPTILER_ADMIN_BOUNDARY_IDS,
    ...MAPTILER_GEOGRAPHIC_LABEL_IDS
  ]);
  const symbolIds = (map.getStyle().layers || [])
    .filter((layer) => layer.type === 'symbol' && !upperContextIds.has(layer.id))
    .map((layer) => layer.id);
  for (const id of symbolIds) {
    if (map.getLayer(id) && map.getLayer(weatherLayer.id)) map.moveLayer(id, weatherLayer.id);
  }

  const upperOrder = [
    MAPTILER_WATER_TINT_ID,
    MAPTILER_WATER_BOUNDARY_ID,
    ...MAPTILER_ADMIN_BOUNDARY_IDS,
    ...MAPTILER_WATER_LABEL_IDS,
    ...MAPTILER_GEOGRAPHIC_LABEL_IDS
  ];
  for (const id of upperOrder) {
    if (map.getLayer(id)) map.moveLayer(id);
  }

  if (map.getLayer(rawLayer.id) && map.getLayer(MAPTILER_WATER_BOUNDARY_ID)) {
    map.moveLayer(rawLayer.id, MAPTILER_WATER_BOUNDARY_ID);
  }
  if (map.getLayer(MAPTILER_WATER_TINT_ID) && map.getLayer(rawLayer.id)) {
    map.moveLayer(MAPTILER_WATER_TINT_ID, rawLayer.id);
  }

  state.mapReady = true;
  applyRenderMode();
  rebaseCamera();
  rebuildSamples(initialLevel);
  markStartup('initial-weather-topology-ready');
  markStartup('first-weather-keyframe-evaluated');
  markStartup('first-renderer-instance-payload-ready');
  installGpuMotionExperiment();
  installGpuWeatherExperiment();
  map.triggerRepaint();
}

function startAdjacentTransition(level, now) {
  if (gpuWeatherUsingGpu) disableGpuWeatherPath(state.time / LOOP_SECONDS, `CPU reference fallback during LOD transition to L${level}`);
  const direction = Math.sign(level - state.lod.level);
  const toLevel = state.lod.level + direction;
  const toLevelData = geographicWeatherPyramid.levelDataFor(toLevel);
  state.lodTransition = {
    fromLevel: state.lod.level,
    toLevel,
    fromLevelData: state.levelData,
    toLevelData,
    start: now,
    rawProgress: 0
  };
  runtimeDiagnostics?.recordEvent('lod-transition-start', { fromLevel: state.lod.level, toLevel });
  weatherLayer.setTransition(state.levelData, toLevelData, state.time / LOOP_SECONDS, 0);
  squaresLayer.setTransition(state.levelData, toLevelData, state.time / LOOP_SECONDS, 0);
  updateLodDiagnostics();
  wakeApplicationFrame();
}

function rebuildSamples(level, now = performance.now()) {
  if (!state.mapReady) return;
  state.desiredLevel = level;
  if (state.lod.level === null) {
    commitLevelData(level, geographicWeatherPyramid.levelDataFor(level));
    return;
  }
  const transition = state.lodTransition;
  if (!transition) {
    if (state.lod.level !== level) startAdjacentTransition(level, now);
    return;
  }
  const direction = Math.sign(transition.toLevel - transition.fromLevel);
  if (level === transition.toLevel) return;
  if (level === transition.fromLevel || Math.sign(level - transition.toLevel) !== direction) {
    const rawProgress = 1 - transition.rawProgress;
    state.lodTransition = {
      fromLevel: transition.toLevel,
      toLevel: transition.fromLevel,
      fromLevelData: transition.toLevelData,
      toLevelData: transition.fromLevelData,
      start: now - rawProgress * LOD_MORPH_SECONDS * 1000,
      rawProgress
    };
    weatherLayer.setTransition(transition.toLevelData, transition.fromLevelData, state.time / LOOP_SECONDS, smoothstep(0, 1, rawProgress));
    squaresLayer.setTransition(transition.toLevelData, transition.fromLevelData, state.time / LOOP_SECONDS, smoothstep(0, 1, rawProgress));
    updateLodDiagnostics();
    wakeApplicationFrame();
  }
}

function updateLODTransition(now) {
  const transition = state.lodTransition;
  if (!transition) return;
  const rawProgress = clamp((now - transition.start) / (LOD_MORPH_SECONDS * 1000), 0, 1);
  transition.rawProgress = rawProgress;
  weatherLayer.setTransitionProgress(smoothstep(0, 1, rawProgress));
  squaresLayer.setTransitionProgress(smoothstep(0, 1, rawProgress));
  updateLodDiagnostics();
  if (rawProgress < 1) return;
  state.lodTransition = null;
  runtimeDiagnostics?.recordEvent('lod-transition-end', { level: transition.toLevel });
  commitLevelData(transition.toLevel, transition.toLevelData);
  if (state.pendingCanonicalWindow) {
    const pendingWindow = state.pendingCanonicalWindow;
    state.pendingCanonicalWindow = null;
    applyCanonicalWindow(pendingWindow);
  }
  applyStableTopologyRange(transition.toLevel);
  if (state.desiredLevel !== state.lod.level) startAdjacentTransition(state.desiredLevel, now);
}

function queueWeatherUpdate() {
  if (state.weatherQueued) return;
  state.weatherQueued = true;
  requestAnimationFrame(() => {
    state.weatherQueued = false;
    if (!state.mapReady || !activeWeatherField) return;
    const time = state.time / LOOP_SECONDS;
    if (state.renderMode === 'raw') return;
    requestWeatherTime(time, { playback: state.playing });
  });
}

function rendererTemporalRequirements(normalizedTime) {
  const rendererFrame = geographicTemporalFrameAt(normalizedTime);
  const nextRendererTime = rendererFrame.nextIndex / TEMPORAL_FRAME_COUNT;
  const times = [normalizedTime, nextRendererTime];
  const sourceFrames = activeWeatherField?.frameCount === undefined
    ? []
    : [...new Set(times.flatMap((time) => activeWeatherField.requiredSourceFrames(time)))];
  return { times, sourceFrames, key: sourceFrames.join(',') };
}

function rendererSourcesAreAvailable(requirements) {
  return gpuWeatherRequestedAtCurrentLevel()
    || activeWeatherField?.frameCount === undefined
    || requirements.sourceFrames.every((frameIndex) => activeWeatherField.isSourceFrameAvailable(frameIndex));
}

function renderCurrentWeather() {
  if (!state.mapReady || state.renderMode === 'raw') return;
  const started = performance.now();
  const gpuWeatherUpdated = gpuWeatherRequestedAtCurrentLevel();
  if (gpuWeatherUpdated) updateGpuWeatherTime(state.time / LOOP_SECONDS);
  else if (state.renderMode === 'dots') weatherLayer.updateWeather(state.time / LOOP_SECONDS);
  else if (state.renderMode === 'squares') squaresLayer.updateWeather(state.time / LOOP_SECONDS);
  runtimeCadence?.recordWeatherUpdate({
    prepared: true,
    committed: true,
    durationMs: performance.now() - started,
    logicalTime: state.time
  });
  if (!gpuWeatherUpdated) map.triggerRepaint();
}

function rebasePlaybackHorizon(normalizedTime, requirements) {
  if (!activeWeatherField || activeWeatherField.frameCount === undefined || requirements.key === state.playbackHorizonKey) return;
  state.playbackHorizonKey = requirements.key;
  void weatherLoad.rebaseRollingPrefetch(normalizedTime).catch((error) => {
    console.error('Unable to prefetch the rolling playback weather buffer.', error);
  });
}

function requestWeatherTime(normalizedTime, { playback = false } = {}) {
  if (!activeWeatherField) return Promise.resolve();
  if (gpuWeatherRequestedAtCurrentLevel()) {
    updateGpuWeatherTime(normalizedTime);
    return Promise.resolve({ status: 'gpu-weather' });
  }
  const requirements = rendererTemporalRequirements(normalizedTime);
  if (playback && rendererSourcesAreAvailable(requirements)) {
    rebasePlaybackHorizon(normalizedTime, requirements);
    renderCurrentWeather();
    return Promise.resolve();
  }
  const requestGeneration = ++weatherRequestGeneration;
  // Dots/Squares retain two adjacent 100 ms renderer keyframes. Resolve both
  // provider times as one coalesced HIGH source requirement before asking
  // either layer to evaluate. A manual scrub replaces only its older target.
  return weatherLoad.requestTimes(requirements.times, {
    priority: 'high',
    replaceKey: state.scrubbing ? 'manual-temporal-target' : playback ? 'playback-required' : null,
    latestTargetGeneration: requestGeneration
  }).then(({ result } = {}) => {
    if (result?.status === 'superseded') return result;
    if (requestGeneration !== weatherRequestGeneration || !state.mapReady || state.renderMode === 'raw') return result;
    runtimeCadence?.recordRequestCommit(requestGeneration);
    // Temporal reconstruction remains synchronous once the adjacent source
    // frames are present. A stale load cannot overwrite a newer timeline target.
    rebasePlaybackHorizon(state.time / LOOP_SECONDS, rendererTemporalRequirements(state.time / LOOP_SECONDS));
    renderCurrentWeather();
    return result;
  }).catch((error) => console.error('Unable to load requested weather time.', error));
}

function applyRenderMode() {
  if (!state.mapReady) return;
  const mode = state.renderMode;
  const time = state.time / LOOP_SECONDS;
  const rawActive = mode === 'raw';
  rawLayer.setActive(rawActive);
  rawLayer.setHazards(state.hazardsVisible);
  weatherLayer.setActive(mode === 'dots');
  weatherLayer.setHazardsVisible(state.hazardsVisible);
  squaresLayer.setActive(mode === 'squares');
  squaresLayer.setHazardsVisible(state.hazardsVisible);
  if (rawActive) {
    updateTimestamp();
    return;
  }
  if (mode === 'dots' || mode === 'squares') requestWeatherTime(time);
  updateTimestamp();
}

function setRawFrame(frameIndex, commitTime = false) {
  if (!activeWeatherField || !rawLayer) return;
  const nextFrameIndex = clamp(frameIndex, 0, sourceFrameCount - 1);
  state.rawFrameIndex = nextFrameIndex;
  timeSlider.value = String(normalizedTimeForSourceFrame(nextFrameIndex));
  if (commitTime) {
    state.time = normalizedTimeForSourceFrame(nextFrameIndex) * LOOP_SECONDS;
    state.rawTimeChanged = true;
  }
  updateTimestamp();
  const requestGeneration = ++weatherRequestGeneration;
  void weatherLoad.requestSourceFrame(nextFrameIndex, {
    priority: 'high',
    replaceKey: state.scrubbing ? 'manual-raw-target' : null,
    latestTargetGeneration: requestGeneration
  }).then(({ result } = {}) => {
    if (result?.status === 'superseded') return;
    if (requestGeneration !== weatherRequestGeneration || state.renderMode !== 'raw') return;
    const frame = typeof activeWeatherField.exactSourceFrameAt === 'function'
      ? activeWeatherField.exactSourceFrameAt(nextFrameIndex)
      : rawWeatherField;
    rawLayer.setFrame(frame);
    runtimeDiagnostics?.recordEvent('raw-source-frame-change', { frameIndex: nextFrameIndex });
    refreshHighlightedRawCell();
    void weatherLoad.rebaseRollingPrefetch(state.time / LOOP_SECONDS).catch((error) => {
      console.error('Unable to prefetch the RAW scrub weather neighborhood.', error);
    });
    map.triggerRepaint();
  }).catch((error) => console.error('Unable to load requested RAW weather frame.', error));
}

function setRenderMode(mode) {
  if (!VALID_RENDER_MODES.has(mode)) return;
  if (mode === state.renderMode) return;
  const enteringRaw = mode === 'raw';
  const leavingRaw = state.renderMode === 'raw' && !enteringRaw;
  if (enteringRaw) {
    if (state.playing) setPlaying(false);
    state.rawTimeChanged = false;
    setRawFrame(sourceFrameIndexForNormalizedTime(state.time / LOOP_SECONDS));
  }
  state.renderMode = mode;
  runtimeDiagnostics?.recordEvent('render-mode-change', { mode });
  renderModeSelector.dataset.mode = mode;
  if (leavingRaw) timeSlider.value = String(clamp(state.time / LOOP_SECONDS, 0, 1));
  if (leavingRaw) dismissRawTooltip();
  for (const button of renderModeButtons) {
    button.setAttribute('aria-checked', String(button.dataset.renderMode === mode));
  }
  playPause.disabled = mode === 'raw' || !state.playbackReady;
  playPause.setAttribute('aria-disabled', String(mode === 'raw' || !state.playbackReady));
  applyRenderMode();
}

let selectedRawCell = null;
let selectedRawCellKey = null;
let rawMapDragging = false;

function rawCellKey(cell) {
  return `${cell.longitudeIndex}:${cell.latitudeIndex}`;
}

function positionRawTooltip(point) {
  if (rawTooltip.hidden) return;
  const margin = 8;
  const maxLeft = Math.max(margin, mapContainer.clientWidth - rawTooltip.offsetWidth - margin);
  const maxTop = Math.max(margin, mapContainer.clientHeight - rawTooltip.offsetHeight - margin);
  rawTooltip.style.left = `${Math.min(point.x + 14, maxLeft)}px`;
  rawTooltip.style.top = `${Math.min(point.y + 14, maxTop)}px`;
}

function showRawTooltip(cell, point) {
  rawLayer.setHighlightedCell(cell);
  updateRawTooltipContent(cell);
  rawTooltip.hidden = false;
  positionRawTooltip(point);
}

function updateRawTooltipContent(cell) {
  rawTooltipContent.textContent = [
    `lon: ${cell.lon.toFixed(5)}`,
    `lat: ${cell.lat.toFixed(5)}`,
    `mmh: ${cell.mmh.toFixed(3)}`,
    `thunderstorm: ${cell.thunderstorm}`,
    `hail: ${cell.hail}`
  ].join('\n');
}

function refreshHighlightedRawCell() {
  if (!rawLayer) return;
  const cellKey = selectedRawCellKey || (rawLayer.highlightedCell && rawCellKey(rawLayer.highlightedCell));
  if (!cellKey) return;
  const [longitudeIndex, latitudeIndex] = cellKey.split(':').map(Number);
  const field = rawLayer.field;
  const cell = field.rawCellAt(field.longitudes[longitudeIndex], field.latitudes[latitudeIndex]);
  if (!cell) return dismissRawTooltip();
  if (selectedRawCellKey) selectedRawCell = cell;
  rawLayer.setHighlightedCell(cell);
  updateRawTooltipContent(cell);
}

function dismissRawTooltip() {
  selectedRawCell = null;
  selectedRawCellKey = null;
  rawLayer?.setHighlightedCell(null);
  rawTooltip.hidden = true;
}

function updateRawTooltipPosition() {
  if (state.renderMode !== 'raw' || !selectedRawCell) return;
  positionRawTooltip(map.project([selectedRawCell.lon, selectedRawCell.lat]));
}

function updateRawHover(event) {
  if (!rawLayer || state.renderMode !== 'raw' || selectedRawCell || rawMapDragging) return;
  const cell = rawLayer.field.rawCellAt(event.lngLat.lng, event.lngLat.lat);
  if (!cell) {
    dismissRawTooltip();
    return;
  }
  showRawTooltip(cell, event.point);
}

function selectRawCell(event) {
  if (!rawLayer || state.renderMode !== 'raw') return;
  if (selectedRawCell) return dismissRawTooltip();
  const cell = rawLayer.field.rawCellAt(event.lngLat.lng, event.lngLat.lat);
  if (!cell) return dismissRawTooltip();
  selectedRawCell = cell;
  selectedRawCellKey = rawCellKey(cell);
  showRawTooltip(cell, event.point);
}

function setPlaying(playing) {
  const nextPlaying = Boolean(playing) && state.renderMode !== 'raw' && state.playbackReady;
  state.playing = nextPlaying;
  runtimeDiagnostics?.recordEvent(nextPlaying ? 'play' : 'pause');
  state.playbackStalled = false;
  state.playbackPendingRequirementKey = null;
  playPause.disabled = state.renderMode === 'raw' || !state.playbackReady;
  playPause.setAttribute('aria-disabled', String(state.renderMode === 'raw' || !state.playbackReady));
  playPause.dataset.state = nextPlaying ? 'playing' : 'paused';
  playPause.setAttribute('aria-label', nextPlaying ? 'Pause' : 'Play');
  if (nextPlaying) {
    state.playbackHorizonKey = null;
    const normalizedTime = state.time / LOOP_SECONDS;
    rebasePlaybackHorizon(normalizedTime, rendererTemporalRequirements(normalizedTime));
    wakeApplicationFrame();
  }
}

function updateTimeFromTimelineValue(value) {
  const normalizedTime = clamp(Number(value), 0, 1);
  if (state.renderMode === 'raw') {
    setRawFrame(sourceFrameIndexForNormalizedTime(normalizedTime), true);
    return;
  }
  state.time = normalizedTime * LOOP_SECONDS;
  queueWeatherUpdate();
  updateTimestamp();
}

function updateTimelineFromPointer(clientX) {
  const rect = timeSlider.getBoundingClientRect();
  const min = Number(timeSlider.min);
  const max = Number(timeSlider.max);
  const value = clamp(min + (clientX - rect.left) / rect.width * (max - min), min, max);
  timeSlider.value = String(value);
  updateTimeFromTimelineValue(value);
}

let scrubbingPointerId = null;
playPause.addEventListener('click', () => {
  if (state.renderMode === 'raw') return;
  if (!state.playing && state.time >= LOOP_SECONDS) {
    state.time = 0;
    timeSlider.value = '0';
    queueWeatherUpdate();
  }
  setPlaying(!state.playing);
});
zoomIn.addEventListener('click', () => map.zoomIn());
zoomOut.addEventListener('click', () => map.zoomOut());
function resetMapView() {
  if (state.resettingView) return;
  state.resettingView = true;
  map.easeTo({
    center: WEATHER_REGION.center,
    zoom: WEATHER_REGION.initialZoom,
    bearing: 0,
    pitch: 0
  });
}
resetView.addEventListener('click', resetMapView);
for (const button of renderModeButtons) {
  button.addEventListener('click', () => setRenderMode(button.dataset.renderMode));
}
hazards.addEventListener('change', () => {
  state.hazardsVisible = hazards.checked;
  rawLayer.setHazards(state.hazardsVisible);
  weatherLayer?.setHazardsVisible(state.hazardsVisible);
  squaresLayer?.setHazardsVisible(state.hazardsVisible);
});
document.addEventListener('pointerdown', (event) => {
  if (!rawTooltip.hidden && !mapContainer.contains(event.target) && !rawTooltip.contains(event.target)) dismissRawTooltip();
});
document.addEventListener('keydown', (event) => {
  if (event.key === 'Escape') dismissRawTooltip();
});
function finishTimelineScrub(pointerId) {
  if (pointerId !== scrubbingPointerId) return;
  const activePointerId = scrubbingPointerId;
  scrubbingPointerId = null;
  state.scrubbing = false;
  runtimeDiagnostics?.recordEvent('scrub-end');
  if (timeSlider.hasPointerCapture(activePointerId)) timeSlider.releasePointerCapture(activePointerId);
}
timeSlider.addEventListener('pointerdown', (event) => {
  event.preventDefault();
  timeSlider.focus({ preventScroll: true });
  if (state.playing) setPlaying(false);
  state.scrubbing = true;
  runtimeDiagnostics?.recordEvent('scrub-start');
  scrubbingPointerId = event.pointerId;
  timeSlider.setPointerCapture(event.pointerId);
  updateTimelineFromPointer(event.clientX);
});
timeSlider.addEventListener('pointermove', (event) => {
  if (event.pointerId === scrubbingPointerId) updateTimelineFromPointer(event.clientX);
});
timeSlider.addEventListener('input', () => {
  updateTimeFromTimelineValue(timeSlider.value);
});
for (const eventName of ['pointerup', 'pointercancel', 'lostpointercapture']) {
  timeSlider.addEventListener(eventName, (event) => {
    finishTimelineScrub(event.pointerId);
  });
}

function markInitialBasemapVisible(trigger) {
  if (state.basemapReady) return;
  state.basemapReady = true;
  if (basemapFallbackTimer !== null) {
    window.clearTimeout(basemapFallbackTimer);
    basemapFallbackTimer = null;
  }
  markStartup(`initial-basemap-visible-${trigger}`);
  startWeatherSequence(`basemap-${trigger}`);
}

function observeInitialBasemapReadiness() {
  if (!state.styleReady || startupTimings['first-map-render-after-style'] === undefined || state.basemapReady) return;
  // In MapLibre GL JS 5.24.0, areTilesLoaded() reports whether the source
  // tiles required by the current viewport have loaded. Requiring a following
  // render avoids calling the pre-tile gray canvas a visible basemap; unlike
  // loaded()/idle it does not wait for unrelated future work.
  if (typeof map.areTilesLoaded === 'function' && map.areTilesLoaded()) {
    markInitialBasemapVisible('viewport-tiles');
  }
}

map.on('style.load', () => {
  markStartup('maplibre-style-load');
  if (!state.styleReady) map.setProjection({ type: 'globe' });
  state.styleReady = true;
  tryInitializeWeatherLayer();
  // MapLibre load is also observed below, but this bounded safety trigger
  // prevents an optional MapTiler resource from permanently suppressing the
  // weather request. It is not the normal basemap-visible criterion.
  basemapFallbackTimer = window.setTimeout(() => {
    basemapFallbackTimer = null;
    markStartup('initial-basemap-readiness-timeout');
    startWeatherSequence('readiness-timeout');
  }, 5000);
});
map.on('render', () => {
  runtimeDiagnostics?.recordRender();
  if (state.styleReady) markStartup('first-map-render-after-style');
  observeInitialBasemapReadiness();
  if (state.mapReady) markStartup('first-weather-layer-render');
});
map.on('sourcedata', (event) => {
  if (!state.styleReady || !event?.sourceId) return;
  markStartup('initial-map-source-data');
  if (event.isSourceLoaded) markStartup('initial-map-source-ready');
});
map.on('mousemove', updateRawHover);
map.on('click', selectRawCell);
map.on('dragstart', () => {
  runtimeDiagnostics?.recordEvent('drag-start');
  rawMapDragging = true;
  dismissRawTooltip();
});
map.on('dragend', () => {
  runtimeDiagnostics?.recordEvent('drag-end');
  rawMapDragging = false;
});
map.on('mouseout', () => {
  if (!selectedRawCell) dismissRawTooltip();
});
function updateResetViewControl() {
  const center = map.getCenter();
  const bearing = ((map.getBearing() + 180) % 360) - 180;
  const [initialLongitude, initialLatitude] = WEATHER_REGION.center;
  const differs = Math.abs(center.lng - initialLongitude) > 0.0001
    || Math.abs(center.lat - initialLatitude) > 0.0001
    || Math.abs(map.getZoom() - WEATHER_REGION.initialZoom) > 0.01
    || Math.abs(bearing) > 0.1
    || Math.abs(map.getPitch()) > 0.1;
  resetView.hidden = !differs;
}
map.on('move', updateLogicalSamplingZoom);
map.on('move', updateRawTooltipPosition);
map.on('move', updateResetViewControl);
map.on('rotate', updateResetViewControl);
map.on('pitch', updateResetViewControl);
map.on('movestart', () => {
  runtimeDiagnostics?.recordEvent('map-movestart');
  weatherLoad.setBackgroundPrefetchPaused(true);
});
map.on('moveend', () => {
  runtimeDiagnostics?.recordEvent('map-moveend');
  weatherLoad.setBackgroundPrefetchPaused(false);
  if (!state.resettingView) return;
  state.resettingView = false;
  state.logicalSamplingZoom = WEATHER_REGION.initialZoom;
  rebaseCamera();
  updateCanonicalWindow();
  rebuildSamples(zoomToMercatorGridLevel(state.logicalSamplingZoom));
  updateResetViewControl();
});
map.on('zoomstart', () => runtimeDiagnostics?.recordEvent('map-zoomstart'));
map.on('zoomend', () => runtimeDiagnostics?.recordEvent('map-zoomend'));
map.on('load', () => {
  markStartup('maplibre-load');
  markInitialBasemapVisible('map-load');
  updateResetViewControl();
});
map.on('error', (event) => {
  const error = event?.error;
  const details = [];
  if (event && 'sourceId' in event && event.sourceId) details.push(`source=${event.sourceId}`);
  if (event && 'tile' in event && event.tile) details.push('tile');
  const message = (error instanceof Error ? error.message : String(error || 'Unknown MapLibre error'))
    .replaceAll(mapTilerKey, '[redacted]');
  const signature = `${details.join('|')}|${message}`;
  if (signature === lastMapErrorSignature) return;
  lastMapErrorSignature = signature;
  const lowerMessage = message.toLowerCase();
  const category = event?.tile ? 'vector-tile'
    : event?.sourceId ? 'source/TileJSON'
      : lowerMessage.includes('sprite') ? 'sprite'
        : lowerMessage.includes('glyph') ? 'glyph'
          : lowerMessage.includes('style') ? 'style'
            : 'generic';
  console.error(`MapLibre ${category} error${details.length ? ` (${details.join(', ')})` : ''}: ${message}`);
});

let applicationFrameQueued = false;

// Deliberately diagnostic-only: this keeps scheduler counters available to
// focused benchmarks without adding a visible per-pointer UI update path.
window.__dotFieldWeatherDiagnostics = () => weatherLoad.diagnostics();

function wakeApplicationFrame() {
  if (applicationFrameQueued) return;
  state.lastFrame = performance.now();
  applicationFrameQueued = true;
  requestAnimationFrame(frame);
}

function waitForPlaybackRequirements(normalizedTime) {
  const requirements = rendererTemporalRequirements(normalizedTime);
  if (state.playbackPendingRequirementKey === requirements.key) return;
  state.playbackStalled = true;
  state.playbackPendingRequirementKey = requirements.key;
  const requestGeneration = ++weatherRequestGeneration;
  void weatherLoad.requestTimes(requirements.times, {
    priority: 'high',
    replaceKey: 'playback-required',
    latestTargetGeneration: requestGeneration
  }).then(({ result } = {}) => {
    if (result?.status === 'superseded') return;
    if (requestGeneration !== weatherRequestGeneration || !state.playing || state.scrubbing) return;
    state.playbackStalled = false;
    state.playbackPendingRequirementKey = null;
    rebasePlaybackHorizon(normalizedTime, requirements);
    wakeApplicationFrame();
  }).catch((error) => {
    if (requestGeneration !== weatherRequestGeneration) return;
    state.playbackStalled = false;
    state.playbackPendingRequirementKey = null;
    if (state.playing) setPlaying(false);
    console.error('Unable to load required playback weather frames.', error);
  });
}

function frame(now) {
  applicationFrameQueued = false;
  const delta = Math.min((now - state.lastFrame) / 1000, 0.1) * diagnosticPlaybackRate;
  state.lastFrame = now;
  let reachedEndpoint = false;
  if (state.playing && !state.scrubbing) {
    const nextTime = Math.min(state.time + delta, LOOP_SECONDS);
    const requirements = rendererTemporalRequirements(nextTime / LOOP_SECONDS);
    if (rendererSourcesAreAvailable(requirements)) {
      state.playbackStalled = false;
      state.playbackPendingRequirementKey = null;
      state.time = nextTime;
      rebasePlaybackHorizon(state.time / LOOP_SECONDS, requirements);
      reachedEndpoint = state.time === LOOP_SECONDS;
    } else {
      waitForPlaybackRequirements(nextTime / LOOP_SECONDS);
    }
  }
  // A paused static layer has no temporal uniform to advance. Leaving its
  // repaint scheduling to MapLibre prevents the application RAF from keeping
  // an otherwise idle map rendering continuously.
  if (state.mapReady && (state.playing || reachedEndpoint) && !state.scrubbing && !state.playbackStalled) {
    const normalizedTime = state.time / LOOP_SECONDS;
    if (state.renderMode === 'raw') {
      updateRawTooltipPosition();
    } else if (state.renderMode === 'dots') queueWeatherUpdate();
    else if (state.renderMode === 'squares') queueWeatherUpdate();
  }
  if (reachedEndpoint) setPlaying(false);
  updateLODTransition(now);
  if (!state.scrubbing) {
    timeSlider.value = state.renderMode === 'raw'
      ? String(normalizedTimeForSourceFrame(state.rawFrameIndex))
      : String(state.time / LOOP_SECONDS);
  }
  const temporalFrame = geographicTemporalFrameAt(state.time / LOOP_SECONDS);
  runtimeCadence?.recordFrame(now, {
    logicalTime: state.time,
    interval: temporalFrame.index,
    progress: temporalFrame.progress,
    lod: state.lod.level,
    renderMode: state.renderMode,
    weatherPrepared: !state.playbackStalled,
    weatherCommitted: !state.playbackStalled
  });
  updateTimestamp();
  if ((state.playing && !state.scrubbing && !state.playbackStalled) || state.lodTransition) wakeApplicationFrame();
}

wakeApplicationFrame();

if (runtimeCadence) {
  window.__dotFieldCadence = {
    ...runtimeCadence,
    snapshot: diagnosticsSnapshot,
    setCamera({ center, zoom }) {
      if (!Array.isArray(center) || center.length !== 2 || !Number.isFinite(zoom)) throw new TypeError('setCamera expects center: [longitude, latitude] and numeric zoom.');
      map.jumpTo({ center, zoom });
    },
    async step(times = []) {
      if (!Array.isArray(times)) throw new TypeError('step(times) expects an array of normalized times.');
      setPlaying(false);
      const results = [];
      for (const value of times) {
        const normalizedTime = clamp(Number(value), 0, 1);
        state.time = normalizedTime * LOOP_SECONDS;
        state.playbackStalled = false;
        await requestWeatherTime(normalizedTime);
        await new Promise((resolve) => requestAnimationFrame(resolve));
        const temporalFrame = geographicTemporalFrameAt(normalizedTime);
        runtimeCadence.recordDeterministicStep({
          normalizedTime,
          interval: temporalFrame.index,
          progress: temporalFrame.progress,
          lod: state.lod.level,
          renderMode: state.renderMode
        });
        results.push(this.summary());
      }
      return results;
    }
  };
}
