import { LOD_MORPH_SECONDS } from './engine/config.js';
import { clamp, smoothstep } from './engine/math.js';
import { WEATHER_REGION } from './engine/geography.js';
import { MAX_LOGICAL_SAMPLING_ZOOM, logicalZoomLatitudeAdjustment, selectMercatorGridSamples, zoomToMercatorGridLevel } from './engine/geographic-lod.js';
import { GeographicRainLayer } from './engine/geographic-rain-layer.js';

const FIXED_WEATHER_TIME = 0.5;
// Camera inspection is intentionally independent from the L14 weather cap.
const CAMERA_MAX_ZOOM = 13;
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

if (!window.maplibregl) throw new Error('MapLibre GL JS did not load.');
async function loadMapTilerKey() {
  const response = await fetch('./config.local.json', { cache: 'no-store' });
  if (!response.ok) throw new Error('MapTiler local configuration is missing or invalid.');
  const config = await response.json();
  if (typeof config.maptilerKey !== 'string' || !config.maptilerKey.trim()) throw new Error('maptilerKey is missing');
  return config.maptilerKey.trim();
}

const mapTilerKey = await loadMapTilerKey();
const map = new window.maplibregl.Map({
  container: 'map',
  style: `https://api.maptiler.com/maps/dataviz-v4-dark/style.json?key=${encodeURIComponent(mapTilerKey)}`,
  center: WEATHER_REGION.center, zoom: WEATHER_REGION.initialZoom, minZoom: initialMinZoom,
  maxZoom: CAMERA_MAX_ZOOM, maxPitch: 75, attributionControl: false,
  canvasContextAttributes: { antialias: true }
});
map.addControl(new window.maplibregl.AttributionControl({ compact: true }), 'top-right');

const rainLayer = new GeographicRainLayer();
rainLayer.setFixedWeatherTime(FIXED_WEATHER_TIME);
const state = { samples: [], lod: { level: null }, desiredLevel: null, lodTransition: null, logicalSamplingZoom: WEATHER_REGION.initialZoom, camera: null, resettingView: false, mapReady: false, autoRotating: false, rainSpeed: Number(rainSpeed.value), fallingProgress: 0 };
let applicationFrameQueued = false;
let lastApplicationFrame = null;
let lastMapErrorSignature = '';

function cameraState() { return { rawZoom: map.getZoom(), latitude: clamp(map.getCenter().lat, -MAX_SAMPLING_LATITUDE, MAX_SAMPLING_LATITUDE) }; }
function rebaseCamera() { state.camera = cameraState(); }
function commitSamples(level, samples) { state.lod = { level }; state.samples = samples; rainLayer.setSamples(samples); }
function startAdjacentTransition(level, now) {
  const toLevel = state.lod.level + Math.sign(level - state.lod.level);
  const toSamples = selectMercatorGridSamples(toLevel).samples;
  state.lodTransition = { fromLevel: state.lod.level, toLevel, fromSamples: state.samples, toSamples, start: now, rawProgress: 0 };
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
    rainLayer.setTransition(transition.toSamples, transition.fromSamples, smoothstep(0, 1, rawProgress));
    wakeApplicationFrame();
  }
}
function updateLODTransition(now) {
  const transition = state.lodTransition;
  if (!transition) return;
  const rawProgress = clamp((now - transition.start) / (LOD_MORPH_SECONDS * 1000), 0, 1);
  transition.rawProgress = rawProgress;
  rainLayer.setTransitionProgress(smoothstep(0, 1, rawProgress));
  if (rawProgress < 1) return;
  state.lodTransition = null;
  commitSamples(transition.toLevel, transition.toSamples);
  if (state.desiredLevel !== state.lod.level) startAdjacentTransition(state.desiredLevel, now);
}
function updateLogicalSamplingZoom() {
  const next = cameraState();
  if (state.resettingView) { state.camera = next; updateResetViewControl(); return; }
  if (!state.camera) { state.camera = next; return; }
  let delta = next.rawZoom - state.camera.rawZoom;
  delta -= logicalZoomLatitudeAdjustment(next.latitude, state.camera.latitude);
  if (Number.isFinite(delta)) state.logicalSamplingZoom = Math.min(MAX_LOGICAL_SAMPLING_ZOOM, state.logicalSamplingZoom + delta);
  state.camera = next;
  rebuildSamples(zoomToMercatorGridLevel(state.logicalSamplingZoom));
}
function initializeRainLayer() {
  const firstSymbol = (map.getStyle().layers || []).find((layer) => layer.type === 'symbol');
  if (!map.getLayer(rainLayer.id)) map.addLayer(rainLayer, firstSymbol?.id);
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
  state.rainSpeed = clamp(speed, 0, 2);
  if (state.rainSpeed > 0 && hasVisible3DRain()) wakeApplicationFrame();
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
      state.fallingProgress = (state.fallingProgress + delta * state.rainSpeed / BASE_FALL_CYCLE_SECONDS) % 1;
      rainLayer.setAnimationProgress(state.fallingProgress);
    }
    if (state.lodTransition || state.autoRotating || (state.rainSpeed > 0 && hasVisible3DRain())) wakeApplicationFrame();
    else lastApplicationFrame = null;
  });
}

zoomIn.addEventListener('click', () => map.zoomIn());
zoomOut.addEventListener('click', () => map.zoomOut());
autoRotate.addEventListener('click', () => setAutoRotation(!state.autoRotating));
rainSpeed.addEventListener('input', () => setRainSpeed(Number(rainSpeed.value)));
resetView.addEventListener('click', resetMapView);
map.on('style.load', () => { if (!state.mapReady) map.setProjection({ type: 'globe' }); initializeRainLayer(); });
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
