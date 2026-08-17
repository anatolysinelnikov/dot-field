import { LOOP_SECONDS, LOD_MORPH_SECONDS, MAX_ZOOM, MIN_ZOOM } from './engine/config.js';
import { clamp, mix, smoothstep } from './engine/math.js';
import { selectLOD } from './engine/lod.js';
import { renderLOD, renderLODMorph } from './engine/dots-renderer.js';
import { renderSquares, renderSquaresMorph } from './engine/squares-renderer.js';
import { renderBlurredFields } from './engine/blur-renderer.js';
import { renderAreaHazardMorph, renderAreaHazards, renderPrecipitationAreas } from './engine/areas-renderer.js';

const canvas = document.querySelector('#field');
const ctx = canvas.getContext('2d', { alpha: false });
const precipitationCanvas = document.createElement('canvas');
const precipitationCtx = precipitationCanvas.getContext('2d', { alpha: true });
const playPause = document.querySelector('#playPause');
const renderModeSelector = document.querySelector('#renderModeSelector');
const renderModeButtons = [...renderModeSelector.querySelectorAll('[data-render-mode]')];
const timeSlider = document.querySelector('#timeSlider');
const zoomLabel = document.querySelector('#zoomLabel');
const lodLabel = document.querySelector('#lodLabel');
const resetZoom = document.querySelector('#resetZoom');
const squaresRainTuning = document.querySelector('#squaresRainTuning');
const squaresBoundaryRainBrightness = document.querySelector('#squaresBoundaryRainBrightness');
const squaresBoundaryRainBrightnessValue = document.querySelector('#squaresBoundaryRainBrightnessValue');

const state = { playing: true, time: 0, zoom: 1, width: 1, height: 1, dpr: 1,
  lastFrame: performance.now(), scrubbing: false, renderMode: 'dots', lodLevel: null,
  desiredLOD: null, lodMorph: null, boundaryRainBrightness: 0.02 };

function resizeCanvas() {
  state.dpr = window.devicePixelRatio || 1;
  state.width = Math.max(1, window.innerWidth);
  state.height = Math.max(1, window.innerHeight);
  canvas.style.width = `${state.width}px`;
  canvas.style.height = `${state.height}px`;
  canvas.width = Math.round(state.width * state.dpr);
  canvas.height = Math.round(state.height * state.dpr);
  ctx.setTransform(state.dpr, 0, 0, state.dpr, 0, 0);
}

function getVisibleWorldBounds(fieldPixels, centerX, centerY, zoom = state.zoom) {
  const scale = fieldPixels * zoom;
  return { minX: 0.5 - centerX / scale, maxX: 0.5 + (state.width - centerX) / scale,
    minY: 0.5 - centerY / scale, maxY: 0.5 + (state.height - centerY) / scale };
}

function updateLODTransition(delta, desiredLOD) {
  state.desiredLOD = desiredLOD;
  if (state.lodLevel === null) { state.lodLevel = desiredLOD; return; }
  if (!state.lodMorph && desiredLOD !== state.lodLevel) {
    state.lodMorph = desiredLOD < state.lodLevel
      ? { coarse: state.lodLevel, fine: state.lodLevel - 1, progress: 0, direction: 1 }
      : { coarse: state.lodLevel + 1, fine: state.lodLevel, progress: 1, direction: -1 };
  }
  const morph = state.lodMorph;
  if (!morph) return;
  if (desiredLOD <= morph.fine) morph.direction = 1;
  else if (desiredLOD >= morph.coarse) morph.direction = -1;
  morph.progress += morph.direction * delta / LOD_MORPH_SECONDS;
  if (morph.progress >= 1) { state.lodLevel = morph.fine; state.lodMorph = null; }
  else if (morph.progress <= 0) { state.lodLevel = morph.coarse; state.lodMorph = null; }
}

function render(delta) {
  ctx.globalAlpha = 1;
  ctx.fillStyle = '#080b12';
  ctx.fillRect(0, 0, state.width, state.height);
  const fieldPixels = Math.min(state.width, state.height) * 0.92;
  const centerX = state.width / 2;
  const centerY = state.height / 2 - Math.min(24, state.height * 0.025);
  const desiredLOD = Math.round(selectLOD(state.zoom, fieldPixels));
  const t = state.time / LOOP_SECONDS;
  const travelBounds = getVisibleWorldBounds(fieldPixels, centerX, centerY, 1);
  const travelX = mix(mix(travelBounds.minX, travelBounds.maxX, 0.33),
    mix(travelBounds.minX, travelBounds.maxX, 0.67), smoothstep(0, 1, t));
  const viewport = { width: state.width, height: state.height, zoom: state.zoom,
    bounds: getVisibleWorldBounds(fieldPixels, centerX, centerY) };
  updateLODTransition(delta, desiredLOD);
  if (state.renderMode === 'blur') {
    renderBlurredFields(ctx, precipitationCanvas, precipitationCtx, viewport, t, travelX, fieldPixels, centerX, centerY);
  } else if (state.renderMode === 'areas') {
    renderPrecipitationAreas(ctx, viewport, t, travelX, fieldPixels, centerX, centerY);
    if (state.lodMorph) renderAreaHazardMorph(ctx, viewport, state.lodMorph, t, travelX, fieldPixels, centerX, centerY);
    else renderAreaHazards(ctx, viewport, state.lodLevel, t, travelX, fieldPixels, centerX, centerY);
  } else if (state.renderMode === 'squares') {
    if (state.lodMorph) renderSquaresMorph(ctx, viewport, state.lodMorph, t, travelX, fieldPixels, centerX, centerY, state.boundaryRainBrightness);
    else renderSquares(ctx, viewport, state.lodLevel, t, travelX, fieldPixels, centerX, centerY, state.boundaryRainBrightness);
  } else if (state.lodMorph) {
    renderLODMorph(ctx, viewport, state.lodMorph, t, travelX, fieldPixels, centerX, centerY);
  } else {
    renderLOD(ctx, viewport, state.lodLevel, t, travelX, fieldPixels, centerX, centerY);
  }
  ctx.globalAlpha = 1;
  zoomLabel.textContent = `${state.zoom.toFixed(2)}×`;
  lodLabel.textContent = state.lodMorph ? `${state.lodMorph.coarse}→${state.lodMorph.fine}` : String(state.lodLevel);
  if (!state.scrubbing) timeSlider.value = String(Math.round(state.time / LOOP_SECONDS * 1000));
}

function frame(now) {
  const delta = Math.min((now - state.lastFrame) / 1000, 0.1);
  state.lastFrame = now;
  if (state.playing && !state.scrubbing) state.time = (state.time + delta) % LOOP_SECONDS;
  render(delta);
  requestAnimationFrame(frame);
}

function setPlaying(playing) {
  state.playing = playing;
  playPause.dataset.state = state.playing ? 'playing' : 'paused';
  playPause.setAttribute('aria-label', state.playing ? 'Pause' : 'Play');
}
playPause.addEventListener('click', () => {
  setPlaying(!state.playing);
});
function setRenderMode(mode) {
  state.renderMode = mode;
  renderModeSelector.dataset.mode = mode;
  squaresRainTuning.hidden = mode !== 'squares';
  for (const button of renderModeButtons) {
    button.setAttribute('aria-checked', String(button.dataset.renderMode === mode));
  }
}
squaresBoundaryRainBrightness.addEventListener('input', () => {
  state.boundaryRainBrightness = Number(squaresBoundaryRainBrightness.value);
  squaresBoundaryRainBrightnessValue.value = state.boundaryRainBrightness.toFixed(2);
});
for (const button of renderModeButtons) {
  button.addEventListener('click', () => setRenderMode(button.dataset.renderMode));
}
let scrubbingPointerId = null;
function updateTimelineFromPointer(clientX) {
  const rect = timeSlider.getBoundingClientRect();
  const min = Number(timeSlider.min);
  const max = Number(timeSlider.max);
  const value = clamp(min + (clientX - rect.left) / rect.width * (max - min), min, max);
  timeSlider.value = String(value);
  state.time = Number(timeSlider.value) / 1000 * LOOP_SECONDS;
}
timeSlider.addEventListener('pointerdown', (event) => {
  if (state.playing) setPlaying(false);
  updateTimelineFromPointer(event.clientX);
  state.scrubbing = true;
  scrubbingPointerId = event.pointerId;
  timeSlider.setPointerCapture(event.pointerId);
});
timeSlider.addEventListener('pointermove', (event) => {
  if (event.pointerId === scrubbingPointerId) updateTimelineFromPointer(event.clientX);
});
timeSlider.addEventListener('input', () => { state.time = Number(timeSlider.value) / 1000 * LOOP_SECONDS; });
const endScrub = (event) => {
  if (event.pointerId !== scrubbingPointerId) return;
  state.scrubbing = false;
  if (timeSlider.hasPointerCapture(event.pointerId)) timeSlider.releasePointerCapture(event.pointerId);
  scrubbingPointerId = null;
};
timeSlider.addEventListener('pointerup', endScrub);
timeSlider.addEventListener('pointercancel', endScrub);

function setZoom(next) {
  state.zoom = clamp(next, MIN_ZOOM, MAX_ZOOM);
  resetZoom.hidden = state.zoom.toFixed(2) === '1.00';
}
document.querySelector('#zoomIn').addEventListener('click', () => setZoom(state.zoom * 1.28));
document.querySelector('#zoomOut').addEventListener('click', () => setZoom(state.zoom / 1.28));
resetZoom.addEventListener('click', () => setZoom(1));
canvas.addEventListener('wheel', (event) => { event.preventDefault(); setZoom(state.zoom * Math.exp(-event.deltaY * 0.00125)); }, { passive: false });
let pinchStartDistance = 0;
let pinchStartZoom = state.zoom;
function touchDistance(touches) { return Math.hypot(touches[1].clientX - touches[0].clientX, touches[1].clientY - touches[0].clientY); }
canvas.addEventListener('touchstart', (event) => {
  if (event.touches.length !== 2) return;
  event.preventDefault(); pinchStartDistance = touchDistance(event.touches); pinchStartZoom = state.zoom;
}, { passive: false });
canvas.addEventListener('touchmove', (event) => {
  if (event.touches.length !== 2 || pinchStartDistance <= 0) return;
  event.preventDefault(); setZoom(pinchStartZoom * touchDistance(event.touches) / pinchStartDistance);
}, { passive: false });
const endPinch = (event) => { if (event.touches.length < 2) pinchStartDistance = 0; };
canvas.addEventListener('touchend', endPinch, { passive: true });
canvas.addEventListener('touchcancel', endPinch, { passive: true });
window.addEventListener('resize', resizeCanvas);
resizeCanvas();
requestAnimationFrame(frame);
