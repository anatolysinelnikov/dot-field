import { LOOP_SECONDS } from './engine/config.js';
import { clamp } from './engine/math.js';
import { WEATHER_REGION } from './engine/geography.js';
import { Icosphere } from './engine/icosphere.js';
import { selectGeographicSamples } from './engine/geographic-lod.js';
import { GeographicDotsLayer } from './engine/geographic-dots-layer.js';

const MAP_STYLE = 'https://tiles.openfreemap.org/styles/dark';
const MAX_ICO_LEVEL = 9;
const playPause = document.querySelector('#playPause');
const timeSlider = document.querySelector('#timeSlider');
const zoomLabel = document.querySelector('#zoomLabel');
const lodLabel = document.querySelector('#lodLabel');
const sampleLabel = document.querySelector('#sampleLabel');
const projectionSelector = document.querySelector('#projectionSelector');
const projectionButtons = [...projectionSelector.querySelectorAll('[data-projection]')];

if (!window.maplibregl) throw new Error('MapLibre GL JS did not load.');

const map = new window.maplibregl.Map({
  container: 'map',
  style: MAP_STYLE,
  center: WEATHER_REGION.center,
  zoom: WEATHER_REGION.initialZoom,
  maxPitch: 75,
  canvasContextAttributes: { antialias: true },
  attributionControl: true
});
map.addControl(new window.maplibregl.NavigationControl({ showCompass: true }), 'bottom-right');

const state = {
  playing: true,
  time: 0,
  lastFrame: performance.now(),
  scrubbing: false,
  samples: [],
  lod: { finest: 0, leaves: 0 },
  mapReady: false,
  geometryQueued: false,
  lastGeometryAt: 0
};
const icosphere = new Icosphere(MAX_ICO_LEVEL);
const weatherLayer = new GeographicDotsLayer();

function updateReadout() {
  zoomLabel.textContent = map.getZoom().toFixed(2);
  lodLabel.textContent = String(state.lod.finest);
  sampleLabel.textContent = state.samples.length.toLocaleString();
}

function rebuildGeometry() {
  state.geometryQueued = false;
  if (!state.mapReady) return;
  state.lod = selectGeographicSamples(map, icosphere);
  state.samples = state.lod.samples;
  weatherLayer.update(state.samples, state.time / LOOP_SECONDS);
  state.lastGeometryAt = performance.now();
  updateReadout();
}

function queueGeometry() {
  if (state.geometryQueued) return;
  state.geometryQueued = true;
  requestAnimationFrame(rebuildGeometry);
}

function setPlaying(playing) {
  state.playing = playing;
  playPause.dataset.state = playing ? 'playing' : 'paused';
  playPause.setAttribute('aria-label', playing ? 'Pause' : 'Play');
}

function updateTimelineFromPointer(clientX) {
  const rect = timeSlider.getBoundingClientRect();
  const min = Number(timeSlider.min);
  const max = Number(timeSlider.max);
  const value = clamp(min + (clientX - rect.left) / rect.width * (max - min), min, max);
  timeSlider.value = String(value);
  state.time = Number(timeSlider.value) / 1000 * LOOP_SECONDS;
  queueGeometry();
}

function setProjection(type) {
  if (map.getProjection().type === type) return;
  map.setProjection({ type });
  projectionSelector.dataset.projection = type;
  for (const button of projectionButtons) button.setAttribute('aria-checked', String(button.dataset.projection === type));
  queueGeometry();
}

let scrubbingPointerId = null;
playPause.addEventListener('click', () => setPlaying(!state.playing));
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
  state.time = Number(timeSlider.value) / 1000 * LOOP_SECONDS;
  queueGeometry();
});
for (const eventName of ['pointerup', 'pointercancel']) {
  timeSlider.addEventListener(eventName, (event) => {
    if (event.pointerId !== scrubbingPointerId) return;
    state.scrubbing = false;
    if (timeSlider.hasPointerCapture(event.pointerId)) timeSlider.releasePointerCapture(event.pointerId);
    scrubbingPointerId = null;
  });
}
for (const button of projectionButtons) button.addEventListener('click', () => setProjection(button.dataset.projection));

map.on('style.load', () => map.setProjection({ type: 'globe' }));
map.on('load', () => {
  map.addLayer(weatherLayer);
  state.mapReady = true;
  queueGeometry();
});
map.on('move', queueGeometry);
map.on('resize', queueGeometry);
map.on('error', (event) => console.error('MapLibre error:', event.error));
window.addEventListener('resize', queueGeometry);

function frame(now) {
  const delta = Math.min((now - state.lastFrame) / 1000, 0.1);
  state.lastFrame = now;
  if (state.playing && !state.scrubbing) {
    state.time = (state.time + delta) % LOOP_SECONDS;
    // The synthetic field evolves slowly over its 18-second loop. Throttling
    // buffer rebuilds to 10 Hz avoids repeatedly replacing GPU buffers while
    // keeping the deterministic motion visually continuous.
    if (state.mapReady && now - state.lastGeometryAt >= 100) queueGeometry();
  }
  if (!state.scrubbing) timeSlider.value = String(Math.round(state.time / LOOP_SECONDS * 1000));
  requestAnimationFrame(frame);
}

requestAnimationFrame(frame);
