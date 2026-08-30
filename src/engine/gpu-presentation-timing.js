const MAX_SAMPLES = 240;

function percentile(values, fraction) {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * fraction) - 1)];
}

function push(values, value) {
  if (!Number.isFinite(value)) return;
  values.push(value);
  if (values.length > MAX_SAMPLES) values.shift();
}

function summarize(values) {
  return {
    count: values.length,
    latestMs: values.at(-1) ?? null,
    medianMs: percentile(values, 0.5),
    p95Ms: percentile(values, 0.95),
    maxMs: values.length ? Math.max(...values) : null
  };
}

export function createGpuPresentationTiming() {
  let extension = null;
  let enabled = false;
  const pending = [];
  const gpuSamples = [];
  const cpuSamples = [];

  function attach(gl) {
    extension = gl.getExtension('EXT_disjoint_timer_query_webgl2');
  }

  function poll(gl) {
    if (!extension) return;
    if (gl.getParameter(extension.GPU_DISJOINT_EXT)) {
      for (const query of pending.splice(0)) gl.deleteQuery(query);
      return;
    }
    for (let index = pending.length - 1; index >= 0; index--) {
      const query = pending[index];
      if (!gl.getQueryParameter(query, gl.QUERY_RESULT_AVAILABLE)) continue;
      pending.splice(index, 1);
      const nanoseconds = gl.getQueryParameter(query, gl.QUERY_RESULT);
      gl.deleteQuery(query);
      if (Number.isFinite(nanoseconds) && nanoseconds >= 0) push(gpuSamples, nanoseconds / 1e6);
    }
  }

  function begin(gl) {
    if (!enabled) return null;
    poll(gl);
    if (!extension) return null;
    const query = gl.createQuery();
    if (!query) return null;
    gl.beginQuery(extension.TIME_ELAPSED_EXT, query);
    return query;
  }

  function end(gl, query, startedAt) {
    if (enabled && Number.isFinite(startedAt)) push(cpuSamples, performance.now() - startedAt);
    if (!query || !extension) return;
    gl.endQuery(extension.TIME_ELAPSED_EXT);
    pending.push(query);
    if (pending.length > 8) gl.deleteQuery(pending.shift());
  }

  function diagnostics(gl) {
    if (gl) poll(gl);
    return {
      gpu: { ...summarize(gpuSamples), valid: Boolean(extension), pending: pending.length },
      cpuSubmission: summarize(cpuSamples)
    };
  }

  function setEnabled(value) {
    enabled = Boolean(value);
  }

  return { attach, begin, end, diagnostics, setEnabled };
}
