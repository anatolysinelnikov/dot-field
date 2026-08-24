# Dot Field Architecture

## Document status

- Repository: `anatolysinelnikov/dot-field`
- Architecture: `experiment/3d-rain`, Step 1 static 3D rain experiment
- This document is maintained context, not implementation authority. Current code wins when they differ.

## Project model

This branch is a marketing-oriented, frozen-weather rain scene on a MapLibre
Globe. It uses flat precipitation at distant LODs and deterministic 3D rain
streaks at close LODs.
The synthetic geographic field remains independent of MapLibre and rendering,
and the existing time-aware field API remains available for later steps.

```text
app/UI -> GeographicRainLayer -> geographic LOD / geography -> field -> math/config
```

`src/app.js` owns MapLibre construction, the fixed `t = 0.5` weather frame,
camera/reset controls, logical sampling zoom, and LOD transition scheduling. It
does not run a weather-time playback RAF or expose a timeline/mode selector.
Its RAF runs only for the existing 0.2-second LOD transition, compact
auto-rotation, or visible L13/L14 rain with a nonzero speed setting.
Auto-rotation changes only camera bearing at 2.5 degrees per second; it never
changes weather coordinates or rebuilds instance sets. A compact independent
rain-speed slider defaults to 2×, while 0× pauses falling motion without
advancing its retained animation progress.

## Geographic sampling and LOD

`geographic-lod.js` remains the shared globally anchored dyadic Web-Mercator
topology. Display levels are L10–L14, identities are L15 canonical integer
coordinates, and camera movement never reseats the grid. Logical zoom keeps
the existing latitude correction for Globe camera movement. Camera zoom is
independent of sampling in this experiment: MapLibre permits zoom through 13,
while logical weather zoom clamps at L14. Further camera zoom only magnifies
and reprojects the existing L14 rain geometry.

On a level transition the renderer builds deterministic old and new instance
sets once, and crossfades them with the existing smooth 0.2-second transition.
No weather values are reevaluated during camera movement or transition frames.
Rain population is area-normalized instead of using a per-level slot table.
Each cell receives a deterministic rounded budget of
`1.7 × averageCornerRainStrength × (sampleSpacing / L14Spacing)²`, bounded at 512 droplets.
Four finer cells therefore replace one coarse cell without materially changing
the detailed-rain population when L13/L14 is active. Distant L10–L12 use the
main Dots precipitation pyramid instead of materializing that budget.

## LOD rain representations — `src/engine/geographic-rain-layer.js`

The renderer evaluates one prepared geographic field frame at fixed `t = 0.5`
only when an LOD set is built. L10–L12 reuse `GeographicSymbolPyramid`, the
same main-Dots machinery: L13 is its reference grid and lower levels are
derived by deterministic area-preserving reduction of rain and strong-rain
radius. The rain-only renderer draws the same two surface-attached Dots passes
in the same order and colors (rain, then strong rain), without rendering hazard
channels. At the frozen frame these are 37/13, 124/30, and 440/93
rain/strong instances for L10/L11/L12. L13–L14 use the reconstructed 3D
streak population (2,903 / 2,959 visible instances). The existing 0.2-second
transition crossfades the two representations at L12→L13; there is no
representation morph or camera-based sampling.

Each close-LOD rain cell is a conceptual column from 180 m to 10,000 m;
intensity never alters that vertical range. Instead it controls deterministic
slot activation (the strongest signal), then restrained opacity, length, and
width. Empty/insignificant slots are omitted.

Rain density is reconstructed per cell, rather than treating a sample value as
a constant square footprint. The renderer caches one synthetic rain value at
each geographic lattice point, then evaluates each candidate with the shared
top-left/top-right/bottom-left/bottom-right bilinear field. Its local strength
both deterministically accepts the candidate and drives the existing droplet
appearance mapping. Neighboring cells therefore share exactly the same corner
values without per-droplet synthetic field evaluations.

Every potential droplet derives its selector, column phase, length/width,
opacity variation, speed factor, upper trail opacity, and two-axis visual scatter from
`(canonicalX, canonicalY, slotIndex)` through a stable integer hash. Field
evaluation remains at the unmodified sample center; only droplet geometry is
placed across 90% of the cell by an R2/plastic-ratio low-discrepancy sequence
with a stable per-cell Cranley-Patterson shift. There is no runtime randomness,
camera-dependent placement, or jitter. The `phase` is retained as the future
basis for Step 2 motion equivalent
to `fract(globalTime * speed + phase)`.

MapLibre GL JS 5.24.0's custom shader prelude provides
`projectTileFor3D(vec2 posInTile, float elevation)`. The layer uses that exact
function with metre altitudes. On Globe it creates a radial spherical offset,
which means both the common upper shell and each streak follow local Earth
normals; MapLibre handles the projection-transition fallback. Each droplet is
one instanced four-vertex triangle strip. The vertex shader projects its two radial ends
then faces the narrow dimension toward the camera in clip space; the fragment
shader supplies anti-aliased rounded-capsule coverage plus a smooth vertical
trail gradient: the lower Earth-facing end is fully opaque and the upper end is
individually derived from deterministic droplet identity. The result avoids 3D
capsule meshes while retaining
local-radial streak direction and depth testing.

The close-LOD instance stores a deterministic base vertical phase, a stable
0.85×–1.15× speed factor, and 0.00–0.20 upper trail opacity instead of a
CPU-updated altitude. A continuously accumulated renderer-local falling-cycle
uniform uses `fract(basePhase - fallingCycles * speedFactor)` to move each
droplet down to Earth and wrap it individually back to the common shell, with
no global 0–1 reset. The 0×–2× rain-speed slider defaults to 2× and advances
that uniform at a four-second full-column cycle at 1× (two seconds at 2×), only
when L13/L14 is visible; it never rebuilds instances or advances synthetic
weather time. The fragment shader keeps each Earth-facing lower end at full
base opacity and smoothly fades its upper end to that streak's deterministic
upper-opacity value.

Buffers are reusable and are uploaded only when an LOD set changes. The static
scene is otherwise repainted solely by MapLibre navigation. The per-cell budget
is bounded at 512, while the area-normalized close-LOD target keeps actual work
near 3,000 visible streaks. This branch has no storm/lightning, hail, clouds,
or weather-time animation.

## Shared field and future work

`field.js`, `geography.js`, `geographic-lod.js`, temporal helpers, and the
synthetic storm/hail channels are intentionally retained. They preserve the
future provider boundary:

```text
provider format -> normalization -> temporal/spatial interpolation
-> geographic sampling/reconstruction -> rendering
```

Step 2 can introduce motion via the already deterministic slot phase without
changing grid identities or rebuilding rain geometry every camera frame.
