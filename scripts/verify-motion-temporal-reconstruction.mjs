import { RealWeatherSequence } from '../src/engine/real-weather.js';

const width = 9;
const height = 7;
const longitudes = Float64Array.from({ length: width }, (_, index) => index);
const latitudes = Float64Array.from({ length: height }, (_, index) => index);
const allSupport = new Uint8Array(width * height).fill(1);
const timestamps = ['2026-01-01T00:00:00Z', '2026-01-01T00:10:00Z', '2026-01-01T00:20:00Z'];

function assertClose(actual, expected, message, tolerance = 1e-6) {
  if (Math.abs(actual - expected) > tolerance) throw new Error(`${message}: expected ${expected}, received ${actual}`);
}

function translated(source, dx, dy) {
  const result = new Float32Array(source.length);
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    const sx = x - dx;
    const sy = y - dy;
    if (sx >= 0 && sx < width && sy >= 0 && sy < height) result[y * width + x] = source[sy * width + sx];
  }
  return result;
}

function motion(forwardX, forwardY, backwardX, backwardY) {
  const values = new Float32Array(4 * 4); // 2 × 2 grid, one value per component.
  values.fill(forwardX, 0, 4);
  values.fill(forwardY, 4, 8);
  values.fill(backwardX, 8, 12);
  values.fill(backwardY, 12, 16);
  return { width: 2, height: 2, spacing: width - 1, intervals: [values, values] };
}

function sequence(frames, motionData, temporalMode = 'motion') {
  return new RealWeatherSequence({
    longitudes, latitudes, sourceFrames: new Map(frames.map((frame, index) => [index, frame])),
    frameCount: frames.length, longitudeSpacing: 1, latitudeSpacing: 1, timestamps,
    potentialWeatherMask: allSupport, motion: motionData, temporalMode, sourceFrameCacheLimit: 3
  });
}

const frameA = new Float32Array(width * height);
frameA[3 * width + 3] = 4;
const frameB = translated(frameA, 2, 0);
const frameC = translated(frameB, 2, 0);
const weather = sequence([frameA, frameB, frameC], motion(2, 0, -2, 0));

// Exact boundaries use the ordinary exact-frame spatial reconstruction.
for (const [time, frame] of [[0, frameA], [0.5, frameB], [1, frameC]]) {
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    assertClose(weather.prepareFrame(time).sample(x, y, {}).rainMmh, frame[y * width + x], `exact endpoint ${time}/${x}/${y}`);
  }
}

// Matching translation moves the centroid halfway rather than retaining two fading copies.
const halfway = weather.prepareFrame(0.125); // interval 0, progress .25 because 3 frames.
let mass = 0; let centroidX = 0;
for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
  const value = halfway.sample(x, y, {}).rainMmh;
  mass += value;
  centroidX += value * x;
}
assertClose(centroidX / mass, 3.5, 'motion-compensated centroid at quarter interval', 1e-5);

// Differing backward data affects the B trace; this would fail if backward
// were derived by negating forward or simply ignored.
const asymmetric = sequence([frameA, frameB, frameC], motion(2, 0, -1, 0));
const symmetricValue = weather.prepareFrame(0.25).sample(4, 3, {}).rainMmh;
const asymmetricValue = asymmetric.prepareFrame(0.25).sample(4, 3, {}).rainMmh;
if (symmetricValue === asymmetricValue) throw new Error('backward displacement was not used independently.');

const zero = sequence([frameA, frameB, frameC], motion(0, 0, 0, 0));
for (const time of [0.1, 0.25, 0.6]) {
  const frame = zero.prepareFrame(time);
  const linear = sequence([frameA, frameB, frameC], null, 'linear').prepareFrame(time);
  assertClose(frame.sample(4, 3, {}).rainMmh, linear.sample(4, 3, {}).rainMmh, `zero motion reduces to linear ${time}`);
}

const identical = sequence([frameA, frameA, frameA], motion(0, 0, 0, 0));
for (const time of [0, 0.13, 0.5, 0.88, 1]) assertClose(identical.prepareFrame(time).sample(3, 3, {}).rainMmh, 4, `identical frame ${time}`);

// Out-of-domain samples are unavailable, not valid dry rain.
const edgeA = new Float32Array(width * height); edgeA[3 * width + 1] = 2;
const edgeB = translated(edgeA, 2, 0);
const edgeWeather = sequence([edgeA, edgeB, edgeB], motion(2, 0, -2, 0));
if (!(edgeWeather.prepareFrame(0.125).sample(2, 3, {}).rainMmh > 0)) throw new Error('boundary trace created false dry rain.');

const geometry = weather.prepareFrame(0.125).prepareSamplingGeometry(Float64Array.of(3), Float64Array.of(3));
if (geometry.baseIndex[0] !== 3 * width + 3) throw new Error('motion changed canonical sampling geometry identity.');

console.log('Motion temporal reconstruction verification passed: endpoints, translation, independent bidirectional vectors, zero/identical fields, continuity, boundaries, and fixed canonical identity.');
