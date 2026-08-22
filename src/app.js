import { LOOP_SECONDS } from './engine/config.js';
import { clamp } from './engine/math.js';
import { WEATHER_REGION } from './engine/geography.js';
import { selectMercatorGridSamples, zoomToMercatorGridLevel } from './engine/geographic-lod.js';
import { GeographicDotsLayer } from './engine/geographic-dots-layer.js';

const MAP_STYLE = 'https://tiles.openfreemap.org/styles/dark';
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
  lod: { level: null, leafCount: 0 },
  mapReady: false,
  weatherQueued: false,
  lastWeatherAt: 0
};
const weatherLayer = new GeographicDotsLayer();

function updateReadout() {
  zoomLabel.textContent = map.getZoom().toFixed(2);
  lodLabel.textContent = state.lod.level === null ? '–' : String(state.lod.level);
  sampleLabel.textContent = state.samples.length.toLocaleString();
}

function rebuildSamples(level) {
  if (!state.mapReady) return;
  if (state.lod.level === level) return;
  const selection = selectMercatorGridSamples(level);
  state.lod = { level: selection.level };
  state.samples = selection.samples;
  weatherLayer.setSamples(state.samples, state.time / LOOP_SECONDS);
  state.lastWeatherAt = performance.now();
  updateReadout();
}

function queueWeatherUpdate() {
  if (state.weatherQueued) return;
  state.weatherQueued = true;
  requestAnimationFrame(() => {
    state.weatherQueued = false;
    if (!state.mapReady) return;
    weatherLayer.updateWeather(state.time / LOOP_SECONDS);
    state.lastWeatherAt = performance.now();
  });
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
  queueWeatherUpdate();
}

function setProjection(type) {
  if (map.getProjection().type === type) return;
  map.setProjection({ type });
  projectionSelector.dataset.projection = type;
  for (const button of projectionButtons) button.setAttribute('aria-checked', String(button.dataset.projection === type));
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
for (const button of projectionButtons) button.addEventListener('click', () => setProjection(button.dataset.projection));

map.on('style.load', () => map.setProjection({ type: 'globe' }));
map.on('load', () => {
  map.addLayer(weatherLayer);
  state.mapReady = true;
  rebuildSamples(zoomToMercatorGridLevel(map.getZoom()));
});
map.on('zoom', () => {
  updateReadout();
  rebuildSamples(zoomToMercatorGridLevel(map.getZoom()));
});
map.on('error', (event) => console.error('MapLibre error:', event.error));

function frame(now) {
  const delta = Math.min((now - state.lastFrame) / 1000, 0.1);
  state.lastFrame = now;
  if (state.playing && !state.scrubbing) {
    state.time = (state.time + delta) % LOOP_SECONDS;
    // The synthetic field evolves slowly over its 18-second loop. Throttling
    // weather-value buffer rebuilds to 10 Hz keeps the topology untouched.
    if (state.mapReady && now - state.lastWeatherAt >= 100) queueWeatherUpdate();
  }
  if (!state.scrubbing) timeSlider.value = String(Math.round(state.time / LOOP_SECONDS * 1000));
  requestAnimationFrame(frame);
}

requestAnimationFrame(frame);
