# Dot Field Visualization Architecture

## Purpose

Dot Field is a browser-based reference implementation of deterministic geographic weather visualization.

The repository demonstrates two related things:

1. a **visual and behavioral contract** for precipitation and weather phenomena;
2. one concrete implementation of that contract using MapLibre GL JS, deterministic geographic sampling, and custom WebGL layers.

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

A different data source can reproduce the same visualization as long as it provides equivalent normalized phenomenon values at stable geographic sample positions.

## Spatial identity

Weather samples are attached to deterministic geographic positions.

Camera movement changes their projection on screen but does not reseed or randomly relocate them.

Zoom changes the active level of detail without changing the conceptual spatial identity of the weather field.

This matters particularly for phenomenon glyphs: a storm, hail, squall, or hurricane symbol represents weather data at a geographic sample, not a decorative screen-space particle.

## Reference values and portable intent

Numerical thresholds and sizes below describe the current reference implementation. They are useful for reproducing and validating the prototype, but they are not universal coefficients for every rendering or sampling system.

When adapting the visualization, preserve the portable intent:

- the relative visual hierarchy between phenomena;
- the glyph identity and color semantics;
- the three-grade squall progression;
- the strong, cell-scale hurricane presence that does not keep growing with intensity;
- stable spatial placement and temporal continuity;
- the fixed overlap priority.

Exact numerical coefficients may change when sample spacing, renderer scale, or the input severity model differs.

## Phenomenon presentation contract

Each sample can contain values for several phenomenon channels simultaneously.

The renderer first evaluates/interpolates the channel values and then resolves them into a single visible glyph.

### Visual legend

| Phenomenon | Glyph | Color | Current reference size behavior |
| --- | --- | --- | --- |
| Thunderstorm | four-point star | magenta `#FF00FF` | severity-dependent |
| Hail | filled triangle | yellow `#FFD400` | severity-dependent |
| Squall | filled diamond | orange `#FF8500` | three severity grades |
| Hurricane | filled square | red `#DB0414` | fixed relative to sample spacing |

The corresponding reference geometry and colors are defined in `src/engine/geographic-dots-layer.js`.

## Winner priority

Only one phenomenon glyph is displayed at a sample position.

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

This is presentation priority, not data destruction.

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

## Thunderstorm

Thunderstorm is represented by a magenta four-point star.

The star geometry is generated from eight alternating outer/inner vertices, producing four primary points.

The current reference inner radius ratio is:

```text
0.38
```

Thunderstorm radius is relative to active sample spacing.

Current reference range:

```text
0.30 × spacing → 0.50 × spacing
```

The portable intent is a clearly visible but lower-priority symbol whose size communicates severity without dominating hail, squall, or hurricane.

## Hail

Hail is represented by a yellow filled triangle.

Its current reference radius range is:

```text
0.30 × spacing → 0.60 × spacing
```

Hail size changes continuously with normalized hail strength.

The triangle is intentionally less visually massive than the previous larger polygonal form so it does not compete with higher-priority phenomena.

The portable intent is a compact, clearly distinct yellow symbol with continuous severity sizing.

## Squall

Squall is represented by an orange filled diamond.

The diamond is the same geometric family across all squall severities. Severity changes its size rather than changing the phenomenon type.

### Squall grades

The current reference presentation has three grades:

```text
grade 1: 0.08 → 0.38
grade 2: 0.38 → 0.72
grade 3: 0.72 → 1.00
```

The corresponding thresholds are:

```text
[0.08, 0.38, 0.72]
```

The renderer determines the grade from the interpolated squall value.

Within each grade, size continues to evolve smoothly rather than jumping between three fixed sizes.

The grade-local progression uses nonlinear easing before being mapped into the overall squall size range.

Current reference squall radius range:

```text
0.40 × spacing → 0.50 × spacing
```

The portable intent is more important than the exact coefficients: squall remains one orange diamond symbol with three readable severity grades, significant visual weight, and smooth progression between sizes.

## Hurricane

Hurricane is represented by a red filled square.

Unlike the other phenomenon symbols, hurricane size does not continuously encode intensity.

In the current reference implementation, its radius is:

```text
0.50 × sampleSpacing
```

Therefore the full square side is:

```text
1.00 × sampleSpacing
```

These numbers describe the current grid-relative implementation. The portable intent is a strong, cell-scale red square whose size remains effectively fixed for the active sampling scale rather than continuing to grow with scalar intensity.

Hurricane is the highest-priority phenomenon.

If hurricane is active at a sample, lower-priority squall, hail, and thunderstorm glyphs are not drawn at that sample.

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
      render glyph
```

This is intentionally different from crossfading already-rendered symbols.

For example, when a sample evolves from hail-dominant values toward squall-dominant values, the scalar channels interpolate first and the winner is evaluated from the intermediate values.

The system does not simply fade a yellow triangle out while fading an orange diamond in.

This keeps the presentation tied to the weather data throughout the animation.

## Spatial and LOD transitions

The Dots representation uses a deterministic geographic symbol pyramid.

Reference evaluation is performed at L13 for the coarser hierarchy:

```text
L13
 ↓
L12
 ↓
L11
 ↓
L10
```

L14 is evaluated directly.

Coarse hazard values are not produced by selecting one child glyph.

Each phenomenon channel is aggregated independently.

The current coarse-level mapping combines the child average and maximum:

```text
coarse = average × (1 - bias) + maximum × bias
```

Current reference maximum biases are:

```text
storm      0.58
hail       0.72
squall     0.70
hurricane  0.82
```

These values are implementation tuning. The portable intent is that coarse LOD preserves significant localized phenomena better than a simple average while keeping the channels independent.

The presentation priority is applied only after these channel values have been produced.

### LOD interpolation

During an LOD transition, the renderer interpolates the phenomenon values associated with the start and end spatial states.

Winner selection is then performed from the interpolated values.

When the same phenomenon wins at both LOD endpoints, radius interpolation preserves glyph area using squared-radius interpolation.

This reduces perceptual popping during refinement or coarsening.

## Dots

Dots combines precipitation samples and phenomenon glyphs on the deterministic geographic grid.

Precipitation intensity is primarily communicated by circle radius and overlap.

Phenomenon symbols are rendered from the same spatial sampling system but remain independent channels until presentation.

Dots therefore shows:

```text
precipitation samples
+
phenomenon glyph layer
```

## Areas

Areas uses a reconstructed scalar precipitation surface instead of visible precipitation dots.

Phenomena do not receive a separate Areas-specific representation.

The same phenomenon glyph layer used by Dots is reused in hazards-only mode above the Areas precipitation layer.

Conceptually:

```text
Areas precipitation reconstruction
+
same phenomenon glyph layer
```

As a result, switching between Dots and Areas does not change the phenomenon contract:

- same sample identity;
- same channel values;
- same temporal behavior;
- same winner priority;
- same glyphs;
- same colors;
- same sizing semantics.

Only the precipitation representation changes.

## Reference implementation

The most relevant implementation files are:

### `src/engine/precipitation-mapping.js`

Defines normalized presentation thresholds and common strength mappings.

Also defines the three squall grade thresholds.

### `src/engine/hazard-renderer.js`

Contains the readable CPU reference for:

- phenomenon priority;
- size mapping;
- squall grade progression;
- fixed hurricane sizing.

This is a useful compact description of the intended presentation semantics.

### `src/engine/geographic-dots-layer.js`

Contains the actual WebGL presentation implementation:

- glyph geometry;
- colors;
- temporal interpolation;
- winner selection;
- LOD interpolation;
- instanced rendering.

### `src/engine/geographic-symbol-pyramid.js`

Defines the spatial and LOD behavior of weather samples and phenomenon values:

- deterministic sample hierarchy;
- direct/reference evaluation;
- independent channel aggregation;
- average/max-biased coarse summaries.

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
- one visible phenomenon per sample;
- fixed phenomenon priority;
- stable glyph identities;
- defined shape and color for each phenomenon;
- squall severity expressed through three size grades;
- hurricane represented by a fixed cell-scale square;
- phenomenon semantics remain the same across Dots and Areas.

The following are implementation choices rather than universal requirements:

- synthetic Gaussian weather generation;
- MapLibre GL JS;
- the current WebGL buffer layout;
- shader organization;
- the exact numerical size coefficients;
- the exact LOD data structures;
- the current renderer class boundaries.

A different implementation can preserve the same visual contract without copying those internal mechanisms literally.
