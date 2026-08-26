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
storage, and the representation-independent bilinear reconstruction from
geographic source nodes. The snapshot is loaded once before map initialization;
renderers receive only normalized channels. Rain, storm, and hail are sampled
independently from the four surrounding source-node values, with ordinary
bilinear weights and final `[0, 1]` clamping. The RAW midpoint-cell diagnostic
does not constrain this reconstruction. The legacy synthetic
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
 +-> geographic-scalar-lattice.js --------> geographic-scalar-layer.js
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
channels in typed arrays and bilinearly reconstructs the normalized channels
between geographic source nodes. Normalization is
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

The source-of-truth weather data is defined at geographic source nodes. RAW is a
separate static diagnostic representation of the original 376 × 239 provider
grid: it interprets each source-node value as a piecewise-constant midpoint cell
(half-spacing at the outer edges), draws raw `mmh > 0` cells as solid opaque
blue, and draws raw thunderstorm/hail codes as solid magenta/yellow inset
markers. These RAW cell boundaries are diagnostic, not assumed meteorological
boundaries. Values between source nodes use the shared bilinear reconstruction;
RAW does not constrain Dots, Squares, Blur, or Areas. RAW never calls the
normalized bilinear sampler, Mercator LOD, L14 scalar lattice, reconstruction,
smoothing, aggregation, or renderer mappings. The layer stores only nonzero
drawing geometry for performance; zero cells remain inspectable through the
provider's direct regular-grid cell lookup.

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
and deterministic parent mappings. L14 is the single direct/reference level;
L13, L12, L11, and L10 are each deterministically reduced from their immediate
finer level. Rain and strong-rain areas are conserved independently; hail wins
hazard priority during reduction. Parent anchors remain weather-independent and
LOD transitions use the same dyadic parent/child topology for every adjacent
displayed level, including L14 ↔ L13.

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

The square pyramid directly samples only L14, then recursively reduces L13,
L12, L11, and L10 from their immediate deterministic children. Each state keeps
only scalar rain, storm, and hail values. Rain averages immediate child values;
storm and hail retain their average/max-biased reductions. LOD changes crossfade
the deterministic parent and child cell sets during the existing 0.2 s
transition; no new grid is created and no camera-dependent identity is
introduced.

## Fixed scalar reconstruction — `src/engine/geographic-scalar-lattice.js`

Blur and Areas share one fixed L14 lattice with 104,850 vertices (466 × 225).
Its rows,
columns, Mercator positions, and triangle indices are created once from the
globally anchored geographic topology and cached for the life of the layer.
L14 gives a roughly 3 km local grid near the experiment anchor. Panning,
rotation, pitch, resizing, and ordinary camera zoom only reproject this mesh;
they do not rebuild it or reevaluate weather values.

Each temporal keyframe evaluates the bilinearly reconstructed source field at
those fixed L14 vertices using the prepared geographic field. Smooth state and
coverage remapping are computed only for Areas with Smooth enabled. Both Blur
and Areas pack the selected L14 channel values into two reusable RGBA32F
textures sized exactly to the lattice (466 × 225); the fragment shader performs
explicit four-texel bilinear sampling from those textures. The indexed mesh is
surface/projection tessellation only. The scalar mesh is a surface-attached
MapLibre custom 3D layer.

Dots, Squares, and Scalar share the same 100 ms temporal-frame boundary helper
and MapLibre/WebGL projection-uniform helper. Squares retain CPU and GPU
instance capacity across updates, and Scalar retains its two fixed-size CPU/GPU
texture pairs; only data contents are updated for ordinary keyframes.

## Blur — `src/engine/geographic-scalar-layer.js`

In Blur mode the fragment shader bilinearly reconstructs rain/storm/hail from
the shared unsmoothed L14 textures, then applies the continuous visibility and
color-transfer intent: a soft rain support edge, light-blue rain transitioning
to strong blue, then magenta storm and yellow hail composited above it. Hail is
last. The indexed triangles do not define scalar geometry, and no per-vertex
weather attribute buffer is used.

## Areas reconstruction and Smooth — `src/engine/geographic-scalar-layer.js`, `src/engine/geographic-scalar-lattice.js`

Areas uses the same shared L14 RGBA32F textures and explicit four-texel
bilinear reconstruction as Blur. With Smooth off, this raw L14 → bilinear field
is mapped through the existing five precipitation bands (`#0090FF` through
`#0000FF`), storm/hail thresholds, translucent magenta/yellow fills,
hail-over-storm order, and derivative-based edge treatment. The default Areas
field therefore differs from Blur only by transfer semantics, not by scalar
reconstruction.

The two texture arrays and two GPU textures are allocated lazily and retained
for the life of the layer. On ordinary 100 ms temporal advancement, the
previous state1 texture becomes state0 and only the new state1 texture data is
rewritten and uploaded. Mode switching and arbitrary timeline jumps rebuild the
same reusable L14 texture pair, so Blur, Areas, and Areas Smooth cannot retain a
stale reconstruction path.

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
against the unsmoothed lattice, preserving the visual-coverage intent. Both
filtered values and remapped thresholds are interpolated between temporal
keyframes, so Smooth does not introduce visible 100 ms contour steps. Its
deterministic generalized L14 values feed the same shared bilinear texture
reconstruction; Smooth is therefore a deterministic L14 generalization rather
than a separate spatial interpolant. Blur always uses the raw unsmoothed L14
values.
