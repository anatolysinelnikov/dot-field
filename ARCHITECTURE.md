# Dot Field Architecture

## Document status

- Repository: `anatolysinelnikov/dot-field`
- Architecture: `main` geographic weather representations
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
 +-> geographic-scalar-lattice.js ---+
 +-> areas-reconstruction.js --------+----> geographic-scalar-layer.js
```

### Application orchestration — `src/app.js`

`app.js` owns UI state, playback, timeline scrubbing, custom camera controls,
logical weather zoom, MapLibre construction, active-layer routing, and readouts.
It creates all three geographic custom layers once after the style loads and
changes their active state instead of recreating the map or layers when the
render mode changes. `Dots` is the initial mode; the selector order is Dots,
Squares, Blur, Areas. The Smooth control is visible only in Areas mode.

The MapTiler Dataviz Dark Globe basemap, native label and
administrative-boundary ordering, water tint/boundary context, camera controls,
reset behavior, and raw camera zoom constraints remain owned by the existing
MapLibre setup. MapLibre's default attribution control displays the style's
source attribution, and the application includes the linked MapTiler logo
required for Free accounts. Weather layers remain inserted below the promoted
context.

Local development and the static GitHub Pages deployment both load the same
runtime `config.local.json` shape. The ignored local file is supplied by the
developer; the Pages workflow writes the deployment key into the staged site
artifact only, without adding it to the repository.

Animation remains an 18-second deterministic loop. The application creates
adjacent 100 ms keyframes only for the active representation; switching a mode
lazily synchronizes that representation to the exact global time before its
next repaint, while preserving time, play/pause state, camera state, and
logical weather zoom. Inactive layers retain lightweight topology/LOD state but
do not evaluate weather, rebuild instance data, or upload temporal GPU data.
Dots and Squares read out their active LOD/sample count. Blur and Areas report
their fixed L14 reconstruction lattice instead of camera LOD.

The application-owned RAF runs only while playback advances or a 0.2 s LOD
transition is active. Paused map navigation and static updates use MapLibre's
own repaint scheduling; beginning or reversing an LOD transition wakes the
application RAF so its progress still completes while paused.

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
L15 remains the canonical identity resolution but is not materialized as Dots
or Squares runtime topology. Logical sampling zoom is
application-owned and latitude-corrected for Globe camera behavior, so panning
and rotating do not alter displayed weather density.

## Dots — `src/engine/geographic-dots-layer.js`

Dots retain the existing symbol-pyramid implementation. `GeographicSymbolPyramid`
caches L10–L14 topology, direct field points, static anchors, dyadic ownership,
and direct level-pair mappings. It evaluates L13 as the reference, recursively
reduces L10–L12, and directly evaluates L14. Rain and strong-rain areas are
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

Each temporal keyframe evaluates raw rain/storm/hail at those fixed vertices
using the prepared geographic field. Smooth state and coverage remapping are
computed only for Areas with Smooth enabled. Blur packs/uploads only its L14
vertex values; Areas reconstructs/uploads only dense texture values. The scalar
mesh is a surface-attached
MapLibre custom 3D layer, not a Canvas raster, screen overlay, or
post-processing effect.

Dots, Squares, and Scalar share the same 100 ms temporal-frame boundary helper
and MapLibre/WebGL projection-uniform helper. Squares retain CPU and GPU
instance capacity across updates, and Blur retains its fixed-size GPU value
buffer allocation; only data contents are updated for ordinary keyframes.

## Blur — `src/engine/geographic-scalar-layer.js`

In Blur mode the fragment shader retains the existing vertex-varying triangle
interpolation path and applies the legacy continuous visibility and
color-transfer intent: a soft rain support edge, light-blue rain transitioning
to strong blue, then magenta storm and yellow hail composited above it. Hail is
last. The shader computes final color and opacity directly from reconstructed
values, avoiding blur of any discrete representation.

## Areas reconstruction and Smooth — `src/engine/geographic-scalar-layer.js`, `src/engine/areas-reconstruction.js`

Areas starts from the same deterministic L14 samples, but its default
reconstruction is a separate, shape-preserving dense Mercator lattice. The
explicit `AREA_RECONSTRUCTION_SUBDIVISIONS = 2` constant produces a 359 × 335
reconstruction grid from the 180 × 168 source grid. Its CPU pass is a
separable monotone cubic Hermite (PCHIP-style harmonic-slope) interpolator: it
copies every original L14 node exactly, limits slopes to prevent cubic ringing,
and constrains between-node values to their rectangular source-cell range.
This improves continuity for small hail contours without changing the sampled
field or applying low-pass smoothing.

The expensive reconstruction workspace, dense temporal arrays, and two RGBA32F
textures are allocated lazily on first Areas activation and retained thereafter.
Reconstruction is performed only when Areas needs a temporal state: both
adjacent states are rebuilt on Areas activation, arbitrary timeline jumps, or a
Smooth toggle. During ordinary 100 ms temporal advancement, the already
reconstructed `state1` buffer/texture becomes `state0`; only the new `state1`
is reconstructed and uploaded. The two dense RGBA32F textures keep
rain/storm/hail in RGB. The fragment shader uses portable explicit bilinear
four-texel sampling of those dense textures, then temporally mixes the results
before applying the existing five precipitation bands (`#0090FF` through
`#0000FF`), storm/hail thresholds, translucent magenta/yellow fills,
hail-over-storm order, and derivative-based edge treatment. This avoids making
float-linear texture support a requirement.

The static L14 indexed triangles remain projection-only surface tessellation
for MapLibre Globe. Their diagonals never determine Areas scalar contours, and
camera movement only reprojects the surface; it does not rebuild scalar data.

Smooth generalizes field data before Areas rendering. Only while Areas Smooth is
enabled, each needed scalar keyframe receives two deterministic radius-three
box-filter passes on the fixed L14 lattice (an approximately 10 km local
low-pass scale). The filter uses running separable windows while retaining the
same edge-clamping semantics. This
removes local detail without changing the lattice or responding to camera zoom.
Rain band thresholds and storm/hail presence thresholds are coverage-remapped
against the unsmoothed lattice, preserving the legacy visual-coverage intent.
Both filtered values and remapped thresholds are interpolated between temporal
keyframes, so Smooth does not introduce visible 100 ms contour steps. Its
deterministic generalized L14 values feed the same shape-preserving dense Areas
reconstruction; Smooth is therefore still distinct from default reconstruction
quality. Blur remains on its independent triangle-interpolated scalar path.

## Legacy Canvas modules

`dots-renderer.js`, `squares-renderer.js`, `blur-renderer.js`,
`areas-renderer.js`, and `scalar-reconstruction.js` remain inactive reference
implementations of the old fixed-viewport Canvas path. Their pure transfer and
semantic intent informs the geographic layers, but no geographic renderer draws
through a Canvas viewport/raster path.
