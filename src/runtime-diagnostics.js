const DATABASE_NAME = 'dot-field-diagnostics';
const DATABASE_VERSION = 1;
const MAX_SAMPLES = 900;
const MAX_EVENTS = 320;
const MAX_WEATHER_RESOURCES = 256;
const MAX_RENDER_TIMESTAMPS = 360;
const FRAME_WINDOW_MS = 5000;
const FAILURE_WINDOW_MS = 90_000;
const FAILURE_EVENT_TAIL = 24;
const FAILURE_RESOURCE_NEAR_WINDOW_MS = 15_000;
const SAMPLE_INTERVAL_MS = 1000;
const FLUSH_INTERVAL_MS = 2000;
const STALL_THRESHOLDS_MS = Object.freeze([100, 500, 2000]);
const CALLBACK_EXCEPTION_NAME_LIMIT = 120;
const CALLBACK_EXCEPTION_MESSAGE_LIMIT = 1000;
const CALLBACK_EXCEPTION_STACK_LIMIT = 4000;
const CALLBACK_EXCEPTION_VALUE_LIMIT = 500;

const LIMITATIONS = Object.freeze({
  totalProcessMemory: 'Total Safari/WebContent process memory is unavailable from page JavaScript.',
  cpuUtilization: 'Total CPU utilization is unavailable from page JavaScript.',
  gpuUtilization: 'Total GPU utilization is unavailable from page JavaScript.',
  trackedCpu: 'Tracked CPU memory covers explicitly measured Dot Field buffers and arrays only.',
  estimatedGpu: 'GPU buffer sizes are estimates of Dot Field-owned allocations, not total GPU memory.'
});

function now() {
  return globalThis.performance?.now?.() ?? Date.now();
}

function wallClock() {
  return new Date().toISOString();
}

function clampText(value, limit = 500) {
  return String(value ?? '').replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, ' ').slice(0, limit);
}

function sanitizedUrl(value) {
  if (!value) return null;
  try {
    const url = new URL(String(value), globalThis.location?.href);
    const path = url.pathname || '/';
    if (url.origin === globalThis.location?.origin) return path;
    return `${url.origin}${url.pathname || '/'}`;
  } catch {
    return clampText(String(value).split(/[?#]/, 1)[0], 300);
  }
}

function isWeatherResource(entry) {
  try {
    const url = new URL(entry.name, globalThis.location?.href);
    if (url.origin !== globalThis.location?.origin) return false;
    return /(?:^|\/)data\/(?:generated\/|.*mrl_z3)/i.test(url.pathname)
      || /(?:\.f32|\.mask|\.csv|metadata\.json)$/i.test(url.pathname);
  } catch {
    return false;
  }
}

function sumNumbers(values) {
  return values.reduce((total, value) => total + (Number.isFinite(value) ? value : 0), 0);
}

function formatBytes(value) {
  if (!Number.isFinite(value)) return '—';
  if (value < 1024) return `${Math.round(value)} B`;
  const units = ['KiB', 'MiB', 'GiB'];
  let amount = value / 1024;
  let unit = units[0];
  for (let index = 1; index < units.length && amount >= 1024; index++) {
    amount /= 1024;
    unit = units[index];
  }
  return `${amount.toFixed(amount >= 100 ? 0 : amount >= 10 ? 1 : 2)} ${unit}`;
}

function requestResult(request) {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error || new Error('IndexedDB request failed.'));
  });
}

function transactionResult(transaction) {
  return new Promise((resolve, reject) => {
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(transaction.error || new Error('IndexedDB transaction failed.'));
    transaction.onabort = () => reject(transaction.error || new Error('IndexedDB transaction aborted.'));
  });
}

function openDatabase() {
  if (!globalThis.indexedDB) return Promise.reject(new Error('IndexedDB is unavailable.'));
  return new Promise((resolve, reject) => {
    const request = globalThis.indexedDB.open(DATABASE_NAME, DATABASE_VERSION);
    request.onupgradeneeded = () => {
      const database = request.result;
      const sessions = database.createObjectStore('sessions', { keyPath: 'id' });
      sessions.createIndex('startedAt', 'startedAt');
      for (const name of ['samples', 'events', 'weatherResources']) {
        const store = database.createObjectStore(name, { keyPath: ['sessionId', 'sequence'] });
        store.createIndex('sessionId', 'sessionId');
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error || new Error('Unable to open diagnostics IndexedDB.'));
  });
}

function deleteSessionRows(store, sessionId) {
  const request = store.index('sessionId').openCursor(IDBKeyRange.only(sessionId));
  request.onsuccess = () => {
    const cursor = request.result;
    if (!cursor) return;
    cursor.delete();
    cursor.continue();
  };
}

async function readSessionRows(database, storeName, sessionId) {
  const transaction = database.transaction(storeName, 'readonly');
  return requestResult(transaction.objectStore(storeName).index('sessionId').getAll(IDBKeyRange.only(sessionId)));
}

function percentile(values, fraction) {
  if (!values.length) return null;
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * fraction) - 1)];
}

function frameSummary(timestamps, currentTime, visibilityState) {
  const cutoff = currentTime - FRAME_WINDOW_MS;
  while (timestamps.length && timestamps[0] < cutoff) timestamps.shift();
  const active = timestamps.length >= 2 && currentTime - timestamps[timestamps.length - 1] < 1500;
  if (!active) {
    return {
      active: false,
      visibilityState,
      fps: null,
      meanIntervalMs: null,
      p95IntervalMs: null,
      maxIntervalMs: null,
      stallsOver50ms: 0,
      stallsOver100ms: 0
    };
  }
  const intervals = [];
  for (let index = 1; index < timestamps.length; index++) intervals.push(timestamps[index] - timestamps[index - 1]);
  const totalMs = timestamps[timestamps.length - 1] - timestamps[0];
  return {
    active: true,
    visibilityState,
    fps: totalMs > 0 ? (timestamps.length - 1) * 1000 / totalMs : null,
    meanIntervalMs: intervals.length ? sumNumbers(intervals) / intervals.length : null,
    p95IntervalMs: percentile(intervals, 0.95),
    maxIntervalMs: intervals.length ? Math.max(...intervals) : null,
    stallsOver50ms: intervals.filter((interval) => interval > 50).length,
    stallsOver100ms: intervals.filter((interval) => interval > 100).length
  };
}

function weatherResourceAggregate(resources) {
  const encoded = resources.map((resource) => resource.encodedBodySize).filter(Number.isFinite);
  const decoded = resources.map((resource) => resource.decodedBodySize).filter(Number.isFinite);
  const transfer = resources.map((resource) => resource.transferSize).filter(Number.isFinite);
  const cacheHits = resources.filter((resource) => resource.transferSize === 0 && resource.encodedBodySize > 0).length;
  const encodedBytes = sumNumbers(encoded);
  const decodedBytes = sumNumbers(decoded);
  return {
    completedResourceCount: resources.length,
    encodedBytes,
    decodedBytes,
    transferBytes: sumNumbers(transfer),
    decodedToEncodedRatio: encodedBytes > 0 ? decodedBytes / encodedBytes : null,
    likelyBrowserCacheHits: cacheHits,
    recentResources: resources.slice(-8)
  };
}

function compactWeatherResourceAggregate(resources) {
  const aggregate = weatherResourceAggregate(resources);
  const { recentResources, ...compact } = aggregate;
  return compact;
}

function createSessionMetadata(id, environment) {
  return {
    id,
    schemaVersion: 1,
    startedAt: wallClock(),
    startedAtMs: Date.now(),
    cleanlyCompleted: false,
    status: 'active',
    completionReason: null,
    lastPersistedAt: null,
    sampleCount: 0,
    eventCount: 0,
    weatherResourceCount: 0,
    environment,
    limitations: LIMITATIONS
  };
}

function serializableEnvironment(environment) {
  if (!environment || typeof environment !== 'object') return {};
  const { canvasElement, ...serializable } = environment;
  return serializable;
}

function captureBrowserMemory() {
  const memory = globalThis.performance?.memory;
  if (!memory) return null;
  return {
    origin: 'performance.memory (browser-specific, optional)',
    jsHeapSizeLimit: Number.isFinite(memory.jsHeapSizeLimit) ? memory.jsHeapSizeLimit : null,
    totalJSHeapSize: Number.isFinite(memory.totalJSHeapSize) ? memory.totalJSHeapSize : null,
    usedJSHeapSize: Number.isFinite(memory.usedJSHeapSize) ? memory.usedJSHeapSize : null
  };
}

function compactIdentity(value) {
  if (value === null || value === undefined) return null;
  if (typeof value !== 'object') return value;
  const result = {};
  for (const key of ['id', 'key', 'generation', 'revision', 'owner', 'level', 'index', 'slot', 'type']) {
    if (value[key] !== undefined && value[key] !== null) result[key] = value[key];
  }
  return Object.keys(result).length ? result : null;
}

function compactWindow(value) {
  if (!value || typeof value !== 'object') return null;
  const result = {};
  for (const key of ['level', 'minX', 'maxX', 'minY', 'maxY', 'width', 'height', 'count', 'sampleCount', 'area']) {
    if (Number.isFinite(value[key])) result[key] = value[key];
  }
  return Object.keys(result).length ? result : null;
}

export function compactPeriodicSnapshot(snapshot) {
  if (!snapshot || typeof snapshot !== 'object') return {};
  const state = snapshot.state || {};
  const camera = snapshot.camera || {};
  const lod = snapshot.lod || {};
  const canonicalWindow = snapshot.canonicalWindow || {};
  const source = snapshot.source || {};
  const gpuWeather = snapshot.gpuWeather || {};
  const spatial = gpuWeather.spatial || {};
  const memory = snapshot.memory || {};
  const compact = {
    state: {
      activeRenderMode: state.activeRenderMode ?? null,
      playing: Boolean(state.playing),
      scrubbing: Boolean(state.scrubbing),
      mapMoving: state.mapMoving ?? null,
      mapZooming: state.mapZooming ?? null,
      normalizedAnimationTime: state.normalizedAnimationTime ?? null,
      rawFrameIndex: state.rawFrameIndex ?? null,
      playbackStalled: Boolean(state.playbackStalled)
    },
    camera: {
      center: Array.isArray(camera.center) ? camera.center.slice(0, 2) : null,
      rawZoom: camera.rawZoom ?? null,
      logicalWeatherZoom: camera.logicalWeatherZoom ?? null,
      pitch: camera.pitch ?? null,
      bearing: camera.bearing ?? null
    },
    lod: {
      stableLevel: lod.stableLevel ?? null,
      transition: lod.transition ? {
        fromLevel: lod.transition.fromLevel ?? null,
        toLevel: lod.transition.toLevel ?? null,
        progress: lod.transition.progress ?? null
      } : null,
      leafCount: lod.leafCount ?? null
    },
    canonicalWindow: {
      rebuilds: canonicalWindow.rebuilds ?? null,
      lastMs: canonicalWindow.lastMs ?? null,
      targetSampleCount: canonicalWindow.targetSampleCount ?? null,
      retainedSampleCount: canonicalWindow.retainedSampleCount ?? null,
      targetDimensions: compactWindow(canonicalWindow.targetDimensions),
      retainedDimensions: compactWindow(canonicalWindow.retainedDimensions),
      retainedTargetAreaRatio: canonicalWindow.retainedTargetAreaRatio ?? null,
      pending: Boolean(canonicalWindow.pending)
    },
    source: {
      generationId: source.generationId ?? source.generation_id ?? null,
      providerRevisionId: source.providerRevisionId ?? null,
      targetFrameIndex: source.targetFrameIndex ?? source.rawLayerExactFrameIndex ?? null,
      residentSourceFrameCount: source.residentSourceFrameCount ?? null,
      highQueueCount: source.highQueueCount ?? source.highPriorityQueueCount ?? null,
      lowQueueCount: source.lowQueueCount ?? source.lowPriorityQueueCount ?? null,
      pendingFetchCount: source.pendingFetchCount ?? source.fetchConcurrency ?? null,
      residentSourceBytes: source.residentSourceBytes ?? null
    },
    gpuWeather: {
      active: Boolean(gpuWeather.active),
      path: gpuWeather.path ?? null,
      activeLevel: gpuWeather.activeLevel ?? null,
      transitionOwner: gpuWeather.transitionOwner ?? null,
      providerResidency: compactIdentity(gpuWeather.providerResidency?.identity),
      reconstructionTarget: compactIdentity(gpuWeather.targetMemory?.identity),
      rendererSource: compactIdentity(gpuWeather.committedSourceCompatibility?.dotsOwnership),
      pendingSpatial: spatial.pendingReplacement ? {
        generation: spatial.pendingGeneration ?? null,
        status: spatial.pendingStatus ?? null
      } : null,
      pendingStatus: spatial.pendingStatus ?? null,
      pendingGeneration: spatial.pendingGeneration ?? null,
      activeSource: spatial.activeSource ?? null,
      latestLifecycleEventId: gpuWeather.latestLifecycleEventId ?? null
    },
    memory: {
      sourceResidentBytes: memory.sourceResidentBytes ?? 0,
      trackedCpuBytes: memory.trackedCpuBytes ?? 0,
      estimatedGpuBufferBytes: memory.estimatedGpuBufferBytes ?? 0,
      representationGpuBytes: memory.representationGpuBytes ?? 0
    }
  };
  return compact;
}

function readExceptionProperty(value, key) {
  try {
    return { available: true, value: value[key] };
  } catch {
    return { available: false, value: null };
  }
}

function safeExceptionText(value, limit) {
  if (value === null || value === undefined) return null;
  try {
    return clampText(String(value), limit);
  } catch {
    return null;
  }
}

function safeThrownValueText(value) {
  try {
    return clampText(String(value), CALLBACK_EXCEPTION_VALUE_LIMIT);
  } catch {
    return `[unstringifiable ${typeof value}]`;
  }
}

export function serializeCallbackException(callbackName, callbackId, thrownValue, timestamp = now()) {
  const valueType = typeof thrownValue;
  const objectLike = thrownValue !== null && (valueType === 'object' || valueType === 'function');
  let isError = false;
  if (objectLike) {
    try { isError = thrownValue instanceof Error; } catch { isError = false; }
  }
  const name = objectLike ? readExceptionProperty(thrownValue, 'name') : { available: false, value: null };
  const message = objectLike ? readExceptionProperty(thrownValue, 'message') : { available: false, value: null };
  const stack = objectLike ? readExceptionProperty(thrownValue, 'stack') : { available: false, value: null };
  const errorLike = isError || name.available && name.value !== undefined
    || message.available && message.value !== undefined
    || stack.available && stack.value !== undefined;
  const base = {
    callbackName: clampText(callbackName, 80),
    callbackId: Number.isInteger(callbackId) ? callbackId : null,
    timestamp: Number.isFinite(timestamp) ? timestamp : null,
    typeof: valueType
  };
  if (errorLike) {
    return {
      ...base,
      kind: 'error-like',
      name: safeExceptionText(name.value, CALLBACK_EXCEPTION_NAME_LIMIT),
      message: safeExceptionText(message.value, CALLBACK_EXCEPTION_MESSAGE_LIMIT),
      stack: safeExceptionText(stack.value, CALLBACK_EXCEPTION_STACK_LIMIT)
    };
  }
  return {
    ...base,
    kind: 'thrown-value',
    value: safeThrownValueText(thrownValue)
  };
}

function latestCallbackExceptionFromEvents(events) {
  return [...(events || [])]
    .filter((event) => event?.type === 'callback-exception' && event.details)
    .sort((left, right) => left.sequence - right.sequence)
    .at(-1)?.details || null;
}

export function compactFailureSlice(data) {
  const samples = [...(data?.samples || [])].sort((left, right) => left.sequence - right.sequence);
  const latestElapsed = Math.max(
    samples.at(-1)?.elapsedMs ?? 0,
    ...(data?.events || []).map((event) => Number.isFinite(event.elapsedMs) ? event.elapsedMs : 0),
    ...(data?.weatherResources || []).map((resource) => Number.isFinite(resource.elapsedMs) ? resource.elapsedMs : 0)
  );
  const cutoff = Math.max(0, latestElapsed - FAILURE_WINDOW_MS);
  const recentSamples = samples.filter((sample) => sample.elapsedMs >= cutoff);
  const events = [...(data?.events || [])].sort((left, right) => left.sequence - right.sequence);
  const firstRecentEvent = events.findIndex((event) => event.elapsedMs >= cutoff);
  const eventStart = firstRecentEvent < 0
    ? Math.max(0, events.length - FAILURE_EVENT_TAIL)
    : Math.max(0, firstRecentEvent - FAILURE_EVENT_TAIL);
  const slicedEvents = events.slice(eventStart).filter((event) => event.elapsedMs <= latestElapsed);
  const resources = [...(data?.weatherResources || [])]
    .sort((left, right) => left.sequence - right.sequence)
    .filter((resource) => {
      const elapsed = resource.elapsedMs;
      return Number.isFinite(elapsed)
        ? elapsed >= cutoff - FAILURE_RESOURCE_NEAR_WINDOW_MS && elapsed <= latestElapsed + FAILURE_RESOURCE_NEAR_WINDOW_MS
        : true;
    });
  return {
    ...data,
    samples: recentSamples,
    events: slicedEvents,
    weatherResources: resources,
    latestCallbackException: latestCallbackExceptionFromEvents(slicedEvents) || data?.latestCallbackException || null,
    retention: {
      mode: 'failure-slice',
      windowMs: FAILURE_WINDOW_MS,
      precedingEventTail: FAILURE_EVENT_TAIL,
      resourceNearWindowMs: FAILURE_RESOURCE_NEAR_WINDOW_MS,
      latestElapsedMs: latestElapsed,
      cutoffElapsedMs: cutoff
    }
  };
}

export function runDiagnosticCallback(name, callback, diagnostics) {
  const callbackId = diagnostics?.recordCallbackEnter(name) ?? null;
  let completed = false;
  let thrownValue;
  try {
    const result = callback();
    completed = true;
    return result;
  } catch (error) {
    thrownValue = error;
    throw error;
  } finally {
    diagnostics?.recordCallbackExit(callbackId, completed, thrownValue);
  }
}

export function createRuntimeDiagnostics({ enabled = false, getSnapshot, getEnvironment, getStallSnapshot }) {
  const isEnabled = Boolean(enabled);
  if (!isEnabled) return null;

  const sessionId = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
  let database = null;
  let session = null;
  let recoveredSessionId = null;
  let persistenceReady = null;
  let flushing = null;
  let ended = false;
  let sampleSequence = 0;
  let eventSequence = 0;
  let resourceSequence = 0;
  let pendingSamples = [];
  let pendingEvents = [];
  let pendingResources = [];
  let resources = [];
  let latestCallbackException = null;
  let latestSnapshot = null;
  let hud = null;
  let sampleTimer = null;
  let flushTimer = null;
  let nextSampleDue = now() + SAMPLE_INTERVAL_MS;
  let lastDiagnosticTimerAt = null;
  const activity = {
    inputEventCount: 0,
    lastInputType: null,
    lastInputAt: null,
    mapRenderCount: 0,
    lastMapRenderAt: null,
    weatherRenderEnterCount: 0,
    weatherRenderExitCount: 0,
    lastWeatherRenderType: null,
    lastWeatherRenderPhase: null,
    lastWeatherRenderAt: null,
    repaintRequestCount: 0,
    lastRepaintRequestAt: null,
    repaintRequestsSinceRender: 0,
    callbackSequence: 0,
    activeCallbackId: null,
    activeCallbackName: null,
    lastCallbackId: null,
    lastCallbackName: null,
    lastCallbackPhase: null,
    lastCallbackAt: null,
    callbackExceptionCount: 0,
    lastCallbackExceptionAt: null,
    applicationFrameCount: 0,
    lastApplicationFrameAt: null
  };
  const renderTimestamps = [];
  const longTasks = [];
  const seenResourceKeys = new Set();

  function safeSnapshot() {
    try {
      return getSnapshot?.() || {};
    } catch (error) {
      return {
        snapshotError: clampText(error instanceof Error ? error.message : error),
        snapshotErrorStack: clampText(error instanceof Error ? error.stack : null)
      };
    }
  }

  function makeSample(schedulingDriftMs = 0) {
    const snapshot = safeSnapshot();
    const timestamp = now();
    latestSnapshot = snapshot;
    return {
      sessionId,
      sequence: sampleSequence++,
      elapsedMs: Math.max(0, timestamp - sessionStartedAt),
      wallClock: wallClock(),
      visibilityState: document.visibilityState,
      schedulingDriftMs: Math.round(schedulingDriftMs * 100) / 100,
      ...compactPeriodicSnapshot(snapshot),
      activity: { ...activity },
      frame: frameSummary(renderTimestamps, timestamp, document.visibilityState),
      network: compactWeatherResourceAggregate(resources),
      browserMemory: captureBrowserMemory()
    };
  }

  function queueEvent(type, details = {}) {
    if (ended) return;
    pendingEvents.push({
      sessionId,
      sequence: eventSequence++,
      elapsedMs: Math.max(0, now() - sessionStartedAt),
      wallClock: wallClock(),
      type: clampText(type, 80),
      details
    });
    if (pendingEvents.length > MAX_EVENTS) pendingEvents.shift();
  }

  function stallSeverity(gapMs) {
    for (let index = STALL_THRESHOLDS_MS.length - 1; index >= 0; index--) {
      if (gapMs > STALL_THRESHOLDS_MS[index]) return STALL_THRESHOLDS_MS[index];
    }
    return null;
  }

  function stallDetails(gapMs, extra = {}) {
    return {
      gapMs,
      thresholdMs: stallSeverity(gapMs),
      visibilityState: document.visibilityState,
      activity: { ...activity },
      ...extra,
      snapshot: getStallSnapshot?.() || null
    };
  }

  function processResource(entry) {
    if (!isWeatherResource(entry)) return;
    const key = `${entry.name}|${entry.startTime}|${entry.duration}`;
    if (seenResourceKeys.has(key)) return;
    seenResourceKeys.add(key);
    let url;
    try { url = new URL(entry.name, globalThis.location.href); } catch { return; }
    const resource = {
      sessionId,
      sequence: resourceSequence++,
      elapsedMs: Math.max(0, now() - sessionStartedAt),
      path: sanitizedUrl(entry.name),
      startTimeMs: Number.isFinite(entry.startTime) ? entry.startTime : null,
      durationMs: Number.isFinite(entry.duration) ? entry.duration : null,
      transferSize: Number.isFinite(entry.transferSize) ? entry.transferSize : null,
      encodedBodySize: Number.isFinite(entry.encodedBodySize) ? entry.encodedBodySize : null,
      decodedBodySize: Number.isFinite(entry.decodedBodySize) ? entry.decodedBodySize : null,
      nextHopProtocol: entry.nextHopProtocol || null,
      sameOrigin: url.origin === globalThis.location.origin
    };
    resources.push(resource);
    pendingResources.push(resource);
    if (resources.length > MAX_WEATHER_RESOURCES) resources.shift();
    if (pendingResources.length > MAX_WEATHER_RESOURCES) pendingResources.shift();
  }

  function observeResources() {
    try {
      performance.setResourceTimingBufferSize?.(512);
      if (typeof PerformanceObserver !== 'function') return;
      const observer = new PerformanceObserver((list) => {
        for (const entry of list.getEntries()) processResource(entry);
      });
      observer.observe({ type: 'resource', buffered: true });
    } catch {
      // Resource Timing is optional; the rest of diagnostics must continue.
    }
  }

  function observeLongTasks() {
    if (typeof PerformanceObserver !== 'function') return;
    try {
      const observer = new PerformanceObserver((list) => {
        for (const entry of list.getEntries()) {
          const record = {
            startMs: Number.isFinite(entry.startTime) ? entry.startTime : null,
            durationMs: Number.isFinite(entry.duration) ? entry.duration : null,
            endMs: Number.isFinite(entry.startTime) && Number.isFinite(entry.duration)
              ? entry.startTime + entry.duration : null
          };
          longTasks.push(record);
          if (longTasks.length > MAX_RENDER_TIMESTAMPS) longTasks.shift();
          queueEvent('browser-longtask', record);
        }
      });
      observer.observe({ type: 'longtask', buffered: true });
    } catch {
      // Long Task timing is optional; frame-gap events still record their wall-clock interval.
    }
  }

  function recordRender(timestamp = now()) {
    const previous = renderTimestamps.at(-1);
    if (Number.isFinite(previous)) {
      const gapMs = timestamp - previous;
      if (gapMs > 50) {
        const overlappingLongTasks = longTasks.filter((task) => task.startMs < timestamp && task.endMs > previous);
        queueEvent('maplibre-render-gap', stallDetails(gapMs, {
          startMs: previous,
          endMs: timestamp,
          observedLongTaskCount: overlappingLongTasks.length,
          observedLongTaskDurationMs: sumNumbers(overlappingLongTasks.map((task) => task.durationMs)),
          observedLongTasks: overlappingLongTasks
        }));
      }
    }
    renderTimestamps.push(timestamp);
    if (renderTimestamps.length > MAX_RENDER_TIMESTAMPS) renderTimestamps.shift();
    activity.mapRenderCount++;
    activity.lastMapRenderAt = timestamp;
    activity.repaintRequestsSinceRender = 0;
  }

  function recordInput(type, timestamp = now()) {
    activity.inputEventCount++;
    activity.lastInputType = clampText(type, 80);
    activity.lastInputAt = timestamp;
  }

  function recordRepaintRequest(timestamp = now()) {
    activity.repaintRequestCount++;
    activity.lastRepaintRequestAt = timestamp;
    activity.repaintRequestsSinceRender++;
  }

  function recordWeatherRender(type, phase, timestamp = now()) {
    activity.lastWeatherRenderType = clampText(type, 80);
    activity.lastWeatherRenderPhase = clampText(phase, 20);
    activity.lastWeatherRenderAt = timestamp;
    if (phase === 'enter') activity.weatherRenderEnterCount++;
    else if (phase === 'exit') activity.weatherRenderExitCount++;
  }

  function recordCallbackEnter(name) {
    const id = ++activity.callbackSequence;
    activity.activeCallbackId = id;
    activity.activeCallbackName = clampText(name, 80);
    activity.lastCallbackId = id;
    activity.lastCallbackName = activity.activeCallbackName;
    activity.lastCallbackPhase = 'enter';
    activity.lastCallbackAt = now();
    return id;
  }

  function recordCallbackExit(id, completed, thrownValue) {
    if (!Number.isInteger(id)) return;
    activity.lastCallbackId = id;
    activity.lastCallbackPhase = completed ? 'exit' : 'exception';
    activity.lastCallbackAt = now();
    if (!completed) {
      activity.callbackExceptionCount++;
      activity.lastCallbackExceptionAt = activity.lastCallbackAt;
      // Exception diagnostics must never replace the original thrown value.
      try {
        latestCallbackException = serializeCallbackException(activity.lastCallbackName, id, thrownValue, activity.lastCallbackAt);
        queueEvent('callback-exception', latestCallbackException);
      } catch {
        // Keep the existing callback bookkeeping and preserve the original throw.
      }
    }
    if (activity.activeCallbackId === id) {
      activity.activeCallbackId = null;
      activity.activeCallbackName = null;
    }
  }

  async function initializePersistence() {
    try {
      database = await openDatabase();
      const readTransaction = database.transaction('sessions', 'readonly');
      const existing = await requestResult(readTransaction.objectStore('sessions').getAll());
      const unclean = existing
        .filter((candidate) => candidate.id !== sessionId && !candidate.cleanlyCompleted)
        .sort((left, right) => right.startedAtMs - left.startedAtMs)[0] || null;
      const previous = unclean || existing
        .filter((candidate) => candidate.id !== sessionId)
        .sort((left, right) => right.startedAtMs - left.startedAtMs)[0] || null;
      recoveredSessionId = unclean?.id || null;
      hud?.setRecoveredAvailable(Boolean(recoveredSessionId));
      session = createSessionMetadata(sessionId, serializableEnvironment(getEnvironment?.() || {}));
      const keepIds = new Set([sessionId]);
      if (previous) keepIds.add(previous.id);
      const writeTransaction = database.transaction(['sessions', 'samples', 'events', 'weatherResources'], 'readwrite');
      const sessionStore = writeTransaction.objectStore('sessions');
      sessionStore.put(session);
      for (const candidate of existing) {
        if (keepIds.has(candidate.id)) continue;
        sessionStore.delete(candidate.id);
        deleteSessionRows(writeTransaction.objectStore('samples'), candidate.id);
        deleteSessionRows(writeTransaction.objectStore('events'), candidate.id);
        deleteSessionRows(writeTransaction.objectStore('weatherResources'), candidate.id);
      }
      await transactionResult(writeTransaction);
      return true;
    } catch (error) {
      persistenceReady = null;
      console.warn('Dot Field diagnostics persistence is unavailable.', error);
      return false;
    }
  }

  async function trimRows(transaction, storeName, minimumSequence) {
    if (minimumSequence <= 0) return;
    const request = transaction.objectStore(storeName).index('sessionId').openCursor(IDBKeyRange.only(sessionId));
    request.onsuccess = () => {
      const cursor = request.result;
      if (!cursor) return;
      if (cursor.value.sequence < minimumSequence) cursor.delete();
      cursor.continue();
    };
  }

  async function flush() {
    if (flushing) return flushing;
    flushing = (async () => {
      await persistenceReady;
      if (!database || !session || (!pendingSamples.length && !pendingEvents.length && !pendingResources.length)) return;
      const samples = pendingSamples.splice(0);
      const events = pendingEvents.splice(0);
      const weatherResources = pendingResources.splice(0);
      const transaction = database.transaction(['sessions', 'samples', 'events', 'weatherResources'], 'readwrite');
      const nextSession = {
        ...session,
        lastPersistedAt: wallClock(),
        sampleCount: sampleSequence,
        eventCount: eventSequence,
        weatherResourceCount: resourceSequence
      };
      transaction.objectStore('sessions').put(nextSession);
      for (const row of samples) transaction.objectStore('samples').put(row);
      for (const row of events) transaction.objectStore('events').put(row);
      for (const row of weatherResources) transaction.objectStore('weatherResources').put(row);
      trimRows(transaction, 'samples', Math.max(0, sampleSequence - MAX_SAMPLES));
      trimRows(transaction, 'events', Math.max(0, eventSequence - MAX_EVENTS));
      trimRows(transaction, 'weatherResources', Math.max(0, resourceSequence - MAX_WEATHER_RESOURCES));
      try {
        await transactionResult(transaction);
        session = nextSession;
      } catch (error) {
        pendingSamples = [...samples, ...pendingSamples].slice(-MAX_SAMPLES);
        pendingEvents = [...events, ...pendingEvents].slice(-MAX_EVENTS);
        pendingResources = [...weatherResources, ...pendingResources].slice(-MAX_WEATHER_RESOURCES);
        throw error;
      }
    })().finally(() => { flushing = null; });
    return flushing;
  }

  async function persistedSession(sessionKey) {
    await persistenceReady;
    if (!database || !sessionKey) return null;
    const sessionTransaction = database.transaction('sessions', 'readonly');
    const metadata = await requestResult(sessionTransaction.objectStore('sessions').get(sessionKey));
    if (!metadata) return null;
    const [samples, events, weatherResources] = await Promise.all([
      readSessionRows(database, 'samples', sessionKey),
      readSessionRows(database, 'events', sessionKey),
      readSessionRows(database, 'weatherResources', sessionKey)
    ]);
    return { ...metadata, samples, events, weatherResources };
  }

  async function currentExportData() {
    // A broken/paused page may not complete a persistence flush. Already
    // persisted rows plus the in-memory tail are still sufficient to export.
    await flush().catch(() => {});
    const persisted = await persistedSession(sessionId);
    const samples = [...(persisted?.samples || []), ...pendingSamples].sort((left, right) => left.sequence - right.sequence);
    const events = [...(persisted?.events || []), ...pendingEvents].sort((left, right) => left.sequence - right.sequence);
    const weatherResources = [...(persisted?.weatherResources || []), ...pendingResources].sort((left, right) => left.sequence - right.sequence);
    return {
      schemaVersion: 1,
      session: session || createSessionMetadata(sessionId, serializableEnvironment(getEnvironment?.() || {})),
      environment: session?.environment || serializableEnvironment(getEnvironment?.() || {}),
      limitations: LIMITATIONS,
      summary: latestSnapshot || safeSnapshot(),
      samples,
      events,
      weatherResources,
      latestCallbackException
    };
  }

  async function exportSession(which = 'current', { full = false } = {}) {
    const data = which === 'recovered' && recoveredSessionId
      ? await persistedSession(recoveredSessionId)
      : await currentExportData();
    if (!data) return null;
    const exportSource = full ? data : compactFailureSlice(data);
    const exportData = {
      schemaVersion: 1,
      session: {
        ...(exportSource.session || exportSource),
        status: exportSource.session?.cleanlyCompleted ? 'clean' : which === 'recovered' ? 'unclean' : 'active'
      },
      environment: exportSource.environment || exportSource.session?.environment || {},
      limitations: LIMITATIONS,
      summary: exportSource.summary || null,
      samples: exportSource.samples || [],
      events: exportSource.events || [],
      weatherResources: exportSource.weatherResources || [],
      latestCallbackException: exportSource.latestCallbackException || latestCallbackExceptionFromEvents(exportSource.events) || null,
      retention: exportSource.retention || { mode: 'full-history' }
    };
    const timestamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z');
    const filename = `dot-field-diagnostics-${timestamp.slice(0, 15)}.json`;
    const blob = new Blob([JSON.stringify(exportData)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = filename;
    anchor.click();
    window.setTimeout(() => URL.revokeObjectURL(url), 1000);
    return exportData;
  }

  async function clear() {
    await persistenceReady;
    pendingSamples = [];
    pendingEvents = [];
    pendingResources = [];
    resources = [];
    latestCallbackException = null;
    latestSnapshot = null;
    if (database) {
      const transaction = database.transaction(['sessions', 'samples', 'events', 'weatherResources'], 'readwrite');
      for (const name of ['sessions', 'samples', 'events', 'weatherResources']) transaction.objectStore(name).clear();
      await transactionResult(transaction);
    }
    if (!ended) {
      sampleSequence = 0;
      eventSequence = 0;
      resourceSequence = 0;
      session = createSessionMetadata(sessionId, serializableEnvironment(getEnvironment?.() || {}));
      recoveredSessionId = null;
      queueEvent('diagnostic-session-cleared');
      if (database) {
        const transaction = database.transaction('sessions', 'readwrite');
        transaction.objectStore('sessions').put(session);
        await transactionResult(transaction);
      }
    }
    hud?.setStatus('Cleared');
  }

  async function finish(reason) {
    if (ended) return;
    ended = true;
    await flush();
    if (!database || !session) return;
    const nextSession = { ...session, cleanlyCompleted: true, completionReason: reason, lastPersistedAt: wallClock() };
    const transaction = database.transaction('sessions', 'readwrite');
    transaction.objectStore('sessions').put(nextSession);
    await transactionResult(transaction);
    session = nextSession;
  }

  function takeSample(drift = 0) {
    if (ended) return;
    pendingSamples.push(makeSample(drift));
    if (pendingSamples.length > MAX_SAMPLES) pendingSamples.shift();
    hud?.update(latestSnapshot, frameSummary(renderTimestamps, now(), document.visibilityState), weatherResourceAggregate(resources));
  }

  function attachHud(container) {
    const base = document.createElement('span');
    base.className = 'lod-diagnostics-base';
    base.textContent = container.textContent;
    const panel = document.createElement('div');
    panel.className = 'diagnostics-panel';
    const summary = document.createElement('div');
    summary.className = 'diagnostics-summary';
    const actions = document.createElement('div');
    actions.className = 'diagnostics-actions';
    const detailsButton = document.createElement('button');
    detailsButton.type = 'button';
    detailsButton.textContent = 'Details';
    const exportButton = document.createElement('button');
    exportButton.type = 'button';
    exportButton.textContent = 'Export failure slice';
    const fullExportButton = document.createElement('button');
    fullExportButton.type = 'button';
    fullExportButton.textContent = 'Export full history';
    const clearButton = document.createElement('button');
    clearButton.type = 'button';
    clearButton.textContent = 'Clear';
    const recoveredExportButton = document.createElement('button');
    recoveredExportButton.type = 'button';
    recoveredExportButton.textContent = 'Export recovered failure slice';
    recoveredExportButton.hidden = true;
    const details = document.createElement('pre');
    details.className = 'diagnostics-details';
    details.hidden = true;
    const status = document.createElement('span');
    status.className = 'diagnostics-status';
    actions.append(detailsButton, exportButton, fullExportButton, recoveredExportButton, clearButton, status);
    panel.append(summary, actions, details);
    container.replaceChildren(base, panel);
    detailsButton.addEventListener('click', () => {
      details.hidden = !details.hidden;
      detailsButton.textContent = details.hidden ? 'Details' : 'Hide details';
      if (!details.hidden) details.textContent = JSON.stringify(latestSnapshot || safeSnapshot(), null, 2);
    });
    exportButton.addEventListener('click', async () => {
      await exportSession('current');
      status.textContent = 'Failure slice exported';
    });
    fullExportButton.addEventListener('click', async () => {
      await exportSession('current', { full: true });
      status.textContent = 'Full history exported';
    });
    recoveredExportButton.addEventListener('click', async () => {
      await exportSession('recovered');
      status.textContent = 'Recovered session exported';
    });
    clearButton.addEventListener('click', () => { void clear(); });
    hud = {
      setBaseText(value) { base.textContent = value; },
      setStatus(value) { status.textContent = value; },
      setRecoveredAvailable(value) { recoveredExportButton.hidden = !value; },
      update(snapshot, frame, network) {
        const memory = snapshot?.memory || {};
        const fps = frame?.active && Number.isFinite(frame.fps) ? `FPS ${Math.round(frame.fps)}` : 'FPS —';
        summary.textContent = `${fps} · Source ${formatBytes(memory.sourceResidentBytes)} · Tracked CPU ${formatBytes(memory.trackedCpuBytes)} · GPU ~${formatBytes(memory.estimatedGpuBufferBytes)} · Net ${formatBytes(network?.encodedBytes)}/${formatBytes(network?.decodedBytes)}`;
        if (!details.hidden) details.textContent = JSON.stringify(snapshot || {}, null, 2);
      }
    };
    return hud;
  }

  function captureContextEvents() {
    const canvas = getEnvironment?.()?.canvasElement;
    if (canvas?.addEventListener) {
      canvas.addEventListener('webglcontextlost', (event) => queueEvent('webgl-context-lost', {
        statusMessage: clampText(event?.statusMessage || null),
        ...stallDetails(0)
      }));
      canvas.addEventListener('webglcontextrestored', (event) => queueEvent('webgl-context-restored', {
        statusMessage: clampText(event?.statusMessage || null),
        ...stallDetails(0)
      }));
    }
    document.addEventListener('visibilitychange', () => queueEvent('visibility-change', stallDetails(0)));
    globalThis.addEventListener?.('error', (event) => queueEvent('javascript-error', {
      message: clampText(event.message || event.error?.message),
      name: clampText(event.error?.name || null),
      stack: clampText(event.error?.stack || null),
      filename: sanitizedUrl(event.filename),
      line: Number.isFinite(event.lineno) ? event.lineno : null,
      column: Number.isFinite(event.colno) ? event.colno : null,
      errorAvailable: Boolean(event.error),
      errorType: event.error?.constructor?.name || null,
      ...stallDetails(0)
    }));
    globalThis.addEventListener?.('unhandledrejection', (event) => queueEvent('unhandled-rejection', {
      reason: clampText(event.reason instanceof Error ? event.reason.message : event.reason),
      name: clampText(event.reason instanceof Error ? event.reason.name : null),
      stack: clampText(event.reason instanceof Error ? event.reason.stack : null),
      reasonType: event.reason?.constructor?.name || typeof event.reason,
      ...stallDetails(0)
    }));
    globalThis.addEventListener?.('pagehide', (event) => {
      queueEvent('pagehide', stallDetails(0, { persisted: Boolean(event?.persisted) }));
      void finish('pagehide').catch(() => {});
    }, { once: true });
    globalThis.addEventListener?.('pageshow', (event) => queueEvent('pageshow', stallDetails(0, { persisted: Boolean(event?.persisted) })));
    // Page Lifecycle freeze/resume are optional. Do not assume Safari supports
    // them; observe them only where the browser advertises the event property.
    if ('onfreeze' in globalThis) globalThis.addEventListener?.('freeze', () => queueEvent('page-freeze', stallDetails(0)));
    if ('onresume' in globalThis) globalThis.addEventListener?.('resume', () => queueEvent('page-resume', stallDetails(0)));
  }

  const sessionStartedAt = now();
  queueEvent('diagnostic-session-start');
  observeResources();
  observeLongTasks();
  captureContextEvents();
  persistenceReady = initializePersistence();
  sampleTimer = window.setInterval(() => {
    const timestamp = now();
    const drift = timestamp - nextSampleDue;
    nextSampleDue += SAMPLE_INTERVAL_MS;
    const timerGapMs = lastDiagnosticTimerAt === null ? 0 : timestamp - lastDiagnosticTimerAt;
    lastDiagnosticTimerAt = timestamp;
    const lateByMs = Math.max(0, timerGapMs - SAMPLE_INTERVAL_MS);
    if (lateByMs > STALL_THRESHOLDS_MS[0]) {
      queueEvent('diagnostic-timer-gap', stallDetails(lateByMs, {
        timerIntervalMs: timerGapMs,
        schedulingDriftMs: drift
      }));
    }
    takeSample(drift);
  }, SAMPLE_INTERVAL_MS);
  flushTimer = window.setInterval(() => { void flush(); }, FLUSH_INTERVAL_MS);
  takeSample(0);

  return {
    enabled: true,
    recordRender,
    recordInput,
    recordRepaintRequest,
    recordWeatherRender,
    recordCallbackEnter,
    recordCallbackExit,
    recordApplicationFrame(timestamp = now(), active = true) {
      if (!active) return;
      const previous = activity.lastApplicationFrameAt;
      activity.applicationFrameCount++;
      activity.lastApplicationFrameAt = timestamp;
      if (Number.isFinite(previous)) {
        const gapMs = timestamp - previous;
        if (gapMs > STALL_THRESHOLDS_MS[0]) queueEvent('application-raf-gap', stallDetails(gapMs));
      }
    },
    recordEvent: queueEvent,
    attachHud,
    currentSnapshot() { return latestSnapshot || safeSnapshot(); },
    sessionMetadata() { return session ? { ...session, recoveredSessionId } : { id: sessionId, recoveredSessionId }; },
    async getRecoveredSession() {
      const recovered = recoveredSessionId ? await persistedSession(recoveredSessionId) : null;
      return recovered ? { ...recovered, status: 'unclean' } : null;
    },
    export: exportSession,
    clear,
    async stop() {
      if (sampleTimer !== null) window.clearInterval(sampleTimer);
      if (flushTimer !== null) window.clearInterval(flushTimer);
      await finish('stop');
    }
  };
}
