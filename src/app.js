import { LOD_MORPH_SECONDS, LOOP_SECONDS } from './engine/config.js';
import { clamp, smoothstep } from './engine/math.js';
import { loadActiveWeatherField, WEATHER_REGION } from './engine/geography.js';
import {
  MAX_LOGICAL_SAMPLING_ZOOM,
  logicalZoomLatitudeAdjustment,
  rawZoomForLogicalSamplingZoom,
  selectMercatorGridSamples,
  zoomToMercatorGridLevel
} from './engine/geographic-lod.js';
import { GeographicDotsLayer } from './engine/geographic-dots-layer.js';
import { GeographicSquaresLayer } from './engine/geographic-squares-layer.js';
import { GeographicWeatherPyramid } from './engine/geographic-weather-pyramid.js';
import { GeographicScalarLayer } from './engine/geographic-scalar-layer.js';
import { RawWeatherLayer } from './engine/raw-weather-layer.js';

const MAX_SAMPLING_LATITUDE = 85;
const COMPACT_MAP_SHORT_SIDE = 680;
const COMPACT_MIN_ZOOM = 1.5;
const LARGE_MIN_ZOOM = 3.0;
const playPause = document.querySelector('#playPause');
const timeSlider = document.querySelector('#timeSlider');
const resetView = document.querySelector('#resetView');
const zoomIn = document.querySelector('#zoomIn');
const zoomOut = document.querySelector('#zoomOut');
const renderModeSelector = document.querySelector('#renderModeSelector');
const renderModeButtons = [...renderModeSelector.querySelectorAll('[data-render-mode]')];
const rawPhenomenaControl = document.querySelector('#rawPhenomenaControl');
const rawPhenomena = document.querySelector('#rawPhenomena');
const areaSmoothControl = document.querySelector('#areaSmoothControl');
const areaSmooth = document.querySelector('#areaSmooth');
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

const activeWeatherField = await loadActiveWeatherField();
const rawWeatherField = activeWeatherField.rawFrame;

async function loadMapTilerKey() {
  try {
    const response = await fetch('./config.local.json', { cache: 'no-store' });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const config = await response.json();
    if (typeof config.maptilerKey !== 'string' || !config.maptilerKey.trim()) throw new Error('maptilerKey is missing');
    return config.maptilerKey.trim();
  } catch {
    console.error('MapTiler local configuration is missing or invalid. Expected config.local.json with a non-empty maptilerKey.');
    throw new Error('MapTiler local configuration is missing or invalid.');
  }
}

const mapTilerKey = await loadMapTilerKey();
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
  samples: [],
  lod: { level: null, leafCount: 0 },
  desiredLevel: null,
  lodTransition: null,
  logicalSamplingZoom: WEATHER_REGION.initialZoom,
  camera: null,
  rawMaxZoom: INITIAL_RAW_MAX_ZOOM,
  resettingView: false,
  mapReady: false,
  weatherQueued: false,
  renderMode: 'raw'
};
const geographicWeatherPyramid = new GeographicWeatherPyramid();
const weatherLayer = new GeographicDotsLayer(geographicWeatherPyramid);
const squaresLayer = new GeographicSquaresLayer(geographicWeatherPyramid);
const scalarLayer = new GeographicScalarLayer();
const rawLayer = new RawWeatherLayer(rawWeatherField);
const geographicLayers = [rawLayer, scalarLayer, squaresLayer, weatherLayer];
let lastMapErrorSignature = '';

function cameraState() {
  return {
    rawZoom: map.getZoom(),
    latitude: clamp(map.getCenter().lat, -MAX_SAMPLING_LATITUDE, MAX_SAMPLING_LATITUDE)
  };
}

function rebaseCamera() {
  state.camera = cameraState();
}

function updateLodDiagnostics() {
  const zoom = state.logicalSamplingZoom.toFixed(2);
  const transition = state.lodTransition;
  const level = transition
    ? `${transition.fromLevel} → ${transition.toLevel}`
    : state.lod.level === null ? '—' : state.lod.level;
  lodDiagnostics.textContent = `Zoom ${zoom} · LOD ${level}`;
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
  rebuildSamples(zoomToMercatorGridLevel(state.logicalSamplingZoom));
  updateLodDiagnostics();
}

function commitSamples(level, samples) {
  state.lod = { level };
  state.samples = samples;
  weatherLayer.setSamples(samples, state.time / LOOP_SECONDS);
  squaresLayer.setSamples(samples, state.time / LOOP_SECONDS);
  updateLodDiagnostics();
}

function initializeWeatherLayer() {
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

  if (state.mapReady) return;
  state.mapReady = true;
  applyRenderMode();
  rebaseCamera();
  rebuildSamples(zoomToMercatorGridLevel(state.logicalSamplingZoom));
}

function startAdjacentTransition(level, now) {
  const direction = Math.sign(level - state.lod.level);
  const toLevel = state.lod.level + direction;
  const toSamples = selectMercatorGridSamples(toLevel).samples;
  state.lodTransition = {
    fromLevel: state.lod.level,
    toLevel,
    fromSamples: state.samples,
    toSamples,
    start: now,
    rawProgress: 0
  };
  weatherLayer.setTransition(state.samples, toSamples, state.time / LOOP_SECONDS, 0);
  squaresLayer.setTransition(state.samples, toSamples, state.time / LOOP_SECONDS, 0);
  updateLodDiagnostics();
  wakeApplicationFrame();
}

function rebuildSamples(level, now = performance.now()) {
  if (!state.mapReady) return;
  state.desiredLevel = level;
  if (state.lod.level === null) {
    const selection = selectMercatorGridSamples(level);
    commitSamples(selection.level, selection.samples);
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
      fromSamples: transition.toSamples,
      toSamples: transition.fromSamples,
      start: now - rawProgress * LOD_MORPH_SECONDS * 1000,
      rawProgress
    };
    weatherLayer.setTransition(transition.toSamples, transition.fromSamples, state.time / LOOP_SECONDS, smoothstep(0, 1, rawProgress));
    squaresLayer.setTransition(transition.toSamples, transition.fromSamples, state.time / LOOP_SECONDS, smoothstep(0, 1, rawProgress));
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
  commitSamples(transition.toLevel, transition.toSamples);
  if (state.desiredLevel !== state.lod.level) startAdjacentTransition(state.desiredLevel, now);
}

function queueWeatherUpdate() {
  if (state.weatherQueued) return;
  state.weatherQueued = true;
  requestAnimationFrame(() => {
    state.weatherQueued = false;
    if (!state.mapReady) return;
    const time = state.time / LOOP_SECONDS;
    if (state.renderMode === 'raw') return;
    if (state.renderMode === 'dots') weatherLayer.updateWeather(time);
    else if (state.renderMode === 'squares') squaresLayer.updateWeather(time);
    else scalarLayer.updateWeather(time);
  });
}

function applyRenderMode() {
  const mode = state.renderMode;
  const time = state.time / LOOP_SECONDS;
  const rawActive = mode === 'raw';
  const scalarActive = mode === 'blur' || mode === 'areas';
  rawLayer.setActive(rawActive);
  rawLayer.setPhenomena(rawPhenomena.checked);
  weatherLayer.setActive(mode === 'dots');
  squaresLayer.setActive(mode === 'squares');
  scalarLayer.setActive(scalarActive);
  if (rawActive) return;
  if (mode === 'dots') {
    weatherLayer.updateWeather(time);
  }
  else if (mode === 'squares') squaresLayer.updateWeather(time);
  else {
    scalarLayer.setPresentation(mode === 'areas' ? 'areas' : 'blur', mode === 'areas' && areaSmooth.checked, time);
    scalarLayer.updateWeather(time);
  }
}

function setRenderMode(mode) {
  state.renderMode = mode;
  renderModeSelector.dataset.mode = mode;
  rawPhenomenaControl.hidden = mode !== 'raw';
  areaSmoothControl.hidden = mode !== 'areas';
  if (mode !== 'raw') dismissRawTooltip();
  for (const button of renderModeButtons) {
    button.setAttribute('aria-checked', String(button.dataset.renderMode === mode));
  }
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
  rawTooltipContent.textContent = [
    `lon: ${cell.lon.toFixed(5)}`,
    `lat: ${cell.lat.toFixed(5)}`,
    `mmh: ${cell.mmh.toFixed(3)}`,
    `thunderstorm: ${cell.thunderstorm}`,
    `hail: ${cell.hail}`
  ].join('\n');
  rawTooltip.hidden = false;
  positionRawTooltip(point);
}

function dismissRawTooltip() {
  selectedRawCell = null;
  selectedRawCellKey = null;
  rawLayer.setHighlightedCell(null);
  rawTooltip.hidden = true;
}

function updateRawTooltipPosition() {
  if (state.renderMode !== 'raw' || !selectedRawCell) return;
  positionRawTooltip(map.project([selectedRawCell.lon, selectedRawCell.lat]));
}

function updateRawHover(event) {
  if (state.renderMode !== 'raw' || selectedRawCell || rawMapDragging) return;
  const cell = rawWeatherField.rawCellAt(event.lngLat.lng, event.lngLat.lat);
  if (!cell) {
    dismissRawTooltip();
    return;
  }
  showRawTooltip(cell, event.point);
}

function selectRawCell(event) {
  if (state.renderMode !== 'raw') return;
  if (selectedRawCell) return dismissRawTooltip();
  const cell = rawWeatherField.rawCellAt(event.lngLat.lng, event.lngLat.lat);
  if (!cell) return dismissRawTooltip();
  selectedRawCell = cell;
  selectedRawCellKey = rawCellKey(cell);
  showRawTooltip(cell, event.point);
}

function setPlaying(playing) {
  state.playing = playing;
  playPause.dataset.state = playing ? 'playing' : 'paused';
  playPause.setAttribute('aria-label', playing ? 'Pause' : 'Play');
  if (playing) wakeApplicationFrame();
}

function updateTimelineFromPointer(clientX) {
  const rect = timeSlider.getBoundingClientRect();
  const min = Number(timeSlider.min);
  const max = Number(timeSlider.max);
  const value = clamp(min + (clientX - rect.left) / rect.width * (max - min), min, max);
  timeSlider.value = String(value);
  state.time = Number(timeSlider.value) * LOOP_SECONDS;
  queueWeatherUpdate();
}

let scrubbingPointerId = null;
playPause.addEventListener('click', () => {
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
areaSmooth.addEventListener('change', () => {
  if (state.renderMode === 'areas') applyRenderMode();
});
rawPhenomena.addEventListener('change', () => {
  if (state.renderMode === 'raw') rawLayer.setPhenomena(rawPhenomena.checked);
});
document.addEventListener('pointerdown', (event) => {
  if (!rawTooltip.hidden && !mapContainer.contains(event.target) && !rawTooltip.contains(event.target)) dismissRawTooltip();
});
document.addEventListener('keydown', (event) => {
  if (event.key === 'Escape') dismissRawTooltip();
});
timeSlider.addEventListener('pointerdown', (event) => {
  if (state.playing) setPlaying(false);
  state.scrubbing = true;
  scrubbingPointerId = event.pointerId;
  timeSlider.setPointerCapture(event.pointerId);
  updateTimelineFromPointer(event.clientX);
});
timeSlider.addEventListener('pointermove', (event) => {
  if (event.pointerId === scrubbingPointerId) updateTimelineFromPointer(event.clientX);
});
timeSlider.addEventListener('input', () => {
  state.time = Number(timeSlider.value) * LOOP_SECONDS;
  queueWeatherUpdate();
});
for (const eventName of ['pointerup', 'pointercancel']) {
  timeSlider.addEventListener(eventName, (event) => {
    if (event.pointerId !== scrubbingPointerId) return;
    state.scrubbing = false;
    if (timeSlider.hasPointerCapture(event.pointerId)) timeSlider.releasePointerCapture(event.pointerId);
    scrubbingPointerId = null;
  });
}
map.on('style.load', () => {
  if (!state.mapReady) map.setProjection({ type: 'globe' });
  initializeWeatherLayer();
});
map.on('mousemove', updateRawHover);
map.on('click', selectRawCell);
map.on('dragstart', () => {
  rawMapDragging = true;
  dismissRawTooltip();
});
map.on('dragend', () => {
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
map.on('moveend', () => {
  if (!state.resettingView) return;
  state.resettingView = false;
  state.logicalSamplingZoom = WEATHER_REGION.initialZoom;
  rebaseCamera();
  rebuildSamples(zoomToMercatorGridLevel(state.logicalSamplingZoom));
  updateResetViewControl();
});
map.on('load', updateResetViewControl);
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

function wakeApplicationFrame() {
  if (applicationFrameQueued) return;
  state.lastFrame = performance.now();
  applicationFrameQueued = true;
  requestAnimationFrame(frame);
}

function frame(now) {
  applicationFrameQueued = false;
  const delta = Math.min((now - state.lastFrame) / 1000, 0.1);
  state.lastFrame = now;
  let reachedEndpoint = false;
  if (state.playing && !state.scrubbing) {
    state.time = Math.min(state.time + delta, LOOP_SECONDS);
    reachedEndpoint = state.time === LOOP_SECONDS;
  }
  // A paused static layer has no temporal uniform to advance. Leaving its
  // repaint scheduling to MapLibre prevents the application RAF from keeping
  // an otherwise idle map rendering continuously.
  if (state.mapReady && (state.playing || reachedEndpoint) && !state.scrubbing) {
    const normalizedTime = state.time / LOOP_SECONDS;
    if (state.renderMode === 'raw') {
      updateRawTooltipPosition();
    } else if (state.renderMode === 'dots') weatherLayer.updateWeather(normalizedTime);
    else if (state.renderMode === 'squares') squaresLayer.updateWeather(normalizedTime);
    else scalarLayer.updateWeather(normalizedTime);
  }
  if (reachedEndpoint) setPlaying(false);
  updateLODTransition(now);
  if (!state.scrubbing) timeSlider.value = String(state.time / LOOP_SECONDS);
  if ((state.playing && !state.scrubbing) || state.lodTransition) wakeApplicationFrame();
}

wakeApplicationFrame();
