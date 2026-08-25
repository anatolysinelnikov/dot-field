import { LOD_MORPH_SECONDS } from './engine/config.js';
import { clamp, smoothstep } from './engine/math.js';
import { WEATHER_REGION } from './engine/geography.js';
import {
  MAX_LOGICAL_SAMPLING_ZOOM,
  logicalZoomLatitudeAdjustment,
  rawZoomForLogicalSamplingZoom,
  selectMercatorGridSamples,
  zoomToMercatorGridLevel
} from './engine/geographic-lod.js';
import { GeographicDotsLayer } from './engine/geographic-dots-layer.js';
import { GeographicRainLayer } from './engine/geographic-rain-layer.js';

const FIXED_WEATHER_TIME = 0.5;
const AUTO_ROTATE_DEGREES_PER_SECOND = 2.5;
const BASE_FALL_CYCLE_SECONDS = 4;
const MAX_SAMPLING_LATITUDE = 85;
const shortSide = Math.min(document.querySelector('#map').clientWidth, document.querySelector('#map').clientHeight);
const initialMinZoom = shortSide <= 680 ? 1.5 : 3;
const resetView = document.querySelector('#resetView');
const zoomIn = document.querySelector('#zoomIn');
const zoomOut = document.querySelector('#zoomOut');
const autoRotate = document.querySelector('#autoRotate');
const rainSpeed = document.querySelector('#rainSpeed');
const rainMinSize = document.querySelector('#rainMinSize');
const rainMaxSize = document.querySelector('#rainMaxSize');
const rainActivityContrast = document.querySelector('#rainActivityContrast');
const rainMinSizeValue = document.querySelector('#rainMinSizeValue');
const rainMaxSizeValue = document.querySelector('#rainMaxSizeValue');
const rainActivityContrastValue = document.querySelector('#rainActivityContrastValue');

if (!window.maplibregl) throw new Error('MapLibre GL JS did not load.');
async function loadMapTilerKey() {
  const response = await fetch('./config.local.json', { cache: 'no-store' });
  if (!response.ok) throw new Error('MapTiler local configuration is missing or invalid.');
  const config = await response.json();
  if (typeof config.maptilerKey !== 'string' || !config.maptilerKey.trim()) throw new Error('maptilerKey is missing');
  return config.maptilerKey.trim();
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
  center: WEATHER_REGION.center, zoom: WEATHER_REGION.initialZoom, minZoom: initialMinZoom,
  maxZoom: INITIAL_RAW_MAX_ZOOM, maxPitch: 75, attributionControl: false,
  canvasContextAttributes: { antialias: true }
});
map.addControl(new window.maplibregl.AttributionControl({ compact: true }), 'top-right');

const dotsLayer = new GeographicDotsLayer({ renderHazards: false });
const rainLayer = new GeographicRainLayer();
rainLayer.setFixedWeatherTime(FIXED_WEATHER_TIME);
const state = { samples: [], lod: { level: null }, desiredLevel: null, lodTransition: null, logicalSamplingZoom: WEATHER_REGION.initialZoom, camera: null, rawMaxZoom: INITIAL_RAW_MAX_ZOOM, resettingView: false, mapReady: false, autoRotating: false, rainSpeed: Number(rainSpeed.value), rainMinSize: Number(rainMinSize.value), rainMaxSize: Number(rainMaxSize.value), rainActivityContrast: Number(rainActivityContrast.value), fallingCycles: 0 };
let applicationFrameQueued = false;
let lastApplicationFrame = null;
let lastMapErrorSignature = '';

function cameraState() { return { rawZoom: map.getZoom(), latitude: clamp(map.getCenter().lat, -MAX_SAMPLING_LATITUDE, MAX_SAMPLING_LATITUDE) }; }
function rebaseCamera() { state.camera = cameraState(); }
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
function commitSamples(level, samples) {
  state.lod = { level };
  state.samples = samples;
  dotsLayer.setSamples(samples, FIXED_WEATHER_TIME);
  rainLayer.setSamples(samples);
}
function startAdjacentTransition(level, now) {
  const toLevel = state.lod.level + Math.sign(level - state.lod.level);
  const toSamples = selectMercatorGridSamples(toLevel).samples;
  state.lodTransition = { fromLevel: state.lod.level, toLevel, fromSamples: state.samples, toSamples, start: now, rawProgress: 0 };
  dotsLayer.setTransition(state.samples, toSamples, FIXED_WEATHER_TIME);
  rainLayer.setTransition(state.samples, toSamples);
  wakeApplicationFrame();
}
function rebuildSamples(level, now = performance.now()) {
  if (!state.mapReady) return;
  state.desiredLevel = level;
  if (state.lod.level === null) { const selected = selectMercatorGridSamples(level); commitSamples(selected.level, selected.samples); return; }
  const transition = state.lodTransition;
  if (!transition) { if (state.lod.level !== level) startAdjacentTransition(level, now); return; }
  const direction = Math.sign(transition.toLevel - transition.fromLevel);
  if (level === transition.toLevel) return;
  if (level === transition.fromLevel || Math.sign(level - transition.toLevel) !== direction) {
    const rawProgress = 1 - transition.rawProgress;
    state.lodTransition = { fromLevel: transition.toLevel, toLevel: transition.fromLevel, fromSamples: transition.toSamples, toSamples: transition.fromSamples, start: now - rawProgress * LOD_MORPH_SECONDS * 1000, rawProgress };
    dotsLayer.setTransition(transition.toSamples, transition.fromSamples, FIXED_WEATHER_TIME, smoothstep(0, 1, rawProgress));
    rainLayer.setTransition(transition.toSamples, transition.fromSamples, smoothstep(0, 1, rawProgress));
    wakeApplicationFrame();
  }
}
function updateLODTransition(now) {
  const transition = state.lodTransition;
  if (!transition) return;
  const rawProgress = clamp((now - transition.start) / (LOD_MORPH_SECONDS * 1000), 0, 1);
  transition.rawProgress = rawProgress;
  dotsLayer.setTransitionProgress(smoothstep(0, 1, rawProgress));
  rainLayer.setTransitionProgress(smoothstep(0, 1, rawProgress));
  if (rawProgress < 1) return;
  state.lodTransition = null;
  commitSamples(transition.toLevel, transition.toSamples);
  if (state.desiredLevel !== state.lod.level) startAdjacentTransition(state.desiredLevel, now);
}
function updateLogicalSamplingZoom() {
  const next = cameraState();
  updateRawMapMaxZoom(next.latitude);
  if (state.resettingView) { state.camera = next; updateResetViewControl(); return; }
  if (!state.camera) { state.camera = next; return; }
  let delta = next.rawZoom - state.camera.rawZoom;
  delta -= logicalZoomLatitudeAdjustment(next.latitude, state.camera.latitude);
  if (Number.isFinite(delta)) state.logicalSamplingZoom = Math.min(MAX_LOGICAL_SAMPLING_ZOOM, state.logicalSamplingZoom + delta);
  state.camera = next;
  rebuildSamples(zoomToMercatorGridLevel(state.logicalSamplingZoom));
}
function initializeRainLayers() {
  const styleLayers = map.getStyle().layers || [];
  const firstSymbol = styleLayers.find((layer) => layer.type === 'symbol');
  if (!map.getLayer(dotsLayer.id)) map.addLayer(dotsLayer, firstSymbol?.id);
  if (!map.getLayer(rainLayer.id)) map.addLayer(rainLayer, firstSymbol?.id);

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
      }, dotsLayer.id);
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
      }, dotsLayer.id);
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
    if (map.getLayer(id) && map.getLayer(dotsLayer.id)) map.moveLayer(id, dotsLayer.id);
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

  if (state.mapReady) return;
  state.mapReady = true;
  rebaseCamera();
  rebuildSamples(zoomToMercatorGridLevel(state.logicalSamplingZoom));
}
function resetMapView() {
  if (state.resettingView) return;
  state.resettingView = true;
  map.easeTo({ center: WEATHER_REGION.center, zoom: WEATHER_REGION.initialZoom, bearing: 0, pitch: 0 });
}
function updateResetViewControl() {
  const center = map.getCenter();
  const bearing = ((map.getBearing() + 180) % 360) - 180;
  const [longitude, latitude] = WEATHER_REGION.center;
  resetView.hidden = !(Math.abs(center.lng - longitude) > 0.0001 || Math.abs(center.lat - latitude) > 0.0001 || Math.abs(map.getZoom() - WEATHER_REGION.initialZoom) > 0.01 || Math.abs(bearing) > 0.1 || Math.abs(map.getPitch()) > 0.1);
}
function setAutoRotation(autoRotating) {
  state.autoRotating = autoRotating;
  autoRotate.textContent = autoRotating ? '●' : '○';
  autoRotate.setAttribute('aria-pressed', String(autoRotating));
  autoRotate.setAttribute('aria-label', autoRotating ? 'Disable auto rotation' : 'Enable auto rotation');
  if (autoRotating) wakeApplicationFrame();
}
function hasVisible3DRain() {
  if (state.lodTransition) return state.lodTransition.fromLevel >= 13 || state.lodTransition.toLevel >= 13;
  return state.lod.level >= 13;
}
function setRainSpeed(speed) {
  state.rainSpeed = clamp(speed, 0, 4);
  if (state.rainSpeed > 0 && hasVisible3DRain()) wakeApplicationFrame();
}
function updateRainSizeReadouts() {
  rainMinSize.value = state.rainMinSize.toFixed(2);
  rainMaxSize.value = state.rainMaxSize.toFixed(2);
  rainMinSizeValue.textContent = state.rainMinSize.toFixed(2);
  rainMaxSizeValue.textContent = state.rainMaxSize.toFixed(2);
}
function setRainMinSize(value) {
  state.rainMinSize = Math.min(clamp(value, 0.08, 0.30), state.rainMaxSize);
  rainLayer.setDropSizeRange(state.rainMinSize, state.rainMaxSize);
  updateRainSizeReadouts();
}
function setRainMaxSize(value) {
  state.rainMaxSize = Math.max(clamp(value, 0.20, 0.50), state.rainMinSize);
  rainLayer.setDropSizeRange(state.rainMinSize, state.rainMaxSize);
  updateRainSizeReadouts();
}
function setRainActivityContrast(value) {
  state.rainActivityContrast = clamp(value, 0.5, 4.0);
  rainLayer.setActivityContrast(state.rainActivityContrast);
  rainActivityContrast.value = state.rainActivityContrast.toFixed(2);
  rainActivityContrastValue.textContent = state.rainActivityContrast.toFixed(2);
}
function wakeApplicationFrame() {
  if (applicationFrameQueued) return;
  if (lastApplicationFrame === null) lastApplicationFrame = performance.now();
  applicationFrameQueued = true;
  requestAnimationFrame((now) => {
    applicationFrameQueued = false;
    const delta = Math.min((now - lastApplicationFrame) / 1000, 0.1);
    lastApplicationFrame = now;
    if (state.autoRotating) map.setBearing(map.getBearing() + AUTO_ROTATE_DEGREES_PER_SECOND * delta);
    updateLODTransition(now);
    if (state.rainSpeed > 0 && hasVisible3DRain()) {
      state.fallingCycles += delta * state.rainSpeed / BASE_FALL_CYCLE_SECONDS;
      rainLayer.setFallingCycles(state.fallingCycles);
    }
    if (state.lodTransition || state.autoRotating || (state.rainSpeed > 0 && hasVisible3DRain())) wakeApplicationFrame();
    else lastApplicationFrame = null;
  });
}

zoomIn.addEventListener('click', () => map.zoomIn());
zoomOut.addEventListener('click', () => map.zoomOut());
autoRotate.addEventListener('click', () => setAutoRotation(!state.autoRotating));
rainSpeed.addEventListener('input', () => setRainSpeed(Number(rainSpeed.value)));
rainMinSize.addEventListener('input', () => setRainMinSize(Number(rainMinSize.value)));
rainMaxSize.addEventListener('input', () => setRainMaxSize(Number(rainMaxSize.value)));
rainActivityContrast.addEventListener('input', () => setRainActivityContrast(Number(rainActivityContrast.value)));
resetView.addEventListener('click', resetMapView);
map.on('style.load', () => { if (!state.mapReady) map.setProjection({ type: 'globe' }); initializeRainLayers(); });
map.on('move', updateLogicalSamplingZoom);
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
  const message = (event?.error instanceof Error ? event.error.message : String(event?.error || 'Unknown MapLibre error')).replaceAll(mapTilerKey, '[redacted]');
  if (message === lastMapErrorSignature) return;
  lastMapErrorSignature = message;
  console.error(`MapLibre error: ${message}`);
});
