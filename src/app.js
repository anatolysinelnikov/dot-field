import { LOD_MORPH_SECONDS, LOOP_SECONDS } from './engine/config.js';
import { clamp, smoothstep } from './engine/math.js';
import { ACTIVE_REAL_WEATHER_METADATA_URL, beginActiveWeatherLoad, prepareGeographicSamplingGeometry, WEATHER_REGION } from './engine/geography.js';
import { residentSourceFrameIntervals } from './timeline-residency.js';
import {
  MAX_LOGICAL_SAMPLING_ZOOM,
  canonicalWindowFromMercatorBounds,
  canonicalWindowContains,
  canonicalWindowChangeKind,
  canonicalWindowMetrics,
  canonicalWindowNeedsShrink,
  canonicalWindowsEqual,
  GeographicLodTopology,
  lngLatToMercator,
  logicalZoomLatitudeAdjustment,
  lodRangeForStableLevel,
  normalizeCanonicalWindow,
  rawZoomForLogicalSamplingZoom,
  zoomToMercatorGridLevel
} from './engine/geographic-lod.js';
import { GeographicDotsLayer, mapDotsWeatherSummary } from './engine/geographic-dots-layer.js';
import { GeographicSquaresLayer, mapSquaresWeatherSummary } from './engine/geographic-squares-layer.js';
import { GeographicWeatherPyramid, WEATHER_REFERENCE_LEVEL } from './engine/geographic-weather-pyramid.js';
import { GpuMotionReconstructor } from './engine/gpu-motion-reconstruction.js';
import { GpuTemporalTileReconstructor } from './engine/gpu-temporal-tile-reconstruction.js';
import { GpuWeatherProviderResidency } from './engine/gpu-weather-provider-residency.js';
import { GPU_PHYSICAL_SUMMARY_LEVELS, GpuPhysicalSummaryBackend } from './engine/gpu-physical-summary.js';
import {
  fixedL13ChunkForCenter,
  fixedL13ChunksForCanonicalWindow,
  fixedL13ChunkPresentationBounds,
  fixedL13ChunkSampleIdentity,
  GPU_WEATHER_L13_CHUNK_EXTENT_L10,
  GPU_WEATHER_L13_CHUNK_LEVEL
} from './engine/gpu-weather-chunk.js';
import {
  GPU_WEATHER_LEVELS,
  gpuWeatherTransitionReadyPresentationLevels,
  isGpuWeatherLevel,
  isGpuWeatherLodTransitionPairSupported
} from './engine/geographic-gpu-weather-presentation.js';
import { RawWeatherLayer } from './engine/raw-weather-layer.js';
import { geographicTemporalFrameAt, TEMPORAL_FRAME_COUNT } from './engine/geographic-layer-utils.js';
import { createRuntimeDiagnostics, runDiagnosticCallback as runDiagnosticCallbackWithDiagnostics } from './runtime-diagnostics.js';
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
const queryParameters = new URLSearchParams(window.location.search);
const rawRendererEnabled = queryParameters.get('raw') !== '0';
const legacyHierarchicalDotsLodMorph = queryParameters.get('lodMorph') === 'hierarchical';
if (!rawRendererEnabled) {
  renderModeSelector.querySelector('[data-render-mode="raw"]')?.remove();
  renderModeSelector.dataset.mode = 'dots';
}
const renderModeButtons = [...renderModeSelector.querySelectorAll('[data-render-mode]')];
renderModeSelector.style.setProperty('--render-mode-count', String(renderModeButtons.length));

function updateRenderModeIndicator(mode) {
  const modeIndex = renderModeButtons.findIndex((button) => button.dataset.renderMode === mode);
  if (modeIndex >= 0) renderModeSelector.style.setProperty('--render-mode-indicator-index', String(modeIndex));
}

updateRenderModeIndicator(renderModeSelector.dataset.mode);
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
const gpuWeatherExperimentEnabled = queryParameters.get('gpuWeather') === '1';
const gpuWeatherL13ChunkExperimentEnabled = gpuWeatherExperimentEnabled
  && queryParameters.get('gpuWeatherChunkL13') === '1';
const gpuFirstExperimentEnabled = gpuWeatherExperimentEnabled && !rawRendererEnabled;
const GPU_WEATHER_LEVEL = 14;
const GPU_WEATHER_MIN_LEVEL = GPU_WEATHER_LEVELS[0];
let gpuMotionReconstructor = null;
let gpuMotionTileReconstructor = null;
const gpuMotionSharedTileCache = { entries: new Map(), pending: new Map() };
let gpuWeatherProviderResidency = null;
let gpuWeatherTileReconstructor = null;
let gpuWeatherLevelData = null;
let gpuWeatherUsingGpu = false;
let gpuWeatherFallbackReason = gpuWeatherExperimentEnabled ? 'not initialized' : null;
let gpuWeatherInitializationPromise = null;
let gpuWeatherResidencyPromise = null;
let gpuWeatherInitializationGeneration = 0;
let gpuWeatherKeyframes = null;
let gpuPhysicalSummaryBackend = null;
let gpuWeatherLastLodTransitionFallback = null;
let gpuWeatherPendingSpatial = null;
let gpuWeatherPendingSpatialGeneration = 0;
// This is deliberately distinct from the successful-commit counter above.
// Every asynchronous spatial owner gets a never-reused epoch, including work
// that is superseded before it reaches publication.
let gpuWeatherLifecycleGeneration = 0;
let gpuWeatherLifecycleEventId = 0;
const gpuWeatherLifecycleTrace = [];
const gpuWeatherLifecycleObjectIds = new WeakMap();
let gpuWeatherLifecycleObjectId = 0;
const GPU_WEATHER_LIFECYCLE_TRACE_LIMIT = 96;
let gpuWeatherL13Chunk = null;
let gpuWeatherL13ChunkSuspendedReason = null;
const gpuWeatherL13ChunkStats = {
  creationCount: 0,
  publicationCount: 0,
  chunkSetChangeCount: 0,
  candidatePublicationCount: 0,
  supersededCandidateCount: 0,
  directPhysicalReconstructionCount: 0,
  cameraMoveCount: 0,
  cameraMoveReuseCount: 0,
  outsidePreparedChunkCount: 0,
  viewportOwnedSpatialReplacementCount: 0,
  cameraMoveTopologyRebuildCount: 0,
  cameraMoveReconstructorRebuildCount: 0,
  cameraMoveDirectPhysicalReconstructionCount: 0,
  cameraMoveProviderResidencyRebuildCount: 0,
  cameraMoveProviderResidencyUploadCount: 0,
  providerResidencyCreationCount: 0,
  initialResourceIdentity: null,
  lastCameraMove: null
};
const gpuWeatherSpatialStats = {
  targetUpdates: 0,
  pendingReplacementCount: 0,
  supersededPendingCount: 0,
  targetUpdatesCoalescedWithoutCommit: 0,
  committedSpatialReplacements: 0,
  spatialReplacementReconstructionDraws: 0,
  pendingPreparationReconstructionDraws: 0,
  pendingWaitSamples: [],
  lastPendingWaitMs: null,
  stableCommittedSourcelessSamples: 0,
  gpuReactivationReconciliationCount: 0,
  gpuReactivationReplacementRequiredCount: 0,
  gpuReactivationReplacementRequestedCount: 0
};

function gpuWeatherLifecycleIdentity(value, prefix) {
  if (!value || (typeof value !== 'object' && typeof value !== 'function')) return null;
  let id = gpuWeatherLifecycleObjectIds.get(value);
  if (!id) {
    id = `${prefix}-${++gpuWeatherLifecycleObjectId}`;
    gpuWeatherLifecycleObjectIds.set(value, id);
  }
  return id;
}

function traceGpuWeatherLifecycle(operation, {
  pending = null, source = null, action = 'observe', stale = false, reason = null, details = null
} = {}) {
  const committedSource = weatherLayer?.gpuWeatherSource || squaresLayer?.gpuWeatherSource || null;
  const entry = {
    id: ++gpuWeatherLifecycleEventId,
    operation,
    action,
    stale: Boolean(stale),
    reason,
    pendingGeneration: pending?.generation ?? null,
    pendingId: pending?.id ?? null,
    level: pending?.levelData?.level ?? state.lod?.level ?? null,
    topology: gpuWeatherLifecycleIdentity(pending?.topology || source?.topology || geographicWeatherPyramid?.topology, 'topology'),
    levelData: gpuWeatherLifecycleIdentity(pending?.levelData || source?.levelData || state.levelData, 'level-data'),
    rendererSource: gpuWeatherLifecycleIdentity(source || committedSource, 'source'),
    providerResidency: gpuWeatherLifecycleIdentity(
      pending?.reconstructor?.provider || source?.reconstructor?.provider || committedSource?.reconstructor?.provider,
      'provider-residency'
    ),
    reconstructionTarget: gpuWeatherLifecycleIdentity(
      pending?.reconstructor || source?.reconstructor || committedSource?.reconstructor,
      'reconstruction-target'
    ),
    details,
    ownership: pending ? 'pending' : 'active',
    pendingStatus: pending?.status ?? null,
    pendingResourcesReleased: pending?.resourcesReleased ?? false,
    pendingResourcesTransferred: pending?.resourcesTransferred ?? false,
    pendingOwner: pending
      ? (gpuWeatherPendingSpatial === pending && pending.generation === gpuWeatherLifecycleGeneration ? 'current' : 'stale')
      : null,
    gpuWeatherUsingGpu,
    committedRendererSource: Boolean(committedSource)
  };
  gpuWeatherLifecycleTrace.push(entry);
  if (gpuWeatherLifecycleTrace.length > GPU_WEATHER_LIFECYCLE_TRACE_LIMIT) gpuWeatherLifecycleTrace.shift();
  return entry;
}

function gpuWeatherPhaseResourceSnapshot() {
  const provider = gpuWeatherProviderResidency;
  const workingSetDetails = (workingSet) => {
    const chunks = workingSet?.chunks || [];
    const targets = chunks.map((chunk) => chunk.target).filter(Boolean);
    return {
      chunkCount: chunks.length,
      targetCount: targets.length,
      targetIdCount: targets.length,
      targetIds: targets.slice(0, 32).map((target) => target.targetId || null),
      targetPhysicalBytes: targets.reduce((total, target) => total + (
        target.width && target.height ? target.width * target.height * 2 * 2 : 0
      ), 0)
    };
  };
  const active = workingSetDetails(gpuWeatherL13Chunk?.activeSet);
  const candidate = workingSetDetails(gpuWeatherL13Chunk?.candidate);
  return {
    providerResidency: gpuWeatherLifecycleIdentity(provider, 'provider-residency'),
    providerOwnerCount: provider?.referenceCount ?? null,
    providerRevisionCount: provider?.revisions?.size ?? null,
    providerCurrentRevisionId: provider?.currentRevision?.id ?? null,
    providerBuildCount: provider?.stats?.residencyBuildCount ?? null,
    providerRainUploads: provider?.stats?.rainUploads ?? null,
    providerMotionUploads: provider?.stats?.motionUploads ?? null,
    providerLatestRevisionDestroyMs: provider?.stats?.latestResidencyDestroyMs ?? null,
    providerLatestDestroyTimings: provider?.stats?.latestDestroyTimings ?? null,
    normalTarget: gpuWeatherLifecycleIdentity(gpuWeatherTileReconstructor, 'reconstruction-target'),
    active,
    candidate,
    activeSummaryBackend: gpuWeatherLifecycleIdentity(gpuPhysicalSummaryBackend, 'summary-backend')
  };
}

function beginGpuWeatherPhase(phase, details = {}) {
  const id = ++gpuWeatherLifecycleEventId;
  const startedAt = performance.now();
  runtimeDiagnostics?.recordEvent('gpu-weather-phase-enter', {
    phase,
    id,
    ...details,
    resources: gpuWeatherPhaseResourceSnapshot()
  });
  let completed = false;
  return (exitDetails = {}) => {
    if (completed) return;
    completed = true;
    runtimeDiagnostics?.recordEvent('gpu-weather-phase-exit', {
      phase,
      id,
      durationMs: performance.now() - startedAt,
      ...exitDetails,
      resources: gpuWeatherPhaseResourceSnapshot()
    });
  };
}

function fixedL13ChunkPathActive() {
  return Boolean(gpuWeatherL13ChunkExperimentEnabled
    && gpuWeatherL13Chunk?.active
    && state.renderMode === 'dots'
    && state.lod?.level === GPU_WEATHER_L13_CHUNK_LEVEL
    && !state.lodTransition);
}

function fixedL13ChunkResourceIdentity(source = weatherLayer?.gpuWeatherSource) {
  source = source || gpuWeatherL13Chunk?.activeSet?.chunks?.[0]?.source || null;
  return {
    rendererSource: gpuWeatherLifecycleIdentity(source, 'source'),
    providerResidency: gpuWeatherLifecycleIdentity(source?.reconstructor?.provider, 'provider-residency'),
    target: gpuWeatherLifecycleIdentity(source?.reconstructor, 'reconstruction-target'),
    physicalA: gpuWeatherLifecycleIdentity(source?.physicalOwnerA?.texture || source?.textureA, 'physical'),
    physicalB: gpuWeatherLifecycleIdentity(source?.physicalOwnerB?.texture || source?.textureB, 'physical'),
    topology: gpuWeatherLifecycleIdentity(source?.topology, 'topology'),
    levelData: gpuWeatherLifecycleIdentity(source?.levelData, 'level-data')
  };
}

function prepareFixedL13Chunk() {
  if (!gpuWeatherL13ChunkExperimentEnabled
    || gpuWeatherL13Chunk?.active
    || gpuWeatherL13ChunkSuspendedReason
    || state.renderMode !== 'dots'
    || state.levelData?.level !== GPU_WEATHER_L13_CHUNK_LEVEL) return false;
  const bounds = visibleMercatorBounds();
  if (!bounds) return false;
  const viewportWindow = canonicalWindowFromMercatorBounds(bounds);
  const selectedChunks = fixedL13ChunksForCanonicalWindow(viewportWindow, GPU_WEATHER_L13_CHUNK_EXTENT_L10);
  const descriptor = selectedChunks[0] || fixedL13ChunkForCenter([map.getCenter().lng, map.getCenter().lat], GPU_WEATHER_L13_CHUNK_EXTENT_L10);
  gpuWeatherL13Chunk = {
    ...descriptor,
    selectedChunks,
    selectedChunkKeys: selectedChunks.map((chunk) => chunk.key),
    viewportWindow,
    activeSet: null,
    candidate: null,
    active: true,
    insideUsefulCoverage: true,
    candidateGeneration: 0
  };
  gpuWeatherL13ChunkStats.creationCount += 1;
  runtimeDiagnostics?.recordEvent('gpu-weather-fixed-l13-chunk-created', {
    key: descriptor.key,
    level: descriptor.level,
    selectedChunkKeys: gpuWeatherL13Chunk.selectedChunkKeys,
    selectedChunkCount: selectedChunks.length,
    extentL10: descriptor.extentL10,
    viewportWindow
  });
  return true;
}

function updateFixedL13ChunkViewport(bounds) {
  if (!gpuWeatherL13Chunk?.active) return false;
  const candidate = canonicalWindowFromMercatorBounds(bounds);
  const selectedChunks = fixedL13ChunksForCanonicalWindow(candidate, GPU_WEATHER_L13_CHUNK_EXTENT_L10);
  const selectedChunkKeys = selectedChunks.map((chunk) => chunk.key);
  const previousKeys = gpuWeatherL13Chunk.selectedChunkKeys || [];
  const sameSet = selectedChunkKeys.length === previousKeys.length
    && selectedChunkKeys.every((key, index) => key === previousKeys[index]);
  const insideUsefulCoverage = sameSet;
  const before = fixedL13ChunkResourceIdentity();
  gpuWeatherL13Chunk.viewportWindow = candidate;
  gpuWeatherL13Chunk.selectedChunks = selectedChunks;
  gpuWeatherL13Chunk.selectedChunkKeys = selectedChunkKeys;
  if (selectedChunks[0]) Object.assign(gpuWeatherL13Chunk, selectedChunks[0]);
  gpuWeatherL13Chunk.insideUsefulCoverage = insideUsefulCoverage;
  state.canonicalWindowTarget = candidate;
  state.pendingCanonicalWindow = null;
  gpuWeatherL13ChunkStats.cameraMoveCount += 1;
  if (!insideUsefulCoverage) gpuWeatherL13ChunkStats.outsidePreparedChunkCount += 1;
  if (!sameSet && gpuWeatherUsingGpu) requestGpuWeatherMultiChunkReplacement(selectedChunks, candidate);
  const after = fixedL13ChunkResourceIdentity();
  const reused = sameSet
    && before.rendererSource === after.rendererSource
    && before.physicalA === after.physicalA
    && before.physicalB === after.physicalB
    && before.topology === after.topology
    && before.levelData === after.levelData;
  if (reused) gpuWeatherL13ChunkStats.cameraMoveReuseCount += 1;
  gpuWeatherL13ChunkStats.lastCameraMove = {
    insideUsefulCoverage,
    sameSelectedChunkSet: sameSet,
    selectedChunkKeys,
    reusedFixedChunk: reused,
    before,
    after
  };
  return true;
}

function suspendFixedL13Chunk(reason) {
  if (!gpuWeatherL13Chunk?.active) return false;
  gpuWeatherL13Chunk.active = false;
  gpuWeatherL13ChunkSuspendedReason = reason;
  runtimeDiagnostics?.recordEvent('gpu-weather-fixed-l13-chunk-suspended', {
    key: gpuWeatherL13Chunk.key,
    reason
  });
  disableGpuWeatherPath(state.time / LOOP_SECONDS, `Fixed L13 chunk experiment suspended: ${reason}`);
  releaseGpuWeatherResidency();
  const bounds = visibleMercatorBounds();
  if (bounds) applyCanonicalWindow(canonicalWindowFromMercatorBounds(bounds));
  return true;
}

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
  repaintRequests: 0,
  presentationMode: 'normal',
  presentationSyncMode: 'playback',
  presentationHzCap: null,
  playbackRafCount: 0,
  presentationOpportunityCount: 0,
  presentationAcceptedCount: 0,
  presentationSkippedCount: 0,
  mapLayerRenderCount: 0,
  weatherRepaintRequestCount: 0,
  presentationStateUpdatesFromPlayback: 0,
  presentationStateUpdatesFromRender: 0,
  presentationRenderSamples: 0,
  redundantRepaintRequests: 0,
  presentationSourceReuseCount: 0,
  presentationDeferredCount: 0,
  presentationDeferredSuppressedCount: 0,
  lastPresentationAt: null
};
const gpuWeatherLodTransitionStats = {
  started: 0,
  completed: 0,
  reversed: 0,
  unexpectedGpuToCpuFallbacks: 0
};
let gpuWeatherLastDeferredSourceSignature = null;
let gpuWeatherPendingInvariantReported = false;
let gpuWeatherSettledSpatialInvariantSignature = null;

function updateTimelineResidency(residentSourceFrameIndices = []) {
  const gpuStableDirectLevel = gpuWeatherExperimentEnabled && gpuWeatherUsingGpu
    && isGpuWeatherLevel(state.lod?.level)
    && (!state.lodTransition || state.lodTransition.owner === 'gpu')
    && (state.renderMode === 'dots' || state.renderMode === 'squares');
  if (gpuStableDirectLevel) {
    const multiChunkWorkingSet = gpuWeatherL13Chunk?.activeSet;
    const multiChunkActive = fixedL13ChunkPathActive() && Boolean(multiChunkWorkingSet?.chunks?.length);
    const tile = (multiChunkActive ? multiChunkWorkingSet.chunks[0]?.target?.diagnostics?.() : gpuWeatherTileReconstructor?.diagnostics()) || null;
    const dotsSource = weatherLayer?.diagnostics()?.gpuWeather?.source;
    const squaresSource = squaresLayer?.diagnostics()?.gpuWeather?.source;
    const requiredLevels = state.lodTransition?.owner === 'gpu'
      ? [state.lodTransition.fromLevel, state.lodTransition.toLevel]
      : gpuWeatherTransitionReadyPresentationLevels(state.lod.level);
    const summaryReady = multiChunkActive
      ? gpuWeatherL13Chunk.activeSet.chunks.every((chunk) => chunk.source)
      : gpuWeatherKeyframesHavePresentationLevels(gpuWeatherKeyframes, requiredLevels);
    const presentationReady = multiChunkActive ? dotsSource : dotsSource && squaresSource;
    const ready = Boolean(tile?.active && tile.requiredGeometricTileCount >= tile.residentTileCount
      && gpuWeatherKeyframes && summaryReady && presentationReady && !gpuWeatherPendingSpatial);
    timelineResidency.dataset.backend = 'gpu-spatial';
    timelineResidency.dataset.readiness = ready ? 'ready' : 'loading';
    timelineResidency.replaceChildren();
    if (ready) {
      const segment = document.createElement('span');
      segment.className = 'timeline-residency-segment';
      segment.style.left = '0%';
      segment.style.width = '100%';
      timelineResidency.append(segment);
    }
    timelineResidency.title = ready
      ? 'Timeline ready for the committed GPU weather view'
      : 'Loading timeline data for the current GPU weather view';
    return;
  }
  const intervals = timelineResidencyEnabled
    ? residentSourceFrameIntervals(residentSourceFrameIndices, sourceFrameCount)
    : [];
  const cpuRequirements = activeWeatherField && activeWeatherField.frameCount !== undefined
    ? rendererTemporalRequirements(state.time / LOOP_SECONDS) : null;
  const cpuReady = activeWeatherField?.frameCount === undefined
    || Boolean(cpuRequirements?.sourceFrames.every((frameIndex) => activeWeatherField.isSourceFrameAvailable(frameIndex)));
  timelineResidency.dataset.backend = 'cpu-source-cache';
  timelineResidency.dataset.readiness = cpuReady ? 'ready' : 'loading';
  timelineResidency.title = timelineResidency.dataset.readiness === 'ready'
    ? 'Timeline source cache is ready for the current CPU weather view'
    : 'Loading source data for the current CPU weather view';
  timelineResidency.replaceChildren(...intervals.map(({ start, end }) => {
    const segment = document.createElement('span');
    segment.className = 'timeline-residency-segment';
    segment.style.left = `${start * 100}%`;
    segment.style.width = `${(end - start) * 100}%`;
    return segment;
  }));
}

const temporalDiagnostic = queryParameters.get('temporal') === 'linear' ? 'linear' : 'motion';
const weatherLoad = beginActiveWeatherLoad({
  onTiming: markStartup,
  onResidencyChange: updateTimelineResidency,
  temporalMode: temporalDiagnostic,
  gpuFirst: gpuFirstExperimentEnabled,
  rawEnabled: rawRendererEnabled
});

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
  canonicalWindowTarget: null,
  canonicalWindowLastChange: null,
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
  cpuFallbackTransitionPromise: null,
  renderMode: rawRendererEnabled ? 'raw' : 'dots',
  hazardsVisible: true,
  rawFrameIndex: 0,
  rawTimeChanged: false
};
let geographicWeatherPyramid = null;
let weatherLayer = null;
let squaresLayer = null;
let rawLayer = null;
let geographicLayers = [];
const VALID_RENDER_MODES = new Set(rawRendererEnabled ? ['raw', 'dots', 'squares'] : ['dots', 'squares']);
let lastMapErrorSignature = '';
let weatherSequencePromise = null;
let basemapFallbackTimer = null;
let weatherRequestGeneration = 0;
let cpuTransitionRequestGeneration = 0;
let cpuTransitionRequest = null;

const diagnosticsEnabled = queryParameters.get('diagnostics') === '1';
const cadenceEnabled = queryParameters.get('cadence') === '1';
const gpuWeatherHzCap = Number(queryParameters.get('gpuWeatherHz')) === 60 ? 60 : null;
const gpuWeatherPresentationMode = queryParameters.get('gpuWeatherPresentation') === 'none' ? 'maplibre-only' : 'normal';
const gpuWeatherPresentationSyncMode = queryParameters.get('gpuWeatherPresentationSync') === 'render';
gpuWeatherTimelineStats.presentationMode = gpuWeatherPresentationMode;
gpuWeatherTimelineStats.presentationSyncMode = gpuWeatherPresentationSyncMode ? 'render' : 'playback';
gpuWeatherTimelineStats.presentationHzCap = gpuWeatherHzCap;
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
    && isGpuWeatherLevel(state.lod.level)
    && (state.renderMode === 'dots' || state.renderMode === 'squares')
    && Boolean(activeWeatherField?.motion)
    && !gpuWeatherFallbackReason?.startsWith('GPU weather initialization failed')
    && (!state.lodTransition || state.lodTransition.owner === 'gpu');
}

function gpuWeatherStableStateActive() {
  return gpuWeatherRequestedAtCurrentLevel() && !state.lodTransition;
}

function gpuWeatherTransitionEndpointCheck(fromLevelData, toLevelData) {
  const topology = geographicWeatherPyramid?.topology;
  const frame = geographicTemporalFrameAt(state.time / LOOP_SECONDS);
  const levels = [fromLevelData?.level, toLevelData?.level];
  const details = {
    fromLevel: levels[0] ?? null,
    toLevel: levels[1] ?? null,
    topology: gpuWeatherLifecycleIdentity(topology, 'topology'),
    stateLevelData: gpuWeatherLifecycleIdentity(state.levelData, 'level-data'),
    fromLevelData: gpuWeatherLifecycleIdentity(fromLevelData, 'level-data'),
    toLevelData: gpuWeatherLifecycleIdentity(toLevelData, 'level-data'),
    reconstructor: gpuWeatherLifecycleIdentity(gpuWeatherTileReconstructor, 'reconstructor'),
    retainedPresentationLevels: gpuWeatherKeyframes?.a?.presentations
      ? [...gpuWeatherKeyframes.a.presentations.keys()].sort((a, b) => a - b) : [],
    requiredPresentationLevels: levels.filter(Number.isInteger),
    temporalA: gpuWeatherKeyframes?.a?.index ?? null,
    temporalB: gpuWeatherKeyframes?.b?.index ?? null,
    currentTemporalA: frame.index,
    currentTemporalB: frame.nextIndex,
    pendingSpatial: gpuWeatherPendingSpatial ? {
      generation: gpuWeatherPendingSpatial.generation,
      status: gpuWeatherPendingSpatial.status,
      window: gpuWeatherPendingSpatial.window
    } : null,
    stableGpuOwnership: Boolean(gpuWeatherUsingGpu && !state.lodTransition)
  };
  const reject = (reason, readiness = null) => ({ reason, details, readiness });
  if (!topology) return reject('topology-unavailable');
  if (levels.some((level) => !isGpuWeatherLevel(level) || level < GPU_WEATHER_MIN_LEVEL || level > WEATHER_REFERENCE_LEVEL)
    || Math.abs(levels[0] - levels[1]) !== 1) return reject('unsupported-or-non-adjacent-pair');
  if (!gpuWeatherKeyframes) return reject('temporal-keyframes-unavailable');
  if (gpuWeatherKeyframes.a?.index !== frame.index || gpuWeatherKeyframes.b?.index !== frame.nextIndex) return reject('temporal-pair-mismatch');
  if (gpuWeatherKeyframes.a?.topology !== topology || gpuWeatherKeyframes.b?.topology !== topology) return reject('temporal-topology-owner-mismatch');
  const readiness = gpuWeatherKeyframesReadinessDetails(gpuWeatherKeyframes, levels);
  if (!readiness.ready) return reject('endpoint-presentation-incomplete', readiness);
  for (const keyframe of [gpuWeatherKeyframes.a, gpuWeatherKeyframes.b]) {
    for (const levelData of [fromLevelData, toLevelData]) {
      const presentation = keyframe.presentations.get(levelData.level);
      if (presentation?.levelData && presentation.levelData !== levelData) return reject('endpoint-level-data-owner-mismatch', readiness);
    }
  }
  const fromSource = createGpuWeatherPresentationSource(frame, gpuWeatherKeyframes.a, gpuWeatherKeyframes.b, {
    topology, levelData: fromLevelData, presentationLevel: fromLevelData.level
  });
  const toSource = createGpuWeatherPresentationSource(frame, gpuWeatherKeyframes.a, gpuWeatherKeyframes.b, {
    topology, levelData: toLevelData, presentationLevel: toLevelData.level
  });
  if (!fromSource || !toSource || fromSource.topology !== topology || toSource.topology !== topology) return reject('endpoint-source-wrapper-incomplete', readiness);
  return {
    reason: null,
    details,
    readiness,
    sources: { topology, frame, fromSource, toSource, fineLevelData: topology.levels.get(Math.max(...levels)) }
  };
}

function gpuWeatherTransitionEndpointSources(fromLevelData, toLevelData) {
  return gpuWeatherTransitionEndpointCheck(fromLevelData, toLevelData)?.sources || null;
}

function synchronizeGpuWeatherPairBeforeLodTransition() {
  if (!gpuWeatherUsingGpu || state.lodTransition || !gpuWeatherTileReconstructor?.layout
    || gpuWeatherLevelData !== state.levelData || !gpuWeatherKeyframes) return;
  const frame = geographicTemporalFrameAt(state.time / LOOP_SECONDS);
  if (gpuWeatherKeyframes.a?.index === frame.index && gpuWeatherKeyframes.b?.index === frame.nextIndex) return;
  // A playback tick and a camera event can arrive in either order. Complete
  // the normal GPU-only A/B rollover before checking LOD endpoint ownership so
  // a healthy active pair is not misclassified as a CPU transition merely
  // because the renderer pair is one interval behind.
  updateGpuWeatherTime(state.time / LOOP_SECONDS, {
    requestRepaint: false,
    origin: 'gpu-lod-transition-preflight'
  });
  runtimeDiagnostics?.recordEvent('gpu-weather-lod-transition-temporal-preflight', {
    temporalA: gpuWeatherKeyframes?.a?.index ?? null,
    temporalB: gpuWeatherKeyframes?.b?.index ?? null,
    currentTemporalA: frame.index,
    currentTemporalB: frame.nextIndex,
    pendingSpatial: gpuWeatherPendingSpatial?.generation ?? null
  });
}

function gpuWeatherGl() {
  return map.painter?.context?.gl || null;
}

function gpuWeatherPhysicalLevelDataFor(topology, stableLevel) {
  return stableLevel < WEATHER_REFERENCE_LEVEL
    ? topology?.levels.get(WEATHER_REFERENCE_LEVEL) || null
    : topology?.levels.get(stableLevel) || null;
}

function cancelGpuWeatherPendingSpatial() {
  const pending = gpuWeatherPendingSpatial;
  if (!pending) return;
  pending.cancelled = true;
  terminalizeGpuWeatherPending(pending, 'target no longer requires replacement', { stale: true, operation: 'pending-cancel' });
}

function disableGpuWeatherPath(time = state.time / LOOP_SECONDS, reason = null) {
  traceGpuWeatherLifecycle('gpu-disable', { action: 'clear', reason });
  // A CPU-boundary handoff must clear both renderers before either one starts
  // rebuilding CPU temporal state. The former Dots-first call could throw
  // during that synchronous rebuild, leaving Dots disabled while Squares and
  // application ownership still described a stable GPU source.
  if (weatherLayer?.gpuWeatherMode) weatherLayer.setGpuWeatherMode(false, time, { rebuildCpu: false, requestRepaint: false });
  if (squaresLayer?.gpuWeatherMode) squaresLayer.setGpuWeatherMode(false, time, { rebuildCpu: false, requestRepaint: false });
  cancelGpuWeatherPendingSpatial();
  gpuWeatherUsingGpu = false;
  gpuWeatherKeyframes = null;
  destroyGpuPhysicalSummaryBackend(gpuPhysicalSummaryBackend, 'disable-gpu-weather');
  gpuPhysicalSummaryBackend = null;
  gpuWeatherInitializationGeneration += 1;
  if (reason) gpuWeatherFallbackReason = reason;
  updateTimelineResidency();
  map.triggerRepaint();
}

function releaseGpuWeatherResidency() {
  const phaseExit = beginGpuWeatherPhase('gpu-weather-residency-release');
  traceGpuWeatherLifecycle('active-residency-release', { action: 'dispose' });
  cancelGpuWeatherPendingSpatial();
  destroyGpuWeatherMultiChunkWorkingSet(gpuWeatherL13Chunk?.candidate, 'release-gpu-weather-multichunk-candidate');
  destroyGpuWeatherMultiChunkWorkingSet(gpuWeatherL13Chunk?.activeSet, 'release-gpu-weather-multichunk-active');
  if (gpuWeatherL13Chunk) {
    gpuWeatherL13Chunk.candidate = null;
    gpuWeatherL13Chunk.activeSet = null;
    gpuWeatherL13Chunk.active = false;
  }
  if (gpuWeatherTileReconstructor) {
    const targetPhaseExit = beginGpuWeatherPhase('normal-target-destruction', {
      target: gpuWeatherLifecycleIdentity(gpuWeatherTileReconstructor, 'reconstruction-target')
    });
    const timings = gpuWeatherTileReconstructor.destroy();
    targetPhaseExit({ status: 'released', timings });
  }
  gpuWeatherTileReconstructor = null;
  if (gpuWeatherProviderResidency) {
    const provider = gpuWeatherProviderResidency;
    const providerPhaseExit = beginGpuWeatherPhase('gpu-weather-provider-destruction', {
      provider: gpuWeatherLifecycleIdentity(provider, 'provider-residency')
    });
    provider.release();
    providerPhaseExit({
      status: provider.destroyed ? 'destroyed' : 'released-owner',
      destroyTimings: provider.stats.latestDestroyTimings,
      ownerCount: provider.referenceCount
    });
  }
  gpuWeatherProviderResidency = null;
  destroyGpuPhysicalSummaryBackend(gpuPhysicalSummaryBackend, 'release-gpu-weather-residency');
  gpuPhysicalSummaryBackend = null;
  gpuWeatherLevelData = null;
  gpuWeatherKeyframes = null;
  updateTimelineResidency();
  phaseExit({ status: 'released' });
}

async function ensureGpuWeatherProviderResidency() {
  if (!gpuWeatherExperimentEnabled || !activeWeatherField) return null;
  const gl = gpuWeatherGl();
  if (!gl) throw new Error('MapLibre WebGL2 context is unavailable.');
  if (!gpuWeatherProviderResidency
    || gpuWeatherProviderResidency.gl !== gl
    || gpuWeatherProviderResidency.metadata.generation_id !== activeWeatherField.generationId) {
    gpuWeatherTileReconstructor?.destroy();
    gpuWeatherTileReconstructor = null;
    gpuWeatherProviderResidency?.release();
    gpuWeatherProviderResidency = await GpuWeatherProviderResidency.create({
      metadataUrl: ACTIVE_REAL_WEATHER_METADATA_URL,
      generationId: activeWeatherField.generationId,
      sequence: activeWeatherField,
      gl
    });
    gpuWeatherL13ChunkStats.providerResidencyCreationCount += 1;
    runtimeDiagnostics?.recordEvent('gpu-weather-provider-residency-created', {
      providerResidency: gpuWeatherLifecycleIdentity(gpuWeatherProviderResidency, 'provider-residency'),
      generationId: activeWeatherField.generationId
    });
  }
  return gpuWeatherProviderResidency;
}

function destroyGpuWeatherMultiChunkWorkingSet(workingSet, reason = 'unspecified') {
  if (!workingSet || workingSet.resourcesReleased) return false;
  const phaseExit = beginGpuWeatherPhase('multichunk-working-set-release', {
    generation: workingSet.generation ?? null,
    reason,
    chunkKeys: (workingSet.chunks || []).map((chunk) => chunk.descriptor?.key).filter(Boolean)
  });
  workingSet.cancelled = true;
  const targetPhaseExit = beginGpuWeatherPhase('multichunk-target-destruction', {
    generation: workingSet.generation ?? null,
    chunkKeys: (workingSet.chunks || []).map((chunk) => chunk.descriptor?.key).filter(Boolean)
  });
  const targetDestroyTimings = [];
  for (const chunk of workingSet.chunks || []) {
    const timings = chunk.target?.destroy?.() || null;
    if (timings) targetDestroyTimings.push({ target: chunk.target?.targetId || null, timings });
  }
  targetPhaseExit({ status: 'released', targetDestroyTimings });
  workingSet.chunks = workingSet.chunks || [];
  const revisionPhaseExit = beginGpuWeatherPhase('multichunk-provider-revision-release', {
    generation: workingSet.generation ?? null,
    providerRevisionId: workingSet.providerRevisionLease?.revisionId ?? null
  });
  if (workingSet.providerRevisionLease) {
    gpuWeatherProviderResidency?.discardPreparedRevision(workingSet.providerRevisionLease);
    workingSet.providerRevisionLease = null;
  }
  revisionPhaseExit({ status: 'released' });
  workingSet.resourcesReleased = true;
  workingSet.status = 'released';
  runtimeDiagnostics?.recordEvent('gpu-weather-multichunk-working-set-released', {
    reason,
    generation: workingSet.generation ?? null,
    chunkKeys: workingSet.chunks.map((chunk) => chunk.descriptor?.key).filter(Boolean)
  });
  phaseExit({ status: 'released', generation: workingSet.generation ?? null });
  return true;
}

function multiChunkCandidateIsCurrent(candidate) {
  return gpuWeatherL13Chunk?.active
    && gpuWeatherL13Chunk.candidate === candidate
    && !candidate.cancelled
    && candidate.generation === gpuWeatherL13Chunk.candidateGeneration;
}

function multiChunkTargetTopology(descriptor) {
  return new GeographicLodTopology(
    descriptor.canonicalWindow,
    { minLevel: GPU_WEATHER_L13_CHUNK_LEVEL, maxLevel: GPU_WEATHER_L13_CHUNK_LEVEL },
    null,
    { deferTransitionParents: true }
  );
}

function multiChunkPresentationSource(chunk, frame) {
  const { descriptor, topology, levelData, target, keyframes } = chunk;
  return {
    kind: 'physical',
    textureA: keyframes.a.texture,
    textureB: keyframes.b.texture,
    coverageTextureA: keyframes.a.texture,
    coverageTextureB: keyframes.b.texture,
    physicalTextureA: keyframes.a.texture,
    physicalTextureB: keyframes.b.texture,
    progress: frame.progress,
    temporalA: keyframes.a.index,
    temporalB: keyframes.b.index,
    width: levelData.width,
    height: levelData.height,
    format: 'R16F',
    topology,
    levelData,
    presentationLevel: GPU_WEATHER_L13_CHUNK_LEVEL,
    reconstructor: target,
    summaryBackend: null,
    physicalOwnerA: keyframes.a,
    physicalOwnerB: keyframes.b,
    chunk: descriptor,
    presentationOwnership: fixedL13ChunkPresentationBounds(levelData, descriptor),
    gl: target.gl
  };
}

function reconstructGpuWeatherMultiChunkKeyframe(chunk, index, slot) {
  const physicalFrame = activeWeatherField.prepareFrame(index / TEMPORAL_FRAME_COUNT);
  chunk.target.update(physicalFrame, { measureGpu: diagnosticsEnabled, targetSlot: slot });
  gpuWeatherL13ChunkStats.directPhysicalReconstructionCount += 1;
  return { index, slot, texture: chunk.target.outputs[slot], target: chunk.target };
}

function prepareGpuWeatherMultiChunkKeyframes(chunk, normalizedTime) {
  const frame = geographicTemporalFrameAt(normalizedTime);
  const previous = chunk.keyframes || { a: null, b: null };
  const desired = [frame.index, frame.nextIndex];
  const next = [null, null];
  const usedSlots = new Set();
  for (let position = 0; position < desired.length; position++) {
    const reused = [previous.a, previous.b].find((entry) => entry?.index === desired[position] && !usedSlots.has(entry.slot));
    if (reused) {
      next[position] = reused;
      usedSlots.add(reused.slot);
      gpuWeatherTimelineStats.reusedPhysicalKeyframes++;
    }
  }
  for (let position = 0; position < desired.length; position++) {
    if (position === 1 && desired[1] === desired[0]) {
      next[position] = next[0];
      continue;
    }
    if (next[position]) continue;
    const slot = usedSlots.has(0) ? 1 : 0;
    next[position] = reconstructGpuWeatherMultiChunkKeyframe(chunk, desired[position], slot);
    usedSlots.add(slot);
    gpuWeatherTimelineStats.physicalKeyframeReconstructionDraws++;
  }
  chunk.keyframes = { a: next[0], b: next[1] };
  chunk.source = multiChunkPresentationSource(chunk, frame);
  return frame;
}

async function prepareGpuWeatherMultiChunkCandidate(descriptors, generation, normalizedTime, owner = null) {
  const candidate = owner || {
    generation,
    descriptors,
    chunks: [],
    providerRevisionLease: null,
    status: 'preparing',
    cancelled: false,
    resourcesReleased: false,
    promise: null
  };
  const phaseExit = beginGpuWeatherPhase('multichunk-candidate-preparation', {
    generation,
    chunkKeys: descriptors.slice(0, 32).map((descriptor) => descriptor.key),
  });
  let unionHandle = null;
  try {
    const records = descriptors.map((descriptor) => {
      const topology = multiChunkTargetTopology(descriptor);
      return { descriptor, topology, levelData: topology.levelDataFor(GPU_WEATHER_L13_CHUNK_LEVEL), target: null, keyframes: null, source: null };
    });
    candidate.chunks = records;
    const provider = await ensureGpuWeatherProviderResidency();
    const providerBuildsBefore = provider.stats.residencyBuildCount;
    const providerRainUploadsBefore = provider.stats.rainUploads;
    const providerMotionUploadsBefore = provider.stats.motionUploads;
    const required = records.map((chunk) => provider.requiredTileIdsFor(chunk.levelData, null, true));
    const union = provider.requiredTileUnion(required);
    const providerPhaseExit = beginGpuWeatherPhase('multichunk-provider-union-acquire', {
      generation: candidate.generation,
      requiredTileCount: union.length
    });
    try {
      unionHandle = await provider.acquire(union);
    } finally {
      providerPhaseExit({
        status: unionHandle ? 'ready' : 'unavailable',
        providerRevisionId: unionHandle?.revisionId ?? null,
        requiredTileCount: union.length
      });
    }
    if (!unionHandle) throw new Error('Shared GPU provider union revision was not published.');
    if (candidate.cancelled) {
      provider.discardPreparedRevision(unionHandle);
      unionHandle = null;
      destroyGpuWeatherMultiChunkWorkingSet(candidate, 'multichunk-candidate-cancelled-after-provider-acquire');
      return candidate;
    }
    for (const chunk of records) {
      if (candidate.cancelled) return candidate;
      const target = await GpuTemporalTileReconstructor.create({
        metadataUrl: ACTIVE_REAL_WEATHER_METADATA_URL,
        generationId: activeWeatherField.generationId,
        levelData: chunk.levelData,
        sequence: activeWeatherField,
        procedural: true,
        gl: gpuWeatherGl(),
        provider
      });
      if (candidate.cancelled) {
        target.destroy();
        provider.discardPreparedRevision(unionHandle);
        unionHandle = null;
        destroyGpuWeatherMultiChunkWorkingSet(candidate, 'multichunk-candidate-cancelled-after-target-create');
        return candidate;
      }
      chunk.target = target;
      chunk.target.targetId = `gpu-weather-chunk/${chunk.descriptor.key}`;
      await chunk.target.installProviderRevision(unionHandle);
      if (candidate.cancelled) {
        provider.discardPreparedRevision(unionHandle);
        unionHandle = null;
        destroyGpuWeatherMultiChunkWorkingSet(candidate, 'multichunk-candidate-cancelled-after-target-install');
        return candidate;
      }
    }
    candidate.providerRevisionLease = provider.retainPreparedRevision(unionHandle, union);
    unionHandle.release();
    unionHandle = null;
    const frame = geographicTemporalFrameAt(normalizedTime);
    if (candidate.cancelled) {
      destroyGpuWeatherMultiChunkWorkingSet(candidate, 'multichunk-candidate-cancelled-before-reconstruction');
      return candidate;
    }
    const physicalPhaseExit = beginGpuWeatherPhase('multichunk-physical-ab-reconstruction', {
      generation: candidate.generation,
      chunkKeys: records.slice(0, 32).map((chunk) => chunk.descriptor.key),
      rendererPair: [frame.index, frame.nextIndex]
    });
    try {
      for (const chunk of records) prepareGpuWeatherMultiChunkKeyframes(chunk, normalizedTime);
    } finally {
      physicalPhaseExit({ status: 'reconstructed', generation: candidate.generation });
    }
    candidate.frame = frame;
    candidate.providerRevisionId = candidate.providerRevisionLease.revisionId;
    candidate.unionTileIds = union;
    candidate.providerBuildDelta = provider.stats.residencyBuildCount - providerBuildsBefore;
    candidate.providerRainUploadDelta = provider.stats.rainUploads - providerRainUploadsBefore;
    candidate.providerMotionUploadDelta = provider.stats.motionUploads - providerMotionUploadsBefore;
    candidate.status = 'ready';
    return candidate;
  } catch (error) {
    if (unionHandle) gpuWeatherProviderResidency?.discardPreparedRevision(unionHandle);
    destroyGpuWeatherMultiChunkWorkingSet(candidate, 'multichunk-candidate-preparation-failed');
    throw error;
  } finally {
    phaseExit({
      status: candidate.status,
      generation: candidate.generation,
      cancelled: candidate.cancelled,
      resourcesReleased: candidate.resourcesReleased
    });
  }
}

function publishGpuWeatherMultiChunkCandidate(candidate) {
  if (!multiChunkCandidateIsCurrent(candidate) || candidate.status !== 'ready') return false;
  const phaseExit = beginGpuWeatherPhase('multichunk-candidate-publication', {
    generation: candidate.generation,
    chunkKeys: candidate.descriptors.slice(0, 32).map((descriptor) => descriptor.key),
    providerRevisionId: candidate.providerRevisionId
  });
  const frame = geographicTemporalFrameAt(state.time / LOOP_SECONDS);
  for (const chunk of candidate.chunks) prepareGpuWeatherMultiChunkKeyframes(chunk, state.time / LOOP_SECONDS);
  candidate.frame = frame;
  const sources = candidate.chunks.map((chunk) => chunk.source);
  weatherLayer.setGpuWeatherMultiChunkSources(sources, { requestRepaint: false });
  const predecessor = gpuWeatherL13Chunk.activeSet;
  gpuWeatherL13Chunk.activeSet = candidate;
  gpuWeatherL13Chunk.candidate = null;
  gpuWeatherL13Chunk.selectedChunks = candidate.descriptors;
  gpuWeatherL13Chunk.selectedChunkKeys = candidate.descriptors.map((chunk) => chunk.key);
  gpuWeatherL13Chunk.viewportWindow = canonicalWindowFromMercatorBounds(visibleMercatorBounds());
  gpuWeatherL13Chunk.levelData = candidate.chunks[0]?.levelData || null;
  gpuWeatherL13Chunk.topology = candidate.chunks[0]?.topology || null;
  gpuWeatherL13Chunk.providerRevisionId = candidate.providerRevisionId;
  gpuWeatherL13ChunkStats.publicationCount += 1;
  gpuWeatherL13ChunkStats.candidatePublicationCount += 1;
  gpuWeatherKeyframes = { a: { index: frame.index }, b: { index: frame.nextIndex }, progress: frame.progress };
  candidate.status = 'committed';
  candidate.providerRevisionLease?.release();
  candidate.providerRevisionLease = null;
  destroyGpuWeatherMultiChunkWorkingSet(predecessor, 'multichunk-predecessor-release');
  updateTimelineResidency();
  map.triggerRepaint();
  runtimeDiagnostics?.recordEvent('gpu-weather-multichunk-published', {
    generation: candidate.generation,
    chunkKeys: candidate.selectedChunkKeys,
    providerRevisionId: candidate.providerRevisionId
  });
  phaseExit({ status: 'published', generation: candidate.generation });
  return true;
}

function requestGpuWeatherMultiChunkReplacement(descriptors, viewportWindow) {
  if (!gpuWeatherUsingGpu || !gpuWeatherL13Chunk?.active) return false;
  const keys = descriptors.map((descriptor) => descriptor.key);
  const activeKeys = gpuWeatherL13Chunk.activeSet?.descriptors?.map((descriptor) => descriptor.key)
    || gpuWeatherL13Chunk.selectedChunkKeys || [];
  if (keys.length === activeKeys.length && keys.every((key, index) => key === activeKeys[index])) return false;
  const previousCandidate = gpuWeatherL13Chunk.candidate;
  if (previousCandidate) {
    previousCandidate.cancelled = true;
    gpuWeatherL13ChunkStats.supersededCandidateCount += 1;
    destroyGpuWeatherMultiChunkWorkingSet(previousCandidate, 'multichunk-candidate-superseded');
  }
  const candidate = {
    generation: ++gpuWeatherL13Chunk.candidateGeneration,
    descriptors,
    chunks: [],
    status: 'preparing',
    cancelled: false,
    resourcesReleased: false,
    viewportWindow,
    providerRevisionLease: null
  };
  gpuWeatherL13Chunk.candidate = candidate;
  gpuWeatherL13ChunkStats.chunkSetChangeCount += 1;
  const promise = prepareGpuWeatherMultiChunkCandidate(descriptors, candidate.generation, state.time / LOOP_SECONDS, candidate)
    .then((prepared) => {
      Object.assign(candidate, prepared);
      if (!multiChunkCandidateIsCurrent(candidate)) {
        destroyGpuWeatherMultiChunkWorkingSet(candidate, 'multichunk-candidate-completed-stale');
        return null;
      }
      publishGpuWeatherMultiChunkCandidate(candidate);
      return candidate;
    })
    .catch((error) => {
      if (!candidate.cancelled) console.error('GPU multi-chunk candidate preparation failed.', error);
      destroyGpuWeatherMultiChunkWorkingSet(candidate, 'multichunk-candidate-error');
      return null;
    });
  candidate.promise = promise;
  updateTimelineResidency();
  return true;
}

async function initializeGpuWeatherMultiChunkPath() {
  const manager = gpuWeatherL13Chunk;
  if (!manager?.active) return null;
  // The fixed-L13 experiment has per-chunk targets and does not use the
  // normal single-target GPU residency. Release that predecessor before the
  // shared union revision is acquired so a settled set has one live revision.
  gpuWeatherTileReconstructor?.destroy();
  gpuWeatherTileReconstructor = null;
  gpuWeatherLevelData = null;
  const provider = await ensureGpuWeatherProviderResidency();
  if (!manager.active) return null;
  let descriptors = manager.selectedChunks;
  let candidate = await prepareGpuWeatherMultiChunkCandidate(descriptors, ++manager.candidateGeneration, state.time / LOOP_SECONDS);
  const latestKeys = manager.selectedChunkKeys || [];
  const preparedKeys = candidate.descriptors.map((descriptor) => descriptor.key);
  if (latestKeys.length !== preparedKeys.length || latestKeys.some((key, index) => key !== preparedKeys[index])) {
    destroyGpuWeatherMultiChunkWorkingSet(candidate, 'multichunk-initial-selection-superseded');
    descriptors = manager.selectedChunks;
    candidate = await prepareGpuWeatherMultiChunkCandidate(descriptors, ++manager.candidateGeneration, state.time / LOOP_SECONDS);
  }
  if (!manager.active) {
    destroyGpuWeatherMultiChunkWorkingSet(candidate, 'multichunk-initialization-suspended');
    return null;
  }
  manager.candidate = candidate;
  if (!gpuWeatherUsingGpu) {
    weatherLayer.setGpuWeatherMode(true, state.time / LOOP_SECONDS);
    gpuWeatherUsingGpu = true;
  }
  publishGpuWeatherMultiChunkCandidate(candidate);
  return { provider, candidate };
}

async function createGpuWeatherResidency(levelData) {
  if (!gpuWeatherExperimentEnabled || !activeWeatherField || !levelData || !isGpuWeatherLevel(levelData.level)) return null;
  const phaseExit = beginGpuWeatherPhase('gpu-weather-residency-acquire', { level: levelData.level });
  const residencyStarted = performance.now();
  try {
    const provider = await ensureGpuWeatherProviderResidency();
    const gl = gpuWeatherGl();
    let previousTemporalDestroyTimings = null;
    if (gpuWeatherLevelData !== levelData) {
      if (gpuWeatherTileReconstructor) {
        const targetPhaseExit = beginGpuWeatherPhase('normal-target-destruction', {
          target: gpuWeatherLifecycleIdentity(gpuWeatherTileReconstructor, 'reconstruction-target'),
          replacementLevel: levelData.level
        });
        previousTemporalDestroyTimings = gpuWeatherTileReconstructor.destroy();
        targetPhaseExit({ status: 'released', timings: previousTemporalDestroyTimings });
      }
      gpuWeatherTileReconstructor = null;
      destroyGpuPhysicalSummaryBackend(gpuPhysicalSummaryBackend, 'replace-gpu-weather-level-data');
      gpuPhysicalSummaryBackend = null;
      gpuWeatherLevelData = levelData;
    }
    const physicalLevelData = gpuWeatherPhysicalLevelDataFor(geographicWeatherPyramid, levelData.level);
    const hadReconstructor = Boolean(gpuWeatherTileReconstructor);
    const reconstructorStarted = performance.now();
    if (!gpuWeatherTileReconstructor) {
      gpuWeatherTileReconstructor = await GpuTemporalTileReconstructor.create({
        metadataUrl: ACTIVE_REAL_WEATHER_METADATA_URL,
        generationId: activeWeatherField.generationId,
        levelData: physicalLevelData,
        sequence: activeWeatherField,
        procedural: true,
        gl,
        provider
      });
    }
    const reconstructorCreationMs = hadReconstructor ? 0 : performance.now() - reconstructorStarted;
    const ensureStarted = performance.now();
    await gpuWeatherTileReconstructor.ensureResident();
    const residencyDiagnostics = gpuWeatherTileReconstructor.diagnostics();
    runtimeDiagnostics?.recordEvent('gpu-weather-temporal-residency', {
      level: levelData.level,
      totalMs: performance.now() - residencyStarted,
      reconstructorCreationMs,
      reconstructorConstructorMs: residencyDiagnostics.uploads.constructorMs || 0,
      asyncWaitMs: residencyDiagnostics.uploads.latestSpatialAsyncWaitMs || 0,
      synchronousMs: residencyDiagnostics.uploads.latestSpatialSynchronousMs || 0,
      ensureCallMs: performance.now() - ensureStarted,
      previousTemporalDestroyTimings,
      textureArrayAllocationMs: residencyDiagnostics.uploads.latestTextureArrayAllocationMs || 0,
      tileUploadSubmissionMs: residencyDiagnostics.uploads.latestTileUploadSubmissionMs || 0,
      residencyPublicationMs: residencyDiagnostics.uploads.latestResidencyPublicationMs || 0,
      residentTileCount: residencyDiagnostics.residentTileCount,
      residentRainSourceBytes: residencyDiagnostics.residentRainSourceBytes,
      residentMotionSourceBytes: residencyDiagnostics.residentMotionSourceBytes
    });
    return gpuWeatherTileReconstructor;
  } finally {
    phaseExit({ level: levelData.level, status: 'settled' });
  }
}

function ensureGpuWeatherResidency(levelData) {
  if (gpuWeatherResidencyPromise) return gpuWeatherResidencyPromise;
  gpuWeatherResidencyPromise = createGpuWeatherResidency(levelData)
    .finally(() => { gpuWeatherResidencyPromise = null; });
  return gpuWeatherResidencyPromise;
}

function gpuSummaryLevelsForStableLevel(level) {
  const presentationLevels = gpuWeatherTransitionReadyPresentationLevels(level);
  const summaryLevels = presentationLevels.filter((presentationLevel) => presentationLevel < WEATHER_REFERENCE_LEVEL);
  if (!summaryLevels.length) return [];
  const lowestRequiredSummaryLevel = Math.min(...summaryLevels);
  // The summary backend must retain every recursive intermediate from direct
  // L13 down to the lowest prepared presentation endpoint. The intermediate
  // levels are retained GPU state, not additional published presentation
  // sources.
  return GPU_PHYSICAL_SUMMARY_LEVELS.filter((summaryLevel) => summaryLevel >= lowestRequiredSummaryLevel);
}

function gpuWeatherKeyframePresentationDetails(keyframe, level, pending = null) {
  const presentation = keyframe?.presentations?.get(level) || null;
  const requiresCoverage = level < WEATHER_REFERENCE_LEVEL;
  const missing = [];
  if (!keyframe) missing.push('keyframe');
  if (!keyframe?.texture) missing.push('keyframe-texture');
  if (!presentation) missing.push('presentation-record');
  if (!presentation?.texture) missing.push('presentation-texture');
  if (requiresCoverage && !presentation?.coverageTexture) missing.push('presentation-coverage');
  if (pending && keyframe) {
    if (keyframe.reconstructor !== pending.reconstructor) missing.push('reconstructor-owner');
    if (keyframe.topology !== pending.topology) missing.push('topology-owner');
    if (keyframe.levelData !== pending.physicalLevelData) missing.push('physical-level-data-owner');
  }
  return {
    index: keyframe?.index ?? null,
    slot: keyframe?.slot ?? null,
    texturePresent: Boolean(keyframe?.texture),
    presentationTexturePresent: Boolean(presentation?.texture),
    coverageRequired: requiresCoverage,
    coveragePresent: Boolean(presentation?.coverageTexture),
    kind: presentation?.kind ?? null,
    owner: pending ? {
      reconstructor: gpuWeatherLifecycleIdentity(keyframe?.reconstructor, 'reconstructor'),
      topology: gpuWeatherLifecycleIdentity(keyframe?.topology, 'topology'),
      levelData: gpuWeatherLifecycleIdentity(keyframe?.levelData, 'level-data'),
      matchesPendingReconstructor: keyframe?.reconstructor === pending.reconstructor,
      matchesPendingTopology: keyframe?.topology === pending.topology,
      matchesPendingPhysicalLevelData: keyframe?.levelData === pending.physicalLevelData
    } : null,
    missing,
    ready: missing.length === 0
  };
}

function gpuWeatherKeyframesReadinessDetails(keyframes, levels, pending = null) {
  const endpoints = levels.map((level) => ({
    level,
    a: gpuWeatherKeyframePresentationDetails(keyframes?.a, level, pending),
    b: gpuWeatherKeyframePresentationDetails(keyframes?.b, level, pending)
  }));
  for (const endpoint of endpoints) {
    if (endpoint.a.kind && endpoint.b.kind && endpoint.a.kind !== endpoint.b.kind) {
      endpoint.a.missing.push('presentation-kind-mismatch');
      endpoint.b.missing.push('presentation-kind-mismatch');
      endpoint.a.ready = false;
      endpoint.b.ready = false;
    }
  }
  const directLevel = pending?.physicalLevelData?.level ?? null;
  const directA = directLevel === null ? null : keyframes?.a?.presentations?.get(directLevel);
  const directB = directLevel === null ? null : keyframes?.b?.presentations?.get(directLevel);
  const currentFrame = geographicTemporalFrameAt(state.time / LOOP_SECONDS);
  const ready = Boolean(keyframes?.a?.texture && keyframes?.b?.texture
    && endpoints.every(({ a, b }) => a.ready && b.ready));
  return {
    ready,
    requiredPresentationLevels: [...levels],
    currentRendererPair: { a: currentFrame.index, b: currentFrame.nextIndex },
    reconstructedPair: { a: keyframes?.a?.index ?? null, b: keyframes?.b?.index ?? null },
    pairMatchesCurrentRenderer: keyframes?.a?.index === currentFrame.index
      && keyframes?.b?.index === currentFrame.nextIndex,
    directPhysical: {
      level: directLevel,
      aTexturePresent: Boolean(directA?.texture),
      bTexturePresent: Boolean(directB?.texture),
      aKind: directA?.kind ?? null,
      bKind: directB?.kind ?? null
    },
    endpoints,
    pendingReconstructor: pending ? gpuWeatherLifecycleIdentity(pending.reconstructor, 'reconstructor') : null,
    pendingTopology: pending ? gpuWeatherLifecycleIdentity(pending.topology, 'topology') : null,
    pendingPhysicalLevelData: pending ? gpuWeatherLifecycleIdentity(pending.physicalLevelData, 'level-data') : null,
    preparedBeforeReadinessTest: Boolean(pending?.reconstructor && keyframes?.a && keyframes?.b),
    sourceAvailable: pending ? Boolean(createGpuWeatherPresentationSource(
      { progress: keyframes?.progress ?? 0 },
      keyframes?.a,
      keyframes?.b,
      {
        topology: pending.topology,
        levelData: pending.levelData,
        presentationLevel: pending.levelData?.level,
        reconstructor: pending.reconstructor,
        summaryBackend: pending.summaryBackend
      }
    )) : null
  };
}

function gpuWeatherKeyframesHavePresentationLevels(keyframes, levels) {
  return gpuWeatherKeyframesReadinessDetails(keyframes, levels).ready;
}

function createGpuPhysicalSummaryForStableLevel(topology, level, relationReuseSource = gpuPhysicalSummaryBackend) {
  const levels = gpuSummaryLevelsForStableLevel(level);
  if (!levels.length) return null;
  const phaseExit = beginGpuWeatherPhase('physical-summary-construction', { level, levels });
  const started = performance.now();
  const backend = new GpuPhysicalSummaryBackend(gpuWeatherGl(), topology, {
    maximumLevels: levels,
    relationReuseSource
  });
  runtimeDiagnostics?.recordEvent('gpu-physical-summary-construction', {
    stableLevel: level,
    levels,
    durationMs: performance.now() - started,
    timings: backend.constructionTimings,
    relationReuseSource: relationReuseSource?.destroyed ? null : gpuWeatherLifecycleIdentity(relationReuseSource, 'summary-backend')
  });
  phaseExit({ status: 'constructed', level, levels });
  return backend;
}

function destroyGpuPhysicalSummaryBackend(backend, reason = 'unspecified') {
  if (!backend) return null;
  const started = performance.now();
  const timings = backend.destroy();
  runtimeDiagnostics?.recordEvent('gpu-physical-summary-destruction', {
    reason,
    durationMs: performance.now() - started,
    timings
  });
  return timings;
}

// Diagnostics aggregate backend-reported relation identities only. The
// physical-summary module remains the sole owner of relation textures and
// reference counts; app.js never retains or releases an individual relation.
function gpuPhysicalSummaryRelationMemoryDiagnostics(activeDiagnostics, pendingDiagnostics) {
  const backends = [
    ['active', activeDiagnostics],
    ['pending', pendingDiagnostics]
  ].filter(([, diagnostics]) => diagnostics?.active);
  const unique = new Map();
  let logicalBytes = 0;
  for (const [owner, diagnostics] of backends) {
    for (const level of Object.values(diagnostics.levels || {})) {
      logicalBytes += level.relationMetadataGpuBytes || 0;
      const id = level.relationResourceId;
      if (id !== undefined && !unique.has(id)) unique.set(id, {
        bytes: level.relationMetadataGpuBytesUnique || level.relationMetadataGpuBytes || 0,
        owners: [owner]
      });
      else if (id !== undefined) unique.get(id).owners.push(owner);
    }
  }
  const uniqueBytes = [...unique.values()].reduce((total, relation) => total + relation.bytes, 0);
  return {
    backendCount: backends.length,
    overlapping: backends.length > 1,
    logicalRelationBytesReferenced: logicalBytes,
    uniquePhysicalRelationBytes: uniqueBytes,
    sharedRelationBytes: Math.max(0, logicalBytes - uniqueBytes),
    uniqueRelationResourceCount: unique.size,
    resources: [...unique.entries()].map(([relationResourceId, relation]) => ({
      relationResourceId,
      bytes: relation.bytes,
      owners: relation.owners
    }))
  };
}

function reconstructGpuWeatherKeyframe(reconstructor, summaryBackend, level, topology, index, slot) {
  const physicalFrame = activeWeatherField.prepareFrame(index / TEMPORAL_FRAME_COUNT);
  reconstructor.update(physicalFrame, { measureGpu: diagnosticsEnabled, targetSlot: slot });
  const presentations = new Map();
  const directLevel = reconstructor.levelData?.level;
  if (directLevel !== undefined) {
    presentations.set(directLevel, {
      kind: 'physical',
      texture: reconstructor.outputs[slot],
      coverageTexture: reconstructor.outputs[slot],
      levelData: topology.levels.get(directLevel)
    });
  }
  const result = {
    index,
    slot,
    texture: reconstructor.outputs[slot],
    presentations,
    reconstructor,
    topology,
    levelData: reconstructor.levelData
  };
  // L13 remains the direct physical reference for stable L10-L13. When the
  // working set includes an adjacent coarse endpoint, the same summary chain
  // is reconstructed from this direct pair even if the stable published
  // endpoint is L13.
  if (summaryBackend) {
    summaryBackend.reconstruct({
      texture: reconstructor.outputs[slot],
      topology,
      levelData: reconstructor.levelData
    }, { targetSlot: slot, measureGpu: diagnosticsEnabled });
    // The recursive pass above populates every retained endpoint in one
    // backend-owned chain. Refresh the records after that pass; no temporal
    // reconstruction or texture copy is performed here.
    for (const [summaryLevel, output] of summaryBackend.outputs) {
      const summaryOutput = output.slots[slot];
      presentations.set(summaryLevel, {
        kind: 'summary',
        texture: summaryOutput.values,
        coverageTexture: summaryOutput.coverage,
        levelData: topology.levels.get(summaryLevel)
      });
    }
    if (level < WEATHER_REFERENCE_LEVEL) {
      const summaryPresentation = presentations.get(level);
      if (!summaryPresentation) throw new Error(`GPU physical summary output L${level} is unavailable.`);
      result.summary = {
        texture: summaryPresentation.texture,
        coverageTexture: summaryPresentation.coverageTexture
      };
    }
  }
  return result;
}

function gpuWeatherKeyframesFor(reconstructor, normalizedTime, { topology, level, summaryBackend, pending = null } = {}) {
  const frame = geographicTemporalFrameAt(normalizedTime);
  const next = [null, null];
  const drawCountBefore = pending ? reconstructor?.diagnostics()?.gpu?.drawCount || 0 : 0;
  for (const [position, index] of [frame.index, frame.nextIndex].entries()) {
    next[position] = reconstructGpuWeatherKeyframe(reconstructor, summaryBackend, level, topology, index, position);
  }
  if (pending) {
    const drawCountAfter = reconstructor?.diagnostics()?.gpu?.drawCount || drawCountBefore;
    const drawCount = Math.max(0, drawCountAfter - drawCountBefore);
    pending.reconstructionDraws = (pending.reconstructionDraws || 0) + drawCount;
    gpuWeatherSpatialStats.pendingPreparationReconstructionDraws += drawCount;
  }
  return { a: next[0], b: next[1], progress: frame.progress };
}

function gpuWeatherGrowthWindow(activeWindow, targetWindow) {
  const minX = Math.min(activeWindow.minX, targetWindow.minX);
  const maxX = Math.max(activeWindow.maxX, targetWindow.maxX);
  const minY = Math.min(activeWindow.minY, targetWindow.minY);
  const maxY = Math.max(activeWindow.maxY, targetWindow.maxY);
  const spanX = Math.max(maxX - minX, 1);
  const spanY = Math.max(maxY - minY, 1);
  // Reuse the existing 25% viewport overscan proportion around the union of
  // the committed and requested windows. One growth commit therefore carries
  // deterministic spatial slack for the next small camera movement.
  return normalizeCanonicalWindow({
    minX: minX - spanX * 0.25,
    maxX: maxX + spanX * 0.25,
    minY: minY - spanY * 0.25,
    maxY: maxY + spanY * 0.25
  });
}

function trimGpuWeatherTileCache(keepTileIds = []) {
  gpuWeatherProviderResidency?.trimPayloadCache?.(keepTileIds);
}

function gpuWeatherPendingIsCurrent(pending) {
  return gpuWeatherPendingSpatial === pending
    && !pending?.cancelled
    && pending.status !== 'terminal'
    && pending.generation === gpuWeatherLifecycleGeneration;
}

function releaseGpuWeatherPendingResources(pending) {
  if (!pending || pending.resourcesTransferred) return Boolean(pending?.resourcesReleased);
  let cleanupDeferred = false;
  if (pending.reconstructor && !pending.reconstructorReleased) {
    if (pending.preparationSettled) {
      pending.reconstructor.destroy();
      pending.reconstructor = null;
      pending.reconstructorReleased = true;
    } else cleanupDeferred = true;
  }
  if (pending.summaryBackend && !pending.summaryBackendReleased) {
    destroyGpuPhysicalSummaryBackend(pending.summaryBackend, 'terminal-pending-cleanup');
    pending.summaryBackend = null;
    pending.summaryBackendReleased = true;
  }
  pending.cleanupDeferred = cleanupDeferred;
  pending.resourcesReleased = !pending.reconstructor && !pending.summaryBackend;
  return pending.resourcesReleased;
}

function terminalizeGpuWeatherPending(pending, reason, { stale = false, operation = 'pending-terminal-cleanup' } = {}) {
  if (!pending || pending.status === 'committed') return false;
  const firstTerminal = pending.status !== 'terminal';
  pending.status = 'terminal';
  pending.cancelled = true;
  pending.terminalReason = pending.terminalReason || reason;
  const resourcesReleased = releaseGpuWeatherPendingResources(pending);
  const ownsPending = gpuWeatherPendingSpatial === pending
    && pending.generation === gpuWeatherLifecycleGeneration;
  if (ownsPending) gpuWeatherPendingSpatial = null;
  if (firstTerminal || (resourcesReleased && !pending.terminalCleanupCompleteTraced)) {
    traceGpuWeatherLifecycle(operation, {
      pending,
      action: resourcesReleased ? 'dispose-complete' : 'invalidate',
      stale: stale || !ownsPending,
      reason: pending.terminalReason
    });
    if (resourcesReleased) pending.terminalCleanupCompleteTraced = true;
  }
  if (ownsPending) updateTimelineResidency();
  return ownsPending;
}

function prepareGpuWeatherSpatialState(pending) {
  const phaseExit = beginGpuWeatherPhase('normal-spatial-candidate-preparation', {
    generation: pending.generation,
    level: pending.levelData?.level ?? null,
    window: pending.window
  });
  const prepareStarted = performance.now();
  traceGpuWeatherLifecycle('pending-prepare-start', { pending, action: 'prepare' });
  const summaryStarted = performance.now();
  const summaryBackend = createGpuPhysicalSummaryForStableLevel(
    pending.topology,
    pending.levelData.level,
    gpuPhysicalSummaryBackend
  );
  const summaryConstructionMs = performance.now() - summaryStarted;
  pending.summaryBackend = summaryBackend;
  pending.summaryConstructionMs = summaryConstructionMs;
  const reconstructorStarted = performance.now();
  if (!gpuWeatherProviderResidency) throw new Error('GPU weather provider residency is unavailable for target preparation.');
  return GpuTemporalTileReconstructor.create({
    metadataUrl: ACTIVE_REAL_WEATHER_METADATA_URL,
    generationId: activeWeatherField.generationId,
    levelData: pending.physicalLevelData,
    sequence: activeWeatherField,
    procedural: true,
    gl: gpuWeatherGl(),
    provider: gpuWeatherProviderResidency
  }).then(async (reconstructor) => {
    const reconstructorCreationMs = performance.now() - reconstructorStarted;
    pending.reconstructor = reconstructor;
    pending.reconstructorCreationMs = reconstructorCreationMs;
    pending.reconstructorConstructorMs = reconstructor.diagnostics().uploads.constructorMs || 0;
    const residencyStarted = performance.now();
    await reconstructor.ensureResident();
    const residencyWaitMs = reconstructor.diagnostics().uploads.latestSpatialAsyncWaitMs || 0;
    const residencySynchronousMs = reconstructor.diagnostics().uploads.latestSpatialSynchronousMs || 0;
    const residencyMs = performance.now() - residencyStarted;
    pending.temporalAsyncWaitMs = residencyWaitMs;
    pending.temporalSynchronousMs = residencySynchronousMs;
    pending.preparationSettled = true;
    if (!gpuWeatherPendingIsCurrent(pending)) {
      terminalizeGpuWeatherPending(pending, 'superseded before temporal residency completed', { stale: true, operation: 'pending-prepare-complete' });
      trimGpuWeatherTileCache(gpuWeatherTileReconstructor?.diagnostics().residentTileIds || []);
      return null;
    }
    const keyframesStarted = performance.now();
    const physicalPhaseExit = beginGpuWeatherPhase('normal-physical-ab-reconstruction', {
      generation: pending.generation,
      level: pending.levelData.level
    });
    try {
      pending.keyframes = gpuWeatherKeyframesFor(reconstructor, state.time / LOOP_SECONDS, {
        topology: pending.topology,
        level: pending.levelData.level,
        summaryBackend,
        pending
      });
    } finally {
      physicalPhaseExit({ status: 'reconstructed', generation: pending.generation });
    }
    runtimeDiagnostics?.recordEvent('gpu-weather-spatial-prepare', {
      generation: pending.generation,
      stableLevel: pending.levelData.level,
      totalMs: performance.now() - prepareStarted,
      summaryConstructionMs,
      reconstructorCreationMs,
      reconstructorConstructorMs: reconstructor.diagnostics().uploads.constructorMs || 0,
      temporalResidencyMs: residencyMs,
      temporalAsyncWaitMs: residencyWaitMs,
      temporalSynchronousMs: residencySynchronousMs,
      temporalTextureArrayAllocationMs: reconstructor.diagnostics().uploads.latestTextureArrayAllocationMs || 0,
      temporalTileUploadSubmissionMs: reconstructor.diagnostics().uploads.latestTileUploadSubmissionMs || 0,
      temporalResidencyPublicationMs: reconstructor.diagnostics().uploads.latestResidencyPublicationMs || 0,
      temporalKeyframePreparationMs: performance.now() - keyframesStarted,
      requiredTileCount: reconstructor.diagnostics().requiredGeometricTileCount,
      residentTileCount: reconstructor.diagnostics().residentTileCount,
      residentRainSourceBytes: reconstructor.diagnostics().residentRainSourceBytes,
      residentMotionSourceBytes: reconstructor.diagnostics().residentMotionSourceBytes
    });
    pending.status = 'ready';
    traceGpuWeatherLifecycle('pending-prepare-complete', { pending, action: 'prepare' });
    return { reconstructor, summaryBackend, keyframes: pending.keyframes };
  }).finally(() => {
    phaseExit({
      status: pending.status,
      generation: pending.generation,
      cancelled: pending.cancelled,
      resourcesReleased: pending.resourcesReleased
    });
  });
}

function gpuWeatherSpatialStateReadinessReason(pending) {
  if (!pending?.levelData) return 'pending-level-data-unavailable';
  if (!pending.reconstructor) return 'pending-reconstructor-unavailable';
  const residency = pending.reconstructor.diagnostics() || null;
  if (!residency?.active) return 'pending-reconstructor-inactive';
  // `requiredGeometricTileCount` includes deterministic safely omitted tiles;
  // a resident count below it is valid and already part of the tile contract.
  if (residency.residentTileCount > residency.requiredGeometricTileCount) return 'pending-residency-count-inconsistent';
  const requiredPresentationLevels = gpuWeatherTransitionReadyPresentationLevels(pending.levelData.level);
  const presentationReadiness = gpuWeatherKeyframesReadinessDetails(pending.keyframes, requiredPresentationLevels, pending);
  pending.presentationReadiness = presentationReadiness;
  if (!presentationReadiness.ready) {
    return 'pending-presentation-keyframes-incomplete';
  }
  return null;
}

function gpuWeatherSpatialStateReady(pending) {
  return gpuWeatherSpatialStateReadinessReason(pending) === null;
}

function gpuWeatherSettledSpatialInvariant(activeWindow, targetWindow, stableCommittedGpu, pending) {
  if (!stableCommittedGpu || pending || !activeWindow || !targetWindow) return null;
  const activeMetrics = canonicalWindowMetrics(activeWindow, state.lod?.level || GPU_WEATHER_LEVEL);
  const targetMetrics = canonicalWindowMetrics(targetWindow, state.lod?.level || GPU_WEATHER_LEVEL);
  const retainedTargetAreaRatio = targetMetrics.area ? activeMetrics.area / targetMetrics.area : 1;
  const materiallyUncovered = !canonicalWindowContains(activeWindow, targetWindow)
    || retainedTargetAreaRatio < 0.9;
  if (!materiallyUncovered) return null;
  return {
    message: 'Stable GPU weather target materially exceeds the active window without a pending replacement owner.',
    activeWindow,
    targetWindow,
    retainedTargetAreaRatio
  };
}

function createGpuWeatherPresentationSource(frame, physicalA, physicalB, {
  topology = geographicWeatherPyramid?.topology,
  levelData = state.levelData,
  presentationLevel = levelData?.level,
  reconstructor = gpuWeatherTileReconstructor,
  summaryBackend = gpuPhysicalSummaryBackend
} = {}) {
  const presentationLevelData = topology?.levels.get(presentationLevel)
    || (levelData?.level === presentationLevel ? levelData : null);
  const presentationA = physicalA?.presentations?.get(presentationLevel);
  const presentationB = physicalB?.presentations?.get(presentationLevel);
  if (!presentationLevelData || !presentationA?.texture || !presentationB?.texture) return null;
  if ((presentationA.levelData && presentationA.levelData !== presentationLevelData)
    || (presentationB.levelData && presentationB.levelData !== presentationLevelData)) return null;
  if (presentationA.kind !== presentationB.kind) return null;
  const summary = presentationA.kind === 'summary';
  if (summary && (!presentationA.coverageTexture || !presentationB.coverageTexture)) return null;
  return {
    kind: summary ? 'summary' : 'physical',
    textureA: presentationA.texture,
    textureB: presentationB.texture,
    coverageTextureA: summary ? presentationA.coverageTexture : presentationA.texture,
    coverageTextureB: summary ? presentationB.coverageTexture : presentationB.texture,
    physicalTextureA: physicalA.texture,
    physicalTextureB: physicalB.texture,
    progress: frame.progress,
    width: presentationLevelData.width,
    height: presentationLevelData.height,
    format: summary ? 'RGBA16F+RG16F' : 'R16F',
    topology,
    levelData: presentationLevelData,
    presentationLevel,
    reconstructor,
    summaryBackend,
    physicalOwnerA: physicalA,
    physicalOwnerB: physicalB
  };
}

function gpuWeatherPresentationSourceOwnership(source) {
  return {
    source: gpuWeatherLifecycleIdentity(source, 'source'),
    topology: gpuWeatherLifecycleIdentity(source?.topology, 'topology'),
    levelData: gpuWeatherLifecycleIdentity(source?.levelData, 'level-data'),
    reconstructor: gpuWeatherLifecycleIdentity(source?.reconstructor, 'reconstructor'),
    reconstructionTarget: gpuWeatherLifecycleIdentity(source?.reconstructor, 'reconstruction-target'),
    providerResidency: gpuWeatherLifecycleIdentity(source?.reconstructor?.provider, 'provider-residency'),
    reconstructorLive: source?.reconstructor ? Boolean(source.reconstructor.layout) : null,
    summaryBackend: gpuWeatherLifecycleIdentity(source?.summaryBackend, 'summary-backend'),
    summaryBackendLive: source?.summaryBackend ? source.summaryBackend.destroyed !== true : null,
    physicalOwnerA: gpuWeatherLifecycleIdentity(source?.physicalOwnerA, 'physical-owner'),
    physicalOwnerB: gpuWeatherLifecycleIdentity(source?.physicalOwnerB, 'physical-owner')
  };
}

function publishGpuWeatherPresentationSource(source, presentationTimestamp = null, {
  requestRepaint = true,
  origin = 'playback',
  commitState = false,
  time = state.time / LOOP_SECONDS
} = {}) {
  // A spatial commit is the one case where both renderers are intentionally
  // preflighted against a not-yet-committed owner. A source-only update must
  // use each renderer's current identities; otherwise an equivalent-looking
  // but stale topology/level descriptor can be retried forever.
  const compatibilityOptions = commitState
    ? {
      topology: source?.topology,
      levelData: source?.levelData
    }
    : {};
  const dotsCompatibility = weatherLayer?.gpuWeatherSourceCompatibilityDetails?.(source, compatibilityOptions) || {
    compatible: false, failedPredicates: ['dots-renderer-unavailable']
  };
  const squaresCompatibility = squaresLayer?.gpuWeatherSourceCompatibilityDetails?.(source, compatibilityOptions) || {
    compatible: false, failedPredicates: ['squares-renderer-unavailable']
  };
  const compatible = dotsCompatibility.compatible && squaresCompatibility.compatible;
  if (!compatible) {
    // A pending spatial replacement must never invalidate the committed
    // source. The caller will publish only after both renderers carry the new
    // topology and level data.
    gpuWeatherTimelineStats.presentationDeferredCount++;
    const deferredSignature = [
      gpuWeatherLifecycleIdentity(source?.topology, 'topology'),
      gpuWeatherLifecycleIdentity(source?.levelData, 'level-data'),
      gpuWeatherLifecycleIdentity(weatherLayer?.topology, 'topology'),
      gpuWeatherLifecycleIdentity(weatherLayer?.levelData, 'level-data'),
      gpuWeatherLifecycleIdentity(squaresLayer?.topology, 'topology'),
      gpuWeatherLifecycleIdentity(squaresLayer?.levelData, 'level-data'),
      source?.kind || null,
      commitState ? 'commit' : 'source'
    ].join('|');
    if (deferredSignature === gpuWeatherLastDeferredSourceSignature) {
      gpuWeatherTimelineStats.presentationDeferredSuppressedCount++;
    } else {
      gpuWeatherLastDeferredSourceSignature = deferredSignature;
      runtimeDiagnostics?.recordEvent('gpu-weather-source-deferred', {
        expectedTopology: source?.topology?.canonicalWindow || null,
        expectedLevelData: source?.levelData?.level ?? null,
        expectedTopologyIdentity: gpuWeatherLifecycleIdentity(source?.topology, 'topology'),
        expectedLevelDataIdentity: gpuWeatherLifecycleIdentity(source?.levelData, 'level-data'),
        dotsTopology: weatherLayer?.topology?.canonicalWindow || null,
        dotsLevelData: weatherLayer?.levelData?.level ?? null,
        dotsTopologyIdentity: gpuWeatherLifecycleIdentity(weatherLayer?.topology, 'topology'),
        dotsLevelDataIdentity: gpuWeatherLifecycleIdentity(weatherLayer?.levelData, 'level-data'),
        squaresTopology: squaresLayer?.topology?.canonicalWindow || null,
        squaresLevelData: squaresLayer?.levelData?.level ?? null,
        squaresTopologyIdentity: gpuWeatherLifecycleIdentity(squaresLayer?.topology, 'topology'),
        squaresLevelDataIdentity: gpuWeatherLifecycleIdentity(squaresLayer?.levelData, 'level-data'),
        dotsCompatibility,
        squaresCompatibility,
        sourceOwnership: gpuWeatherPresentationSourceOwnership(source),
        currentDotsSourceOwnership: gpuWeatherPresentationSourceOwnership(weatherLayer?.gpuWeatherSource),
        currentSquaresSourceOwnership: gpuWeatherPresentationSourceOwnership(squaresLayer?.gpuWeatherSource)
      });
    }
    updateTimelineResidency();
    return null;
  }
  gpuWeatherLastDeferredSourceSignature = null;
  if (commitState) {
    weatherLayer.setGpuWeatherCommittedState(source.topology, source.levelData, source, time);
    squaresLayer.setGpuWeatherCommittedState(source.topology, source.levelData, source, time);
  } else {
    weatherLayer.setGpuWeatherSource(source, { requestRepaint: false });
    squaresLayer.setGpuWeatherSource(source, { requestRepaint: false });
  }
  if (fixedL13ChunkPathActive() && source?.presentationLevel === GPU_WEATHER_L13_CHUNK_LEVEL) {
    gpuWeatherL13ChunkStats.publicationCount += 1;
    if (!gpuWeatherL13ChunkStats.initialResourceIdentity) {
      gpuWeatherL13ChunkStats.initialResourceIdentity = fixedL13ChunkResourceIdentity(source);
    }
  }
  traceGpuWeatherLifecycle(commitState ? 'renderer-committed-source' : 'renderer-source-update', {
    source,
    action: 'publish'
  });
  return recordAcceptedGpuWeatherPresentation(source, presentationTimestamp, { requestRepaint, origin });
}

function gpuWeatherPresentationSourceMatches(source, physicalA, physicalB, topology, levelData) {
  const presentationLevel = levelData?.level;
  const presentationA = physicalA?.presentations?.get(presentationLevel);
  const presentationB = physicalB?.presentations?.get(presentationLevel);
  if (!source || !presentationA || !presentationB) return false;
  return source.topology === topology
    && source.levelData === levelData
    && source.presentationLevel === presentationLevel
    && source.kind === (presentationA.kind === 'summary' ? 'summary' : 'physical')
    && presentationA.kind === presentationB.kind
    && source.textureA === presentationA.texture
    && source.textureB === presentationB.texture
    && source.coverageTextureA === (presentationA.kind === 'summary' ? presentationA.coverageTexture : presentationA.texture)
    && source.coverageTextureB === (presentationB.kind === 'summary' ? presentationB.coverageTexture : presentationB.texture);
}

function refreshGpuWeatherLodTransitionSources(frame) {
  const transition = state.lodTransition;
  if (!transition || transition.owner !== 'gpu') return null;
  const endpoints = gpuWeatherTransitionEndpointSources(transition.fromLevelData, transition.toLevelData);
  if (!endpoints) return null;
  const samePair = transition.fromSource?.textureA === endpoints.fromSource.textureA
    && transition.fromSource?.textureB === endpoints.fromSource.textureB
    && transition.toSource?.textureA === endpoints.toSource.textureA
    && transition.toSource?.textureB === endpoints.toSource.textureB;
  if (samePair) {
    transition.fromSource.progress = frame.progress;
    transition.toSource.progress = frame.progress;
    return transition;
  }
  transition.fromSource = endpoints.fromSource;
  transition.toSource = endpoints.toSource;
  weatherLayer.setGpuWeatherTransition({
    topology: endpoints.topology,
    fromSource: transition.fromSource,
    toSource: transition.toSource,
    fineLevelData: endpoints.fineLevelData,
    progress: smoothstep(0, 1, transition.rawProgress)
  }, { requestRepaint: false });
  squaresLayer.setGpuWeatherTransition({
    topology: endpoints.topology,
    fromSource: transition.fromSource,
    toSource: transition.toSource,
    progress: smoothstep(0, 1, transition.rawProgress)
  }, { requestRepaint: false });
  runtimeDiagnostics?.recordEvent('gpu-weather-lod-transition-temporal-pair', {
    fromLevel: transition.fromLevel,
    toLevel: transition.toLevel,
    temporalA: gpuWeatherKeyframes?.a?.index ?? null,
    temporalB: gpuWeatherKeyframes?.b?.index ?? null
  });
  return transition;
}

function recordAcceptedGpuWeatherPresentation(source, presentationTimestamp, { requestRepaint, origin }) {
  gpuWeatherLastDeferredSourceSignature = null;
  gpuWeatherTimelineStats.presentationUpdates++;
  gpuWeatherTimelineStats.presentationAcceptedCount++;
  if (origin === 'render') gpuWeatherTimelineStats.presentationStateUpdatesFromRender++;
  else gpuWeatherTimelineStats.presentationStateUpdatesFromPlayback++;
  gpuWeatherTimelineStats.lastPresentationAt = presentationTimestamp;
  if (requestRepaint) {
    map.triggerRepaint();
    gpuWeatherTimelineStats.repaintRequests++;
    gpuWeatherTimelineStats.weatherRepaintRequestCount++;
  }
  updateTimelineResidency();
  return source;
}

function commitGpuWeatherSpatialState(pending, prepared) {
  let rejectionReason = null;
  if (!gpuWeatherPendingIsCurrent(pending)) rejectionReason = 'superseded generation';
  else if (!prepared) rejectionReason = 'prepared state unavailable';
  else if (!gpuWeatherUsingGpu) rejectionReason = 'GPU weather is inactive';
  else if (!isGpuWeatherLevel(state.lod?.level)) rejectionReason = 'stable GPU level is unavailable';
  else if (pending.levelData?.level !== state.lod.level) rejectionReason = 'stable level changed';
  else if (state.lodTransition) rejectionReason = 'LOD transition is active';
  else if (!weatherLayer?.gpuWeatherMode) rejectionReason = 'Dots GPU mode is inactive';
  else if (!squaresLayer?.gpuWeatherMode) rejectionReason = 'Squares GPU mode is inactive';
  else if (weatherLayer.transition) rejectionReason = 'Dots renderer transition is active';
  else if (squaresLayer.transition) rejectionReason = 'Squares renderer transition is active';
  if (rejectionReason) {
    pending.commitRejectionReason = rejectionReason;
    traceGpuWeatherLifecycle('pending-publish-rejected', {
      pending,
      action: 'ignore',
      stale: rejectionReason === 'superseded generation',
      reason: rejectionReason
    });
    return false;
  }
  const started = performance.now();
  const temporalPreflightStarted = started;
  const previousWindow = state.canonicalWindow;
  const previousReconstructor = gpuWeatherTileReconstructor;
  const previousSummaryBackend = gpuPhysicalSummaryBackend;
  const topology = pending.topology;
  const levelData = pending.levelData;
  const frame = geographicTemporalFrameAt(state.time / LOOP_SECONDS);
  // A scrub or playback tick may have changed the desired pair while the
  // spatial tiles were loading. Rebuild only the pending physical pair before
  // publication so the new topology never receives an old timeline pair.
  if (!pending.keyframes || pending.keyframes.a?.index !== frame.index || pending.keyframes.b?.index !== frame.nextIndex) {
    pending.keyframes = gpuWeatherKeyframesFor(pending.reconstructor, state.time / LOOP_SECONDS, {
      topology: pending.topology,
      level: pending.levelData.level,
      summaryBackend: prepared.summaryBackend,
      pending
    });
    prepared.keyframes = pending.keyframes;
  }
  rejectionReason = gpuWeatherSpatialStateReadinessReason(pending);
  if (rejectionReason) {
    pending.commitRejectionReason = rejectionReason;
    traceGpuWeatherLifecycle('pending-publish-rejected', {
      pending,
      action: 'ignore',
      stale: false,
      reason: rejectionReason,
      details: pending.presentationReadiness || null
    });
    return false;
  }
  const temporalPreflightMs = performance.now() - temporalPreflightStarted;
  const sourcePreflightStarted = performance.now();
  const source = createGpuWeatherPresentationSource(frame, pending.keyframes.a, pending.keyframes.b, {
    topology,
    levelData,
    reconstructor: prepared.reconstructor,
    summaryBackend: prepared.summaryBackend
  });
  if (!source) rejectionReason = 'presentation source unavailable';
  else if (!weatherLayer?.isGpuWeatherSourceCompatible(source, { topology, levelData })) rejectionReason = 'Dots renderer preflight rejected source';
  else if (!squaresLayer?.isGpuWeatherSourceCompatible(source, { topology, levelData })) rejectionReason = 'Squares renderer preflight rejected source';
  if (rejectionReason) {
    pending.commitRejectionReason = rejectionReason;
    traceGpuWeatherLifecycle('pending-publish-rejected', { pending, action: 'ignore', stale: false, reason: rejectionReason });
    return false;
  }
  const sourcePreflightMs = performance.now() - sourcePreflightStarted;
  // All state mutations are synchronous. No render callback can run between
  // the topology, level-data, and source publication below. The renderers keep
  // their old source until setGpuWeatherCommittedState assigns this complete
  // replacement state.
  const applicationSwapStarted = performance.now();
  geographicWeatherPyramid.setTopology(topology, { preserveCompatibleState: false });
  state.canonicalWindow = pending.window;
  state.canonicalWindowTarget = pending.window;
  state.pendingCanonicalWindow = null;
  state.canonicalWindowLastChange = canonicalWindowChangeKind(previousWindow, pending.window);
  state.canonicalWindowRebuilds += 1;
  state.lod = { level: pending.levelData.level };
  state.levelData = levelData;
  gpuWeatherLevelData = levelData;
  gpuWeatherTileReconstructor = prepared.reconstructor;
  gpuPhysicalSummaryBackend = prepared.summaryBackend || null;
  gpuWeatherKeyframes = { ...prepared.keyframes, progress: frame.progress };
  const applicationStateSwapMs = performance.now() - applicationSwapStarted;
  const rendererSwapStarted = performance.now();
  const published = publishGpuWeatherPresentationSource(source, null, {
    requestRepaint: false,
    origin: 'spatial-replacement',
    commitState: true
  });
  if (!published) throw new Error('GPU weather spatial commit failed renderer preflight.');
  const rendererSwapMs = performance.now() - rendererSwapStarted;
  traceGpuWeatherLifecycle('pending-publish', { pending, source, action: 'publish' });
  pending.reconstructor = null;
  pending.summaryBackend = null;
  pending.prepared = null;
  pending.resourcesTransferred = true;
  pending.resourcesReleased = false;
  pending.status = 'committed';
  if (gpuWeatherPendingSpatial === pending && pending.generation === gpuWeatherLifecycleGeneration) {
    gpuWeatherPendingSpatial = null;
  }
  traceGpuWeatherLifecycle('pending-owner-cleared', {
    pending,
    action: 'commit',
    reason: 'resources transferred to active state'
  });
  gpuWeatherPendingSpatialGeneration += 1;
  state.canonicalWindowRebuildLastMs = performance.now() - started;
  state.canonicalWindowRebuildSamples.push(state.canonicalWindowRebuildLastMs);
  if (state.canonicalWindowRebuildSamples.length > 120) state.canonicalWindowRebuildSamples.shift();
  gpuWeatherSpatialStats.committedSpatialReplacements++;
  gpuWeatherSpatialStats.lastPendingWaitMs = performance.now() - pending.startedAt;
  gpuWeatherSpatialStats.pendingWaitSamples.push(gpuWeatherSpatialStats.lastPendingWaitMs);
  if (gpuWeatherSpatialStats.pendingWaitSamples.length > 120) gpuWeatherSpatialStats.pendingWaitSamples.shift();
  gpuWeatherSpatialStats.spatialReplacementReconstructionDraws += prepared.reconstructor.diagnostics().gpu.drawCount;
  runtimeDiagnostics?.recordEvent('canonical-window-replacement', {
    rebuildCount: state.canonicalWindowRebuilds,
    durationMs: state.canonicalWindowRebuildLastMs,
    pendingWaitMs: gpuWeatherSpatialStats.lastPendingWaitMs,
    change: state.canonicalWindowLastChange,
    gpuStableLevel: pending.levelData.level,
    reusedTileCount: prepared.reconstructor.diagnostics().uploads.reusedTileCount,
    newlyFetchedTileCount: prepared.reconstructor.diagnostics().uploads.newlyFetchedTileCount
  });
  trimGpuWeatherTileCache(prepared.reconstructor.diagnostics().residentTileIds);
  updateTimelineResidency();
  updateLodDiagnostics();
  map.triggerRepaint();
  gpuWeatherTimelineStats.repaintRequests++;
  gpuWeatherTimelineStats.weatherRepaintRequestCount++;
  const predecessorDestroyStarted = performance.now();
  const previousReconstructorDestroyTimings = previousReconstructor?.destroy() || null;
  const previousSummaryDestroyTimings = destroyGpuPhysicalSummaryBackend(previousSummaryBackend, 'completed-gpu-spatial-replacement');
  const predecessorDestroyMs = performance.now() - predecessorDestroyStarted;
  traceGpuWeatherLifecycle('active-predecessor-release', { source, action: 'dispose' });
  runtimeDiagnostics?.recordEvent('gpu-weather-spatial-commit', {
    generation: pending.generation,
    stableLevel: pending.levelData.level,
    totalSynchronousCommitMs: performance.now() - started,
    temporalPreflightMs,
    sourcePreflightMs,
    applicationStateSwapMs,
    rendererSwapMs,
    predecessorDestroyMs,
    previousReconstructorDestroyTimings,
    previousSummaryDestroyTimings,
    asyncPendingWaitMs: pending.temporalAsyncWaitMs,
    synchronousPrepareMs: pending.topologyConstructionMs + (pending.summaryConstructionMs || 0)
      + (pending.reconstructorConstructorMs || 0) + (pending.temporalSynchronousMs || 0),
    pendingLifetimeMs: performance.now() - pending.startedAt
  });
  return true;
}

function requestGpuWeatherSpatialReplacement(targetWindow) {
  if (!gpuWeatherUsingGpu || !isGpuWeatherLevel(state.lod?.level) || state.lodTransition) return false;
  let existing = gpuWeatherPendingSpatial;
  if (existing?.status === 'terminal' || existing?.cancelled) {
    terminalizeGpuWeatherPending(existing, existing.terminalReason || 'terminal pending owner no longer coalescable', { stale: true });
    existing = null;
  }
  if (existing && existing.levelData?.level !== state.lod.level) {
    terminalizeGpuWeatherPending(existing, 'stable LOD changed before spatial publication', { stale: true });
    existing = null;
  }
  const shrink = canonicalWindowContains(state.canonicalWindow, targetWindow)
    && canonicalWindowNeedsShrink(state.canonicalWindow, targetWindow);
  const window = shrink
    ? targetWindow
    : existing && canonicalWindowContains(existing.window, targetWindow)
      ? existing.window
      : gpuWeatherGrowthWindow(existing?.window || state.canonicalWindow, targetWindow);
  gpuWeatherSpatialStats.targetUpdates++;
  state.canonicalWindowTarget = window;
  state.pendingCanonicalWindow = window;
  if (existing && canonicalWindowsEqual(existing.window, window)) {
    if (existing.status === 'ready' && existing.prepared
      && commitGpuWeatherSpatialState(existing, existing.prepared)) return true;
    gpuWeatherSpatialStats.targetUpdatesCoalescedWithoutCommit++;
    updateTimelineResidency();
    return true;
  }
  if (existing) {
    traceGpuWeatherLifecycle('pending-supersede', { pending: existing, action: 'invalidate', stale: true, reason: 'newer spatial target' });
    terminalizeGpuWeatherPending(existing, 'newer spatial target', { stale: true, operation: 'pending-supersede' });
    gpuWeatherSpatialStats.supersededPendingCount++;
  }
  const topologyStarted = performance.now();
  const topology = new GeographicLodTopology(
    window,
    lodRangeForStableLevel(state.lod.level),
    null,
    { deferTransitionParents: true }
  );
  const topologyConstructionMs = performance.now() - topologyStarted;
  const pending = {
    id: gpuWeatherPendingSpatialGeneration + 1,
    generation: ++gpuWeatherLifecycleGeneration,
    window,
    topology,
    levelData: topology.levelDataFor(state.lod.level),
    physicalLevelData: gpuWeatherPhysicalLevelDataFor(topology, state.lod.level),
    startedAt: performance.now(),
    topologyConstructionMs,
    summaryConstructionMs: null,
    reconstructorCreationMs: null,
    temporalAsyncWaitMs: null,
    temporalSynchronousMs: null,
    reconstructor: null,
    keyframes: null,
    cancelled: false,
    status: 'preparing',
    terminalReason: null,
    commitRejectionReason: null,
    preparationSettled: false,
    resourcesTransferred: false,
    resourcesReleased: false,
    reconstructorReleased: false,
    summaryBackendReleased: false,
    cleanupDeferred: false,
    reconstructionDraws: 0,
    presentationReadiness: null,
    terminalCleanupCompleteTraced: false,
    prepared: null,
    promise: null
  };
  gpuWeatherPendingSpatial = pending;
  // The generation captured above is an acceptance token. Trace creation
  // without advancing it, so a completion can compare exactly this token.
  traceGpuWeatherLifecycle('pending-create', { pending, action: 'prepare' });
  gpuWeatherSpatialStats.pendingReplacementCount++;
  updateTimelineResidency();
  pending.promise = prepareGpuWeatherSpatialState(pending).then((prepared) => {
    if (!prepared) return null;
    if (!commitGpuWeatherSpatialState(pending, prepared)) {
      if (pending.commitRejectionReason === 'LOD transition is active') {
        pending.status = 'ready';
        pending.prepared = prepared;
        runtimeDiagnostics?.recordEvent('gpu-weather-spatial-publication-deferred', {
          generation: pending.generation,
          stableLevel: pending.levelData.level,
          reason: pending.commitRejectionReason
        });
        return prepared;
      }
      terminalizeGpuWeatherPending(
        pending,
        pending.commitRejectionReason || 'completion was not accepted for publication',
        { stale: false, operation: 'pending-completion-cleanup' }
      );
      trimGpuWeatherTileCache(gpuWeatherTileReconstructor?.diagnostics().residentTileIds || []);
      return null;
    }
    return prepared;
  }).catch((error) => {
    const wasCurrent = gpuWeatherPendingSpatial === pending && !pending.cancelled;
    if (wasCurrent) {
      runtimeDiagnostics?.recordEvent('gpu-weather-spatial-load-failed', {
        message: error instanceof Error ? error.message : String(error),
        window
      });
    }
    pending.preparationSettled = true;
    terminalizeGpuWeatherPending(pending, error instanceof Error ? error.message : String(error), { stale: !wasCurrent });
    if (gpuWeatherPendingSpatial !== pending) {
      trimGpuWeatherTileCache(gpuWeatherTileReconstructor?.diagnostics().residentTileIds || []);
    }
    traceGpuWeatherLifecycle('pending-prepare-failed', { pending, action: 'observe', stale: !wasCurrent, reason: error instanceof Error ? error.message : String(error) });
    return null;
  });
  return true;
}

function reconcileGpuWeatherSpatialTarget(origin = 'gpu-reactivation') {
  if (!gpuWeatherUsingGpu || !isGpuWeatherLevel(state.lod?.level) || state.lodTransition) return false;
  const phaseExit = beginGpuWeatherPhase('spatial-reactivation-reconcile', {
    origin,
    level: state.lod?.level ?? null
  });
  const activeWindow = state.canonicalWindow;
  const targetWindow = state.canonicalWindowTarget;
  const pendingBefore = gpuWeatherPendingSpatial;
  const contained = Boolean(activeWindow && targetWindow && canonicalWindowContains(activeWindow, targetWindow));
  const needsShrink = contained && canonicalWindowNeedsShrink(activeWindow, targetWindow);
  const replacementRequired = Boolean(activeWindow && targetWindow && (!contained || needsShrink));
  let requested = false;
  if (replacementRequired) {
    requested = requestGpuWeatherSpatialReplacement(targetWindow);
    if (requested) gpuWeatherSpatialStats.gpuReactivationReplacementRequestedCount++;
    gpuWeatherSpatialStats.gpuReactivationReplacementRequiredCount++;
  }
  gpuWeatherSpatialStats.gpuReactivationReconciliationCount++;
  runtimeDiagnostics?.recordEvent('gpu-weather-spatial-reactivation-reconcile', {
    origin,
    activeWindow,
    targetWindow,
    contained,
    needsShrink,
    replacementRequired,
    requestAccepted: requested,
    pendingBefore: pendingBefore?.generation ?? null,
    pendingAfter: gpuWeatherPendingSpatial?.generation ?? null,
    pendingStatus: gpuWeatherPendingSpatial?.status ?? null
  });
  phaseExit({ status: replacementRequired ? 'replacement-requested' : 'already-contained', requestAccepted: requested });
  return requested;
}

async function initializeGpuWeatherPath() {
  if (!gpuWeatherStableStateActive() || !activeWeatherField) return null;
  const initializationGeneration = gpuWeatherInitializationGeneration;
  if (gpuWeatherL13ChunkExperimentEnabled && state.levelData?.level === GPU_WEATHER_L13_CHUNK_LEVEL
    && state.renderMode === 'dots') prepareFixedL13Chunk();
  if (gpuWeatherL13ChunkExperimentEnabled && state.levelData?.level === GPU_WEATHER_L13_CHUNK_LEVEL
    && state.renderMode === 'dots') {
    const initialized = await initializeGpuWeatherMultiChunkPath();
    if (initialized) {
      gpuWeatherFallbackReason = null;
      updateTimelineResidency();
      return initialized;
    }
    return null;
  }
  const levelData = state.levelData;
  await ensureGpuWeatherResidency(levelData);
  if (initializationGeneration !== gpuWeatherInitializationGeneration
    || state.levelData !== levelData || !gpuWeatherStableStateActive()) return null;
  const stableOwnershipPhaseExit = beginGpuWeatherPhase('gpu-stable-ownership-publication', {
    level: levelData.level
  });
  const requiredSummaryLevels = gpuSummaryLevelsForStableLevel(levelData.level);
  if (requiredSummaryLevels.length) {
    if (!gpuPhysicalSummaryBackend
      || !canonicalWindowsEqual(gpuPhysicalSummaryBackend.topology.canonicalWindow, geographicWeatherPyramid.topology.canonicalWindow)
      || gpuPhysicalSummaryBackend.levels.join(',') !== requiredSummaryLevels.join(',')) {
      const previousSummaryBackend = gpuPhysicalSummaryBackend;
      const nextSummaryBackend = createGpuPhysicalSummaryForStableLevel(
        geographicWeatherPyramid.topology,
        levelData.level,
        previousSummaryBackend
      );
      destroyGpuPhysicalSummaryBackend(previousSummaryBackend, 'replace-gpu-weather-summary-levels');
      gpuPhysicalSummaryBackend = nextSummaryBackend;
    }
  } else if (gpuPhysicalSummaryBackend) {
    gpuPhysicalSummaryBackend.destroy();
    gpuPhysicalSummaryBackend = null;
  }
  if (gpuFirstExperimentEnabled) {
    const releasedPyramidGeometry = geographicWeatherPyramid?.releaseSamplingGeometry(levelData.level) || false;
    runtimeDiagnostics?.recordEvent('gpu-direct-level-pyramid-geometry-release', { level: levelData.level, releasedPyramidGeometry });
  }
  if (!gpuWeatherUsingGpu) {
    weatherLayer.setGpuWeatherMode(true, state.time / LOOP_SECONDS);
    squaresLayer.setGpuWeatherMode(true, state.time / LOOP_SECONDS);
  }
  const frame = geographicTemporalFrameAt(state.time / LOOP_SECONDS);
  const physicalPhaseExit = beginGpuWeatherPhase('normal-physical-ab-reconstruction', {
    level: levelData.level,
    rendererPair: [frame.index, frame.nextIndex]
  });
  let keyframes;
  try {
    keyframes = gpuWeatherKeyframesFor(gpuWeatherTileReconstructor, state.time / LOOP_SECONDS, {
      topology: geographicWeatherPyramid.topology,
      level: levelData.level,
      summaryBackend: gpuPhysicalSummaryBackend
    });
  } finally {
    physicalPhaseExit({ status: 'reconstructed', level: levelData.level });
  }
  const source = createGpuWeatherPresentationSource(frame, keyframes.a, keyframes.b);
  const published = publishGpuWeatherPresentationSource(source, null, { requestRepaint: false });
  if (!published) throw new Error('GPU weather initialization failed renderer preflight.');
  gpuWeatherKeyframes = { ...keyframes, progress: frame.progress };
  // GPU ownership becomes active only after the complete renderer source pair
  // has been published. This prevents a stable GPU diagnostic state from ever
  // observing mode=true with no committed source.
  gpuWeatherUsingGpu = true;
  gpuWeatherFallbackReason = null;
  if (gpuFirstExperimentEnabled) {
    const sourceDiagnostics = weatherLoad.diagnostics();
    runtimeDiagnostics?.recordEvent('gpu-direct-level-stable-ownership', {
      level: levelData.level,
      residentSourceFrames: sourceDiagnostics?.residentSourceFrameCount || 0,
      residentSourceBytes: sourceDiagnostics?.residentSourceBytes || 0,
      dotsCpuBytes: weatherLayer.diagnostics().cpuBytes,
      squaresCpuBytes: squaresLayer.diagnostics().cpuBytes,
      gpuCpuGeometryBytes: gpuWeatherTileReconstructor?.diagnostics().retainedCpuGeometryBytes || 0
    });
  }
  updateTimelineResidency();
  reconcileGpuWeatherSpatialTarget('gpu-reactivation');
  stableOwnershipPhaseExit({ status: 'published', level: levelData.level });
  return gpuWeatherKeyframes;
}

function queueGpuWeatherInitialization(normalizedTime = state.time / LOOP_SECONDS) {
  if (gpuWeatherInitializationPromise) return;
  const promise = initializeGpuWeatherPath();
  gpuWeatherInitializationPromise = promise;
  void promise.then((result) => {
    if (gpuWeatherInitializationPromise === promise) gpuWeatherInitializationPromise = null;
    // A topology/range commit can replace the captured level-data identity
    // before async residency finishes. Retry the current stable target rather
    // than leaving GPU ownership partially initialized.
    if (result === null && gpuWeatherStableStateActive()
      && (!gpuWeatherUsingGpu || gpuWeatherLevelData !== state.levelData)) {
      queueGpuWeatherInitialization(normalizedTime);
    }
  }).catch((error) => {
    if (gpuWeatherInitializationPromise === promise) gpuWeatherInitializationPromise = null;
    disableGpuWeatherPath(normalizedTime, `GPU weather initialization failed: ${error instanceof Error ? error.message : String(error)}`);
    void requestWeatherTime(normalizedTime);
  });
}

function setGpuWeatherPresentation(frame, physicalA, physicalB, presentationTimestamp = null, { requestRepaint = true, origin = 'playback' } = {}) {
  if (state.lodTransition?.owner === 'gpu') {
    const transition = refreshGpuWeatherLodTransitionSources(frame);
    if (!transition) return null;
    gpuWeatherTimelineStats.presentationSourceReuseCount++;
    return recordAcceptedGpuWeatherPresentation(transition.fromSource, presentationTimestamp, { requestRepaint, origin });
  }
  const topology = geographicWeatherPyramid?.topology;
  const levelData = state.levelData;
  const existing = weatherLayer?.gpuWeatherSource;
  if (existing
    && existing === squaresLayer?.gpuWeatherSource
    && gpuWeatherPresentationSourceMatches(existing, physicalA, physicalB, topology, levelData)
    && weatherLayer?.isGpuWeatherSourceCompatible(existing)
    && squaresLayer?.isGpuWeatherSourceCompatible(existing)) {
    // Temporal progress is the only changing value for an unchanged A/B pair.
    // Keep the one shared source object and update it in place; its textures
    // remain owned by the current reconstructor/summary backend.
    existing.progress = frame.progress;
    gpuWeatherTimelineStats.presentationSourceReuseCount++;
    return recordAcceptedGpuWeatherPresentation(existing, presentationTimestamp, { requestRepaint, origin });
  }
  const source = createGpuWeatherPresentationSource(frame, physicalA, physicalB);
  return publishGpuWeatherPresentationSource(source, presentationTimestamp, { requestRepaint, origin });
}

function updateGpuWeatherMultiChunkTime(normalizedTime, { requestRepaint = true, origin = 'playback' } = {}) {
  const started = performance.now();
  const workingSet = gpuWeatherL13Chunk?.activeSet;
  if (!workingSet?.chunks?.length) {
    queueGpuWeatherInitialization(normalizedTime);
    return true;
  }
  const frame = geographicTemporalFrameAt(normalizedTime);
  const current = gpuWeatherKeyframes?.a?.index === frame.index
    && gpuWeatherKeyframes?.b?.index === frame.nextIndex;
  if (current) {
    for (const chunk of workingSet.chunks) chunk.source.progress = frame.progress;
    workingSet.frame = frame;
    gpuWeatherKeyframes.progress = frame.progress;
    gpuWeatherTimelineStats.temporalChanges++;
    gpuWeatherTimelineStats.lastUpdateMs = performance.now() - started;
    if (requestRepaint) map.triggerRepaint();
    return workingSet;
  }
  for (const chunk of workingSet.chunks) prepareGpuWeatherMultiChunkKeyframes(chunk, normalizedTime);
  workingSet.frame = frame;
  gpuWeatherKeyframes = { a: { index: frame.index }, b: { index: frame.nextIndex }, progress: frame.progress };
  gpuWeatherTimelineStats.temporalChanges++;
  gpuWeatherTimelineStats.rendererPairChanges++;
  gpuWeatherTimelineStats.lastUpdateMs = performance.now() - started;
  weatherLayer.setGpuWeatherMultiChunkSources(workingSet.chunks.map((chunk) => chunk.source), { requestRepaint: false });
  if (requestRepaint) map.triggerRepaint();
  runtimeDiagnostics?.recordEvent('gpu-weather-multichunk-temporal-update', {
    origin,
    temporalA: frame.index,
    temporalB: frame.nextIndex,
    progress: frame.progress,
    chunkCount: workingSet.chunks.length
  });
  return workingSet;
}

let gpuWeatherLastRenderSampleTime = null;
function updateGpuWeatherTime(normalizedTime, { presentationTimestamp = null, requestRepaint = true, origin = 'playback' } = {}) {
  if (!gpuWeatherRequestedAtCurrentLevel()) return false;
  if (presentationTimestamp !== null) {
    gpuWeatherTimelineStats.presentationOpportunityCount++;
    const interval = 1000 / gpuWeatherHzCap;
    if (gpuWeatherHzCap && gpuWeatherTimelineStats.lastPresentationAt !== null
      && presentationTimestamp - gpuWeatherTimelineStats.lastPresentationAt < interval) {
      gpuWeatherTimelineStats.presentationSkippedCount++;
      return { status: 'presentation-skipped' };
    }
  }
  if (fixedL13ChunkPathActive()) return updateGpuWeatherMultiChunkTime(normalizedTime, { requestRepaint, origin });
  if (!gpuWeatherUsingGpu || !gpuWeatherTileReconstructor?.layout
    || gpuWeatherLevelData !== state.levelData) {
    queueGpuWeatherInitialization(normalizedTime);
    return true;
  }
  const started = performance.now();
  const frame = geographicTemporalFrameAt(normalizedTime);
  if (gpuWeatherKeyframes?.a?.index === frame.index && gpuWeatherKeyframes?.b?.index === frame.nextIndex) {
    gpuWeatherKeyframes.progress = frame.progress;
    gpuWeatherTimelineStats.temporalChanges++;
    gpuWeatherTimelineStats.lastUpdateMs = performance.now() - started;
    setGpuWeatherPresentation(frame, gpuWeatherKeyframes.a, gpuWeatherKeyframes.b, presentationTimestamp, { requestRepaint, origin });
    return gpuWeatherKeyframes;
  }
  const desired = [frame.index, frame.nextIndex];
  const previous = gpuWeatherKeyframes ? [gpuWeatherKeyframes.a, gpuWeatherKeyframes.b].filter(Boolean) : [];
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
    next[position] = reconstructGpuWeatherKeyframe(
      gpuWeatherTileReconstructor,
      gpuPhysicalSummaryBackend,
      state.lod.level,
      geographicWeatherPyramid.topology,
      desired[position],
      slot
    );
    usedSlots.add(slot);
    gpuWeatherTimelineStats.physicalKeyframeReconstructionDraws++;
  }
  gpuWeatherKeyframes = { a: next[0], b: next[1], progress: frame.progress };
  gpuWeatherTimelineStats.temporalChanges++;
  gpuWeatherTimelineStats.rendererPairChanges++;
  gpuWeatherTimelineStats.lastUpdateMs = performance.now() - started;
  return setGpuWeatherPresentation(frame, next[0], next[1], presentationTimestamp, { requestRepaint, origin });
}

function synchronizeGpuWeatherPresentationForRender() {
  if (!gpuWeatherPresentationSyncMode || gpuWeatherHzCap || !gpuWeatherRequestedAtCurrentLevel()) return;
  const normalizedTime = state.time / LOOP_SECONDS;
  if (gpuWeatherLastRenderSampleTime === normalizedTime) return;
  gpuWeatherLastRenderSampleTime = normalizedTime;
  gpuWeatherTimelineStats.presentationRenderSamples++;
  updateGpuWeatherTime(normalizedTime, { requestRepaint: false, origin: 'render' });
}

function gpuWeatherMultiChunkDiagnostics(workingSet) {
  const chunks = workingSet?.chunks || [];
  const targets = chunks.map((chunk) => chunk.target?.diagnostics?.() || null);
  const sources = chunks.map((chunk) => chunk.source).filter(Boolean);
  const providerRevisionIds = [...new Set(targets.map((target) => target?.targetRevisionId).filter(Number.isInteger))];
  return {
    selectedChunkCount: chunks.length,
    selectedChunkKeys: chunks.map((chunk) => chunk.descriptor.key),
    activeReadyChunkCount: sources.length,
    activeReadyChunkKeys: chunks.filter((chunk) => chunk.source).map((chunk) => chunk.descriptor.key),
    providerRevisionIds,
    reconstructionTargetCount: targets.filter(Boolean).length,
    reconstructionTargetIdentities: chunks.map((chunk) => ({
      chunkKey: chunk.descriptor.key,
      targetId: gpuWeatherLifecycleIdentity(chunk.target, 'reconstruction-target'),
      targetRevisionId: chunk.target?.providerRevision?.revisionId ?? null,
      width: chunk.target?.width ?? null,
      height: chunk.target?.height ?? null,
      physicalABBytes: chunk.target?.diagnostics?.().targetPhysicalOutputBytes || 0,
      sourceReady: Boolean(chunk.source)
    })),
    aggregateTargetPhysicalABBytes: targets.reduce((total, target) => total + (target?.targetPhysicalOutputBytes || 0), 0),
    aggregateTargetPhysicalBytes: targets.reduce((total, target) => total + (target?.targetPhysicalOutputBytes || 0), 0),
    aggregateTargetGpuBytes: targets.reduce((total, target) => total + (target?.totalTargetGpuBytes || 0), 0),
    directPhysicalReconstructionDraws: targets.reduce((total, target) => total + (target?.gpu?.drawCount || 0), 0),
    temporalPair: workingSet?.frame ? {
      a: workingSet.frame.index,
      b: workingSet.frame.nextIndex,
      progress: workingSet.frame.progress
    } : null,
    providerRevisionId: providerRevisionIds.length === 1 ? providerRevisionIds[0] : null
  };
}

function gpuWeatherDiagnostics() {
  const multiWorkingSet = gpuWeatherL13Chunk?.activeSet || null;
  const multiDiagnostics = gpuWeatherMultiChunkDiagnostics(multiWorkingSet);
  const tile = multiWorkingSet?.chunks?.[0]?.target?.diagnostics?.()
    || gpuWeatherTileReconstructor?.diagnostics() || null;
  const provider = gpuWeatherProviderResidency?.diagnostics(
    multiWorkingSet?.chunks?.[0]?.target?.providerRevision || null
  ) || {
    active: false,
    providerRevisionId: null,
    providerOwnerCount: 0,
    providerGpuRainBytes: 0,
    providerGpuMotionBytes: 0,
    providerLookupInfoGpuBytes: 0,
    totalProviderGpuBytes: 0
  };
  const pendingSpatial = gpuWeatherPendingSpatial;
  const pendingLevelData = pendingSpatial?.levelData || null;
  const pendingStateInvariantError = pendingSpatial && !pendingLevelData
    ? 'GPU weather pending spatial state is missing its stable level-data owner.'
    : null;
  if (pendingStateInvariantError && !gpuWeatherPendingInvariantReported) {
    gpuWeatherPendingInvariantReported = true;
    runtimeDiagnostics?.recordEvent('gpu-weather-state-invariant-error', {
      owner: 'pending-spatial',
      message: pendingStateInvariantError,
      pendingGeneration: pendingSpatial.generation ?? null,
      pendingId: pendingSpatial.id ?? null
    });
  } else if (!pendingStateInvariantError) gpuWeatherPendingInvariantReported = false;
  const pendingTile = pendingSpatial?.reconstructor?.diagnostics() || null;
  const dotsDiagnostics = weatherLayer?.diagnostics() || null;
  const squaresDiagnostics = squaresLayer?.diagnostics() || null;
  const stableCommittedGpu = gpuWeatherUsingGpu && isGpuWeatherLevel(state.lod?.level) && !state.lodTransition;
  const multiChunkActive = Boolean(gpuWeatherL13Chunk?.activeSet?.chunks?.length);
  const dotsSource = weatherLayer?.gpuWeatherSource;
  const squaresSource = squaresLayer?.gpuWeatherSource;
  const stableLevel = stableCommittedGpu ? state.lod.level : null;
  const pendingPresentationReadiness = pendingSpatial
    ? (pendingSpatial.presentationReadiness
      || gpuWeatherKeyframesReadinessDetails(
        pendingSpatial.keyframes,
        gpuWeatherTransitionReadyPresentationLevels(pendingLevelData?.level ?? state.lod?.level),
        pendingSpatial
      ))
    : null;
  const settledSpatialInvariant = multiChunkActive ? null : gpuWeatherSettledSpatialInvariant(
    state.canonicalWindow,
    state.canonicalWindowTarget,
    stableCommittedGpu,
    pendingSpatial
  );
  const settledSpatialInvariantSignature = settledSpatialInvariant
    ? JSON.stringify([settledSpatialInvariant.activeWindow, settledSpatialInvariant.targetWindow])
    : null;
  if (settledSpatialInvariantSignature && settledSpatialInvariantSignature !== gpuWeatherSettledSpatialInvariantSignature) {
    gpuWeatherSettledSpatialInvariantSignature = settledSpatialInvariantSignature;
    runtimeDiagnostics?.recordEvent('gpu-weather-spatial-target-without-pending', settledSpatialInvariant);
  } else if (!settledSpatialInvariantSignature) {
    gpuWeatherSettledSpatialInvariantSignature = null;
  }
  const transitionReadyPresentationLevels = state.lodTransition?.owner === 'gpu'
    ? [state.lodTransition.fromLevel, state.lodTransition.toLevel].sort((a, b) => a - b)
    : stableLevel === null
      ? [] : [...gpuWeatherTransitionReadyPresentationLevels(stableLevel)];
  const retainedPresentationLevels = gpuWeatherKeyframes?.a?.presentations
    ? [...gpuWeatherKeyframes.a.presentations.keys()].sort((a, b) => a - b)
    : [];
  const retainedSummaryLevels = gpuPhysicalSummaryBackend?.levels ? [...gpuPhysicalSummaryBackend.levels] : [];
  const physicalSummaryDiagnostics = gpuPhysicalSummaryBackend?.diagnostics() || { active: false };
  const pendingPhysicalSummaryDiagnostics = pendingSpatial?.summaryBackend?.diagnostics() || { active: false };
  const physicalSummaryRelationMemory = gpuPhysicalSummaryRelationMemoryDiagnostics(
    physicalSummaryDiagnostics,
    pendingPhysicalSummaryDiagnostics
  );
  const fixedChunkResource = fixedL13ChunkResourceIdentity(dotsSource);
  const dotsSourceCompatibility = multiChunkActive
    ? { compatible: multiWorkingSet.chunks.every((chunk) => weatherLayer?.gpuWeatherMultiChunkSourceCompatibilityDetails?.(chunk.source)?.compatible === true), failedPredicates: [] }
    : weatherLayer?.gpuWeatherSourceCompatibilityDetails?.(dotsSource) || {
    compatible: false, failedPredicates: ['dots-renderer-unavailable']
  };
  const squaresSourceCompatibility = multiChunkActive
    ? { compatible: true, failedPredicates: ['dots-only-multi-chunk-experiment'] }
    : squaresLayer?.gpuWeatherSourceCompatibilityDetails?.(squaresSource) || {
    compatible: false, failedPredicates: ['squares-renderer-unavailable']
  };
  const hasCommittedSource = multiChunkActive
    ? multiWorkingSet.chunks.length === multiDiagnostics.activeReadyChunkCount
    : Boolean(dotsSource && dotsSource === squaresSource
    && dotsSource.topology === geographicWeatherPyramid?.topology
    && dotsSource.levelData === state.levelData
    && dotsSource.levelData?.level === state.lod?.level
    && dotsSourceCompatibility.compatible
    && squaresSourceCompatibility.compatible);
  if (stableCommittedGpu && tile?.active && !gpuWeatherPendingSpatial && !hasCommittedSource) {
    gpuWeatherSpatialStats.stableCommittedSourcelessSamples++;
    const lifecycleContext = gpuWeatherLifecycleTrace.slice(-16);
    const sourceDiagnostics = {
      dots: dotsSourceCompatibility,
      squares: squaresSourceCompatibility,
      sourceOwnership: gpuWeatherPresentationSourceOwnership(dotsSource),
      squaresSourceOwnership: gpuWeatherPresentationSourceOwnership(squaresSource)
    };
    runtimeDiagnostics?.recordEvent('gpu-weather-stable-source-invariant-error', sourceDiagnostics);
    console.error('Stable GPU weather committed state has no coherent renderer source.', sourceDiagnostics, lifecycleContext);
    throw new Error(`Stable GPU weather committed state has no coherent renderer source. details=${JSON.stringify(sourceDiagnostics)} lifecycle=${JSON.stringify(lifecycleContext)}`);
  }
  gpuWeatherTimelineStats.mapLayerRenderCount = (dotsDiagnostics?.lifecycle?.gpuWeatherRenderCalls || 0)
    + (squaresDiagnostics?.lifecycle?.gpuWeatherRenderCalls || 0);
  return {
    enabled: gpuWeatherExperimentEnabled,
    fixedL13Chunk: {
      experimentEnabled: gpuWeatherL13ChunkExperimentEnabled,
      active: fixedL13ChunkPathActive(),
      suspendedReason: gpuWeatherL13ChunkSuspendedReason,
      level: GPU_WEATHER_L13_CHUNK_LEVEL,
      key: gpuWeatherL13Chunk?.key || null,
      chunkX: gpuWeatherL13Chunk?.chunkX ?? null,
      chunkY: gpuWeatherL13Chunk?.chunkY ?? null,
      extentL10: gpuWeatherL13Chunk?.extentL10 ?? GPU_WEATHER_L13_CHUNK_EXTENT_L10,
      canonicalBounds: gpuWeatherL13Chunk?.canonicalBounds || null,
      preparedCanonicalWindow: gpuWeatherL13Chunk?.canonicalWindow || null,
      l13: fixedL13ChunkSampleIdentity(gpuWeatherL13Chunk?.levelData),
      viewportWindow: gpuWeatherL13Chunk?.viewportWindow || null,
      insideUsefulCoverage: gpuWeatherL13Chunk?.insideUsefulCoverage ?? null,
      multiChunk: multiChunkActive,
      selectedChunkCount: gpuWeatherL13Chunk?.selectedChunkKeys?.length || 0,
      selectedChunkKeys: gpuWeatherL13Chunk?.selectedChunkKeys || [],
      activeReadyChunkCount: multiDiagnostics.activeReadyChunkCount,
      activeReadyChunkKeys: multiDiagnostics.activeReadyChunkKeys,
      candidateGeneration: gpuWeatherL13Chunk?.candidate?.generation ?? null,
      candidateStatus: gpuWeatherL13Chunk?.candidate?.status ?? null,
      candidateChunkKeys: gpuWeatherL13Chunk?.candidate?.descriptors?.map((chunk) => chunk.key) || [],
      activeProviderRevisionId: multiDiagnostics.providerRevisionId,
      liveProviderRevisionCount: provider.providerRevisionCount || 0,
      reconstructionTargetCount: multiDiagnostics.reconstructionTargetCount,
      reconstructionTargetIdentities: multiDiagnostics.reconstructionTargetIdentities,
      aggregateTargetPhysicalABBytes: multiDiagnostics.aggregateTargetPhysicalABBytes,
      chunkSetChangeCount: gpuWeatherL13ChunkStats.chunkSetChangeCount,
      sameSetCameraReuseCount: gpuWeatherL13ChunkStats.cameraMoveReuseCount,
      candidatePublicationCount: gpuWeatherL13ChunkStats.candidatePublicationCount,
      supersededCandidateCount: gpuWeatherL13ChunkStats.supersededCandidateCount,
      directPhysicalReconstructionCount: gpuWeatherL13ChunkStats.directPhysicalReconstructionCount,
      providerBuildDelta: gpuWeatherL13Chunk?.activeSet?.providerBuildDelta || 0,
      providerRainUploadDelta: gpuWeatherL13Chunk?.activeSet?.providerRainUploadDelta || 0,
      providerMotionUploadDelta: gpuWeatherL13Chunk?.activeSet?.providerMotionUploadDelta || 0,
      candidateProviderBuildDelta: gpuWeatherL13Chunk?.candidate?.providerBuildDelta || 0,
      candidateProviderRainUploadDelta: gpuWeatherL13Chunk?.candidate?.providerRainUploadDelta || 0,
      candidateProviderMotionUploadDelta: gpuWeatherL13Chunk?.candidate?.providerMotionUploadDelta || 0,
      creationCount: gpuWeatherL13ChunkStats.creationCount,
      publicationCount: gpuWeatherL13ChunkStats.publicationCount,
      cameraMoveCount: gpuWeatherL13ChunkStats.cameraMoveCount,
      cameraMoveReuseCount: gpuWeatherL13ChunkStats.cameraMoveReuseCount,
      outsidePreparedChunkCount: gpuWeatherL13ChunkStats.outsidePreparedChunkCount,
      viewportOwnedSpatialReplacementCount: gpuWeatherL13ChunkStats.viewportOwnedSpatialReplacementCount,
      cameraMoveTopologyRebuildCount: gpuWeatherL13ChunkStats.cameraMoveTopologyRebuildCount,
      cameraMoveReconstructorRebuildCount: gpuWeatherL13ChunkStats.cameraMoveReconstructorRebuildCount,
      cameraMoveDirectPhysicalReconstructionCount: gpuWeatherL13ChunkStats.cameraMoveDirectPhysicalReconstructionCount,
      cameraMoveProviderResidencyRebuildCount: gpuWeatherL13ChunkStats.cameraMoveProviderResidencyRebuildCount,
      cameraMoveProviderResidencyUploadCount: gpuWeatherL13ChunkStats.cameraMoveProviderResidencyUploadCount,
      providerResidencyCreationCount: gpuWeatherL13ChunkStats.providerResidencyCreationCount,
      providerResidencyIdentity: fixedChunkResource.providerResidency,
      reconstructionTargetIdentity: fixedChunkResource.target,
      currentTemporalPair: multiDiagnostics.temporalPair || (gpuWeatherKeyframes ? {
        a: gpuWeatherKeyframes.a?.index ?? null,
        b: gpuWeatherKeyframes.b?.index ?? null,
        progress: gpuWeatherKeyframes.progress
      } : null),
      temporalRolloverCount: gpuWeatherTimelineStats.rendererPairChanges,
      rendererSourceIdentity: fixedChunkResource.rendererSource,
      physicalResourceIdentity: {
        a: fixedChunkResource.physicalA,
        b: fixedChunkResource.physicalB
      },
      initialResourceIdentity: gpuWeatherL13ChunkStats.initialResourceIdentity,
      lastCameraMove: gpuWeatherL13ChunkStats.lastCameraMove
    },
    active: gpuWeatherUsingGpu,
    path: gpuWeatherUsingGpu ? 'GPU weather experimental' : 'CPU reference',
    fallbackReason: gpuWeatherFallbackReason,
    transitionOwner: state.lodTransition?.owner || null,
    lodTransition: state.lodTransition ? {
      owner: state.lodTransition.owner || 'cpu',
      fromLevel: state.lodTransition.fromLevel,
      toLevel: state.lodTransition.toLevel,
      progress: smoothstep(0, 1, state.lodTransition.rawProgress),
      fromSourceLevel: state.lodTransition.fromSource?.presentationLevel ?? null,
      toSourceLevel: state.lodTransition.toSource?.presentationLevel ?? null,
      fineGridLevel: state.lodTransition.fineLevelData?.level ?? null,
      endpointSourcesComplete: Boolean(state.lodTransition.fromSource?.textureA
        && state.lodTransition.fromSource?.textureB
        && state.lodTransition.toSource?.textureA
        && state.lodTransition.toSource?.textureB),
      drawCallCount: (dotsDiagnostics?.gpuWeather?.transition?.drawCallCount || 0)
        + (squaresDiagnostics?.gpuWeather?.transition?.drawCallCount || 0)
    } : null,
    lodTransitionStats: { ...gpuWeatherLodTransitionStats },
    lastLodTransitionFallback: gpuWeatherLastLodTransitionFallback,
    committedSourceCompatibility: {
      sharedSource: Boolean(dotsSource && dotsSource === squaresSource),
      dots: dotsSourceCompatibility,
      squares: squaresSourceCompatibility,
      dotsOwnership: gpuWeatherPresentationSourceOwnership(dotsSource),
      squaresOwnership: gpuWeatherPresentationSourceOwnership(squaresSource)
    },
    supportedLod: [...GPU_WEATHER_LEVELS],
    activeLevel: stableCommittedGpu ? state.lod.level : null,
    currentTarget: gpuWeatherTileReconstructor ? {
      level: state.lod?.level ?? null,
      physicalSupportLevel: gpuWeatherTileReconstructor.levelData?.level ?? null,
      width: gpuWeatherTileReconstructor.width,
      height: gpuWeatherTileReconstructor.height,
      sampleCount: gpuWeatherTileReconstructor.width * gpuWeatherTileReconstructor.height,
      format: 'R16F',
      byteEstimate: gpuWeatherTileReconstructor.width * gpuWeatherTileReconstructor.height * 2,
      workingSetByteEstimate: gpuWeatherTileReconstructor.width * gpuWeatherTileReconstructor.height * 4
    } : multiChunkActive ? {
      level: GPU_WEATHER_L13_CHUNK_LEVEL,
      physicalSupportLevel: GPU_WEATHER_L13_CHUNK_LEVEL,
      width: multiWorkingSet.chunks[0]?.target?.width || 0,
      height: multiWorkingSet.chunks[0]?.target?.height || 0,
      sampleCount: multiWorkingSet.chunks.reduce((total, chunk) => total + (chunk.target?.width || 0) * (chunk.target?.height || 0), 0),
      format: 'R16F',
      byteEstimate: multiDiagnostics.aggregateTargetPhysicalABBytes / 2,
      workingSetByteEstimate: multiDiagnostics.aggregateTargetPhysicalABBytes
    } : null,
    currentTargets: multiChunkActive ? multiDiagnostics.reconstructionTargetIdentities : null,
    providerResidency: {
      identity: gpuWeatherLifecycleIdentity(gpuWeatherProviderResidency, 'provider-residency'),
      ...provider
    },
    targetMemory: {
      identity: multiChunkActive
        ? multiDiagnostics.reconstructionTargetIdentities.map((target) => target.targetId)
        : gpuWeatherLifecycleIdentity(gpuWeatherTileReconstructor, 'reconstruction-target'),
      physicalABBytes: multiChunkActive ? multiDiagnostics.aggregateTargetPhysicalABBytes : tile?.targetPhysicalOutputBytes || 0,
      auxiliaryBytes: multiChunkActive ? multiDiagnostics.aggregateTargetGpuBytes - multiDiagnostics.aggregateTargetPhysicalABBytes : tile?.targetAuxiliaryGpuBytes || 0,
      totalTargetBytes: multiChunkActive ? multiDiagnostics.aggregateTargetGpuBytes : tile?.totalTargetGpuBytes || 0,
      targetCount: multiChunkActive ? multiDiagnostics.reconstructionTargetCount : gpuWeatherTileReconstructor ? 1 : 0
    },
    reconstruction: (gpuWeatherTileReconstructor || multiChunkActive) ? {
      drawCount: multiChunkActive ? multiDiagnostics.directPhysicalReconstructionDraws : tile.gpu.drawCount,
      latestGpuPassMs: tile.gpu.latestPassMs,
      mainThreadSubmissionMs: gpuWeatherTimelineStats.lastUpdateMs,
      keyframes: gpuWeatherKeyframes ? {
        a: gpuWeatherKeyframes.a?.index ?? null,
        b: gpuWeatherKeyframes.b?.index ?? null,
        progress: gpuWeatherKeyframes.progress,
        retainedPresentationLevels
      } : null,
      targetCount: multiChunkActive ? multiDiagnostics.reconstructionTargetCount : 1
    } : null,
    workingSet: {
      stableActiveLod: stableLevel,
      rendererPublishedPresentationLod: hasCommittedSource
        ? (multiChunkActive ? GPU_WEATHER_L13_CHUNK_LEVEL : dotsSource.levelData.level) : null,
      transitionReadyPresentationLevels,
      retainedPresentationLevels,
      directPhysicalReconstructionLevel: tile?.active
        ? (multiChunkActive ? GPU_WEATHER_L13_CHUNK_LEVEL : gpuWeatherTileReconstructor.levelData?.level ?? null) : null,
      retainedSummaryLevels,
      temporalProviderResidencyCount: provider.active ? 1 : 0,
      directPhysicalReconstructionTargetCount: multiChunkActive ? multiDiagnostics.reconstructionTargetCount : gpuWeatherTileReconstructor ? 1 : 0,
      rendererKeyframeSlots: gpuWeatherKeyframes ? 2 : 0,
      directPhysicalKeyframeGpuBytes: multiChunkActive ? multiDiagnostics.aggregateTargetPhysicalABBytes : tile?.physicalKeyframeWorkingSetByteEstimate || 0,
      summaryKeyframeGpuBytes: physicalSummaryDiagnostics.persistentGpuSummaryBytes || 0,
      providerGpuRainBytes: provider.providerGpuRainBytes || 0,
      providerGpuMotionBytes: provider.providerGpuMotionBytes || 0,
      providerLookupInfoGpuBytes: provider.providerLookupInfoGpuBytes || 0,
      totalProviderGpuBytes: provider.totalProviderGpuBytes || 0,
      targetPhysicalABBytes: multiChunkActive ? multiDiagnostics.aggregateTargetPhysicalABBytes : tile?.targetPhysicalOutputBytes || 0,
      targetAuxiliaryGpuBytes: multiChunkActive ? multiDiagnostics.aggregateTargetGpuBytes - multiDiagnostics.aggregateTargetPhysicalABBytes : tile?.targetAuxiliaryGpuBytes || 0,
      totalTargetGpuBytes: multiChunkActive ? multiDiagnostics.aggregateTargetGpuBytes : tile?.totalTargetGpuBytes || 0,
      targetCount: multiChunkActive ? multiDiagnostics.reconstructionTargetCount : gpuWeatherTileReconstructor ? 1 : 0,
      presentationSourcesBorrowOwnerTextures: true
    },
    presentation: {
      mode: gpuWeatherPresentationMode,
      hzCap: gpuWeatherHzCap,
      sync: gpuWeatherPresentationSyncMode ? 'render' : 'playback',
      dots: dotsDiagnostics ? {
        timing: dotsDiagnostics.gpuPresentationTiming,
        lifecycle: dotsDiagnostics.lifecycle
      } : null,
      squares: squaresDiagnostics ? {
        timing: squaresDiagnostics.gpuPresentationTiming,
        lifecycle: squaresDiagnostics.lifecycle
      } : null
    },
    timeline: { ...gpuWeatherTimelineStats },
    residency: tile,
    physicalSummary: physicalSummaryDiagnostics,
    physicalSummaryRelationMemory,
    spatial: {
      activeLevel: stableCommittedGpu ? state.lod.level : null,
      activeSummaryLevel: stableCommittedGpu && state.lod.level < WEATHER_REFERENCE_LEVEL ? state.lod.level : null,
      activeWindow: state.canonicalWindow,
      pendingWindow: gpuWeatherPendingSpatial?.window || null,
      pendingPhysicalReconstructionLevel: pendingSpatial?.physicalLevelData?.level ?? null,
      pendingSummaryLevel: pendingLevelData?.level < WEATHER_REFERENCE_LEVEL
        ? pendingLevelData.level : null,
      targetWindow: state.canonicalWindowTarget,
      activeRequiredTileCount: tile?.requiredGeometricTileCount || 0,
      activeResidentTileCount: tile?.residentTileCount || 0,
      pendingRequiredTileCount: pendingTile?.requiredGeometricTileCount || 0,
      pendingResidentTileCount: pendingTile?.residentTileCount || 0,
      pendingPhysicalSummary: pendingPhysicalSummaryDiagnostics,
      activeSource: hasCommittedSource,
      pendingReady: Boolean(pendingSpatial && pendingLevelData && gpuWeatherSpatialStateReady(pendingSpatial)),
      pendingReplacement: Boolean(pendingSpatial),
      pendingStatus: pendingSpatial?.status ?? null,
      pendingTerminalReason: pendingSpatial?.terminalReason ?? null,
      pendingResourcesReleased: pendingSpatial?.resourcesReleased ?? false,
      pendingResourcesTransferred: pendingSpatial?.resourcesTransferred ?? false,
      pendingCleanupDeferred: pendingSpatial?.cleanupDeferred ?? false,
      pendingStateInvariantError,
      pendingPresentationReadiness,
      settledTargetWithoutPending: settledSpatialInvariant,
      ...gpuWeatherSpatialStats,
      pendingWaitMs: gpuWeatherSpatialStats.lastPendingWaitMs,
      pendingWaitTiming: numericSummary(gpuWeatherSpatialStats.pendingWaitSamples)
    },
    lifecycle: {
      activeGeneration: gpuWeatherLifecycleGeneration,
      pendingGeneration: gpuWeatherPendingSpatial?.generation ?? null,
      trace: gpuWeatherLifecycleTrace.slice()
    },
    stableGpuCpuWeatherOwned: Boolean(gpuWeatherUsingGpu && (
      (dotsDiagnostics?.cpuBreakdown?.temporalPhysicalSummaryBytes || 0)
      + (dotsDiagnostics?.cpuBreakdown?.mappedPresentationBytes || 0)
      + (squaresDiagnostics?.gpuWeather?.mappedCpuBytes || 0)
      + (tile?.retainedCpuGeometryBytes || 0)
    )),
    stableGpuCpuWeatherBytes: gpuWeatherUsingGpu ? (
      (dotsDiagnostics?.cpuBreakdown?.temporalPhysicalSummaryBytes || 0)
      + (dotsDiagnostics?.cpuBreakdown?.mappedPresentationBytes || 0)
      + (squaresDiagnostics?.gpuWeather?.mappedCpuBytes || 0)
      + (tile?.retainedCpuGeometryBytes || 0)
    ) : 0,
    stableL13CpuWeatherOwned: Boolean(stableCommittedGpu && state.lod.level === 13 && (
      (dotsDiagnostics?.cpuBreakdown?.temporalPhysicalSummaryBytes || 0)
      + (dotsDiagnostics?.cpuBreakdown?.mappedPresentationBytes || 0)
      + (squaresDiagnostics?.gpuWeather?.mappedCpuBytes || 0)
      + (tile?.retainedCpuGeometryBytes || 0)
    )),
    stableL14CpuWeatherOwned: Boolean(stableCommittedGpu && state.lod.level === 14 && (
      (dotsDiagnostics?.cpuBreakdown?.temporalPhysicalSummaryBytes || 0)
      + (dotsDiagnostics?.cpuBreakdown?.mappedPresentationBytes || 0)
      + (squaresDiagnostics?.gpuWeather?.mappedCpuBytes || 0)
      + (tile?.retainedCpuGeometryBytes || 0)
    ))
  };
}

function diagnosticsSnapshot() {
  let source = weatherLoad.diagnostics();
  const raw = rawLayer?.diagnostics() || null;
  const dots = weatherLayer?.diagnostics() || null;
  const squares = squaresLayer?.diagnostics() || null;
  const pyramid = geographicWeatherPyramid?.snapshot() || null;
  const sourceResidentBytes = source?.residentSourceBytes || 0;
  const targetWindowMetrics = state.canonicalWindowTarget
    ? canonicalWindowMetrics(state.canonicalWindowTarget, state.lod?.level || GPU_WEATHER_LEVEL) : null;
  const retainedWindowMetrics = state.canonicalWindow
    ? canonicalWindowMetrics(state.canonicalWindow, state.lod?.level || GPU_WEATHER_LEVEL) : null;
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
      mapMoving: Boolean(map.isMoving?.()),
      mapZooming: Boolean(map.isZooming?.()),
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
      timings: numericSummary(state.canonicalWindowRebuildSamples),
      targetSampleCount: targetWindowMetrics?.count || 0,
      retainedSampleCount: retainedWindowMetrics?.count || 0,
      targetDimensions: targetWindowMetrics ? { width: targetWindowMetrics.width, height: targetWindowMetrics.height } : null,
      retainedDimensions: retainedWindowMetrics ? { width: retainedWindowMetrics.width, height: retainedWindowMetrics.height } : null,
      retainedTargetAreaRatio: targetWindowMetrics?.area ? (retainedWindowMetrics?.area || 0) / targetWindowMetrics.area : 0,
      lastChange: state.canonicalWindowLastChange,
      pending: Boolean(state.pendingCanonicalWindow)
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
      experimentalCanonicalPresentationGeometryGpuBytes: gpuWeatherDiagnostics().residency?.canonicalPresentationGeometryGpuByteEstimate || 0,
      experimentalProceduralGeometryMetadataBytes: gpuWeatherDiagnostics().residency?.proceduralGeometryMetadataByteEstimate || 0,
      experimentalTileGridMetadataGpuBytes: gpuWeatherDiagnostics().residency?.tileGridMetadataGpuByteEstimate || 0,
      stableGpuL14RetainedCpuGeometryBytes: gpuWeatherDiagnostics().residency?.retainedCpuGeometryBytes || 0,
      representationGpuBytes: (dots?.estimatedGpuBufferBytes || 0) + (squares?.estimatedGpuBufferBytes || 0)
    }
  };
}

// Kept deliberately scalar and allocation-light: runtime diagnostics calls this
// only after a detected activity gap or browser lifecycle/context event.
function diagnosticsStallSnapshot() {
  const source = weatherLoad.diagnostics?.() || null;
  const gl = gpuWeatherGl();
  const committedSource = state.renderMode === 'squares'
    ? squaresLayer?.gpuWeatherSource : weatherLayer?.gpuWeatherSource;
  return {
    mapMoving: Boolean(map.isMoving?.()),
    playing: state.playing,
    scrubbing: state.scrubbing,
    rawZoom: map.getZoom?.() ?? null,
    logicalWeatherZoom: state.logicalSamplingZoom,
    stableLod: state.lod?.level ?? null,
    lodTransition: state.lodTransition ? {
      owner: state.lodTransition.owner || 'cpu',
      fromLevel: state.lodTransition.fromLevel,
      toLevel: state.lodTransition.toLevel
    } : null,
    canonicalWindow: state.canonicalWindow || null,
    canonicalWindowTarget: state.canonicalWindowTarget || null,
    gpuWeatherUsingGpu,
    activeRenderMode: state.renderMode,
    committedRendererSource: gpuWeatherPresentationSourceOwnership(committedSource),
    dotsRendererSource: gpuWeatherPresentationSourceOwnership(weatherLayer?.gpuWeatherSource),
    squaresRendererSource: gpuWeatherPresentationSourceOwnership(squaresLayer?.gpuWeatherSource),
    providerResidency: gpuWeatherLifecycleIdentity(gpuWeatherProviderResidency, 'provider-residency'),
    reconstructionTarget: gpuWeatherLifecycleIdentity(gpuWeatherTileReconstructor, 'reconstruction-target'),
    pendingSpatial: gpuWeatherPendingSpatial ? {
      generation: gpuWeatherPendingSpatial.generation,
      status: gpuWeatherPendingSpatial.status,
      hasOwner: true
    } : null,
    lifecycleGeneration: gpuWeatherLifecycleGeneration,
    latestLifecycleEventId: gpuWeatherLifecycleTrace.at(-1)?.id ?? null,
    sourceFrameQueue: source ? {
      highQueueCount: source.highQueueCount ?? source.highPriorityQueueCount ?? null,
      lowQueueCount: source.lowQueueCount ?? source.lowPriorityQueueCount ?? null,
      pendingFetchCount: source.pendingFetchCount ?? source.fetchConcurrency ?? null,
      residentSourceFrameCount: source.residentSourceFrameCount ?? null
    } : null,
    webglContextLost: gl && typeof gl.isContextLost === 'function' ? gl.isContextLost() : null
  };
}

const runtimeDiagnostics = createRuntimeDiagnostics({
  enabled: diagnosticsEnabled,
  getSnapshot: diagnosticsSnapshot,
  getEnvironment: diagnosticsEnvironment,
  getStallSnapshot: diagnosticsStallSnapshot
});
function runDiagnosticCallback(name, callback) {
  return runDiagnosticCallbackWithDiagnostics(name, callback, runtimeDiagnostics);
}
if (runtimeDiagnostics) {
  // Probe MapLibre's existing repaint gate without changing its scheduling
  // semantics. The wrapper is installed only for a diagnostics capture.
  const triggerRepaint = map.triggerRepaint.bind(map);
  map.triggerRepaint = (...args) => {
    runtimeDiagnostics.recordRepaintRequest();
    return triggerRepaint(...args);
  };
}
if (runtimeCadence) window.__dotFieldCadence = runtimeCadence;
const diagnosticsHud = runtimeDiagnostics?.attachHud(lodDiagnostics) || null;
if (runtimeDiagnostics) window.__dotFieldDiagnostics = runtimeDiagnostics;

for (const control of [...renderModeButtons, hazards, timeSlider, playPause]) control.disabled = true;

function activateWeatherField(field) {
  activeWeatherField = field;
  sourceFrameCount = Number.isInteger(field.frameCount) ? field.frameCount : 1;
  timelineResidencyEnabled = Number.isInteger(field.frameCount) && field.frameCount > 1;
  updateTimelineResidency(weatherLoad.diagnostics()?.residentSourceFrameIndices || []);
  rawWeatherField = rawRendererEnabled && typeof field.exactSourceFrameAt === 'function'
    ? field.exactSourceFrameAt(0)
    : field.rawFrame;
  sourceTimestamps = Array.isArray(field.timestamps) ? field.timestamps : [];
  rawLayer = rawRendererEnabled ? new RawWeatherLayer(rawWeatherField) : null;
  // RAW can show its exact initial source frame immediately. A no-RAW startup
  // begins in Dots, whose first two renderer keyframes legitimately require
  // the initial CPU temporal buffer rather than an implicit RAW fallback.
  state.weatherReady = rawRendererEnabled;
  for (const control of [...renderModeButtons, hazards, timeSlider]) control.disabled = false;
  markStartup('first-weather-ready');
  if (state.weatherReady) tryInitializeWeatherLayer();
  if (field.frameCount === undefined) {
    state.weatherReady = true;
    tryInitializeWeatherLayer();
    state.playbackReady = true;
    markStartup('playback-ready');
    return;
  }
  markStartup('initial-playback-buffer-start');
  void weatherLoad.prepareInitialPlaybackBuffer().then(({ frameIndices } = {}) => {
    if (!state.weatherReady) {
      state.weatherReady = true;
      tryInitializeWeatherLayer();
    }
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
  // Keep the latest canonical target authoritative even when the resolved
  // active window is already equal. This path is also used when a deferred
  // camera target is applied as CPU-owned LOD work completes; GPU reactivation
  // reconciles this target against the newly published active residency.
  state.canonicalWindowTarget = canonicalWindow;
  if (canonicalWindowsEqual(canonicalWindow, state.canonicalWindow)) return false;
  const phaseExit = beginGpuWeatherPhase('canonical-window-replacement', {
    change: canonicalWindowChangeKind(state.canonicalWindow, canonicalWindow),
    level: state.lod?.level ?? null
  });
  if (state.lodTransition) {
    state.pendingCanonicalWindow = canonicalWindow;
    phaseExit({ status: 'deferred-during-lod-transition' });
    return false;
  }
  const previousWindow = state.canonicalWindow;
  const gpuStableDirectLevel = gpuWeatherUsingGpu && isGpuWeatherLevel(state.lod.level) && !state.lodTransition;
  if (gpuStableDirectLevel) {
    const requested = requestGpuWeatherSpatialReplacement(canonicalWindow);
    phaseExit({ status: requested ? 'gpu-candidate-requested' : 'gpu-replacement-not-required', requestAccepted: requested });
    return requested;
  }
  const started = performance.now();
  if (!geographicWeatherPyramid.setCanonicalWindow(canonicalWindow, { deferL14TransitionParents: gpuStableDirectLevel })) {
    // The initial camera envelope may equal the fixed-support topology. Record
    // that resolved window even when no topology allocation was necessary.
    state.canonicalWindow = canonicalWindow;
    state.pendingCanonicalWindow = null;
    phaseExit({ status: 'resolved-without-topology-rebuild' });
    return false;
  }
  state.canonicalWindow = canonicalWindow;
  state.canonicalWindowLastChange = canonicalWindowChangeKind(previousWindow, canonicalWindow);
  state.pendingCanonicalWindow = null;
  state.canonicalWindowRebuilds += 1;
  weatherLayer.setTopology(geographicWeatherPyramid.topology);
  squaresLayer.setTopology(geographicWeatherPyramid.topology);
  if (state.lod.level === null) {
    phaseExit({ status: 'topology-rebuilt-without-level-data' });
    return true;
  }
  commitLevelData(state.lod.level, geographicWeatherPyramid.levelDataFor(state.lod.level));
  state.canonicalWindowRebuildLastMs = performance.now() - started;
  state.canonicalWindowRebuildSamples.push(state.canonicalWindowRebuildLastMs);
  if (state.canonicalWindowRebuildSamples.length > 120) state.canonicalWindowRebuildSamples.shift();
  runtimeDiagnostics?.recordEvent('canonical-window-replacement', {
    rebuildCount: state.canonicalWindowRebuilds,
    durationMs: state.canonicalWindowRebuildLastMs,
    change: state.canonicalWindowLastChange,
    gpuStableDirectLevel
  });
  updateLodDiagnostics();
  phaseExit({ status: 'topology-rebuilt', durationMs: state.canonicalWindowRebuildLastMs });
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
  if (gpuWeatherL13ChunkExperimentEnabled && gpuWeatherL13Chunk?.active
    && state.renderMode === 'dots' && state.lod?.level === GPU_WEATHER_L13_CHUNK_LEVEL
    && !state.lodTransition) {
    updateFixedL13ChunkViewport(bounds);
    return;
  }
  const candidate = canonicalWindowFromMercatorBounds(bounds);
  if (canonicalWindowsEqual(candidate, state.canonicalWindow)) {
    state.canonicalWindowTarget = candidate;
    state.pendingCanonicalWindow = null;
    cancelGpuWeatherPendingSpatial();
    return;
  }
  const contained = canonicalWindowContains(state.canonicalWindow, candidate);
  if (contained && !canonicalWindowNeedsShrink(state.canonicalWindow, candidate)) {
    state.canonicalWindowTarget = candidate;
    state.pendingCanonicalWindow = null;
    cancelGpuWeatherPendingSpatial();
    return;
  }
  applyCanonicalWindow(candidate);
}

function updateLodDiagnostics() {
  const zoom = state.logicalSamplingZoom.toFixed(2);
  const transition = state.lodTransition;
  const level = transition
    ? `${transition.fromLevel} → ${transition.toLevel}${transition.owner === 'gpu' ? ' · GPU' : ''}`
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
  const nextLevel = zoomToMercatorGridLevel(state.logicalSamplingZoom);
  if (fixedL13ChunkPathActive() && nextLevel !== GPU_WEATHER_L13_CHUNK_LEVEL) {
    suspendFixedL13Chunk(`desired LOD left L${GPU_WEATHER_L13_CHUNK_LEVEL}`);
  }
  updateCanonicalWindow();
  rebuildSamples(nextLevel);
  updateLodDiagnostics();
}

function commitLevelData(level, levelData) {
  if (gpuWeatherUsingGpu && (!isGpuWeatherLevel(level) || gpuWeatherLevelData !== levelData)) {
    // A level-data identity change is a committed-state replacement, not a
    // source-only update. Leave the stable GPU state before changing the
    // descriptor so GPU ownership and renderer source cannot diverge.
    disableGpuWeatherPath(state.time / LOOP_SECONDS, `CPU reference fallback while committing L${level}`);
  }
  if (!isGpuWeatherLevel(level) && gpuWeatherUsingGpu) {
    disableGpuWeatherPath(state.time / LOOP_SECONDS, `CPU reference fallback outside stable direct levels L${GPU_WEATHER_MIN_LEVEL}–L${GPU_WEATHER_LEVEL}`);
  }
  state.lod = { level };
  state.levelData = levelData;
  weatherLayer.setLevelData(levelData, state.time / LOOP_SECONDS);
  squaresLayer.setLevelData(levelData, state.time / LOOP_SECONDS);
  updateLodDiagnostics();
  if (isGpuWeatherLevel(level) && gpuWeatherExperimentEnabled
    && (state.renderMode === 'dots' || state.renderMode === 'squares')) {
    queueGpuWeatherInitialization(state.time / LOOP_SECONDS);
    void requestWeatherTime(state.time / LOOP_SECONDS);
  }
}

function installGpuWeatherExperiment() {
  if (!gpuWeatherExperimentEnabled || window.__dotFieldGpuWeather) return;
  window.__dotFieldGpuWeather = {
    diagnostics: gpuWeatherDiagnostics,
    async warmup(normalizedTime = state.time / LOOP_SECONDS) {
      if (!gpuWeatherStableStateActive()) throw new Error(`GPU weather is supported only for active stable L${GPU_WEATHER_MIN_LEVEL}–L${GPU_WEATHER_LEVEL} Dots/Squares.`);
      return initializeGpuWeatherPath().then(() => updateGpuWeatherTime(normalizedTime));
    },
    update(normalizedTime = state.time / LOOP_SECONDS) {
      if (!gpuWeatherStableStateActive()) throw new Error(`GPU weather is supported only for active stable L${GPU_WEATHER_MIN_LEVEL}–L${GPU_WEATHER_LEVEL} Dots/Squares.`);
      return updateGpuWeatherTime(normalizedTime);
    },
    async validate(normalizedTime = state.time / LOOP_SECONDS, maximumSamples = 32768) {
      if (!gpuWeatherStableStateActive()) throw new Error(`GPU weather validation requires active stable GPU L${GPU_WEATHER_MIN_LEVEL}–L${GPU_WEATHER_LEVEL}.`);
      await initializeGpuWeatherPath();
      const referenceFrame = activeWeatherField.prepareFrame(normalizedTime);
      const referenceGeometry = prepareGeographicSamplingGeometry(referenceFrame, state.levelData);
      return gpuWeatherTileReconstructor.validate(referenceFrame, { maximumSamples, referenceGeometry });
    },
    validatePhysicalSummary(maximumSamples = 32768) {
      if (!gpuWeatherStableStateActive() || state.levelData?.level !== 13) {
        throw new Error('GPU physical-summary validation requires stable GPU L13.');
      }
      // Validate the committed render state before constructing the diagnostic
      // backend. This hook is intentionally diagnostic-only: an invalid or
      // transitional state must not allocate relation textures or framebuffers.
      const keyframe = gpuWeatherKeyframes?.a;
      const source = weatherLayer?.gpuWeatherSource;
      const squaresSource = squaresLayer?.gpuWeatherSource;
      const committedSource = Boolean(
        gpuWeatherUsingGpu
        && !state.lodTransition
        && gpuWeatherGl()
        && gpuWeatherLevelData === state.levelData
        && gpuWeatherTileReconstructor?.diagnostics()?.active
        && keyframe?.texture
        && gpuWeatherKeyframes?.b?.texture
        && source
        && source === squaresSource
        && weatherLayer?.isGpuWeatherSourceCompatible(source)
        && squaresLayer?.isGpuWeatherSourceCompatible(source)
      );
      if (!committedSource) {
        throw new Error('GPU physical-summary validation requires a committed stable GPU L13 physical keyframe/source.');
      }
      const topology = new GeographicLodTopology(state.canonicalWindow, lodRangeForStableLevel(10));
      const validationBackend = !gpuPhysicalSummaryBackend
        || !canonicalWindowsEqual(gpuPhysicalSummaryBackend.topology.canonicalWindow, topology.canonicalWindow)
        || gpuPhysicalSummaryBackend.levels.join(',') !== GPU_PHYSICAL_SUMMARY_LEVELS.join(',')
        ? new GpuPhysicalSummaryBackend(gpuWeatherGl(), topology)
        : gpuPhysicalSummaryBackend;
      const ownsValidationBackend = validationBackend !== gpuPhysicalSummaryBackend;
      try {
        validationBackend.reconstruct({
          texture: keyframe.texture,
          topology: geographicWeatherPyramid.topology,
          levelData: state.levelData
        }, { targetSlot: 0, measureGpu: diagnosticsEnabled });
        const referenceFrame = activeWeatherField.prepareFrame(keyframe.index / TEMPORAL_FRAME_COUNT);
        const referencePyramid = new GeographicWeatherPyramid(Float32Array, topology);
        const referenceSummaries = referencePyramid.evaluate([10, 11, 12], referenceFrame);
        const validation = {};
        for (const level of [10, 11, 12]) {
          validation[level] = validationBackend.validate(level, referenceSummaries[level], { maximumSamples });
          const readback = validationBackend.readback(level);
          const levelData = topology.levels.get(level);
          const actualSummary = {
            representation: 'dense-summary',
            profile: 'rain-only-display',
            level,
            levelData,
            totalWeight: new Float32Array(levelData.count),
            rainWeightedSumMmh: new Float32Array(levelData.count),
            rainMaxMmh: new Float32Array(levelData.count),
            rainCoverageWeight: [new Float32Array(levelData.count), new Float32Array(levelData.count)]
          };
          for (let index = 0; index < levelData.count; index++) {
            actualSummary.rainWeightedSumMmh[index] = readback.values[index * 4];
            actualSummary.rainMaxMmh[index] = readback.values[index * 4 + 1];
            actualSummary.totalWeight[index] = readback.values[index * 4 + 2];
            actualSummary.rainCoverageWeight[0][index] = readback.coverage[index * 4];
            actualSummary.rainCoverageWeight[1][index] = readback.coverage[index * 4 + 1];
          }
          const cpuDots = mapDotsWeatherSummary(referenceSummaries[level]);
          const gpuDots = mapDotsWeatherSummary(actualSummary);
          const cpuSquares = mapSquaresWeatherSummary(referenceSummaries[level]);
          const gpuSquares = mapSquaresWeatherSummary(actualSummary);
          const maxError = (left, right, fields) => fields.reduce((maximum, field) => {
            for (let index = 0; index < left[field].length; index++) maximum = Math.max(maximum, Math.abs(left[field][index] - right[field][index]));
            return maximum;
          }, 0);
          validation[level].presentation = {
            dotsMaximumAbsoluteError: maxError(cpuDots, gpuDots, ['rainRadius', 'strongRadius']),
            squaresMaximumAbsoluteError: maxError(cpuSquares, gpuSquares, ['rainWetMeanMmh', 'rainCoverage'])
          };
        }
        return { backend: validationBackend.diagnostics(), validation };
      } finally {
        if (ownsValidationBackend) destroyGpuPhysicalSummaryBackend(validationBackend, 'physical-summary-validation');
      }
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
  console.info(`GPU weather Dots/Squares experiment available at ?gpuWeather=1 (GPU-native stationary L10-L13 adjacent transitions; CPU fallback at L13↔L14, hierarchical morphs, and failures). Fixed Dots-only L13 chunk proof: add &gpuWeatherChunkL13=1. Diagnostics: add &gpuWeatherHz=60 to cap presentation, &gpuWeatherPresentation=none for MapLibre-only redraw measurement, or &gpuWeatherPresentationSync=render to sample presentation in the MapLibre render callback.`);
}

// This is intentionally opt-in. It exercises the existing canonical direct-level
// geometry without changing Dots/Squares evaluation below stable GPU levels or
// their CPU transition fallback.
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
            sequence: activeWeatherField,
            sharedTileCache: gpuMotionSharedTileCache
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
    new GeographicLodTopology(initialWindow, lodRangeForStableLevel(initialLevel), null, { deferTransitionParents: true })
  );
  const renderDiagnosticsFor = (type) => runtimeDiagnostics ? {
    enter: () => runtimeDiagnostics.recordWeatherRender(type, 'enter'),
    exit: () => runtimeDiagnostics.recordWeatherRender(type, 'exit')
  } : null;
  weatherLayer = new GeographicDotsLayer(geographicWeatherPyramid, {
    legacyHierarchicalLodMorph: legacyHierarchicalDotsLodMorph,
    renderDiagnostics: renderDiagnosticsFor('dots')
  });
  squaresLayer = new GeographicSquaresLayer(geographicWeatherPyramid, { renderDiagnostics: renderDiagnosticsFor('squares') });
  weatherLayer.setGpuWeatherPresentationEnabled(gpuWeatherPresentationMode !== 'maplibre-only');
  squaresLayer.setGpuWeatherPresentationEnabled(gpuWeatherPresentationMode !== 'maplibre-only');
  weatherLayer.setGpuWeatherTimingEnabled(diagnosticsEnabled);
  squaresLayer.setGpuWeatherTimingEnabled(diagnosticsEnabled);
  if (gpuWeatherPresentationSyncMode) {
    weatherLayer.setGpuWeatherRenderSynchronizer(synchronizeGpuWeatherPresentationForRender);
    squaresLayer.setGpuWeatherRenderSynchronizer(synchronizeGpuWeatherPresentationForRender);
  }
  geographicLayers = [rawLayer, squaresLayer, weatherLayer].filter(Boolean);
  state.canonicalWindow = initialWindow;
  state.canonicalWindowTarget = initialWindow;
  state.canonicalWindowLastChange = 'grow';
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

  if (rawLayer && map.getLayer(rawLayer.id) && map.getLayer(MAPTILER_WATER_BOUNDARY_ID)) {
    map.moveLayer(rawLayer.id, MAPTILER_WATER_BOUNDARY_ID);
  }
  if (rawLayer && map.getLayer(MAPTILER_WATER_TINT_ID) && map.getLayer(rawLayer.id)) {
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

function refreshGpuWeatherKeyframePresentations(keyframe, topology, summaryBackend) {
  if (!keyframe) return;
  const directLevelData = topology.levels.get(WEATHER_REFERENCE_LEVEL);
  keyframe.topology = topology;
  keyframe.levelData = directLevelData;
  const presentations = new Map([[WEATHER_REFERENCE_LEVEL, {
    kind: 'physical',
    texture: keyframe.texture,
    coverageTexture: keyframe.texture,
    levelData: directLevelData
  }]]);
  if (summaryBackend) for (const [summaryLevel, output] of summaryBackend.outputs) {
    const summaryOutput = output.slots[keyframe.slot];
    presentations.set(summaryLevel, {
      kind: 'summary',
      texture: summaryOutput.values,
      coverageTexture: summaryOutput.coverage,
      levelData: topology.levels.get(summaryLevel)
    });
  }
  keyframe.presentations = presentations;
}

function promoteGpuWeatherLodTransition(transition) {
  const promotionStarted = performance.now();
  const targetLevel = transition.toLevel;
  const currentTopology = geographicWeatherPyramid.topology;
  const targetRange = lodRangeForStableLevel(targetLevel);
  const rangeChanged = currentTopology.levelRange.minLevel !== targetRange.minLevel
    || currentTopology.levelRange.maxLevel !== targetRange.maxLevel;
  const topologyStarted = performance.now();
  const targetTopology = rangeChanged
    ? new GeographicLodTopology(state.canonicalWindow, targetRange, currentTopology, { deferTransitionParents: true })
    : currentTopology;
  const topologyNormalizationMs = performance.now() - topologyStarted;
  const requiredSummaryLevels = gpuSummaryLevelsForStableLevel(targetLevel);
  const currentSummaryLevels = gpuPhysicalSummaryBackend?.levels || [];
  const summaryNeedsReplacement = Boolean(requiredSummaryLevels.length
    && (gpuPhysicalSummaryBackend?.topology !== targetTopology
      || currentSummaryLevels.join(',') !== requiredSummaryLevels.join(',')));
  let targetSummaryBackend = gpuPhysicalSummaryBackend;
  const summaryStarted = performance.now();
  if (requiredSummaryLevels.length && summaryNeedsReplacement) {
    targetSummaryBackend = createGpuPhysicalSummaryForStableLevel(
      targetTopology,
      targetLevel,
      gpuPhysicalSummaryBackend
    );
    const directLevelData = gpuWeatherPhysicalLevelDataFor(targetTopology, targetLevel);
    for (const keyframe of [gpuWeatherKeyframes?.a, gpuWeatherKeyframes?.b]) {
      targetSummaryBackend.reconstruct({
        texture: keyframe.texture,
        topology: targetTopology,
        levelData: directLevelData
      }, { targetSlot: keyframe.slot, measureGpu: diagnosticsEnabled });
    }
  } else if (!requiredSummaryLevels.length) targetSummaryBackend = null;
  const summaryWorkingSetNormalizationMs = performance.now() - summaryStarted;
  const endpointStarted = performance.now();
  const targetKeyframes = gpuWeatherKeyframes;
  refreshGpuWeatherKeyframePresentations(targetKeyframes?.a, targetTopology, targetSummaryBackend);
  refreshGpuWeatherKeyframePresentations(targetKeyframes?.b, targetTopology, targetSummaryBackend);
  const frame = geographicTemporalFrameAt(state.time / LOOP_SECONDS);
  const targetSource = createGpuWeatherPresentationSource(frame, targetKeyframes?.a, targetKeyframes?.b, {
    topology: targetTopology,
    levelData: targetTopology.levels.get(targetLevel),
    summaryBackend: targetSummaryBackend
  });
  const endpointSourceConstructionMs = performance.now() - endpointStarted;
  if (!targetSource
    || !weatherLayer?.isGpuWeatherSourceCompatible(targetSource, { topology: targetTopology, levelData: targetSource.levelData, allowTransition: true })
    || !squaresLayer?.isGpuWeatherSourceCompatible(targetSource, { topology: targetTopology, levelData: targetSource.levelData, allowTransition: true })) {
    if (targetSummaryBackend !== gpuPhysicalSummaryBackend) destroyGpuPhysicalSummaryBackend(targetSummaryBackend, 'failed-gpu-lod-promotion-preflight');
    throw new Error('GPU LOD promotion target source failed renderer preflight.');
  }
  if (rangeChanged) geographicWeatherPyramid.setTopology(targetTopology, { preserveCompatibleState: true });
  const rendererStarted = performance.now();
  const published = publishGpuWeatherPresentationSource(targetSource, null, {
    requestRepaint: false,
    origin: 'gpu-lod-promotion',
    commitState: true
  });
  if (!published) {
    if (rangeChanged) geographicWeatherPyramid.setTopology(currentTopology, { preserveCompatibleState: true });
    if (targetSummaryBackend !== gpuPhysicalSummaryBackend) destroyGpuPhysicalSummaryBackend(targetSummaryBackend, 'rejected-gpu-lod-promotion-publication');
    throw new Error('GPU LOD promotion source publication was rejected.');
  }
  const rendererPromotionMs = performance.now() - rendererStarted;
  const previousSummaryBackend = gpuPhysicalSummaryBackend;
  state.lod = { level: targetLevel };
  state.levelData = targetTopology.levels.get(targetLevel);
  gpuWeatherLevelData = state.levelData;
  gpuPhysicalSummaryBackend = targetSummaryBackend;
  gpuWeatherKeyframes = { ...targetKeyframes, progress: frame.progress };
  gpuWeatherLodTransitionStats.completed++;
  const predecessorDestroyStarted = performance.now();
  runtimeDiagnostics?.recordEvent('gpu-weather-lod-transition-end', {
    owner: 'gpu', level: targetLevel, fromLevel: transition.fromLevel,
    toLevel: transition.toLevel, directResidency: true,
    retainedSummaryLevels: targetSummaryBackend?.levels || []
  });
  const predecessorDestroyTimings = previousSummaryBackend && previousSummaryBackend !== targetSummaryBackend
    ? destroyGpuPhysicalSummaryBackend(previousSummaryBackend, 'completed-gpu-lod-promotion') : null;
  const predecessorDestroyMs = performance.now() - predecessorDestroyStarted;
  runtimeDiagnostics?.recordEvent('gpu-weather-lod-promotion', {
    fromLevel: transition.fromLevel,
    toLevel: targetLevel,
    totalMs: performance.now() - promotionStarted,
    topologyNormalizationMs,
    summaryWorkingSetNormalizationMs,
    endpointSourceConstructionMs,
    rendererPromotionMs,
    predecessorDestroyMs,
    predecessorDestroyTimings,
    rangeChanged,
    requiredSummaryLevels,
    retainedSummaryLevels: targetSummaryBackend?.levels || []
  });
  updateTimelineResidency();
  updateLodDiagnostics();
  map.triggerRepaint();
  return true;
}

function cpuTransitionSourcesAreAvailable(requirements) {
  return activeWeatherField?.frameCount === undefined
    || requirements.sourceFrames.every((frameIndex) => activeWeatherField.isSourceFrameAvailable(frameIndex));
}

function requestCpuTransitionSourceFrames(level, now, requirements) {
  const fromLevelData = state.levelData;
  const request = {
    id: ++cpuTransitionRequestGeneration,
    fromLevel: state.lod.level,
    toLevel: level,
    fromLevelData,
    requirements
  };
  if (cpuTransitionRequest
    && cpuTransitionRequest.fromLevel === request.fromLevel
    && cpuTransitionRequest.toLevel === request.toLevel
    && cpuTransitionRequest.fromLevelData === request.fromLevelData
    && cpuTransitionRequest.requirements.key === request.requirements.key) return false;
  cpuTransitionRequest = request;
  runtimeDiagnostics?.recordEvent('cpu-lod-transition-source-request', {
    requestId: request.id,
    fromLevel: request.fromLevel,
    toLevel: request.toLevel,
    sourceFrames: requirements.sourceFrames,
    temporalKey: requirements.key,
    requestedAt: now
  });
  const promise = weatherLoad.requestTimes(requirements.times, {
    priority: 'high',
    replaceKey: 'cpu-lod-transition',
    latestTargetGeneration: request.id
  }).then(({ result } = {}) => {
    if (cpuTransitionRequest !== request) return result;
    cpuTransitionRequest = null;
    state.cpuFallbackTransitionPromise = null;
    if (result?.status === 'superseded') {
      if (state.desiredLevel !== state.lod.level) startAdjacentTransition(state.desiredLevel, performance.now());
      return result;
    }
    const currentRequirements = rendererTemporalRequirements(state.time / LOOP_SECONDS);
    const current = state.desiredLevel === request.toLevel
      && state.lod.level === request.fromLevel
      && state.levelData === request.fromLevelData
      && !state.lodTransition
      && currentRequirements.key === request.requirements.key
      && cpuTransitionSourcesAreAvailable(currentRequirements);
    if (!current) {
      if (state.desiredLevel !== state.lod.level) startAdjacentTransition(state.desiredLevel, performance.now());
      return result;
    }
    startAdjacentTransition(request.toLevel, performance.now());
    return result;
  }).catch((error) => {
    if (cpuTransitionRequest === request) {
      cpuTransitionRequest = null;
      state.cpuFallbackTransitionPromise = null;
      runtimeDiagnostics?.recordEvent('cpu-lod-transition-source-failed', {
        requestId: request.id,
        fromLevel: request.fromLevel,
        toLevel: request.toLevel,
        sourceFrames: request.requirements.sourceFrames,
        message: error instanceof Error ? error.message : String(error)
      });
    }
    return null;
  });
  state.cpuFallbackTransitionPromise = promise;
  return true;
}

function startAdjacentTransition(level, now) {
  const currentLevelData = state.levelData;
  const nextLevel = currentLevelData ? currentLevelData.level + Math.sign(level - currentLevelData.level) : null;
  const phaseExit = beginGpuWeatherPhase('lod-transition-preparation', {
    fromLevel: currentLevelData?.level ?? null,
    toLevel: nextLevel,
    requestedLevel: level
  });
  try {
  const fixedChunkL13Entry = Boolean(gpuWeatherL13ChunkExperimentEnabled
    && state.renderMode === 'dots'
    && nextLevel === GPU_WEATHER_L13_CHUNK_LEVEL);
  synchronizeGpuWeatherPairBeforeLodTransition();
  const gpuEndpointCheck = currentLevelData && nextLevel !== null
    ? gpuWeatherTransitionEndpointCheck(currentLevelData, geographicWeatherPyramid?.levels?.get(nextLevel))
    : null;
  const gpuEndpoints = gpuEndpointCheck?.sources || null;
  const supportedGpuAttempt = Boolean(currentLevelData
    && nextLevel !== null
    && isGpuWeatherLodTransitionPairSupported(currentLevelData.level, nextLevel)
    && !legacyHierarchicalDotsLodMorph
    && !fixedChunkL13Entry
    && (state.renderMode === 'dots' || state.renderMode === 'squares'));
  const canUseGpuTransition = Boolean(gpuWeatherUsingGpu
    && !state.lodTransition
    && !legacyHierarchicalDotsLodMorph
    && currentLevelData
    && nextLevel !== null
    && isGpuWeatherLodTransitionPairSupported(currentLevelData.level, nextLevel)
    && !fixedChunkL13Entry
    && gpuEndpoints
    && weatherLayer?.gpuWeatherMode
    && squaresLayer?.gpuWeatherMode);
  if (supportedGpuAttempt && gpuWeatherUsingGpu
    && !gpuWeatherFallbackReason?.startsWith('GPU weather initialization failed')
    && !canUseGpuTransition) {
    gpuWeatherLodTransitionStats.unexpectedGpuToCpuFallbacks++;
    gpuWeatherLastLodTransitionFallback = {
      owner: 'cpu',
      category: gpuEndpointCheck?.reason || (!weatherLayer?.gpuWeatherMode || !squaresLayer?.gpuWeatherMode
        ? 'renderer-gpu-mode-inactive' : 'gpu-transition-not-selected'),
      ...gpuEndpointCheck?.details,
      stableGpuOwnership: true,
      endpointReadiness: gpuEndpointCheck?.readiness || null
    };
    runtimeDiagnostics?.recordEvent('gpu-weather-lod-transition-fallback', gpuWeatherLastLodTransitionFallback);
  }
  if (canUseGpuTransition) {
    const transition = {
      owner: 'gpu',
      fromLevel: currentLevelData.level,
      toLevel: nextLevel,
      fromLevelData: currentLevelData,
      toLevelData: geographicWeatherPyramid.levels.get(nextLevel),
      fromSource: gpuEndpoints.fromSource,
      toSource: gpuEndpoints.toSource,
      fineLevelData: gpuEndpoints.fineLevelData,
      start: now,
      rawProgress: 0
    };
    state.lodTransition = transition;
    weatherLayer.setGpuWeatherTransition(transition, { requestRepaint: false });
    squaresLayer.setGpuWeatherTransition(transition, { requestRepaint: false });
    gpuWeatherLodTransitionStats.started++;
    runtimeDiagnostics?.recordEvent('gpu-weather-lod-transition-start', {
      owner: 'gpu', fromLevel: transition.fromLevel, toLevel: transition.toLevel,
      fromSourceLevel: transition.fromSource.presentationLevel,
      toSourceLevel: transition.toSource.presentationLevel,
      fineGridLevel: transition.fineLevelData.level,
      temporalA: gpuWeatherKeyframes?.a?.index ?? null,
      temporalB: gpuWeatherKeyframes?.b?.index ?? null
    });
    runtimeDiagnostics?.recordEvent('lod-transition-start', { fromLevel: transition.fromLevel, toLevel: transition.toLevel, owner: 'gpu' });
    updateLodDiagnostics();
    wakeApplicationFrame();
    return;
  }
  const cpuRequirements = rendererTemporalRequirements(state.time / LOOP_SECONDS);
  if (!cpuTransitionSourcesAreAvailable(cpuRequirements)) {
    requestCpuTransitionSourceFrames(level, now, cpuRequirements);
    return;
  }
  if (gpuWeatherUsingGpu) {
    const leavingGpuLevelDownward = isGpuWeatherLevel(state.lod.level) && level < state.lod.level;
    disableGpuWeatherPath(state.time / LOOP_SECONDS, `CPU reference fallback during LOD transition to L${level}`);
    if (leavingGpuLevelDownward) releaseGpuWeatherResidency();
  }
  const direction = Math.sign(level - state.lod.level);
  const toLevel = state.lod.level + direction;
  const toLevelData = geographicWeatherPyramid.levelDataFor(toLevel);
  if (gpuFirstExperimentEnabled && isGpuWeatherLevel(toLevel)
    && (state.renderMode === 'dots' || state.renderMode === 'squares')) {
    // The CPU L14 endpoint still exists for this exact adjacent morph, but
    // tile I/O can overlap its fixed-duration presentation. Activation waits
    // for the stable direct-level commit above.
    void ensureGpuWeatherResidency(toLevelData).catch((error) => {
      gpuWeatherFallbackReason = `GPU weather initialization failed: ${error instanceof Error ? error.message : String(error)}`;
    });
  }
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
  } finally {
    phaseExit({
      fromLevel: state.lod?.level ?? null,
      toLevel: state.lodTransition?.toLevel ?? nextLevel,
      status: state.lodTransition ? 'transition-active' : 'transition-not-started'
    });
  }
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
    if (transition.owner === 'gpu') {
      const reversed = {
        ...transition,
        fromLevel: transition.toLevel,
        toLevel: transition.fromLevel,
        fromLevelData: transition.toLevelData,
        toLevelData: transition.fromLevelData,
        fromSource: transition.toSource,
        toSource: transition.fromSource,
        start: now - rawProgress * LOD_MORPH_SECONDS * 1000,
        rawProgress
      };
      state.lodTransition = reversed;
      weatherLayer.setGpuWeatherTransition(reversed, { requestRepaint: false });
      squaresLayer.setGpuWeatherTransition(reversed, { requestRepaint: false });
      gpuWeatherLodTransitionStats.reversed++;
      runtimeDiagnostics?.recordEvent('gpu-weather-lod-transition-reversal', {
        fromLevel: reversed.fromLevel, toLevel: reversed.toLevel,
        progress: smoothstep(0, 1, rawProgress)
      });
      updateLodDiagnostics();
      wakeApplicationFrame();
      return;
    }
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
  const progress = smoothstep(0, 1, rawProgress);
  if (transition.owner === 'gpu') {
    weatherLayer.gpuWeatherTransition && (weatherLayer.gpuWeatherTransition.progress = progress);
    squaresLayer.gpuWeatherTransition && (squaresLayer.gpuWeatherTransition.progress = progress);
  } else {
    weatherLayer.setTransitionProgress(progress);
    squaresLayer.setTransitionProgress(progress);
  }
  updateLodDiagnostics();
  if (rawProgress < 1) return;
  if (transition.owner === 'gpu') {
    try {
      promoteGpuWeatherLodTransition(transition);
      state.lodTransition = null;
      if (state.pendingCanonicalWindow) {
        const pendingWindow = state.pendingCanonicalWindow;
        state.pendingCanonicalWindow = null;
        applyCanonicalWindow(pendingWindow);
      }
      if (state.desiredLevel !== state.lod.level) startAdjacentTransition(state.desiredLevel, now);
    } catch (error) {
      gpuWeatherLodTransitionStats.unexpectedGpuToCpuFallbacks++;
      state.lodTransition = null;
      disableGpuWeatherPath(state.time / LOOP_SECONDS, `GPU LOD transition failed: ${error instanceof Error ? error.message : String(error)}`);
      releaseGpuWeatherResidency();
      startAdjacentTransition(transition.toLevel, now);
    }
    return;
  }
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
  if (gpuWeatherPresentationSyncMode && !gpuWeatherHzCap && gpuWeatherRequestedAtCurrentLevel()) {
    map.triggerRepaint();
    gpuWeatherTimelineStats.repaintRequests++;
    gpuWeatherTimelineStats.weatherRepaintRequestCount++;
    return;
  }
  state.weatherQueued = true;
  requestAnimationFrame((presentationTimestamp) => runDiagnosticCallback('weather-update-raf-callback', () => {
    state.weatherQueued = false;
    if (!state.mapReady || !activeWeatherField) return;
    const time = state.time / LOOP_SECONDS;
    if (state.renderMode === 'raw') return;
    requestWeatherTime(time, { playback: state.playing, presentationTimestamp });
  }));
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

function requestWeatherTime(normalizedTime, { playback = false, presentationTimestamp = null } = {}) {
  if (!activeWeatherField) return Promise.resolve();
  if (gpuWeatherRequestedAtCurrentLevel()) {
    updateGpuWeatherTime(normalizedTime, { presentationTimestamp });
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
  rawLayer?.setActive(rawActive);
  rawLayer?.setHazards(state.hazardsVisible);
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
  if (fixedL13ChunkPathActive() && mode !== 'dots') {
    suspendFixedL13Chunk(`render mode changed from Dots to ${mode}`);
  }
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
  updateRenderModeIndicator(mode);
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
playPause.addEventListener('click', () => runDiagnosticCallback('playback-button-callback', () => {
  if (state.renderMode === 'raw') return;
  if (!state.playing && state.time >= LOOP_SECONDS) {
    state.time = 0;
    timeSlider.value = '0';
    queueWeatherUpdate();
  }
  setPlaying(!state.playing);
}));
zoomIn.addEventListener('click', () => runDiagnosticCallback('zoom-in-button-callback', () => map.zoomIn()));
zoomOut.addEventListener('click', () => runDiagnosticCallback('zoom-out-button-callback', () => map.zoomOut()));
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
  rawLayer?.setHazards(state.hazardsVisible);
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
timeSlider.addEventListener('pointerdown', (event) => runDiagnosticCallback('timeline-pointerdown-callback', () => {
  runtimeDiagnostics?.recordInput('timeline-pointerdown');
  event.preventDefault();
  timeSlider.focus({ preventScroll: true });
  if (state.playing) setPlaying(false);
  state.scrubbing = true;
  runtimeDiagnostics?.recordEvent('scrub-start');
  scrubbingPointerId = event.pointerId;
  timeSlider.setPointerCapture(event.pointerId);
  updateTimelineFromPointer(event.clientX);
}));
timeSlider.addEventListener('pointermove', (event) => runDiagnosticCallback('timeline-pointermove-callback', () => {
  runtimeDiagnostics?.recordInput('timeline-pointermove');
  if (event.pointerId === scrubbingPointerId) updateTimelineFromPointer(event.clientX);
}));
timeSlider.addEventListener('input', () => runDiagnosticCallback('timeline-input-callback', () => {
  runtimeDiagnostics?.recordInput('timeline-input');
  updateTimeFromTimelineValue(timeSlider.value);
}));
for (const eventName of ['pointerup', 'pointercancel', 'lostpointercapture']) {
  timeSlider.addEventListener(eventName, (event) => runDiagnosticCallback(`timeline-${eventName}-callback`, () => {
    runtimeDiagnostics?.recordInput(`timeline-${eventName}`);
    finishTimelineScrub(event.pointerId);
  }));
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
map.on('render', () => runDiagnosticCallback('map-render-callback', () => {
  runtimeDiagnostics?.recordRender();
  if (state.styleReady) markStartup('first-map-render-after-style');
  observeInitialBasemapReadiness();
  if (state.mapReady) markStartup('first-weather-layer-render');
}));
map.on('sourcedata', (event) => {
  if (!state.styleReady || !event?.sourceId) return;
  markStartup('initial-map-source-data');
  if (event.isSourceLoaded) markStartup('initial-map-source-ready');
});
map.on('mousemove', updateRawHover);
map.on('click', selectRawCell);
map.on('dragstart', () => runDiagnosticCallback('map-dragstart-callback', () => {
  runtimeDiagnostics?.recordInput('dragstart');
  runtimeDiagnostics?.recordEvent('drag-start');
  rawMapDragging = true;
  dismissRawTooltip();
}));
map.on('dragend', () => runDiagnosticCallback('map-dragend-callback', () => {
  runtimeDiagnostics?.recordInput('dragend');
  runtimeDiagnostics?.recordEvent('drag-end');
  rawMapDragging = false;
}));
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
map.on('move', (event) => runDiagnosticCallback('map-move-callback', () => {
  runtimeDiagnostics?.recordInput('move');
  updateLogicalSamplingZoom(event);
}));
map.on('move', updateRawTooltipPosition);
map.on('move', updateResetViewControl);
map.on('rotate', updateResetViewControl);
map.on('pitch', updateResetViewControl);
map.on('movestart', () => runDiagnosticCallback('map-movestart-callback', () => {
  runtimeDiagnostics?.recordInput('movestart');
  runtimeDiagnostics?.recordEvent('map-movestart');
  weatherLoad.setBackgroundPrefetchPaused(true);
}));
map.on('moveend', () => runDiagnosticCallback('map-moveend-callback', () => {
  runtimeDiagnostics?.recordInput('moveend');
  runtimeDiagnostics?.recordEvent('map-moveend');
  weatherLoad.setBackgroundPrefetchPaused(false);
  if (!state.resettingView) return;
  state.resettingView = false;
  state.logicalSamplingZoom = WEATHER_REGION.initialZoom;
  rebaseCamera();
  if (fixedL13ChunkPathActive() && zoomToMercatorGridLevel(state.logicalSamplingZoom) !== GPU_WEATHER_L13_CHUNK_LEVEL) {
    suspendFixedL13Chunk(`desired LOD left L${GPU_WEATHER_L13_CHUNK_LEVEL}`);
  }
  updateCanonicalWindow();
  rebuildSamples(zoomToMercatorGridLevel(state.logicalSamplingZoom));
  updateResetViewControl();
}));
map.on('zoomstart', () => runDiagnosticCallback('map-zoomstart-callback', () => {
  runtimeDiagnostics?.recordInput('zoomstart');
  runtimeDiagnostics?.recordEvent('map-zoomstart');
}));
map.on('zoomend', () => runDiagnosticCallback('map-zoomend-callback', () => {
  runtimeDiagnostics?.recordInput('zoomend');
  runtimeDiagnostics?.recordEvent('map-zoomend');
}));
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
  runtimeDiagnostics?.recordEvent('maplibre-error', {
    category: event?.tile ? 'vector-tile' : event?.sourceId ? 'source/TileJSON' : 'generic',
    message,
    stack: error instanceof Error ? error.stack || null : null,
    sourceId: event?.sourceId || null,
    hasTile: Boolean(event?.tile)
  });
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
  return runDiagnosticCallback('application-raf-callback', () => frameBody(now));
}

function frameBody(now) {
  applicationFrameQueued = false;
  runtimeDiagnostics?.recordApplicationFrame(now, Boolean(state.playing || state.lodTransition));
  if (gpuWeatherExperimentEnabled) gpuWeatherTimelineStats.playbackRafCount++;
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
