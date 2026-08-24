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
auto-rotation, or visible 3D falling rain. Auto-rotation changes only camera
bearing at 2.5 degrees per second; it never changes weather coordinates or
rebuilds instance sets. Falling motion is independently paused by default.

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
the detailed-rain population when L13/L14 is active. Distant L10–L12 use their
own cheaper flat sample representation instead of materializing that budget.

## LOD rain representations — `src/engine/geographic-rain-layer.js`

The renderer evaluates one prepared geographic field frame at fixed `t = 0.5`
only when an LOD set is built. L10–L12 use a rain-only, surface-attached flat
circle per active rain sample (23 / 92 / 362 visible instances at the frozen
frame). L13–L14 use the reconstructed 3D streak population (2,903 / 2,959
visible instances). The existing 0.2-second transition crossfades the two
representations at L12→L13; there is no representation morph or camera-based
sampling.

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
opacity variation, and two-axis visual scatter from
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
30% of base opacity. The result avoids 3D capsule meshes while retaining
local-radial streak direction and depth testing.

The close-LOD instance stores a deterministic base vertical phase instead of a
CPU-updated altitude. A single renderer-local animation progress uniform uses
`fract(basePhase - progress)` to move droplets down to Earth and wrap them back
to the common shell. `app.js` advances that uniform over a shared seven-second
cycle only while falling is enabled and L13/L14 is visible; it never rebuilds
instances or advances synthetic weather time.

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
