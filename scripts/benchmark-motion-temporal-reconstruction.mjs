import { performance } from 'node:perf_hooks';
import { loadRealWeatherFixture } from './real-weather-fixture.mjs';
import { GeographicLodTopology, lodRangeForStableLevel, mercatorXForIndex, mercatorYForIndex } from '../src/engine/geographic-lod.js';
import { setActiveWeatherField } from '../src/engine/geography.js';

const { weather } = await loadRealWeatherFixture();
setActiveWeatherField(weather);
const topology = new GeographicLodTopology(undefined, lodRangeForStableLevel(13));
const level = topology.levels.get(13);
const longitudes = Float64Array.from({ length: level.width }, (_, x) => mercatorXForIndex(level, x) * 360 - 180);
const latitudes = Float64Array.from({ length: level.height }, (_, y) => Math.atan(Math.sinh(Math.PI * (1 - 2 * mercatorYForIndex(level, y)))) * 180 / Math.PI);
const geometry = weather.prepareRectangularSamplingGeometry(longitudes, latitudes, level.width, level.height);
const frame = weather.prepareFrame(0.347);
const generatedMotion = weather.motion;
// The checked-out generation may predate this experiment. A zero-vector asset
// still exercises the identical prepared-state and hot sampling path for a
// same-viewport arithmetic comparison without changing source rain values.
if (!weather.motion) {
  const spacing = 16;
  const width = Math.ceil((weather.longitudes.length - 1) / spacing) + 1;
  const height = Math.ceil((weather.latitudes.length - 1) / spacing) + 1;
  weather.motion = { width, height, spacing, intervals: Array.from({ length: weather.frameCount - 1 }, () => new Float32Array(width * height * 4)) };
}
const median = (values) => [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)];
function measure(mode) {
  weather.setTemporalMode(mode);
  for (let run = 0; run < 3; run++) {
    const sample = frame.prepareTemporalSampling(geometry);
    for (let i = 0; i < geometry.potentialActiveIndices.length; i++) sample(i);
  }
  const times = [];
  for (let run = 0; run < 9; run++) {
    const started = performance.now();
    const sample = frame.prepareTemporalSampling(geometry);
    let total = 0;
    for (let i = 0; i < geometry.potentialActiveIndices.length; i++) total += sample(i);
    if (!Number.isFinite(total)) throw new Error('non-finite temporal output');
    times.push(performance.now() - started);
  }
  return median(times);
}
const linearMs = measure('linear');
const motionMs = measure('motion');
console.log(JSON.stringify({
  activeCandidateSamples: geometry.potentialActiveIndices.length,
  linearMedianMs: linearMs,
  motionMedianMs: motionMs,
  motionPreparedBytes: weather.motionPreparedBytes(geometry),
  motionAssetKind: generatedMotion ? 'generated' : 'zero-vector synthetic fixture (hot-path cost only)'
}, null, 2));
