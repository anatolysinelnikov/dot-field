const MAX_SAMPLES = 6000;

function percentile(values, fraction) {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * fraction) - 1)];
}

function summarize(values) {
  if (!values.length) return { count: 0, medianMs: null, p95Ms: null, p99Ms: null, maxMs: null, over16_7Pct: null, over33_3Pct: null, over50Pct: null, over100Pct: null };
  const over = (threshold) => values.filter((value) => value > threshold).length * 100 / values.length;
  return {
    count: values.length,
    medianMs: percentile(values, 0.5),
    p95Ms: percentile(values, 0.95),
    p99Ms: percentile(values, 0.99),
    maxMs: Math.max(...values),
    over16_7Pct: over(16.7),
    over33_3Pct: over(33.3),
    over50Pct: over(50),
    over100Pct: over(100)
  };
}

function pushBounded(values, value) {
  if (!Number.isFinite(value)) return;
  values.push(value);
  if (values.length > MAX_SAMPLES) values.shift();
}

export function createRuntimeCadenceDiagnostics({ enabled = false, playbackRate = 1 } = {}) {
  if (!enabled) return null;
  const frameDeltas = [];
  const logicalDeltas = [];
  const updateDurations = [];
  const preparationDurations = [];
  const deterministicSteps = [];
  let previousFrameAt = null;
  let previousLogicalTime = null;
  let previousCommittedTime = null;
  let previousInterval = null;
  let previousProgress = null;
  let previousRequestGeneration = null;
  let frameCount = 0;
  let weatherUpdateCount = 0;
  let preparedCount = 0;
  let committedCount = 0;
  let longFrameCount = 0;
  let orderingViolations = 0;
  let intervalRegressions = 0;
  let progressRegressions = 0;
  let staleCommitCount = 0;
  let lastFrame = null;

  function recordFrame(timestamp, details = {}) {
    if (previousFrameAt !== null) {
      const delta = timestamp - previousFrameAt;
      pushBounded(frameDeltas, delta);
      if (delta > 50) longFrameCount++;
    }
    if (previousLogicalTime !== null) {
      const delta = details.logicalTime - previousLogicalTime;
      pushBounded(logicalDeltas, delta);
      if (delta < -1e-9) orderingViolations++;
    }
    const interval = details.interval;
    const progress = details.progress;
    if (previousInterval !== null && interval < previousInterval) intervalRegressions++;
    if (previousInterval === interval && previousProgress !== null && progress < previousProgress - 1e-9) progressRegressions++;
    previousFrameAt = timestamp;
    previousLogicalTime = details.logicalTime;
    previousInterval = interval;
    previousProgress = progress;
    frameCount++;
    lastFrame = { ...details, timestamp };
  }

  function recordWeatherUpdate({ prepared = false, committed = false, durationMs = null, preparationMs = null, logicalTime = null } = {}) {
    weatherUpdateCount++;
    if (prepared) preparedCount++;
    if (committed) committedCount++;
    pushBounded(updateDurations, durationMs);
    pushBounded(preparationDurations, preparationMs);
    if (committed && Number.isFinite(logicalTime)) {
      if (previousCommittedTime !== null && logicalTime < previousCommittedTime - 1e-9) orderingViolations++;
      previousCommittedTime = logicalTime;
    }
  }

  function recordRequestCommit(requestGeneration) {
    if (!Number.isFinite(requestGeneration)) return;
    if (previousRequestGeneration !== null && requestGeneration < previousRequestGeneration) staleCommitCount++;
    previousRequestGeneration = requestGeneration;
  }

  function recordDeterministicStep(details = {}) {
    deterministicSteps.push({ ...details });
    if (deterministicSteps.length > MAX_SAMPLES) deterministicSteps.shift();
  }

  function reset() {
    frameDeltas.length = 0; logicalDeltas.length = 0; updateDurations.length = 0; preparationDurations.length = 0; deterministicSteps.length = 0;
    previousFrameAt = null; previousLogicalTime = null; previousCommittedTime = null; previousInterval = null; previousProgress = null; previousRequestGeneration = null;
    frameCount = 0; weatherUpdateCount = 0; preparedCount = 0; committedCount = 0; longFrameCount = 0;
    orderingViolations = 0; intervalRegressions = 0; progressRegressions = 0; staleCommitCount = 0; lastFrame = null;
  }

  return {
    playbackRate,
    recordFrame,
    recordWeatherUpdate,
    recordRequestCommit,
    recordDeterministicStep,
    reset,
    summary() {
      return {
        enabled: true,
        playbackRate,
        frameCount,
        weatherUpdateCount,
        preparedCount,
        committedCount,
        longFrameCount,
        frameGaps: summarize(frameDeltas),
        logicalTimeDeltas: summarize(logicalDeltas),
        weatherUpdateDurations: summarize(updateDurations),
        weatherPreparationDurations: summarize(preparationDurations),
        deterministic: { count: deterministicSteps.length, steps: [...deterministicSteps] },
        ordering: { logicalTimeRegressions: orderingViolations, intervalRegressions, progressRegressions, staleCommitCount },
        lastFrame
      };
    }
  };
}
