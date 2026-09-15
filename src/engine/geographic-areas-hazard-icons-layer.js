import { prepareGeographicFieldFrame } from './geography.js';
import { lngLatToMercator, mercatorToLngLat, MAX_GRID_LEVEL } from './geographic-lod.js';
import { geographicTemporalFrameAt, TEMPORAL_FRAME_COUNT } from './geographic-layer-utils.js';
import { GeographicSymbolPyramid } from './geographic-symbol-pyramid.js';
import { clamp, smoothstep } from './math.js';
import { hailGradeForIntensity, intensityToStrength } from './precipitation-mapping.js';

export const AREAS_HAZARD_BLOCK_SIZE = 4;
export const AREAS_HAZARD_SQUALL_ICON_SIZE = 28;
export const AREAS_HAZARD_TORNADO_ICON_SIZE = 28;
export const AREAS_HAZARD_STORM_ICON_SIZES = Object.freeze([18, 22, 26]);
export const AREAS_HAZARD_HAIL_ICON_SIZES = Object.freeze([16, 20, 24]);
export const AREAS_HAZARD_LOD_HANDOFF_START = 0.65;

const MIN_ICON_PIXEL_RATIO = 1;
const MAX_ICON_PIXEL_RATIO = 3;
const STORM_IMAGE_ID = 'areas-hazard-storm';
const HAIL_IMAGE_ID = 'areas-hazard-hail';
const SQUALL_IMAGE_ID = 'areas-hazard-squall';
const TORNADO_IMAGE_ID = 'areas-hazard-tornado';

// SVG loading is deliberately kept here, at the presentation boundary. The
// weather channels and aggregate marker model contain only scalar values.
async function loadSvgImage(url, logicalSize, pixelRatio) {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`HTTP ${response.status} while loading ${url}`);
  const svgText = await response.text();
  const image = new Image();
  const loaded = new Promise((resolve, reject) => {
    image.onload = () => resolve(image);
    image.onerror = () => reject(new Error(`Invalid SVG image at ${url}`));
  });
  image.src = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svgText)}`;
  await loaded;

  const canvas = document.createElement('canvas');
  canvas.width = Math.round(logicalSize * pixelRatio);
  canvas.height = Math.round(logicalSize * pixelRatio);
  const context = canvas.getContext('2d');
  if (!context) throw new Error(`Unable to rasterize SVG at ${url}`);

  const sourceWidth = image.naturalWidth || logicalSize;
  const sourceHeight = image.naturalHeight || logicalSize;
  const scale = Math.min(canvas.width / sourceWidth, canvas.height / sourceHeight);
  const width = sourceWidth * scale;
  const height = sourceHeight * scale;
  context.drawImage(image, (canvas.width - width) / 2, (canvas.height - height) / 2, width, height);
  return context.getImageData(0, 0, canvas.width, canvas.height);
}

function iconPixelRatioFor(map) {
  const devicePixelRatio = map.getPixelRatio?.() ?? window.devicePixelRatio ?? 1;
  return Math.min(MAX_ICON_PIXEL_RATIO, Math.max(MIN_ICON_PIXEL_RATIO, devicePixelRatio));
}

function addImageIfMissing(map, id, image, pixelRatio) {
  if (!map.hasImage(id)) map.addImage(id, image, { pixelRatio });
}

function gradedIconSize(strength, anchors) {
  const scaled = Math.max(0, Math.min(1, strength)) * (anchors.length - 1);
  const lower = Math.floor(scaled);
  const upper = Math.min(anchors.length - 1, lower + 1);
  const progress = scaled - lower;
  return anchors[lower] + (anchors[upper] - anchors[lower]) * progress;
}

function markerScaleForIcon(icon, values) {
  if (icon === HAIL_IMAGE_ID) {
    const size = AREAS_HAZARD_HAIL_ICON_SIZES[hailGradeForIntensity(values.hail)];
    return size / AREAS_HAZARD_HAIL_ICON_SIZES[2];
  }
  if (icon === STORM_IMAGE_ID) {
    const size = gradedIconSize(intensityToStrength(values.storm, 'storm'), AREAS_HAZARD_STORM_ICON_SIZES);
    return size / AREAS_HAZARD_STORM_ICON_SIZES[2];
  }
  return 1;
}

function makeProceduralIconImage(logicalSize, pixelRatio, shape, color) {
  const size = Math.round(logicalSize * pixelRatio);
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const context = canvas.getContext('2d');
  if (!context) throw new Error(`Unable to create ${shape} hazard icon`);
  context.fillStyle = color;
  context.beginPath();
  const center = size / 2;
  const radius = size * 0.42;
  const vertexCount = shape === 'star' ? 8 : 6;
  for (let index = 0; index < vertexCount; index++) {
    const angle = -Math.PI / 2 + index * Math.PI * 2 / vertexCount;
    const vertexRadius = shape === 'star' && index % 2 ? radius * 0.30 : radius;
    const x = center + Math.cos(angle) * vertexRadius;
    const y = center + Math.sin(angle) * vertexRadius;
    if (index === 0) context.moveTo(x, y);
    else context.lineTo(x, y);
  }
  context.closePath();
  context.fill();
  return context.getImageData(0, 0, size, size);
}

function blockLayoutFor(samples, level) {
  const blockSpan = AREAS_HAZARD_BLOCK_SIZE * 2 ** (MAX_GRID_LEVEL - level);
  const blocksById = new Map();

  for (let index = 0; index < samples.length; index++) {
    const sample = samples[index];
    const blockX = Math.floor(sample.canonicalX / blockSpan);
    const blockY = Math.floor(sample.canonicalY / blockSpan);
    const id = `${blockX}:${blockY}`;
    let block = blocksById.get(id);
    if (!block) {
      block = { id, gridX: blockX, gridY: blockY, indices: [], anchorX: 0, anchorY: 0 };
      blocksById.set(id, block);
    }
    block.indices.push(index);
    block.anchorX += sample.lngLat[0];
    block.anchorY += sample.lngLat[1];
  }

  return {
    level,
    blocks: [...blocksById.values()].map((block) => ({
      ...block,
      anchorX: block.anchorX / block.indices.length,
      anchorY: block.anchorY / block.indices.length
    }))
  };
}

export function blockParentIdFor(block, delta = 1) {
  const factor = 2 ** delta;
  return `${Math.floor(block.gridX / factor)}:${Math.floor(block.gridY / factor)}`;
}

export function hierarchyForLayouts(fineLayout, coarseLayout, activeChildIds = null) {
  const delta = fineLayout.level - coarseLayout.level;
  if (delta < 1) throw new Error('Hazard hierarchy requires a finer source level than its target level.');
  const maximumChildren = 4 ** delta;
  const coarseBlocksById = new Map(coarseLayout.blocks.map((block) => [block.id, block]));
  const childrenByParentId = new Map();

  for (const child of fineLayout.blocks) {
    if (activeChildIds && !activeChildIds.has(child.id)) continue;
    const parentId = blockParentIdFor(child, delta);
    const parent = coarseBlocksById.get(parentId);
    if (!parent) throw new Error(`Fine hazard block ${child.id} has no coarse parent ${parentId}.`);
    const children = childrenByParentId.get(parentId) || [];
    children.push(child);
    if (children.length > maximumChildren) {
      throw new Error(`Coarse hazard block ${parentId} has more than ${maximumChildren} fine children.`);
    }
    childrenByParentId.set(parentId, children);
  }

  return { coarseBlocksById, childrenByParentId };
}

export function collapsePhaseForTransition(fromLevel, toLevel, progress) {
  const transitionProgress = clamp(progress);
  return fromLevel > toLevel ? transitionProgress : 1 - transitionProgress;
}

function interpolatedAnchor(from, to, progress) {
  if (progress <= 0) return [from[0], from[1]];
  if (progress >= 1) return [to[0], to[1]];
  const fromMercator = lngLatToMercator(from[0], from[1]);
  const toMercator = lngLatToMercator(to[0], to[1]);
  return mercatorToLngLat(
    fromMercator[0] + (toMercator[0] - fromMercator[0]) * progress,
    fromMercator[1] + (toMercator[1] - fromMercator[1]) * progress
  );
}

function aggregateBlock(block, state0, state1, progress) {
  let storm = 0;
  let hail = 0;
  let squall = 0;
  let hurricane = 0;
  for (const index of block.indices) {
    storm = Math.max(storm, state0.hazardValues.storm[index] + (state1.hazardValues.storm[index] - state0.hazardValues.storm[index]) * progress);
    hail = Math.max(hail, state0.hazardValues.hail[index] + (state1.hazardValues.hail[index] - state0.hazardValues.hail[index]) * progress);
    squall = Math.max(squall, state0.hazardValues.squall[index] + (state1.hazardValues.squall[index] - state0.hazardValues.squall[index]) * progress);
    hurricane = Math.max(hurricane, state0.hazardValues.hurricane[index] + (state1.hazardValues.hurricane[index] - state0.hazardValues.hurricane[index]) * progress);
  }

  const values = { storm, hail, squall, hurricane };
  const icon = resolveHazardIcon(values);
  return icon ? { icon, values } : null;
}

function resolveHazardIcon(values) {
  const priority = [
    [TORNADO_IMAGE_ID, 'hurricane'],
    [SQUALL_IMAGE_ID, 'squall'],
    [HAIL_IMAGE_ID, 'hail'],
    [STORM_IMAGE_ID, 'storm']
  ];
  const winnerIndex = priority.findIndex(([, channel]) => intensityToStrength(values[channel], channel) > 0);
  if (winnerIndex < 0) return null;

  const [icon] = priority[winnerIndex];
  for (let index = 0; index < winnerIndex; index++) {
    const [, higherChannel] = priority[index];
    if (intensityToStrength(values[higherChannel], higherChannel) > 0) {
      throw new Error(`Hazard priority invariant violated: ${higherChannel} did not win aggregate block.`);
    }
  }
  return icon;
}

function aggregateFeaturesForLayout(layout, state0, state1, progress) {
  const candidates = [];
  for (const block of layout.blocks) {
    const aggregate = aggregateBlock(block, state0, state1, progress);
    if (!aggregate) continue;
    candidates.push({ block, aggregate });
  }

  return new Map(candidates.map(({ block, aggregate }) => [block.id, { block, aggregate }]));
}

function featureForAggregate(id, aggregate, coordinates, opacity = 1) {
  return {
    type: 'Feature',
    id,
    geometry: { type: 'Point', coordinates },
    properties: {
      icon: aggregate.icon,
      scale: markerScaleForIcon(aggregate.icon, aggregate.values),
      opacity
    }
  };
}

function featuresForLayout(layout, state0, state1, progress) {
  const aggregates = aggregateFeaturesForLayout(layout, state0, state1, progress);
  return [...aggregates.values()].map(({ block, aggregate }) => featureForAggregate(
    `${layout.level}:${block.id}`,
    aggregate,
    [block.anchorX, block.anchorY]
  ));
}

function featuresForTransition(fineLayout, coarseLayout, fineState0, fineState1, coarseState0, coarseState1, temporalProgress, collapsePhase) {
  const fineAggregates = aggregateFeaturesForLayout(fineLayout, fineState0, fineState1, temporalProgress);
  const coarseAggregates = aggregateFeaturesForLayout(coarseLayout, coarseState0, coarseState1, temporalProgress);
  const { coarseBlocksById, childrenByParentId } = hierarchyForLayouts(
    fineLayout,
    coarseLayout,
    new Set(fineAggregates.keys())
  );
  const movement = smoothstep(0, 1, collapsePhase);
  const handoff = smoothstep(AREAS_HAZARD_LOD_HANDOFF_START, 1, collapsePhase);
  const features = [];
  let childCount = 0;
  let parentCount = 0;

  for (const parent of coarseLayout.blocks) {
    const parentId = parent.id;
    const children = childrenByParentId.get(parentId) || [];
    const parentAggregate = coarseAggregates.get(parentId);
    for (const child of children) {
      const childAggregate = fineAggregates.get(child.id);
      if (!childAggregate) continue;
      if (!parentAggregate) throw new Error(`Active fine hazard block ${child.id} has no active coarse parent ${parentId}.`);
      features.push(featureForAggregate(
        `fine:${fineLayout.level}:${child.id}`,
        childAggregate.aggregate,
        interpolatedAnchor(
          [child.anchorX, child.anchorY],
          [parent.anchorX, parent.anchorY],
          movement
        ),
        1 - handoff
      ));
      childCount++;
    }
    if (parentAggregate) {
      features.push(featureForAggregate(
        `coarse:${coarseLayout.level}:${parent.id}`,
        parentAggregate.aggregate,
        [parent.anchorX, parent.anchorY],
        handoff
      ));
      parentCount++;
    }
  }

  return { features, childCount, parentCount };
}

export class GeographicAreasHazardIconsLayer {
  constructor() {
    this.id = 'geographic-areas-hazard-icons';
    this.type = 'custom';
    this.renderingMode = '2d';
    this.sourceId = `${this.id}-source`;
    this.symbolLayerIds = [
      `${this.id}-storm`,
      `${this.id}-hail`,
      `${this.id}-squall`,
      `${this.id}-tornado`
    ];
    this.imageIds = [STORM_IMAGE_ID, HAIL_IMAGE_ID, SQUALL_IMAGE_ID, TORNADO_IMAGE_ID];
    this.pyramid = new GeographicSymbolPyramid();
    this.layouts = new Map();
    this.samples = [];
    this.transition = null;
    this.transitionProgress = 0;
    this.temporal = null;
    this.temporalProgress = 0;
    this.lastTime = 0;
    this.active = false;
    this.data = { type: 'FeatureCollection', features: [] };
    this.layersReady = false;
    this.onLayersReady = null;
    this.lastRebuildStats = null;
  }

  onAdd(map) {
    this.map = map;
    map.addSource(this.sourceId, { type: 'geojson', data: this.data });
    const squallUrl = new URL('../../assets/squall-dark.svg', import.meta.url).href;
    const tornadoUrl = new URL('../../assets/tornado-dark.svg', import.meta.url).href;
    const pixelRatio = iconPixelRatioFor(map);
    const proceduralImages = [
      [STORM_IMAGE_ID, makeProceduralIconImage(AREAS_HAZARD_STORM_ICON_SIZES[2], pixelRatio, 'star', '#FF00FF')],
      [HAIL_IMAGE_ID, makeProceduralIconImage(AREAS_HAZARD_HAIL_ICON_SIZES[2], pixelRatio, 'hexagon', '#FFD400')]
    ];
    Promise.all([
      loadSvgImage(squallUrl, AREAS_HAZARD_SQUALL_ICON_SIZE, pixelRatio),
      loadSvgImage(tornadoUrl, AREAS_HAZARD_TORNADO_ICON_SIZE, pixelRatio)
    ]).then(([squall, tornado]) => {
      for (const [id, image] of proceduralImages) addImageIfMissing(map, id, image, pixelRatio);
      addImageIfMissing(map, SQUALL_IMAGE_ID, squall, pixelRatio);
      addImageIfMissing(map, TORNADO_IMAGE_ID, tornado, pixelRatio);
      const beforeId = map.getStyle().layers?.find((layer) => layer.type === 'symbol')?.id;
      for (let index = 0; index < this.symbolLayerIds.length; index++) {
        const imageId = this.imageIds[index];
        map.addLayer({
          id: this.symbolLayerIds[index],
          type: 'symbol',
          source: this.sourceId,
          filter: ['==', ['get', 'icon'], imageId],
          layout: {
            'icon-image': imageId,
            'icon-size': ['coalesce', ['get', 'scale'], 1],
            'icon-allow-overlap': true,
            'icon-ignore-placement': true,
            'icon-rotation-alignment': 'viewport',
            'icon-pitch-alignment': 'viewport'
          },
          paint: { 'icon-opacity': ['coalesce', ['get', 'opacity'], 1] }
        }, beforeId);
      }
      this.layersReady = true;
      this.setLayerVisibility();
      this.onLayersReady?.();
      this.refreshSource();
    }).catch((error) => {
      console.error('Areas hazard icon assets failed to load.', error instanceof Error ? error.message : error);
    });
  }

  onRemove(map) {
    for (const layerId of this.symbolLayerIds) if (map.getLayer(layerId)) map.removeLayer(layerId);
    if (map.getSource(this.sourceId)) map.removeSource(this.sourceId);
    for (const imageId of this.imageIds) if (map.hasImage(imageId)) map.removeImage(imageId);
    this.layersReady = false;
  }

  render() {}

  setLayerVisibility() {
    if (!this.layersReady) return;
    for (const layerId of this.symbolLayerIds) {
      if (this.map.getLayer(layerId)) this.map.setLayoutProperty(layerId, 'visibility', this.active ? 'visible' : 'none');
    }
  }

  refreshSource() {
    this.map?.getSource(this.sourceId)?.setData(this.data);
  }

  layoutFor(level) {
    let layout = this.layouts.get(level);
    if (!layout) {
      layout = blockLayoutFor(this.pyramid.samplesFor(level), level);
      this.layouts.set(level, layout);
    }
    return layout;
  }

  activeLevels() {
    if (this.transition) return [this.transition.fromLevel, this.transition.toLevel];
    return this.samples.length ? [this.samples[0].level] : [];
  }

  evaluateLevels(time, reusable = null) {
    const levels = [...new Set(this.activeLevels())];
    if (!levels.length) return [];
    return this.pyramid.evaluate(levels, prepareGeographicFieldFrame(time), reusable);
  }

  rebuildData() {
    if (!this.temporal) return;
    const startedAt = performance.now();
    const features = [];
    let animatedChildCount = 0;
    let parentCount = 0;
    if (this.transition) {
      const fineLevel = Math.max(this.transition.fromLevel, this.transition.toLevel);
      const coarseLevel = Math.min(this.transition.fromLevel, this.transition.toLevel);
      const animated = featuresForTransition(
        this.layoutFor(fineLevel),
        this.layoutFor(coarseLevel),
        this.temporal.states0[fineLevel],
        this.temporal.states1[fineLevel],
        this.temporal.states0[coarseLevel],
        this.temporal.states1[coarseLevel],
        this.temporalProgress,
        collapsePhaseForTransition(this.transition.fromLevel, this.transition.toLevel, this.transitionProgress)
      );
      features.push(...animated.features);
      animatedChildCount = animated.childCount;
      parentCount = animated.parentCount;
    } else {
      for (const level of this.activeLevels()) {
        features.push(...featuresForLayout(
          this.layoutFor(level),
          this.temporal.states0[level],
          this.temporal.states1[level],
          this.temporalProgress
        ));
      }
    }
    this.data = { type: 'FeatureCollection', features };
    this.refreshSource();
    this.lastRebuildStats = {
      durationMs: performance.now() - startedAt,
      featureCount: features.length,
      animatedChildCount,
      parentCount
    };
  }

  rebuildTemporal(time, options) {
    const frame = geographicTemporalFrameAt(time, options);
    const nextIndex = frame.nextIndex;
    this.temporal = {
      index: frame.index,
      nextIndex,
      terminal: frame.terminal,
      states0: this.evaluateLevels(frame.index / TEMPORAL_FRAME_COUNT),
      states1: this.evaluateLevels(frame.terminal ? 1 : nextIndex / TEMPORAL_FRAME_COUNT)
    };
    this.temporalProgress = frame.progress;
    this.rebuildData();
  }

  setSamples(samples, time) {
    this.samples = samples;
    this.transition = null;
    this.transitionProgress = 0;
    this.lastTime = time;
    this.temporal = null;
    if (this.active) this.rebuildTemporal(time);
  }

  setTransition(fromSamples, toSamples, time, progress = 0) {
    this.samples = toSamples;
    this.transition = {
      fromLevel: fromSamples[0].level,
      toLevel: toSamples[0].level
    };
    this.transitionProgress = clamp(progress);
    this.lastTime = time;
    this.temporal = null;
    if (this.active) this.rebuildTemporal(time);
  }

  setTransitionProgress(progress) {
    if (!this.transition) return;
    this.transitionProgress = clamp(progress);
    this.rebuildData();
  }

  setActive(active) {
    this.active = active;
    this.setLayerVisibility();
    if (active && !this.temporal && this.samples.length) this.rebuildTemporal(this.lastTime);
    this.map?.triggerRepaint();
  }

  updateWeather(time, options) {
    this.lastTime = time;
    if (!this.samples.length || !this.active) return;
    const frame = geographicTemporalFrameAt(time, options);
    if (!this.temporal || frame.index !== this.temporal.index || frame.terminal !== this.temporal.terminal) {
      if (!frame.terminal && this.temporal && frame.index === this.temporal.nextIndex) {
        const reusable = this.temporal.states0;
        this.temporal.index = frame.index;
        this.temporal.nextIndex = frame.nextIndex;
        this.temporal.terminal = false;
        this.temporal.states0 = this.temporal.states1;
        this.temporal.states1 = this.evaluateLevels(this.temporal.nextIndex / TEMPORAL_FRAME_COUNT, reusable);
      } else {
        this.rebuildTemporal(time, options);
      }
    }
    this.temporalProgress = frame.progress;
    this.rebuildData();
  }
}
