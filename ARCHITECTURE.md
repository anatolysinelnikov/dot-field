# Dot Field Architecture

## Document status

- Repository: `anatolysinelnikov/dot-field`
- Architecture: `real-data-2026-08-26-2200` geographic weather sequence playback
- This document is maintained context, not implementation authority. The current code wins when they differ.

## Project model

This is a browser-native geographic weather prototype. It uses MapLibre GL JS in
Globe projection, a validated compact real-data precipitation sequence, a globally
anchored Mercator sampling topology, and projection-aware MapLibre custom WebGL
layers. The active modes are **RAW**, **Dots**, **Squares**, **Blur**, and
**Areas**; RAW is the initial mode and Dots remains available as a selectable mode.

The weather channels are always independent data channels:

- rain;
- thunderstorm (`storm` in code);
- hail.

The active renderer split is intentional:

```text
real geographic weather sequence
        |
        +-- direct source-grid cells ------------------------------> RAW
        |
        +-- discrete Mercator LOD
        |     +-- shared physical weather summaries --> Dots / Squares presentation mapping
        |
        +-- fixed L14 scalar lattice --> Blur / Areas (+ optional Smooth)
```

The intended provider boundary remains:

```text
provider format -> validation -> temporal/spatial interpolation
-> geographic sampling/reconstruction -> rendering
```

`real-weather.js` owns CSV and compact-sequence validation, physical typed-array
storage, and representation-independent geographic reconstruction. The active
sequence samples physical `rainMmh` bilinearly from four geographic source nodes
and linearly between its adjacent source frames; storm and hail are independent
channels but are zero for this rain-only sequence. Rain remains physical `mm/h`
through interpolation, sampling, LOD reduction, and scalar-lattice
reconstruction; renderer presentation mappings may use the named 50 mm/h visual
anchor but do not clamp the data field. The RAW midpoint-cell diagnostic does
not constrain this reconstruction. The legacy synthetic
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
 +-> geographic-lod.js ------------------> geographic-weather-pyramid.js
 |                                           +-> geographic-dots-layer.js
 |                                           +-> geographic-squares-layer.js
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

The finite source forecast traverses from 22:00 to 01:00 in the existing
18-second UI duration: normalized time 0 samples frame 0 and normalized time 1
samples frame 18. Playback stops at the endpoint rather than creating a
final-to-first seam; pressing Play at the endpoint explicitly restarts it from
the beginning. The application commits the terminal renderer update before it
marks playback paused. The application creates adjacent 100 ms keyframes only
for the active representation, including an exact terminal keyframe; switching a mode
lazily synchronizes that representation to the exact global time before its
next repaint, while preserving time, play/pause state, camera state, and
logical weather zoom. Inactive layers retain lightweight topology/LOD state but
do not evaluate weather, rebuild instance data, or upload temporal GPU data.
RAW is intentionally static and never participates in temporal evaluation.
Dots and Squares read out their active LOD/sample count. Blur and Areas report
their fixed L14 reconstruction lattice instead of camera LOD.

The application-owned RAF runs only while playback advances or a 0.2 s LOD
transition is active. Paused map navigation and static updates use MapLibre's
own repaint scheduling; beginning or reversing an LOD transition wakes the
application RAF so its progress still completes while paused.

## Real-data geographic adapter — `src/engine/real-weather.js`, `src/engine/geography.js`

The active provider is the ignored local compact sequence at
`data/generated/202608262200/metadata.json` plus `rain.f32`: 19 frames on one
fixed 259 × 93 regular geographic grid, stored as little-endian Float32 in
`[time][latitude][longitude]` order. Metadata validation requires the supported
schema, dimensions, timestamps, binary layout/counts/byte count, positive axis
spacing, mm/h normalized units, rain availability, and absent storm/hail
channels; the fetched binary byte length must match exactly. Geographic axes
are constructed deterministically from metadata. `RealWeatherSequence` keeps
the existing bilinear spatial sampler and presents value-free temporal frames
that linearly blend source frames; prepared geometry remains a `Uint32Array`
source-cell index plus two `Float64Array` interpolation fractions (20
bytes/sample), reusable across all 19 frames because it stores no weather
values. The single-point sampler remains the semantic reference path.

`geography.js` is the renderer-facing adapter. It loads and activates the
sequence before map initialization and converts the shared point interface to
geographic longitude/latitude. It falls back to the checked-in
`data/mrl_z3_t+40min_376x239.csv` snapshot only when the local sequence assets
are unavailable (such as HTTP 404), with one concise warning; malformed
metadata, inconsistent values/geometry, or an incorrect binary length fail
visibly instead. `WEATHER_SUPPORT` remains the existing stable rectangle and is
not expanded. The availability GeoJSON is diagnostic observation coverage only,
not a forecast-rain mask.

## RAW source-grid diagnostic — `src/engine/raw-weather-layer.js`

The source-of-truth weather data is defined at geographic source nodes. RAW is a
separate static diagnostic representation of the first sequence source frame on
its 259 × 93 provider grid: it interprets each source-node value as a
piecewise-constant midpoint cell
(half-spacing at the outer edges), draws raw `mmh > 0` cells as solid opaque
blue. The compact sequence has no storm or hail, so RAW has no phenomenon
markers. These RAW cell boundaries are diagnostic, not assumed meteorological
boundaries. Values between source nodes use the shared bilinear reconstruction;
RAW does not constrain Dots, Squares, Blur, or Areas. RAW never calls the
shared bilinear sampler, Mercator LOD, L14 scalar lattice, reconstruction,
smoothing, aggregation, or renderer mappings. The layer stores only nonzero
drawing geometry for performance; zero cells remain inspectable through the
provider's direct regular-grid cell lookup.

RAW interaction is application-owned: pointer coordinates select the source cell
directly from the loaded longitude/latitude axes, including zero-valued cells.
Hover shows a diagnostic tooltip and click/tap pins it; Escape, outside clicks,
or clicking the selected cell again dismiss it. Tooltip values are raw source
coordinates, three-decimal mm/h, and integer phenomenon codes. RAW currently
does not advance with playback: it intentionally shows only source frame 0.

## Shared geographic Mercator topology — `src/engine/geographic-lod.js`

The discrete topology is a globally anchored dyadic grid in normalized
Web-Mercator coordinates. A sample identity is its integer L15 canonical
coordinate pair, so inherited vertices retain identity through LOD refinement.
`selectMercatorGridSamples()` is the canonical spatial authority: every
selected sample's `mercator` coordinate is the world-space position used by
discrete representations.
The camera never reseats the grid. Canonical identity resolution and the
maximum displayed Dots/Squares level are both L15. Logical sampling zoom is
application-owned and latitude-corrected for Globe camera behavior, so panning
and rotating do not alter displayed weather density.

## Shared physical weather summaries — `src/engine/geographic-weather-pyramid.js`

The application owns one `GeographicWeatherPyramid` and passes it to both Dots
and Squares. It is representation-independent and uses the canonical samples from
`selectMercatorGridSamples()` but has no dependency on Dots radii, Squares
opacity/color, glyph geometry, WebGL, UI state, presentation mappings, or
hazard-renderer functions. The parsed provider grid is anisotropic geographic
data; near `WEATHER_REGION.center` its roughly 0.04° longitude/latitude source
spacing is closest to canonical L13. `WEATHER_REFERENCE_LEVEL = 13` is thus the
effective direct/aggregate boundary. L13, L14, and L15 independently evaluate
their own canonical geographic coordinates through the bilinearly reconstructed
physical field. The pyramid lazily owns one reusable provider sampling geometry
for each direct canonical level, so source-cell lookup is not repeated for each
weather frame. L13/L14/L15 remain independent direct samples of the
reconstructed field; the geometry contains no weather values and does not
couple temporal frames or renderers. L14/L15 add sampling resolution, not
meteorological information.
Only L12 through L10 are recursively aggregated spatial summaries from L13;
they are never direct field samples or values from an existing renderer pyramid.

```text
provider source grid
        ↓
bilinear reconstructed physical field
        ↓
L15 direct sample
L14 direct sample
L13 direct/effective reference sample
-------------------------------
L12 centered spatial summary
L11 centered spatial summary
L10 centered spatial summary
```

Each summary is a struct of typed arrays with 16 `Float32Array` fields per
sample (64 bytes/sample): `totalWeight`, `rainWeightedSumMmh`,
`rainMaxMmh`, seven `rainCoverageWeight` arrays for the physical thresholds
0.05, 0.10, 0.30, 1.00, 2.50, 10.0, and 50.0 mm/h,
`stormCoverageWeight`, `stormWeightedSeverity`, `stormMaxSeverity`,
`hailCoverageWeight`, `hailWeightedSeverity`, and `hailMaxSeverity`. Means are
derived as weighted sum divided by `totalWeight`; they are not stored. Rain
remains physical mm/h, including values above 50 mm/h. Coverage arrays retain
distribution information that a mean alone would lose, and hazard maxima are
retained alongside coverage and weighted severity.

Aggregate-side centered contribution mappings are separate from LOD transition
ownership. They exist only for L13→L12→L11→L10. An aligned fine coordinate contributes with weight 1; a half-step
coordinate splits 0.5/0.5 on that axis, with X/Y weights multiplied. Candidates
outside the finite selected support are omitted and the remaining weights for
that fine sample are divided by their sum, so every child retains total support
weight 1. For each child summary contribution `w`, all additive statistics and
coverage weights receive `w * child.totalWeight` or `w * child statistic`, and
maxima retain the maximum over positive support. This makes the summaries
recursively composable without re-thresholding child means. The summary storage
choice was validated against an equivalent Float64 calculation across the
complete L10–L15 topology, deterministic fixtures, recursive composition, and
the real weather snapshot; the verifier records field-specific absolute and
relative error bounds. Contribution weights remain Float64 because their
topology is shared and their smaller memory cost does not justify a precision
tradeoff.

Storm and hail are zero throughout the active compact sequence and are never
inferred from precipitation. Dots and Squares map these same summaries into
renderer-owned compact presentation buffers;
neither renderer recursively aggregates radii, colors, opacity, or hazard
glyph values. L14 and L15 sample the reconstructed field directly and
independently; neither interpolates a lower discrete summary.

Only the active discrete renderer retains temporal summary/mapping buffers;
switching away releases that renderer's temporal state while retaining the
shared topology and reusable GPU capacities.
Within an active Dots or Squares renderer, temporal state is owned per LOD
level: a stable renderer retains the current level's frame 0/frame 1 summary
and mapped state, while a transition retains those states for both `fromLevel`
and `toLevel`. Starting an adjacent transition preserves the prepared source
and evaluates/maps only a missing destination level. Completion promotes the
prepared destination state without reevaluating it; reversal swaps transition
ownership and reuses both level states. When the temporal frame advances, each
active level promotes its previous next frame and prepares only its missing
future frame.

## Dots — `src/engine/geographic-dots-layer.js`

Dots map each shared physical summary after it is produced. Base rain uses
`spacing * sqrt(rainCoverage) * rainMmhToRadiusFraction(wetMeanMmh)`, where
coverage is the shared 0.05 mm/h coverage and wet mean divides the rain weighted
sum by that wet support. L13, L14, and L15 are direct point samples and use the
exact strong-rain presentation mapping from physical `rainMmh`. Coarse L10–L12
strong-blue uses shared 2.5 mm/h coverage plus the retained peak:
`spacing * sqrt(strongCoverage) *
dotsStrongRainMmhToRadiusFraction(rainMaxMmh)`. Dots strong-blue saturation is
now a fixed 35 mm/h presentation setting; the temporary tuning slider and
mutable state were removed. Coarse storm/hail glyphs use independent shared coverage,
positive mean severity, and retained maximum severity; the presentation severity
retains the peak, coverage scales glyph area, and hail wins only when its mapped
glyph is visible. Direct L13/L14/L15 hazards retain the existing
`geographicHazardRadii()` mapping.

`GeographicLodTopology` in `geographic-lod.js` owns canonical anchors and the
deterministic one-parent child ownership used only for Dots geometric morphing.
That mapping is deliberately separate from the centered multi-parent weather
contribution topology. LOD transitions therefore keep canonical child/parent
positions and no-grid-jump behavior.

The custom MapLibre layer draws instanced Mercator-space circles, storm stars,
and hail hexagons with MapLibre's `projectTile` projection path. Its 0.2 s LOD
transitions use deterministic parent/child topology below/equal to L13 and
direct-pair refinement for L13↔L14 and L14↔L15.
Dots retain the stable same-level temporal/mapped state for a source LOD while
a transition builds the required pair representation; promoting a destination
therefore only performs the unavoidable same-level instance pass. Reversals
reuse physical and mapped states and rebuild only the direction-specific pair
instance representation.
Rain glyph radii use the shared monotonic physical anchor transfer in squared
radius/visual area; the light-blue base saturates at 0.86 spacing near 10 mm/h,
while the nested Dots-only strong-blue overlay starts visually at 1.6 mm/h and
uses a fixed monotonic squared-area shape stretched from that onset to 35 mm/h.
This fixed presentation setting does not affect other renderers.

## Squares — `src/engine/geographic-squares-layer.js`

Squares use the same active globally anchored L10–L15 Mercator topology and
shared physical summaries as Dots, but map them into square color and opacity.
Each active sample instantiates a square centered on its Mercator grid point;
the cell side equals the active grid spacing. Geometry is projected by the same
MapLibre custom-layer shader path, so it follows Globe curvature, pitch,
bearing, perspective, pan, and depth. Rain color/strength uses wet-area mean
rain; its visibility is the existing rain transfer multiplied by 0.05 mm/h
coverage. Storm/hail retain coverage, positive mean severity, and maximum
severity as separate attributes; coverage controls contribution while mean/max
control strength, with hail composited after storm. LOD changes crossfade the
deterministic parent and child cell sets during the existing 0.2 s transition;
no new grid is created and no camera-dependent identity is introduced. Rain square visibility and
light-to-strong blue color use the same physical rain transfer anchors as Dots;
rain values above 3 mm/h therefore remain distinguishable through the
progressive strong-color transfer. Squares assign each active LOD to one of
two reusable instance groups. A transition builds and uploads only its new
destination group; completion promotes that group as stable, and reversal
swaps group ownership without repacking or reuploading unchanged data.
Temporal updates dirty only groups whose mapped frame data changed.

## Fixed scalar reconstruction — `src/engine/geographic-scalar-lattice.js`

Blur and Areas share one explicitly fixed `SCALAR_GRID_LEVEL = 14` lattice with
104,850 vertices (466 × 225). This scalar level is independent of the discrete
maximum display LOD, so enabling discrete L15 cannot change scalar texture
dimensions, smoothing resolution, or reconstruction topology.
Its rows,
columns, Mercator positions, and triangle indices are created once from the
globally anchored geographic topology and cached for the life of the layer.
L14 gives roughly 1.8 km local east-west grid spacing near the experiment
anchor. Panning,
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
the shared unsmoothed L14 textures, then applies the continuous physical rain
visibility transfer: a soft 0.05 mm/h onset, clearly readable light rain near
0.30 mm/h, and a progressive light-blue to strong-blue transfer from 2.5 to
50 mm/h. Magenta storm and yellow hail remain composited above it, with hail
last. The indexed triangles do not define scalar geometry, and no per-vertex
weather attribute buffer is used.

## Areas reconstruction and Smooth — `src/engine/geographic-scalar-layer.js`, `src/engine/geographic-scalar-lattice.js`

Areas uses the same shared L14 RGBA32F textures and explicit four-texel
bilinear reconstruction as Blur. With Smooth off, this raw L14 → bilinear field
is mapped through five physical rain bands at 0.10, 0.30, 1.00, 2.50, and
10.0 mm/h (`#0090FF` through `#0000FF`), storm/hail thresholds, translucent
magenta/yellow fills, hail-over-storm order, and derivative-based edge
treatment. The default Areas field therefore differs from Blur only by
transfer semantics, not by scalar reconstruction; values above 10 mm/h use
the darkest discrete rain band.

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
