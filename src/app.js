import { LOD_MORPH_SECONDS, LOOP_SECONDS } from './engine/config.js';
import { clamp, smoothstep } from './engine/math.js';
import { WEATHER_REGION } from './engine/geography.js';
import { selectMercatorGridSamples, zoomToMercatorGridLevel } from './engine/geographic-lod.js';
import { GeographicDotsLayer } from './engine/geographic-dots-layer.js';

const MAP_STYLE = 'https://tiles.openfreemap.org/styles/dark';
const WATER_BOUNDARY_LAYER_ID = 'geographic-water-boundaries';
const WEATHER_CONTEXT_BEFORE_IDS = [
  'highway_major_inner',
  'highway_major_subtle',
  'highway_motorway_casing',
  'highway_name_other',
  'boundary_state',
  'place_other'
];
const WEATHER_CONTEXT_TEXT_IDS = [
  'highway_name_other',
  'highway_name_motorway',
  'place_other',
  'place_suburb',
  'place_village',
  'place_town',
  'place_city',
  'place_city_large',
  'place_state',
  'place_country_other',
  'place_country_minor',
  'place_country_major'
];
const WEATHER_CONTEXT_ROAD_LABEL_IDS = [
  'highway_name_other',
  'highway_name_motorway'
];
const WEATHER_CONTEXT_PLACE_LABEL_IDS = WEATHER_CONTEXT_TEXT_IDS.filter((layerId) => !WEATHER_CONTEXT_ROAD_LABEL_IDS.includes(layerId));
const WEATHER_CONTEXT_RAIL_IDS = [
  'railway_transit',
  'railway_transit_dashline',
  'railway_minor',
  'railway_minor_dashline',
  'railway',
  'railway_dashline'
];
const WEATHER_CONTEXT_BELOW_WEATHER_IDS = ['highway_motorway_subtle'];
const WEATHER_CONTEXT_MAJOR_SUPPORT_IDS = ['highway_major_subtle'];
const WEATHER_CONTEXT_UPPER_LINE_FACTORS = [
  ['highway_major_inner', 0.45],
  ['highway_major_subtle', 0.3],
  ['highway_motorway_casing', 0.7],
  ['highway_motorway_inner', 0.7]
];
const PLACE_LABEL_COLOR = '#AAAAAA';
const ROAD_LABEL_COLOR = '#AAAAAA';
const MAX_SAMPLING_LATITUDE = 85;
const playPause = document.querySelector('#playPause');
const timeSlider = document.querySelector('#timeSlider');
const zoomLabel = document.querySelector('#zoomLabel');
const mapZoomLabel = document.querySelector('#mapZoomLabel');
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
  desiredLevel: null,
  lodTransition: null,
  logicalSamplingZoom: WEATHER_REGION.initialZoom,
  camera: null,
  projectionSwitching: false,
  mapReady: false,
  weatherQueued: false
};
const weatherLayer = new GeographicDotsLayer();
let lastMapErrorSignature = '';
let contextStyleObject = null;

function updateReadout() {
  zoomLabel.textContent = state.logicalSamplingZoom.toFixed(2);
  mapZoomLabel.textContent = map.getZoom().toFixed(2);
  lodLabel.textContent = state.lod.level === null ? '–' : String(state.lod.level);
  sampleLabel.textContent = state.samples.length.toLocaleString();
}

function cameraState() {
  return {
    rawZoom: map.getZoom(),
    latitude: clamp(map.getCenter().lat, -MAX_SAMPLING_LATITUDE, MAX_SAMPLING_LATITUDE),
    projection: map.getProjection().type
  };
}

function rebaseCamera() {
  state.camera = cameraState();
}

function updateLogicalSamplingZoom() {
  const next = cameraState();
  const previous = state.camera;
  if (!previous || state.projectionSwitching || previous.projection !== next.projection) {
    state.camera = next;
    updateReadout();
    return;
  }
  let delta = next.rawZoom - previous.rawZoom;
  if (next.projection === 'globe') {
    const nextCosine = Math.max(0.001, Math.cos(next.latitude * Math.PI / 180));
    const previousCosine = Math.max(0.001, Math.cos(previous.latitude * Math.PI / 180));
    delta -= Math.log2(nextCosine / previousCosine);
  }
  if (Number.isFinite(delta)) state.logicalSamplingZoom += delta;
  state.camera = next;
  updateReadout();
  rebuildSamples(zoomToMercatorGridLevel(state.logicalSamplingZoom));
}

function commitSamples(level, samples) {
  state.lod = { level };
  state.samples = samples;
  weatherLayer.setSamples(samples, state.time / LOOP_SECONDS);
  updateReadout();
}

function multiplyPaintOpacity(currentOpacity, factor) {
  if (typeof currentOpacity === 'number') return currentOpacity * factor;
  if (Array.isArray(currentOpacity)) return ['*', currentOpacity, factor];
  return factor;
}

function findHydrographyBeforeId() {
  return WEATHER_CONTEXT_BEFORE_IDS.find((layerId) => map.getLayer(layerId));
}

function waterBoundaryLayer() {
  const waterLayer = map.getLayer('water');
  if (!waterLayer || !waterLayer.source || !waterLayer['source-layer']) return null;
  const boundaryLayer = {
    id: WATER_BOUNDARY_LAYER_ID,
    type: 'line',
    source: waterLayer.source,
    'source-layer': waterLayer['source-layer'],
    filter: waterLayer.filter,
    paint: {
      'line-color': waterLayer.paint?.['fill-color'] || '#1B1B1D',
      'line-opacity': 0.75,
      'line-width': 1
    }
  };
  if (waterLayer.minzoom !== undefined) boundaryLayer.minzoom = waterLayer.minzoom;
  if (waterLayer.maxzoom !== undefined) boundaryLayer.maxzoom = waterLayer.maxzoom;
  return boundaryLayer;
}

function tuneWeatherContext(style) {
  if (style === contextStyleObject) return;
  contextStyleObject = style;
  for (const layerId of WEATHER_CONTEXT_TEXT_IDS) {
    if (!map.getLayer(layerId)) continue;
    map.setPaintProperty(layerId, 'text-halo-color', 'rgba(0, 0, 0, 0.9)');
    map.setPaintProperty(layerId, 'text-halo-width', 1.5);
    map.setPaintProperty(layerId, 'text-halo-blur', 0.2);
  }
  for (const layerId of WEATHER_CONTEXT_PLACE_LABEL_IDS) {
    if (!map.getLayer(layerId)) continue;
    map.setPaintProperty(layerId, 'text-color', PLACE_LABEL_COLOR);
    map.setPaintProperty(layerId, 'text-halo-width', 1.75);
  }
  for (const layerId of WEATHER_CONTEXT_ROAD_LABEL_IDS) {
    if (!map.getLayer(layerId)) continue;
    map.setPaintProperty(layerId, 'text-color', ROAD_LABEL_COLOR);
  }
  const majorSubtleLayer = map.getLayer('highway_major_subtle');
  if (majorSubtleLayer) {
    const width = map.getPaintProperty('highway_major_subtle', 'line-width');
    if (Array.isArray(width) && width[0] === 'interpolate') {
      const adjustedWidth = [...width];
      const zoomSixIndex = adjustedWidth.findIndex((value, index) => index > 2 && value === 6);
      if (zoomSixIndex >= 0 && adjustedWidth[zoomSixIndex + 1] === 0) {
        adjustedWidth[zoomSixIndex + 1] = 0.6;
        map.setPaintProperty('highway_major_subtle', 'line-width', adjustedWidth);
      }
    }
  }
  for (const [layerId, factor] of WEATHER_CONTEXT_UPPER_LINE_FACTORS) {
    if (!map.getLayer(layerId)) continue;
    const currentOpacity = map.getPaintProperty(layerId, 'line-opacity');
    map.setPaintProperty(layerId, 'line-opacity', multiplyPaintOpacity(currentOpacity, factor));
  }
  const waterwayLayer = map.getLayer('waterway');
  if (waterwayLayer) {
    const currentOpacity = map.getPaintProperty('waterway', 'line-opacity');
    map.setPaintProperty('waterway', 'line-opacity', multiplyPaintOpacity(currentOpacity, 0.65));
  }
}

function initializeWeatherLayer() {
  tuneWeatherContext(map.getStyle());
  const layerAlreadyPresent = Boolean(map.getLayer(weatherLayer.id));
  if (!layerAlreadyPresent) {
    const beforeId = WEATHER_CONTEXT_BEFORE_IDS.find((layerId) => map.getLayer(layerId));
    map.addLayer(weatherLayer, beforeId);
  }
  for (const layerId of WEATHER_CONTEXT_BELOW_WEATHER_IDS) {
    if (map.getLayer(layerId)) map.moveLayer(layerId, weatherLayer.id);
  }
  for (const layerId of WEATHER_CONTEXT_RAIL_IDS) {
    if (map.getLayer(layerId)) map.moveLayer(layerId, weatherLayer.id);
  }
  if (map.getLayer('waterway')) {
    const beforeId = findHydrographyBeforeId();
    if (beforeId) map.moveLayer('waterway', beforeId);
    else map.moveLayer('waterway');
  }
  if (!map.getLayer(WATER_BOUNDARY_LAYER_ID)) {
    const boundaryLayer = waterBoundaryLayer();
    if (boundaryLayer) map.addLayer(boundaryLayer, findHydrographyBeforeId());
  }
  for (const layerId of WEATHER_CONTEXT_MAJOR_SUPPORT_IDS) {
    if (!map.getLayer(layerId)) continue;
    const beforeId = map.getLayer('highway_major_inner') ? 'highway_major_inner' : weatherLayer.id;
    map.moveLayer(layerId, beforeId);
  }
  if (state.mapReady) return;
  state.mapReady = true;
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
  }
}

function updateLODTransition(now) {
  const transition = state.lodTransition;
  if (!transition) return;
  const rawProgress = clamp((now - transition.start) / (LOD_MORPH_SECONDS * 1000), 0, 1);
  transition.rawProgress = rawProgress;
  weatherLayer.setTransitionProgress(smoothstep(0, 1, rawProgress));
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
    weatherLayer.updateWeather(state.time / LOOP_SECONDS);
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
  state.time = Number(timeSlider.value) * LOOP_SECONDS;
  queueWeatherUpdate();
}

function setProjection(type) {
  if (map.getProjection().type === type) return;
  state.projectionSwitching = true;
  map.setProjection({ type });
  projectionSelector.dataset.projection = type;
  for (const button of projectionButtons) button.setAttribute('aria-checked', String(button.dataset.projection === type));
  // MapLibre may adjust raw camera zoom while changing projections. Its
  // projection update is applied in the render cycle, while this custom layer
  // continuously requests repaints, so do not wait for an idle event here.
  requestAnimationFrame(() => requestAnimationFrame(() => {
    rebaseCamera();
    state.projectionSwitching = false;
    updateReadout();
  }));
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
for (const button of projectionButtons) button.addEventListener('click', () => setProjection(button.dataset.projection));

map.on('style.load', () => {
  if (!state.mapReady) map.setProjection({ type: 'globe' });
  initializeWeatherLayer();
});
map.on('move', updateLogicalSamplingZoom);
map.on('error', (event) => {
  const error = event?.error;
  const details = [];
  if (event && 'sourceId' in event && event.sourceId) details.push(`source=${event.sourceId}`);
  if (event && 'tile' in event && event.tile) details.push('tile');
  if (event && 'url' in event && event.url) details.push(`url=${event.url}`);
  const message = error instanceof Error ? error.message : String(error || 'Unknown MapLibre error');
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
  console.error(`MapLibre ${category} error${details.length ? ` (${details.join(', ')})` : ''}:`, error || event);
});

function frame(now) {
  const delta = Math.min((now - state.lastFrame) / 1000, 0.1);
  state.lastFrame = now;
  if (state.playing && !state.scrubbing) {
    state.time = (state.time + delta) % LOOP_SECONDS;
  }
  // A paused static layer has no temporal uniform to advance. Leaving its
  // repaint scheduling to MapLibre prevents the application RAF from keeping
  // an otherwise idle map rendering continuously.
  if (state.mapReady && state.playing && !state.scrubbing) weatherLayer.updateWeather(state.time / LOOP_SECONDS);
  updateLODTransition(now);
  if (!state.scrubbing) timeSlider.value = String(state.time / LOOP_SECONDS);
  requestAnimationFrame(frame);
}

requestAnimationFrame(frame);
