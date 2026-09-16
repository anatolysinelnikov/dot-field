# Dot Field Reference Architecture

## 1. Purpose

Dot Field is a visual and behavioral reference prototype for deterministic geographic weather visualization. The observable contract is the reference; MapLibre, WebGL, and the synthetic weather source demonstrate one implementation of it.

## 2. Active data flow

```text
independent weather channels
        ↓
deterministic geographic samples
        ↓
temporal interpolation
        ↓
Areas rain reconstruction  +  hazard aggregation and winner selection
        ↓
scalar rain surface        +  aggregate hazard symbols
```

Areas is the only active precipitation representation. Rain is rendered by the scalar Areas layer. Storm, Hail, Squall, and Hurricane are rendered separately as aggregate symbols above it.

## 3. Weather data model

The input channels are independent scalar values: rain, storm, hail, squall, and hurricane. They contain no colors, glyphs, or other presentation data. Interpolation happens before hazards are aggregated and a visible winner is resolved.

`src/engine/field.js` generates deterministic synthetic values for the demo. Its shapes, trajectories, and lifecycle are demonstration data, not requirements for another data source.

## 4. Visual contract

| Channel | Areas presentation | Current appearance |
| --- | --- | --- |
| Rain | Reconstructed scalar field | Blue precipitation bands; field-dependent coverage |
| Storm | Aggregate symbol | Magenta (`#FF00FF`) narrow four-point star; smoothly sized from 18 to 26 CSS px, with 22 px midpoint |
| Hail | Aggregate symbol | Yellow (`#FFD400`) filled hexagon; discrete 16, 20, or 24 CSS px sizes |
| Squall | Aggregate symbol | `squall-dark.svg`, fixed 28 CSS px |
| Hurricane | Aggregate symbol | `tornado-dark.svg`, fixed 28 CSS px; the internal channel is `hurricane` while the prototype artwork is Tornado artwork |

For a settled aggregate block, priority is `hurricane > squall > hail > storm`; at most one hazard symbol is shown. The channels remain independent even when one symbol wins.

## 5. Spatial and temporal invariants

- Geographic sample identities and aggregate anchors are deterministic and stable. Camera movement and time change projected positions or values without reseeding the samples.
- Weather values vary over time; sample identity does not.
- The prototype starts paused at frame 0.
- The final timeline segment interpolates frame 179 to an explicit terminal state at `t = 1`. Automatic playback wraps to frame 0 only after reaching the endpoint.
- Hazard icons have fixed screen-space sizing across LOD. LOD changes their geographic density, not their icon size.

## 6. Hazard aggregation and priority

Hazard values are evaluated directly at the L14 reference grid. Each channel is independently max-reduced through the nested hierarchy to L7. At a requested LOD, the aggregate layer groups samples into geographic blocks and uses a deterministic average geographic anchor for each block.

For each block, the interpolated channel values are aggregated independently. The winner is then selected in the fixed priority order. A higher-priority channel suppresses a lower-priority symbol only when both resolve within the same block; there is no neighbor propagation. Areas rain reconstruction is separate from the hazard hierarchy.

## 7. LOD behavior and merge/split presentation

The hierarchy maps blocks by canonical geographic identity. A transition goes directly from the current level to the requested level, including when intermediate levels are skipped. Fine child symbols travel from their stable anchors to the exact coarse parent anchor as a presentation effect; the weather snapshot and aggregate membership stay fixed for the morph.

The parent appears as children converge, and the same mapping runs in reverse when splitting. Reversing an active transition continues from its current progress without an anchor jump or duplicate-symbol flash. The morph duration does not grow when more levels are skipped.

## 8. Areas rain reconstruction

Rain uses its own fixed L14 scalar lattice and is independent of hazard aggregation. Spatial smoothing is followed by coverage-preserving threshold remapping so the smoothed field retains the raw field's band coverage. The dense Areas surface uses separable monotone cubic Hermite reconstruction: source nodes remain exact, interpolation stays monotone, and values are clamped to the source cell. Subdivision creates the denser render grid without moving source nodes.

## 9. Synthetic demo data

The demo field makes the prototype repeatable and provides a compact hazard cluster within a broader rain and Storm field. These geographic patterns and their timing are not part of the visualization contract.

## 10. Key implementation files

- `src/engine/geographic-scalar-lattice.js` — deterministic rain lattice, smoothing, and coverage thresholds.
- `src/engine/areas-reconstruction.js` — monotone scalar reconstruction for Areas.
- `src/engine/geographic-scalar-layer.js` — rain texture preparation and Areas rendering.
- `src/engine/geographic-symbol-pyramid.js` — L14 hazard evaluation and independent max reduction through L7.
- `src/engine/geographic-areas-hazard-icons-layer.js` — hazard block aggregation, symbol presentation, and LOD merge/split.
- `src/engine/geographic-lod.js` — deterministic geographic sample grids and LOD selection.
- `src/engine/precipitation-mapping.js` — hazard visibility strength and Hail severity mapping.
- `src/app.js` — map, timeline, and LOD orchestration.
