import fs from 'node:fs';
import { setActiveWeatherField, WEATHER_REGION } from '../src/engine/geography.js';
import { RealWeatherSequence } from '../src/engine/real-weather.js';
import { GeographicWeatherPyramid } from '../src/engine/geographic-weather-pyramid.js';
import { canonicalWindowFromMercatorBounds, GeographicLodTopology, lngLatToMercator, lodRangeForStableLevel } from '../src/engine/geographic-lod.js';
import { GeographicDotsLayer, mapDotsWeatherSummary } from '../src/engine/geographic-dots-layer.js';
import { GeographicSquaresLayer, mapSquaresWeatherSummary } from '../src/engine/geographic-squares-layer.js';

const now = () => performance.now();
const metadata = JSON.parse(fs.readFileSync(new URL('../data/generated/current/metadata.json', import.meta.url), 'utf8'));
const grid = metadata.spatial_grid;
const binary = Buffer.concat(metadata.rain.frame_assets.map((asset) => fs.readFileSync(new URL(`../data/generated/current/${asset}`, import.meta.url))));
const weather = new RealWeatherSequence({ longitudes: Float64Array.from({ length: grid.width }, (_, i) => grid.longitude_start + i * grid.longitude_spacing), latitudes: Float64Array.from({ length: grid.height }, (_, i) => grid.latitude_start + i * grid.latitude_spacing), rainFramesMmh: new Float32Array(binary.buffer, binary.byteOffset, binary.byteLength / 4), frameCount: metadata.time.count, longitudeSpacing: grid.longitude_spacing, latitudeSpacing: grid.latitude_spacing, weatherSupport: grid.weather_support, timestamps: metadata.time.timestamps });
setActiveWeatherField(weather);
const [x, y] = lngLatToMercator(...WEATHER_REGION.center);
const window = canonicalWindowFromMercatorBounds({ minX: x - .004, maxX: x + .004, minY: y - .004, maxY: y + .004 });
const mappedBytes = (state) => Object.values(state).reduce((total, value) => total + (value instanceof Float32Array ? value.byteLength : 0), 0);
function median(values) { const sorted = [...values].sort((a, b) => a - b); return sorted[sorted.length >> 1]; }
function measure(fn, repeats = 25) { for (let i = 0; i < 5; i++) fn(); const values = []; for (let i = 0; i < repeats; i++) { const start = now(); fn(); values.push(now() - start); } return { median: median(values), p95: [...values].sort((a, b) => a - b)[Math.floor((values.length - 1) * .95)], max: Math.max(...values) }; }
function scenario(Layer, level, transition = null) {
  const topology = new GeographicLodTopology(window, lodRangeForStableLevel(level)); const pyramid = new GeographicWeatherPyramid(Float32Array, topology); const layer = new Layer(pyramid); layer.setActive(true); layer.setLevelData(topology.levelDataFor(transition?.[0] ?? level), .37);
  if (transition) layer.setTransition(topology.levelDataFor(transition[0]), topology.levelDataFor(transition[1]), .37, 0);
  return { layer, topology };
}
function layoutMetrics(level) {
  const topology = new GeographicLodTopology(window, lodRangeForStableLevel(level)); const pyramid = new GeographicWeatherPyramid(Float32Array, topology); const summary = pyramid.evaluate([level], weather.prepareFrame(.37))[level];
  const dots = mapDotsWeatherSummary(summary); const squares = mapSquaresWeatherSummary(summary);
  const squareLayer = new GeographicSquaresLayer(pyramid); squareLayer.levelData = topology.levelDataFor(level); squareLayer.temporal = { levels: new Map([[level, { frames0: { mapped: { [level]: squares } }, frames1: { mapped: { [level]: squares } } }]]) }; squareLayer.rebuildInstances();
  const samples = topology.levelDataFor(level).count;
  const count = squareLayer.instanceCounts[0];
  return { samples, dotsMappedBytes: mappedBytes(dots), squaresMappedBytes: mappedBytes(squares), squaresStride: squareLayer.instanceLayouts[0] === 'rain-only' ? 6 : 18, squaresInstanceUsedBytes: count * (squareLayer.instanceLayouts[0] === 'rain-only' ? 24 : 72), squaresInstanceCapacityBytes: squareLayer.instanceData[0].byteLength, fullHazardReference: { dotsMappedBytes: samples * 4 * 4, squaresMappedBytes: samples * 8 * 4, squaresStride: 18, squaresInstanceUsedBytes: count * 72 } };
}
const stableSquares = scenario(GeographicSquaresLayer, 14); const stableDots = scenario(GeographicDotsLayer, 14);
const refineSquares = scenario(GeographicSquaresLayer, 13, [13, 14]); const coarsenSquares = scenario(GeographicSquaresLayer, 14, [14, 13]);
console.log(JSON.stringify({ benchmark: 'renderer-channel-layouts', window, stable: { L13: layoutMetrics(13), L14: layoutMetrics(14), squaresL14Rebuild: measure(() => stableSquares.layer.rebuildInstances()), dotsL14Rebuild: measure(() => stableDots.layer.rebuildInstances()) }, transitions: { squares13to14Rebuild: measure(() => refineSquares.layer.rebuildInstances()), squares14to13Rebuild: measure(() => coarsenSquares.layer.rebuildInstances()) } }, null, 2));
