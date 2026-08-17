# Dot Field Architecture

## Document status

- Repository: `anatolysinelnikov/dot-field`
- Analyzed branch: `experiment/areas-performance`
- Analyzed commit: `a1c0ebaa7c0e88651b90cc2dc4742ba742340b1b` (feature branch after merging `origin/main`)
- Snapshot date: 2026-08-17

This file is maintained architectural context, not implementation authority. For implementation-dependent work, inspect the current requested branch and relevant files first. If code and this document disagree, the code wins and this file should be updated.

## How to use this document

Use this file to answer four questions quickly:

1. What are the system invariants that changes must preserve?
2. Which module owns a behavior?
3. Which data/rendering path is used by each representation?
4. Which files should be inspected first for a given change?

`AGENTS.md` contains repository-wide working instructions for coding agents. This file describes the current architecture.

## Project model

Dot Field is a browser-native experimental weather visualization system built around a deterministic multi-channel scalar field and fixed-grid sampling/reconstruction.

The current weather channels are:

- rain;
- thunderstorm (`storm` in code);
- hail.

The current representations are:

- **Dots** — adaptive fixed-grid halftone-like circles;
- **Squares** — adaptive fixed-grid full-cell color;
- **Blur** — continuous reconstructed scalar field rendered to a raster;
- **Areas** — crisp discrete world-space contours, with optional deterministic generalization via `Smooth`.

All representations derive from the same synthetic weather field. They do not own independent weather simulations.

## Core spatial invariants

- The spatial lattice is deterministic and anchored in world coordinates.
- Sample identity must not change because of camera zoom.
- Animation changes field values over time while the sampling lattice remains spatially stable.
- No random placement, jitter, or random particle motion is used.
- Adaptive LOD changes sampling resolution, not the underlying coordinate identity model.
- Dots and Squares use explicit parent/child LOD relationships during transitions.
- Areas contour geometry is generated in world space rather than viewport-raster space.
- Blur reconstructs from the scalar field; it is not a post-process over another representation.
- Hazard channels are weather data, not decorative overlays detached from field semantics.

## Repository structure

```text
dot-field/
├── AGENTS.md                 # agent working instructions (after this documentation change)
├── ARCHITECTURE.md           # this architecture snapshot
├── index.html
├── styles.css
└── src/
    ├── app.js
    └── engine/
        ├── areas-renderer.js
        ├── blur-renderer.js
        ├── config.js
        ├── dots-renderer.js
        ├── field.js
        ├── hazard-renderer.js
        ├── lod.js
        ├── math.js
        ├── precipitation-mapping.js
        ├── scalar-reconstruction.js
        └── squares-renderer.js
```

The application is plain browser ES modules. There is no package manifest, framework, bundler configuration, or automated test/build pipeline in the analyzed tree.

## Architecture at a glance

```text
index.html + styles.css
        |
        v
     app.js
        |
        +----------------+----------------+----------------+
        |                |                |                |
      Dots            Squares           Areas            Blur
        |                |                |                |
        |                |        scalar reconstruction   |
        |                |           + contours           |
        |                |                |                |
   lod/sampleField   lod/sampleField      |       scalar reconstruction
        |                |                |                |
        +---------> field.js <-------------+----------------+

Shared support:
- precipitation-mapping.js: Dots + Squares precipitation transfer
- hazard-renderer.js: Dots fixed-grid hazard symbols
- scalar-reconstruction.js: Areas + Blur reconstructed scalar grids
- math.js/config.js: low-level shared helpers/constants
```

Preferred dependency direction is:

`app/UI -> renderers -> sampling/reconstruction/field -> math/config`

There are no cyclic ES-module dependencies in the analyzed implementation.

## Coordinate and camera model

`src/app.js` owns the camera and viewport transformation.

Each frame:

- `fieldPixels = min(width, height) * 0.92`;
- the field center is horizontally centered and slightly shifted upward;
- visible world bounds are derived from screen size, field scale, center, and zoom;
- world coordinate `(0.5, 0.5)` is the visual field center;
- world-to-screen scale is `fieldPixels * zoom`.

The synthetic weather system travels through world space using `travelX`. `travelX` is derived from bounds computed at `zoom = 1`, so changing the camera zoom does not alter the trajectory of the weather system.

Canvas backing size is DPR-scaled while application/rendering coordinates remain CSS-pixel based through `ctx.setTransform(dpr, 0, 0, dpr, 0, 0)`.

## Application orchestration — `src/app.js`

`app.js` owns:

- DOM references;
- main and offscreen Canvas creation;
- mutable application state;
- resize/DPR handling;
- camera/world bounds;
- animation timing;
- playback and timeline interaction;
- zoom input;
- render-mode routing;
- LOD selection/transition state;
- Areas `Smooth` UI state.

Current state includes:

```text
playing, time, zoom, width, height, dpr,
lastFrame, scrubbing, renderMode,
lodLevel, desiredLOD, lodMorph,
areaSmooth
```

Render routing is:

- `dots` -> `renderLOD()` or `renderLODMorph()`;
- `squares` -> `renderSquares()` or `renderSquaresMorph()`;
- `blur` -> `renderBlurredFields()`;
- `areas` -> `renderAreas(..., state.areaSmooth)`.

LOD selection is still updated every frame even when the active representation does not consume adaptive LOD directly.

Timeline pointer interaction pauses active playback on `pointerdown`, then scrubs time directly from pointer position.

## Synthetic field — `src/engine/field.js`

`field.js` is the current weather data source.

Public API:

```js
intensityAt(x, y, t, travelX) -> { rain, storm, hail }
```

The field is composed from deterministic evolving Gaussian components plus deterministic sinusoidal fine structure. A lifecycle envelope makes the animation loop enter/exit smoothly. The field performs an early empty-support rejection outside a bounded region around the traveling system.

Important architectural property: `field.js` knows nothing about Canvas, UI, render modes, LOD transitions, marker shapes, or future external weather providers.

A future real-data integration should preserve a separation such as:

`provider format -> normalization -> temporal/spatial interpolation -> sampling/reconstruction -> rendering`

rather than coupling provider-specific data directly into renderers.

## Adaptive fixed-grid sampling and LOD — `src/engine/lod.js`

`lod.js` owns shared adaptive sampling semantics for Dots and Squares.

### LOD selection

`selectLOD(zoom, fieldPixels)` compares projected base-grid spacing against `TARGET_SPACING` and returns a continuous LOD value clamped to `0..5`. `app.js` rounds it to the desired discrete level and owns temporal morph state.

At LOD `n`, the world-grid step is:

```text
2^n / BASE_GRID
```

Grid sample centers remain world anchored at:

```text
(i + 0.5) * step
(j + 0.5) * step
```

### Coarse sampling

At LOD 0, `sampleField()` calls `intensityAt()` directly.

At coarser LODs it samples a deterministic 3x3 neighborhood within the coarse cell:

- rain is averaged;
- storm uses an average/max blend biased toward the maximum;
- hail uses a stronger average/max blend biased toward the maximum.

This preserves more localized hazard presence while reducing rain detail.

### Hazard interpretation

`intensityToStrength()` maps channel intensity through smooth visibility thresholds.

`resolveHazardState()` gives hail priority over thunderstorm when both are present.

`resolveLODGroupHazardState()` inspects four child cells of a coarse cell so hazard presence is preserved through LOD aggregation.

## LOD transitions

LOD transition state lives in `app.js` as:

```text
{ coarse, fine, progress, direction }
```

`LOD_MORPH_SECONDS` controls transition duration.

Dots and Squares share the same parent/child lattice relationship but visualize the transition differently:

- **Dots:** marker positions and radii morph from parent to children;
- **Squares:** fine child cells stay at child positions while their colors interpolate from parent state to child state.

The parent of fine cell `(i, j)` is derived from `floor(i / 2), floor(j / 2)`, preserving deterministic nesting.

## Shared precipitation mapping — `src/engine/precipitation-mapping.js`

This module is used by Dots and Squares.

It owns:

- `intensityToRadius()` — visibility threshold + nonlinear radius mapping for rain/storm/hail;
- `strongPrecipitationIntensity()` — normalized rain intensity above `RAIN_MODERATE_MAX`.

Rain intentionally receives the largest overlap factor so stronger precipitation can visually merge.

This module has no Canvas or DOM responsibility.

## Shared fixed-grid hazard renderer — `src/engine/hazard-renderer.js`

This module is currently used by Dots only.

It owns Canvas symbol appearance for fixed-grid hazards:

- thunderstorm: magenta 8-point star-like path;
- hail: yellow hexagon;
- radius mapping from hazard strength;
- normal hazard drawing;
- position/radius morph drawing during Dots LOD transitions.

Hazard classification itself remains in `lod.js`.

Important current fact: Areas no longer uses `hazard-renderer.js`; storm and hail are rendered as reconstructed contour regions in Areas.

## Shared scalar reconstruction — `src/engine/scalar-reconstruction.js`

This module is shared by Areas and Blur.

Its main responsibilities are:

1. sample `intensityAt()` on the deterministic `BASE_GRID` lattice;
2. apply separable Gaussian smoothing to requested weather channels;
3. provide reusable fast separable box-blur helpers;
4. provide reusable reconstruction buffers keyed by grid dimensions and channels;
5. provide cubic B-spline reconstruction for both raster and world-space sampling.

### Base reconstructed grid

`buildSmoothedWeatherGrid()`:

- uses `step = 1 / BASE_GRID`;
- intersects requested bounds with the known compact support of the synthetic field;
- adds padding for smoothing/interpolation (plus optional extra padding);
- samples rain/storm/hail on fixed world-grid centers;
- Gaussian-smooths each requested scalar channel.

### B-spline reconstruction

Three forms exist:

- screen/raster-oriented precomputed-axis sampling for Blur;
- direct world-space sampling (`interpolateSplineScalarAt` / `interpolateSplineScalarsAt`) for general consumers;
- separable regular-lattice sampling (`interpolateSplineScalarsOnLattice`) for Areas contours. It computes and reuses horizontal four-tap values before applying vertical four-tap combinations, preserving the same cubic B-spline arithmetic while avoiding repeated coordinate/index/weight work.

Weather-grid buffers are reused when width, height, and requested channels are unchanged. Areas contour-lattice horizontal and output buffers are likewise reused when source count and lattice dimensions are unchanged. These caches are implementation-level storage reuse; they do not change grid anchoring, reconstruction values, or world-space coordinates.

This separation is important: Areas geometry is not tied to a viewport raster, while Blur intentionally samples a screen raster.

## Dots representation — `src/engine/dots-renderer.js`

**Responsibility:** adaptive fixed-grid circular precipitation marks plus fixed-grid hazard symbols.

Pipeline:

```text
world-anchored LOD lattice
-> sampleField()
-> precipitation-mapping radius transfer
-> rain circles
-> strong-rain circles
-> hazard state
-> hazard-renderer symbols
-> Canvas
```

Render order is rain -> strong precipitation -> hazard.

Dots construct the visible lattice from current world bounds plus `GRID_OVERSCAN_CELLS`. The lattice itself is conceptually unbounded; the browser clips drawing to the Canvas.

During LOD transitions, each fine child sample has a deterministic parent location/value. Position and radius interpolate between parent and child states.

## Squares representation — `src/engine/squares-renderer.js`

**Responsibility:** adaptive fixed-grid full-cell color representation using the same sampling/LOD identity as Dots.

Squares reuse:

- `sampleField()`;
- `resolveHazardState()` / `resolveLODGroupHazardState()`;
- precipitation radius/strength semantics from `precipitation-mapping.js`.

Instead of drawing symbols, rain/storm/hail are composited into each cell color. Hail has priority in hazard state; sampled storm may still contribute as a lower color layer under hail.

A small `+0.5px` right/bottom overdraw prevents raster hairline seams between adjacent cells.

During LOD morph, fine cells remain on the fine lattice and their color interpolates from deterministic parent color to child color.

## Areas representation — `src/engine/areas-renderer.js`

**Responsibility:** crisp discrete world-space contour regions for rain, storm, and hail.

Areas does not use adaptive Dots/Squares LOD and does not use fixed-grid hazard marker rendering.

### Default detailed Areas

`areaSmooth` defaults to `false` in `app.js`.

Default pipeline:

```text
field.intensityAt()
-> BASE_GRID sampling
-> shared Gaussian smoothing
-> cubic B-spline world reconstruction
-> Marching Squares contour extraction
-> nested rain fills + storm/hail contours
```

For a changed weather state, the reconstructed contour paths are cached as world-space geometry using `(t, travelX, smooth)` as the cache identity. Repeated paused renders and camera zoom changes reuse those paths; zoom only changes the Canvas transform and is intentionally not a geometry-cache key. A new contour build occurs when the weather time, weather travel position, or Smooth state changes.

Rain uses the configured precipitation band thresholds directly. Storm and hail use presence thresholds aligned with the lower visibility edges used by shared hazard semantics.

### Smooth Areas

The `Smooth` checkbox is visible only in Areas mode. When enabled:

1. the reconstructed rain/storm/hail grids receive three extra separable box-blur passes with radius 6;
2. extra grid padding is requested so the filter has sufficient support;
3. thresholds are remapped by coverage quantiles so generalized geometry approximately preserves the visual covered area of the pre-generalized fields;
4. the generalized fields are then reconstructed and contoured through the same world-space contour pipeline.

The coverage remapping is currently a visual semantic mechanism, not a physical meteorological calibration. If Areas thresholds later acquire physical meaning, this behavior must be reconsidered.

### Contour extraction

Contours are extracted on a world-space lattice at:

```text
grid.step / AREA_CONTOUR_SUBDIVISIONS
```

with `AREA_CONTOUR_SUBDIVISIONS = 3`.

Marching Squares segments are stored in flat numeric segment arrays and connected into closed `Path2D` loops. Each cell first computes its scalar corner minimum and maximum; sorted thresholds outside that range are rejected before case processing. For non-empty cases, only the edge intersections required by that case are interpolated. These are equivalent hot-loop optimizations: threshold comparisons retain the existing `>= threshold` semantics, and saddle cases are still resolved using the scalar value at the cell center.

Contour support is based on the complete synthetic weather support plus overscan rather than only the visible viewport. This prevents geometry from changing merely because the camera clips into the middle of an active system.

### Areas layering

Rain bands are filled as nested discrete blue regions. Storm is a magenta contour region above rain; hail is a yellow contour region above storm. Storm and hail also receive thin world-scaled outlines.

## Blur representation — `src/engine/blur-renderer.js`

**Responsibility:** continuous reconstructed scalar-field visualization.

Pipeline:

```text
field.intensityAt()
-> BASE_GRID sampling
-> shared Gaussian smoothing
-> cubic B-spline raster reconstruction
-> visibility/color transfer
-> rain -> storm -> hail alpha compositing
-> low-resolution offscreen Canvas
-> smoothed upscale to main Canvas
```

Blur raster dimensions are approximately `viewport * BLUR_RASTER_SCALE`, currently `0.42`.

Rain color moves from `#0090FF` toward `#0000FF` for strong rain.

Storm is composited as pure magenta and hail as pure yellow, with hail last. Visibility ramps alter display opacity after reconstruction; they do not modify the reconstructed scalar field itself.

Blur's hazard visibility uses piecewise smooth ramps aligned with visibility/strong anchors derived from shared storm/hail thresholds.

## UI structure — `index.html` and `styles.css`

The UI is intentionally thin and lives outside the engine modules.

`index.html` contains:

- main Canvas;
- Rain / Thunderstorm / Hail legend;
- render-mode radiogroup;
- Areas-only `Smooth` checkbox;
- zoom and LOD readout;
- zoom controls;
- play/pause + timeline controls.

Mode order is:

`Dots -> Squares -> Blur -> Areas`

`styles.css` owns all presentation/responsive behavior.

The render-mode selector uses a responsive width capped at `408px`. A shared CSS calculation makes `.area-smooth-content` match the actual width of one render-mode grid segment.

Responsive behavior includes:

- at `max-width: 900px`, the Areas Smooth control moves above and right-aligns with the selector;
- at `max-width: 680px`, desktop +/- zoom buttons are hidden and the reset button moves to the upper-right area.

## Module ownership summary

### UI / application

- `index.html` — semantic DOM structure and controls.
- `styles.css` — visual and responsive presentation.
- `src/app.js` — mutable state, camera, animation, input, Canvas setup, mode routing, LOD transition ownership.

### Data / math

- `src/engine/field.js` — deterministic synthetic multi-channel weather field.
- `src/engine/math.js` — pure `clamp`, `mix`, `smoothstep` helpers.
- `src/engine/config.js` — shared architecture/render constants.

### Sampling / mapping

- `src/engine/lod.js` — adaptive LOD selection, coarse sampling, hazard state interpretation.
- `src/engine/precipitation-mapping.js` — Dots/Squares precipitation transfer functions.

### Reconstruction

- `src/engine/scalar-reconstruction.js` — fixed-base-grid scalar sampling, Gaussian smoothing, box blur support, cubic B-spline reconstruction.

### Renderers

- `src/engine/dots-renderer.js` — fixed-grid circles + Dots LOD morph + shared hazard symbols.
- `src/engine/squares-renderer.js` — fixed-grid full-cell color + color LOD morph.
- `src/engine/areas-renderer.js` — world-space rain/storm/hail contour regions + optional deterministic generalization.
- `src/engine/blur-renderer.js` — continuous reconstructed raster compositing.
- `src/engine/hazard-renderer.js` — fixed-grid Dots hazard symbol appearance/drawing.

## Current ES-module dependency graph

```text
app.js
├── config.js
├── math.js
├── lod.js
│   ├── config.js
│   ├── field.js -> math.js
│   └── math.js
├── dots-renderer.js
│   ├── config.js
│   ├── math.js
│   ├── lod.js
│   ├── precipitation-mapping.js -> config.js, lod.js, math.js
│   └── hazard-renderer.js -> math.js, lod.js
├── squares-renderer.js
│   ├── config.js
│   ├── math.js
│   ├── lod.js
│   └── precipitation-mapping.js
├── areas-renderer.js
│   ├── config.js
│   ├── math.js
│   └── scalar-reconstruction.js -> config.js, math.js, field.js
└── blur-renderer.js
    ├── config.js
    ├── math.js
    └── scalar-reconstruction.js
```

## Important shared constants

From `src/engine/config.js` at the analyzed commit:

```text
BASE_GRID = 128
LOOP_SECONDS = 18
MIN_ZOOM = 0.1
MAX_ZOOM = 5.5
TARGET_SPACING = 11.5
LOD_MORPH_SECONDS = 0.2
GRID_OVERSCAN_CELLS = 4
RAIN_MODERATE_MAX = 0.55
RAIN_BLUE = #0090FF
STRONG_PRECIPITATION_BLUE = #0000FF
BLUR_RASTER_SCALE = 0.42
AREA_RAIN_CONTOUR_THRESHOLD = 0.027
AREA_CONTOUR_SUBDIVISIONS = 3
SCALAR_SMOOTH_RADIUS = 4
SCALAR_SMOOTH_SIGMA = 1.2
```

Rain Areas bands are currently:

```text
0.027 -> #0090FF
0.12  -> #0078FF
0.25  -> #005EFF
0.40  -> #003CFF
0.55  -> #0000FF
```

Areas Smooth local generalization currently uses radius `6`, passes `3`, and a `1024`-bin coverage histogram.

`WEATHER_MARGIN_WORLD = 0.72` is exported by `config.js` but is not consumed by the current repository code at this snapshot.

## Critical contracts and regression risks

### Fixed-grid identity

Changing the formula for grid centers, anchoring grid indices to the viewport, or adding camera-dependent offsets will break spatial identity.

### LOD hierarchy

Dots/Squares parent-child mapping depends on powers-of-two grid nesting and `floor(index / 2)`. Changes to sampling origins or step definitions must preserve this relationship.

### Hazard priority

Hail has priority over storm in shared fixed-grid hazard state. Representation-specific compositing should not accidentally invert the intended layer priority.

### Areas world stability

Areas contours must remain world-space stable. Avoid deriving contour geometry from screen raster resolution, DPR, or zoom.

### Areas Smooth semantics

Smooth is deterministic generalization of the same reconstructed fields. Do not implement it with random/noise boundary deformation. Coverage remapping currently preserves visual support rather than physical threshold meaning.

### Blur semantics

Blur visibility transfer is a display mapping after reconstruction. Do not bake those opacity curves back into the shared scalar field unless intentionally changing data semantics.

### DPR and camera

Main rendering logic assumes CSS-pixel coordinates under a DPR transform. Mixing backing-pixel dimensions into world/screen math can produce scale and positioning errors.

## Change guide: where to look first

| Change | Inspect first |
|---|---|
| Dot radius, overlap, rain/strong-rain transition | `precipitation-mapping.js`, `dots-renderer.js` |
| Dot hazard symbols or their LOD motion | `hazard-renderer.js`, `lod.js`, `dots-renderer.js` |
| Squares colors / rain-hazard layering | `squares-renderer.js`, `precipitation-mapping.js`, `lod.js` |
| LOD thresholds, density, aggregation | `lod.js`, `config.js`, `app.js` |
| LOD transition behavior | `app.js`, `dots-renderer.js`, `squares-renderer.js` |
| Synthetic weather geometry/time behavior | `field.js` |
| Shared Areas/Blur reconstruction | `scalar-reconstruction.js` |
| Areas detailed contour geometry | `areas-renderer.js`, `scalar-reconstruction.js`, `config.js` |
| Areas Smooth generalization/coverage | `areas-renderer.js`, `scalar-reconstruction.js` |
| Areas storm/hail regions | `areas-renderer.js`, `scalar-reconstruction.js` |
| Blur footprint/visibility/compositing | `blur-renderer.js`, `scalar-reconstruction.js` |
| Camera/zoom/DPR | `app.js` |
| Mode selector / Smooth UI | `index.html`, `styles.css`, `app.js` |
| Timeline/playback interaction | `app.js`, `index.html`, `styles.css` |

## Verification checklist

For meaningful changes, use the applicable subset of this checklist:

- initial render works without console errors;
- Dots render and preserve fixed-grid stability;
- Squares render and preserve fixed-grid stability;
- Blur renders as a continuous field;
- Areas detailed mode renders stable rain/storm/hail contours;
- Areas Smooth mode generalizes without viewport/zoom-dependent geometry;
- play/pause works;
- touching/clicking the timeline pauses active playback and scrubs correctly;
- zoom works by controls, wheel, and pinch where applicable;
- Dots/Squares LOD transitions do not pop or jump grids;
- hail priority remains correct;
- resize and DPR changes preserve positioning/scaling;
- mobile/responsive controls do not overlap.

There is currently no repository automated test suite, package build, or CI verification defined in the analyzed tree, so manual smoke testing is an important part of rendering changes.

## Documentation maintenance

Update this document when changes materially affect:

- module boundaries or dependencies;
- coordinate/grid/LOD contracts;
- sampling or reconstruction;
- Areas contour/generalization behavior;
- representation semantics;
- application/render orchestration;
- important shared constants or verification assumptions.

Do not update the analyzed commit field pre-emptively for unmerged work. When documentation is refreshed from a newer `main`, set it to the commit actually inspected.
