# Dot Field Architecture

## Document status

- Repository: `anatolysinelnikov/dot-field`
- Architecture: `real-data-2026-08-25-1630MSK` geographic weather representations
- This document is maintained context, not implementation authority. The current code wins when they differ.

## Project model

This is a browser-native geographic weather prototype. It uses MapLibre GL JS in
Globe projection, a validated static real-data CSV snapshot, a globally
anchored Mercator sampling topology, and projection-aware MapLibre custom WebGL
layers. The active modes are **RAW**, **Dots**, **Squares**, **Blur**, and
**Areas**; RAW is the initial mode and Dots remains available as a selectable mode.

The weather channels are always independent data channels:

- rain;
- thunderstorm (`storm` in code);
- hail.

The active renderer split is intentional:

```text
real geographic field snapshot
        |
        +-- direct source-grid cells ------------------------------> RAW
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

`real-weather.js` owns CSV parsing, validation, normalization, typed-array
storage, and bilinear sampling. The snapshot is loaded once before map
initialization; renderers receive only normalized channels. The legacy synthetic
`field.js` remains independent of MapLibre, WebGL, and UI but is not on the
active data path.

## Runtime ownership

```text
index.html + styles.css
        |
        v
app.js ----------------------> MapLibre GL JS / Globe camera and basemap
 |                                  |
 +-> real-weather.js --------------------> raw-weather-layer.js
 +-> geographic-lod.js ------------------> geographic-dots-layer.js
 |      geographic-symbol-pyramid.js      geographic-squares-layer.js
 +-> geographic-scalar-lattice.js ---+
 +-> areas-reconstruction.js --------+----> geographic-scalar-layer.js
```

### Application orchestration — `src/app.js`

`app.js` owns UI state, playback, timeline scrubbing, custom camera controls,
logical weather zoom, MapLibre construction, active-layer routing, and readouts.
It creates all four geographic custom layers once after the style loads and
changes their active state instead of recreating the map or layers when the
render mode changes. RAW is the initial mode and playback starts paused; the
selector order is RAW, Dots, Squares, Blur, Areas. The `Явления` control is visible only in RAW mode;
the Smooth control is visible only in Areas mode.

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
RAW is static and never participates in temporal evaluation.
Dots and Squares read out their active LOD/sample count. Blur and Areas report
their fixed L14 reconstruction lattice instead of camera LOD.

The application-owned RAF runs only while playback advances or a 0.2 s LOD
transition is active. Paused map navigation and static updates use MapLibre's
own repaint scheduling; beginning or reversing an LOD transition wakes the
application RAF so its progress still completes while paused.

## Real-data geographic adapter — `src/engine/real-weather.js`, `src/engine/geography.js`

The active provider is `data/mrl_z3_t+40min_376x239.csv`, containing 89,864 rows
on a regular 376 × 239 longitude/latitude grid. `real-weather.js` validates the
header, dimensions, complete grid, regular axes (within rounded-coordinate
tolerance), nonnegative mm/h values, and supported thunderstorm/hail codes. It
stores raw mm/h and phenomenon codes plus normalized rain, storm, and hail
channels in typed arrays and bilinearly samples the normalized channels in
geographic coordinates. Normalization is
`clamp(mmh / 3, 0, 1)` for rain; thunderstorm codes 0/10/11/12 map to
0/0.2660123/0.4818750/0.6977377; hail codes 0/16/17/18 map to
0/0.2776807/0.4897500/0.7018193.

`geography.js` is the renderer-facing adapter. It loads and activates the
snapshot once, keeps the existing time-frame API (all times sample the same
static field), and converts the existing shared point interface to geographic
longitude/latitude. `WEATHER_SUPPORT` is a stable rectangle around the source
nodes with any nonzero channel, padded by one source-grid cell on each side:
`39.93113..50.12886` longitude and `41.57035..45.12740` latitude. The complete
CSV envelope remains available inside the provider and is not altered by this
topology optimization.

## RAW source-grid diagnostic — `src/engine/raw-weather-layer.js`

RAW is a separate static diagnostic representation of the original 376 × 239
provider grid. It constructs one world-space cell per source node from midpoint
boundaries (half-spacing at the outer edges), draws raw `mmh > 0` cells as solid
opaque blue, and draws raw thunderstorm/hail codes as solid magenta/yellow inset
markers. It never calls the normalized bilinear sampler, Mercator LOD, the L14
scalar lattice, reconstruction, smoothing, aggregation, or renderer mappings.
The layer stores only nonzero drawing geometry for performance; zero cells remain
inspectable through the provider's direct regular-grid cell lookup.

RAW interaction is application-owned: pointer coordinates select the source cell
directly from the loaded longitude/latitude axes, including zero-valued cells.
Hover shows a diagnostic tooltip and click/tap pins it; Escape, outside clicks,
or clicking the selected cell again dismiss it. Tooltip values are raw source
coordinates, three-decimal mm/h, and integer phenomenon codes. RAW does not
advance with the existing playback loop.

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
hail use the existing average/max-biased intent. The fragment transfer preserves
the light-blue to strong-blue precipitation hierarchy, magenta storm, yellow
hail, and hail-over-storm compositing. LOD changes crossfade the deterministic
parent and child cell sets during the existing 0.2 s transition; no new grid is
created and no camera-dependent identity is introduced.

## Fixed scalar reconstruction — `src/engine/geographic-scalar-lattice.js`

Blur and Areas share one fixed L14 lattice with 104,850 vertices (466 × 225).
Its rows,
columns, Mercator positions, and triangle indices are created once from the
globally anchored geographic topology and cached for the life of the layer.
L14 gives a roughly 3 km local grid near the experiment anchor. Panning,
rotation, pitch, resizing, and ordinary camera zoom only reproject this mesh;
they do not rebuild it or reevaluate weather values.

Each temporal keyframe evaluates raw rain/storm/hail at those fixed vertices
using the prepared geographic field. Smooth state and coverage remapping are
computed only for Areas with Smooth enabled. Blur packs/uploads only its L14
vertex values; Areas reconstructs/uploads only dense texture values. The scalar
mesh is a surface-attached MapLibre custom 3D layer.

Dots, Squares, and Scalar share the same 100 ms temporal-frame boundary helper
and MapLibre/WebGL projection-uniform helper. Squares retain CPU and GPU
instance capacity across updates, and Blur retains its fixed-size GPU value
buffer allocation; only data contents are updated for ordinary keyframes.

## Blur — `src/engine/geographic-scalar-layer.js`

In Blur mode the fragment shader retains the existing vertex-varying triangle
interpolation path and applies the continuous visibility and
color-transfer intent: a soft rain support edge, light-blue rain transitioning
to strong blue, then magenta storm and yellow hail composited above it. Hail is
last. The shader computes final color and opacity directly from reconstructed
values, avoiding blur of any discrete representation.

## Areas reconstruction and Smooth — `src/engine/geographic-scalar-layer.js`, `src/engine/areas-reconstruction.js`

Areas starts from the same deterministic L14 samples, but its default
reconstruction is a separate, shape-preserving dense Mercator lattice. The
explicit `AREA_RECONSTRUCTION_SUBDIVISIONS = 2` constant produces a 931 × 449
reconstruction grid from the 466 × 225 source grid. Its CPU pass is a
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
against the unsmoothed lattice, preserving the visual-coverage intent.
Both filtered values and remapped thresholds are interpolated between temporal
keyframes, so Smooth does not introduce visible 100 ms contour steps. Its
deterministic generalized L14 values feed the same shape-preserving dense Areas
reconstruction; Smooth is therefore still distinct from default reconstruction
quality. Blur remains on its independent triangle-interpolated scalar path.
