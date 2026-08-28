export function residentSourceFrameIntervals(residentSourceFrameIndices, sourceFrameCount) {
  if (!Number.isInteger(sourceFrameCount) || sourceFrameCount < 2) return [];

  const resident = [...new Set(residentSourceFrameIndices || [])]
    .filter((frameIndex) => Number.isInteger(frameIndex) && frameIndex >= 0 && frameIndex < sourceFrameCount)
    .sort((left, right) => left - right);
  const intervals = [];
  const denominator = sourceFrameCount - 1;

  for (let index = 0; index < resident.length - 1; index++) {
    if (resident[index + 1] !== resident[index] + 1) continue;
    const startFrame = resident[index];
    let endFrame = resident[index + 1];
    while (index + 1 < resident.length - 1 && resident[index + 2] === endFrame + 1) {
      index++;
      endFrame = resident[index + 1];
    }
    intervals.push(Object.freeze({
      start: startFrame / denominator,
      end: endFrame / denominator
    }));
  }

  return Object.freeze(intervals);
}
