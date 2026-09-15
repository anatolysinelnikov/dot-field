# Dot Field Visualization Architecture

## Purpose

Dot Field is a browser-based reference implementation of deterministic geographic weather visualization.

The repository demonstrates two related things:

1. a **visual and behavioral contract** for precipitation and weather phenomena;
2. one active implementation of that contract using MapLibre GL JS, deterministic geographic sampling, and custom WebGL layers.

The visual contract is the important part.

The exact renderer, GPU layout, sampling implementation, or synthetic data generator is not required to reproduce the same visualization semantics elsewhere.

## High-level flow

```text
weather values
    ↓
stable geographic sampling
    ↓
temporal interpolation
    ↓
LOD aggregation / transition
    ↓
phenomenon priority resolution
    ↓
glyph shape + size + color
    ↓
map presentation
```

The important separation is:

```text
data → sampling/interpolation → presentation
```

Weather phenomena remain independent data channels until the presentation stage.

## Weather data model

The prototype contains five independent weather channels:

- precipitation (`rain`);
- thunderstorm (`storm`);
- hail;
- squall;
- hurricane.

The phenomenon channels are scalar values.

They do not contain glyphs, colors, icons, or other presentation information.

`src/engine/field.js` generates deterministic synthetic values for the public prototype. Its Gaussian components, trajectories, and timing exist only to provide repeatable demonstration data.

The synthetic generator is therefore not part of the phenomenon presentation contract.

For this demonstration, geographic field preparation is the single time boundary: normalized display time `t` maps directly to internal synthetic phase `t`. Rain, Storm, Hail, and Squall all use that prepared phase. Only the Hurricane channel additionally receives the display-keyframe-0 identity so later discrete keyframes remain zero for Hurricane. The synthetic lifecycle is `smoothstep(0, 0.12, 1 - t)`: fully active at frame 0 and fading only during the final 12% of the loop (about 2.16 seconds).

A different data source can reproduce the same visualization as long as it provides equivalent normalized phenomenon values at stable geographic sample positions.

## Spatial identity

Weather samples are attached to deterministic geographic positions.

Camera movement changes their projection on screen but does not reseed or randomly relocate them.

Zoom changes the active level of detail without changing the conceptual spatial identity of the weather field.

This matters particularly for phenomenon icons: an aggregate marker represents weather data in a deterministic geographic block, not a decorative screen-space particle.

## Reference values and portable intent

Numerical thresholds and sizes below describe the current reference implementation. They are useful for reproducing and validating the prototype, but they are not universal coefficients for every rendering or sampling system.

When adapting the visualization, preserve the portable intent:

- the relative visual hierarchy between phenomena;
- the glyph identity and color semantics;
- stable aggregate hazard placement and screen-space marker sizing;
- stable spatial placement and temporal continuity;
- the fixed overlap priority.

Exact numerical coefficients may change when sample spacing, renderer scale, or the input severity model differs.

## Phenomenon presentation contract

Each sample can contain values for several phenomenon channels simultaneously.

The renderer first evaluates/interpolates the channel values, aggregates the active grid into geographic blocks, and then resolves each block into a single visible icon.

### Active Areas visual legend

| Phenomenon | Areas presentation | Color/artwork | Current reference size behavior |
| --- | --- | --- | --- |
| Rain | reconstructed scalar field | blue precipitation bands | field-dependent |
| Thunderstorm | aggregate procedural four-point star | magenta `#FF00FF` | smoothly interpolated `18–26 CSS px` severity range, with `22 CSS px` midpoint |
| Hail | aggregate procedural filled hexagon | yellow `#FFD400` | smoothly interpolated `20–28 CSS px` severity range, with `24 CSS px` midpoint |
| Squall | aggregate `squall-dark.svg` icon | supplied dark artwork | fixed `30 CSS px` |
| Hurricane | aggregate `tornado-dark.svg` icon | supplied dark artwork | fixed `30 CSS px` |

The Areas rendering paths are defined in `src/engine/geographic-scalar-layer.js` and `src/engine/geographic-areas-hazard-icons-layer.js`.

## Winner priority

Only one hazard icon is displayed at an aggregate block anchor.

When multiple channels are active, the fixed priority is:

```text
hurricane
    ↓
squall
    ↓
hail
    ↓
thunderstorm
```

In code:

```text
hurricane > squall > hail > storm
```

This is the Areas marker priority, not data destruction.

The underlying scalar channels remain independent even when one glyph visually wins.

This distinction is important because the winner may change continuously as the weather values evolve over time.

## Threshold and strength mapping

The current normalized presentation thresholds are defined in `src/engine/precipitation-mapping.js`:

```text
storm      0.075
hail       0.11
squall     0.08
hurricane  0.18
```

Visibility is intentionally eased rather than switched on abruptly.

For a phenomenon value `v` and nominal threshold `t`, the current strength mapping is conceptually:

```text
strength = smoothstep(t × 0.45, 0.93, v)
```

This means the nominal threshold is part of a smooth presentation mapping, not a hard binary cutoff.

These values operate on the prototype's normalized scalar channels. They are presentation-space values, not physical meteorological thresholds.

## Squall

In Areas, Squall is represented by the supplied `assets/squall-dark.svg` artwork at a deterministic aggregate block anchor. Existing Squall thresholds are used only to decide whether the binary, fully opaque icon is visible; severity does not change its screen size or opacity.

## Thunderstorm

In Areas, Thunderstorm is represented by a procedural magenta four-point star at a deterministic aggregate block anchor. Its screen-space size interpolates smoothly across `18`, `22`, and `26 CSS px` severity anchors using the existing normalized presentation strength.

## Hail

In Areas, Hail is represented by a procedural filled yellow hexagon at a deterministic aggregate block anchor. Its screen-space size interpolates smoothly across `20`, `24`, and `28 CSS px` severity anchors using the existing normalized presentation strength.

## Hurricane

In Areas, Hurricane is represented by the supplied `assets/tornado-dark.svg` artwork at a deterministic aggregate block anchor. Existing Hurricane thresholds are used only to decide whether the binary, fully opaque icon is visible; intensity does not change its screen size or opacity.

Hurricane is the highest-priority phenomenon.

If hurricane is active in an aggregate block, no lower-priority hazard icon is drawn in that block.

## Temporal behavior

Temporal interpolation operates on the underlying weather values before the visible phenomenon winner is selected.

Conceptually:

```text
state A phenomenon values
            ↓
        interpolate
            ↓
state B phenomenon values
            ↓
  interpolated channel values
            ↓
      resolve winner
            ↓
      render icon
```

This is intentionally different from crossfading already-rendered symbols.

For example, when interpolated Storm, Hail, Squall, and Hurricane values compete inside an aggregate block, the scalar channels interpolate first and the winner is evaluated from the intermediate maximum values.

The system does not simply fade one already-rendered icon out while fading another in.

This keeps the presentation tied to the weather data throughout the animation.

## Spatial and LOD transitions

The Areas hazard overlay uses a deterministic geographic symbol pyramid.

Hazard reference evaluation is performed at L14, then reduced through the nested hierarchy:

```text
L14
 ↓
L13
 ↓
L12
 ↓
L11
 ↓
L10
 ↓
L9
 ↓
L8
 ↓
L7
```

L14 is the only level evaluated directly for the Areas hazard hierarchy. Each lower level is produced from its child level with independent per-channel maximum reduction through L7, covering the map's desktop and compact/mobile minimum zooms. Areas rain-area reduction remains separate from this hazard hierarchy.

Coarse hazard values are not produced by selecting one child glyph.

Each phenomenon channel is aggregated independently with the maximum child value. This preserves localized hazard channels instead of diluting them with surrounding zero-valued children.

The presentation priority is applied only after these channel values have been produced. Storm and Hail marker sizes are then smoothly mapped through their `20`, `24`, and `28 CSS px` severity anchors; LOD does not alter those screen-space sizes.

There is no post-resolution neighbor propagation or suppression pass. At each LOD, priority is resolved only within the aggregate block itself. Because the block hierarchy is nested, a higher-priority channel consumes a lower-priority channel only when their values merge into the same coarser parent block.

### LOD marker replacement

During an LOD transition, only the outgoing aggregate marker set is rendered. Its icons remain fully opaque and fixed-size until the transition commits, then the incoming set replaces it discretely at the same screen-space size.

Marker sets are not opacity-crossfaded, scaled, or moved toward one another. Reversing a transition keeps the currently displayed set until the reversed replacement commits.

## Areas

Areas is the sole active precipitation representation. It uses a reconstructed scalar precipitation surface rather than visible precipitation dots.

Areas renders a separate sparse icon overlay for the `storm`, `hail`, `squall`, and `hurricane` channels:

```text
Areas precipitation reconstruction
+
aggregate Areas hazard icons
```

The overlay uses procedural Storm/Hail images plus the dark SVG assets in `assets/squall-dark.svg` and `assets/tornado-dark.svg`. The internal `hurricane` channel remains unchanged; `tornado-dark.svg` is only its Areas presentation.

### Areas aggregate marker contract

- The active sampling grid is grouped into deterministic `4 × 4` sample blocks.
- Each block uses the average geographic anchor of its underlying samples. Anchor identity is fixed for that LOD and does not depend on weather values.
- Storm, Hail, Squall, and Hurricane values are aggregated independently with the maximum value in the block.
- Presentation is resolved after aggregation with `hurricane > squall > hail > storm`, so at most one icon is shown per block.
- Priority is resolved only within each aggregate block; coarser nested blocks naturally consume lower-priority channels when independent channel values merge into the same parent block. There is no neighbor propagation or suppression.
- Existing presentation strength mappings and thresholds are reused.
- Icons are MapLibre screen-space symbols: procedural Storm markers use a smoothly interpolated `18–26 CSS px` severity range, Hail markers use `20–28 CSS px`, and SVG Squall/Tornado markers remain fixed at `30 CSS px`. They remain screen-upright and use overlap settings that prevent label/icon collision from randomly suppressing them. SVGs and procedural shapes are rasterized at the device pixel ratio before registration.
- Increasing geographic LOD creates more, geographically smaller aggregate blocks. It does not change icon size.

During an LOD transition, the outgoing aggregate marker set remains fully opaque until the transition commits. It is then replaced by the incoming set at the same fixed icon size; marker sets are not crossfaded, scaled, or moved toward one another. Reversing a transition keeps the currently displayed set until the replacement commits.

The scalar Areas field and hazard overlay use one captured normalized weather time for the duration of an active LOD transition, keeping a spatial transition from changing the displayed phenomenon classification. Explicit timeline scrubbing can update that shared snapshot; normal playback resumes from the current timeline time after the transition commits.

Temporal interpolation is applied to the underlying channel values before each block's maximum and winner selection are evaluated. Weather changes can alter icon visibility or the winning marker type, but never move the aggregate anchor. The final display interval uses frame 179 → an explicit terminal state evaluated at `t = 1`, rather than frame 179 → frame 0. Only automatic playback uses the periodic wrap to begin a new frame-0 cycle.

Areas uses the aggregate Storm, Hail, Squall, and Tornado icon overlay for hazard presentation in this prototype. The internal Hurricane channel is presented as Tornado artwork.

The synthetic demonstration keeps the severe channels as one compact, independently shaped cluster embedded near one edge of the broader Storm field. This spatial arrangement is demonstration data only; presentation still resolves each aggregate block with the normal hazard priority.

## Reference implementation

The most relevant implementation files are:

### `src/engine/precipitation-mapping.js`

Defines normalized presentation thresholds and common strength mappings.

Also defines the three squall grade thresholds.

### `src/engine/geographic-scalar-layer.js`

Contains the reconstructed scalar precipitation Areas renderer and its temporal texture preparation.

### `src/engine/geographic-areas-hazard-icons-layer.js`

Contains the deterministic aggregate Storm/Hail/Squall/Tornado icon overlay, procedural/SVG image registration, winner selection, and discrete LOD marker replacement.

### `src/engine/geographic-symbol-pyramid.js`

Defines the spatial and LOD behavior of weather samples and phenomenon values:

- deterministic sample hierarchy;
- direct/reference evaluation;
- independent channel aggregation;
- max-preserving coarse hazard summaries and rain-area reduction.

### `src/engine/field.js`

Provides deterministic synthetic demonstration data.

Its weather generation model is not required to reproduce the visualization contract.

## Reference implementation vs. required behavior

The repository should be read primarily as a reference for observable visualization semantics.

The following are core behaviors:

- independent phenomenon channels;
- deterministic geographic placement;
- continuous temporal evolution;
- data interpolation before winner selection;
- one visible phenomenon marker per aggregate block;
- fixed phenomenon priority;
- stable glyph identities;
- defined shape and color for each phenomenon;
- Areas markers for Thunderstorm, Hail, Squall, and Hurricane/Tornado;
- Areas is the sole active precipitation representation;
- Areas uses sparse deterministic aggregate hazard icons;
- Areas marker density changes with LOD while fixed screen-space marker size does not;
- aggregate anchors remain spatially stable;
- Areas marker priority is `hurricane > squall > hail > storm`;
- icon artwork is kept at the presentation boundary and does not enter the weather data model.

The following are implementation choices rather than universal requirements:

- synthetic Gaussian weather generation;
- MapLibre GL JS;
- the current WebGL buffer layout;
- shader organization;
- the exact numerical size coefficients;
- the exact LOD data structures;
- the current renderer class boundaries.

A different implementation can preserve the same visual contract without copying those internal mechanisms literally.
