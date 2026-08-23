# Dot Field Architecture

## Document status

- Repository: `anatolysinelnikov/dot-field`
- Architecture: `experiment/globe-layers` geographic weather representations
- This document is maintained context, not implementation authority. The current code wins when they differ.

## Project model

This is a browser-native geographic weather prototype. It uses MapLibre GL JS in
Globe projection, the deterministic synthetic field in `field.js`, a globally
anchored Mercator sampling topology, and projection-aware MapLibre custom WebGL
layers. The active modes are **Dots**, **Squares**, **Blur**, and **Areas**.

The weather channels are always independent data channels:

- rain;
- thunderstorm (`storm` in code);
- hail.

The active renderer split is intentional:

```text
synthetic geographic field
        |
        +-- discrete Mercator LOD --> Dots / Squares
        |
        +-- fixed L14 scalar lattice --> Blur / Areas (+ optional Smooth)
```

The intended provider boundary remains:

```text
provider format -> normalization -> temporal/spatial interpolation
-> geographic sampling/reconstruction -> rendering
```

`field.js` is only the current deterministic synthetic data-source side of that
boundary and remains independent of MapLibre, WebGL, and UI.

## Runtime ownership

```text
index.html + styles.css
        |
        v
app.js ----------------------> MapLibre GL JS / Globe camera and basemap
 |                                  |
 +-> geographic-lod.js              +-> MapLibre custom 3D layers
 |      geographic-symbol-pyramid.js      |
 |                                        +-> geographic-dots-layer.js
 +-> geographic-squares-layer.js          +-> geographic-squares-layer.js
 +-> geographic-scalar-lattice.js         +-> geographic-scalar-layer.js
```

### Application orchestration — `src/app.js`

`app.js` owns UI state, playback, timeline scrubbing, custom camera controls,
logical weather zoom, MapLibre construction, active-layer routing, and readouts.
It creates all three geographic custom layers once after the style loads and
changes their active state instead of recreating the map or layers when the
render mode changes. `Dots` is the initial mode; the selector order is Dots,
Squares, Blur, Areas. The Smooth control is visible only in Areas mode.

The MapTiler Dataviz Dark Globe basemap, attribution/logo, native label and
administrative-boundary ordering, water tint/boundary context, camera controls,
reset behavior, and raw camera zoom constraints remain owned by the existing
MapLibre setup. Weather layers remain inserted below the promoted context.

Animation remains an 18-second deterministic loop. The application creates
adjacent 100 ms keyframes and updates all weather layers together; switching a
mode preserves time, play/pause state, camera state, and logical weather zoom.
Dots and Squares read out their active LOD/sample count. Blur and Areas report
their fixed L14 reconstruction lattice instead of camera LOD.

## Geographic field adapter — `src/engine/geography.js`

`WEATHER_REGION` centralizes the Saint Petersburg anchor, synthetic longitude /
latitude scale, deterministic trajectory, and support. `WEATHER_SUPPORT` is the
only support envelope consumed by the geographic topology. A fixed Mercator
point maps to a fixed synthetic coordinate; camera movement never participates
in that mapping. `prepareGeographicFieldFrame` prepares time-only field values,
and `geographicPreparedIntensityAt` evaluates those frames at stable points.

## Shared geographic Mercator topology — `src/engine/geographic-lod.js`

The discrete topology is a globally anchored dyadic grid in normalized
Web-Mercator coordinates. A sample identity is its integer L15 canonical
coordinate pair, so inherited vertices retain identity through LOD refinement.
The camera never reseats the grid. Displayed Dots/Squares levels are L10–L14;
L15 remains the canonical identity resolution. Logical sampling zoom is
application-owned and latitude-corrected for Globe camera behavior, so panning
and rotating do not alter displayed weather density.

## Dots — `src/engine/geographic-dots-layer.js`

Dots retain the existing symbol-pyramid implementation. `GeographicSymbolPyramid`
caches L10–L15 topology, direct field points, static anchors, dyadic ownership,
and direct level-pair mappings. It evaluates L13 as the reference, recursively
reduces L10–L12, and directly evaluates L14/L15. Rain and strong-rain areas are
conserved independently; hail wins hazard priority during reduction.

The custom MapLibre layer draws instanced Mercator-space circles, storm stars,
and hail hexagons with MapLibre's `projectTile` projection path. Its 0.2 s LOD
transitions use deterministic parent/child topology and squared-radius morphs.

## Squares — `src/engine/geographic-squares-layer.js`

Squares use the same active globally anchored L10–L14 Mercator topology as
Dots, but are a discrete sampled representation rather than a scalar mesh.
Each active sample instantiates a square centered on its Mercator grid point;
the cell side equals the active grid spacing. Geometry is projected by the same
MapLibre custom-layer shader path, so it follows Globe curvature, pitch,
bearing, perspective, pan, and depth.

The square pyramid evaluates direct L13+ samples and recursively reduces coarse
levels: rain averages over immediate deterministic children, while storm and
hail use the legacy average/max-biased intent. The fragment transfer preserves
the light-blue to strong-blue precipitation hierarchy, magenta storm, yellow
hail, and hail-over-storm compositing. LOD changes crossfade the deterministic
parent and child cell sets during the existing 0.2 s transition; no new grid is
created and no camera-dependent identity is introduced.

## Fixed scalar reconstruction — `src/engine/geographic-scalar-lattice.js`

Blur and Areas share one fixed L14 lattice with 30,240 vertices. Its rows,
columns, Mercator positions, and triangle indices are created once from the
globally anchored geographic topology and cached for the life of the layer.
L14 gives a roughly 3 km local grid near the experiment anchor. Panning,
rotation, pitch, resizing, and ordinary camera zoom only reproject this mesh;
they do not rebuild it or reevaluate weather values.

Each temporal keyframe evaluates rain/storm/hail at those fixed vertices using
the prepared geographic field. The scalar layer uploads adjacent keyframe
channels and interpolates them in the vertex shader, then interpolates over the
static surface triangles. This keeps Blur and Areas continuous between 100 ms
evaluations. The scalar mesh is a surface-attached MapLibre custom 3D layer,
not a Canvas raster, screen overlay, or post-processing effect.

## Blur — `src/engine/geographic-scalar-layer.js`

In Blur mode the fragment shader applies the legacy continuous visibility and
color-transfer intent to the interpolated scalar channels: a soft rain support
edge, light-blue rain transitioning to strong blue, then magenta storm and
yellow hail composited above it. Hail is last. The shader computes final color
and opacity directly from reconstructed values, avoiding blur of any discrete
representation.

## Areas and Smooth — `src/engine/geographic-scalar-layer.js`

Areas uses the same scalar mesh but applies the existing five precipitation
threshold bands (`#0090FF` through `#0000FF`) in the fragment shader. This
creates world-stable nested discrete regions without CPU Path2D or polygon
triangulation. Storm and hail use their existing presence thresholds, translucent
magenta/yellow fills, hail-over-storm order, and derivative-based threshold
edges for approximately screen-stable readable boundaries.

Smooth generalizes field data before Areas rendering. For every prepared scalar
keyframe, each channel receives two deterministic radius-three box-filter passes
on the fixed L14 lattice (an approximately 10 km local low-pass scale). This
removes local detail without changing the lattice or responding to camera zoom.
Rain band thresholds and storm/hail presence thresholds are coverage-remapped
against the unsmoothed lattice, preserving the legacy visual-coverage intent.
Both filtered values and remapped thresholds are interpolated between temporal
keyframes, so Smooth does not introduce visible 100 ms contour steps.

## Legacy Canvas modules

`dots-renderer.js`, `squares-renderer.js`, `blur-renderer.js`,
`areas-renderer.js`, and `scalar-reconstruction.js` remain inactive reference
implementations of the old fixed-viewport Canvas path. Their pure transfer and
semantic intent informs the geographic layers, but no geographic renderer draws
through a Canvas viewport/raster path.
