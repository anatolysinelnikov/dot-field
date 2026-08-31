import fs from 'node:fs';
import { parseRealWeatherCsv } from '../src/engine/real-weather.js';
import { setActiveWeatherField } from '../src/engine/geography.js';
import { canonicalWindowFromMercatorBounds, GeographicLodTopology, lngLatToMercator } from '../src/engine/geographic-lod.js';
import { GeographicWeatherPyramid } from '../src/engine/geographic-weather-pyramid.js';
import { GeographicDotsLayer } from '../src/engine/geographic-dots-layer.js';
import { GeographicSquaresLayer } from '../src/engine/geographic-squares-layer.js';

const GPU_LEVEL = 14;
setActiveWeatherField(parseRealWeatherCsv(fs.readFileSync(new URL('../data/mrl_z3_t+40min_376x239.csv', import.meta.url), 'utf8')));
const [centerX, centerY] = lngLatToMercator(45.03, 43.35);
const firstWindow = canonicalWindowFromMercatorBounds({
  minX: centerX - 0.004,
  maxX: centerX + 0.004,
  minY: centerY - 0.004,
  maxY: centerY + 0.004
});
const shiftedWindow = canonicalWindowFromMercatorBounds({
  minX: centerX + 0.006,
  maxX: centerX + 0.014,
  minY: centerY - 0.002,
  maxY: centerY + 0.006
});

let failures = 0;
function check(condition, message) {
  if (condition) console.log(`PASS ${message}`);
  else { failures++; console.error(`FAIL ${message}`); }
}

function source(topology, levelData) {
  return {
    topology,
    levelData,
    textureA: {},
    textureB: {},
    width: levelData.width,
    height: levelData.height,
    format: 'R16F'
  };
}

for (const Layer of [GeographicDotsLayer, GeographicSquaresLayer]) {
  const pyramid = new GeographicWeatherPyramid(Float32Array, new GeographicLodTopology(firstWindow, { minLevel: 13, maxLevel: 14 }));
  const layer = new Layer(pyramid);
  const firstTopology = pyramid.topology;
  const firstLevelData = pyramid.levelDataFor(GPU_LEVEL);

  layer.setGpuWeatherMode(true);
  layer.setLevelData(firstLevelData, 0);
  const firstSource = source(firstTopology, firstLevelData);
  check(layer.isGpuWeatherSourceCompatible(firstSource), `${Layer.name} accepts matching topology and L14 identity`);
  layer.setGpuWeatherSource(firstSource, { requestRepaint: false });
  check(layer.gpuWeatherSource === firstSource, `${Layer.name} installs the matching source`);

  pyramid.setCanonicalWindow(shiftedWindow);
  const shiftedTopology = pyramid.topology;
  layer.setTopology(shiftedTopology);
  check(layer.gpuWeatherSource === null, `${Layer.name} clears source when the canonical window changes`);
  layer.setLevelData(pyramid.levelDataFor(GPU_LEVEL), 0);
  check(layer.gpuWeatherSource === null, `${Layer.name} keeps source clear until the new L14 source is ready`);

  const shiftedSource = source(shiftedTopology, layer.levelData);
  layer.setGpuWeatherSource(shiftedSource, { requestRepaint: false });
  check(layer.gpuWeatherSource === shiftedSource, `${Layer.name} accepts the synchronized replacement source`);

  const sameWindowReplacement = new GeographicLodTopology(shiftedTopology.canonicalWindow, { minLevel: 13, maxLevel: 14 });
  pyramid.setTopology(sameWindowReplacement);
  layer.setTopology(sameWindowReplacement);
  check(layer.gpuWeatherSource === null, `${Layer.name} clears source for a same-window topology replacement`);
  layer.setLevelData(pyramid.levelDataFor(GPU_LEVEL), 0);
  const synchronizedSource = source(sameWindowReplacement, layer.levelData);
  layer.setGpuWeatherSource(synchronizedSource, { requestRepaint: false });
  check(layer.gpuWeatherSource === synchronizedSource, `${Layer.name} resumes after same-window synchronization`);

  let threw = false;
  try {
    layer.setGpuWeatherSource(source(shiftedTopology, layer.levelData), { requestRepaint: false });
  } catch (error) {
    threw = error instanceof Error && error.message.includes('GPU weather source must match the active direct-level topology');
  }
  check(threw, `${Layer.name} retains the topology compatibility invariant`);

  layer.setActive(false);
  layer.setTransition(pyramid.levelDataFor(13), pyramid.levelDataFor(GPU_LEVEL), 0, 0);
  check(layer.gpuWeatherSource === null, `${Layer.name} clears source before an L13/L14 transition`);

  layer.setGpuWeatherMode(false);
  check(layer.gpuWeatherSource === null, `${Layer.name} clears source on GPU deactivation`);
}

// Stable L13 uses the same source/topology identity contract as L14.
for (const Layer of [GeographicDotsLayer, GeographicSquaresLayer]) {
  const pyramid = new GeographicWeatherPyramid(Float32Array, new GeographicLodTopology(firstWindow, { minLevel: 12, maxLevel: 14 }));
  const layer = new Layer(pyramid);
  const levelData = pyramid.levelDataFor(13);
  layer.setGpuWeatherMode(true);
  layer.setLevelData(levelData, 0);
  const source13 = source(pyramid.topology, levelData);
  check(layer.isGpuWeatherSourceCompatible(source13), `${Layer.name} accepts matching stable L13 identity`);
  layer.setGpuWeatherSource(source13, { requestRepaint: false });
  check(layer.gpuWeatherSource === source13, `${Layer.name} installs the stable L13 source`);
  const mismatched = source(new GeographicLodTopology(shiftedWindow, { minLevel: 12, maxLevel: 14 }), levelData);
  let threw = false;
  try { layer.setGpuWeatherSource(mismatched, { requestRepaint: false }); } catch (error) {
    threw = error instanceof Error && error.message.includes('GPU weather source must match the active direct-level topology');
  }
  check(threw, `${Layer.name} rejects mismatched stable L13 source identity`);
}

if (failures) process.exitCode = 1;
console.log(failures ? `VERIFICATION FAILED: ${failures}` : 'VERIFICATION PASSED');
