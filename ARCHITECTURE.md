# Dot Field Architecture

## Document status

- Repository: `anatolysinelnikov/dot-field`
- Architecture: `experiment/3d-rain`, Step 1 static 3D rain experiment
- This document is maintained context, not implementation authority. Current code wins when they differ.

## Project model

This branch is a marketing-oriented, static 3D rain scene on a MapLibre Globe.
It deliberately contains one active representation: deterministic rain streaks.
The synthetic geographic field remains independent of MapLibre and rendering,
and the existing time-aware field API remains available for later steps.

```text
app/UI -> GeographicRainLayer -> geographic LOD / geography -> field -> math/config
```

`src/app.js` owns MapLibre construction, the fixed `t = 0.5` weather frame,
camera/reset controls, logical sampling zoom, and LOD transition scheduling. It
does not run a continuous playback RAF or expose a timeline/mode selector. Its
only RAF is the existing 0.2-second LOD transition while a zoom crossing is in
progress.

## Geographic sampling and LOD

`geographic-lod.js` remains the shared globally anchored dyadic Web-Mercator
topology. Display levels are L10–L14, identities are L15 canonical integer
coordinates, and camera movement never reseats the grid. Logical zoom keeps
the existing latitude correction for Globe camera movement.

On a level transition the renderer builds deterministic old and new instance
sets once, and crossfades them with the existing smooth 0.2-second transition.
No weather values are reevaluated during camera movement or transition frames.
Per-sample slot capacity decreases with refinement (L10–L12: 24, L13: 12,
L14: 4), keeping the practical visible density broadly stable while bounding
memory and draw work.

## Static 3D rain — `src/engine/geographic-rain-layer.js`

The renderer evaluates one prepared geographic field frame at `t = 0.5` only
when an LOD set is built. Each rain-bearing geographic sample is a conceptual
column from 180 m to 8,200 m; intensity never alters that vertical range.
Instead it controls deterministic slot activation (the strongest signal), then
restrained opacity, length, and width. Empty/insignificant slots are omitted.

Every potential droplet derives its selector, column phase, length/width and
opacity variation from `(canonicalX, canonicalY, slotIndex)` through a stable
integer hash. There is no runtime randomness, camera-dependent placement, or
jitter. The `phase` is retained as the future basis for Step 2 motion equivalent
to `fract(globalTime * speed + phase)`.

MapLibre GL JS 5.24.0's custom shader prelude provides
`projectTileFor3D(vec2 posInTile, float elevation)`. The layer uses that exact
function with metre altitudes. On Globe it creates a radial spherical offset,
which means both the common upper shell and each streak follow local Earth
normals; MapLibre handles the projection-transition fallback. Each droplet is
one instanced six-vertex quad. The vertex shader projects its two radial ends
then faces the narrow dimension toward the camera in clip space; the fragment
shader supplies anti-aliased rounded-capsule coverage. The result avoids 3D
capsule meshes while retaining local-radial streak direction and depth testing.

Buffers are reusable and are uploaded only when an LOD set changes. The static
scene is otherwise repainted solely by MapLibre navigation. Worst-case capacity
at L14 is 120,960 instances (30,240 samples × 4 slots), though rain support and
slot activation reduce the actual count substantially; L13's comparable bound
is 90,720. This branch has no storm/lightning, hail, clouds, or temporal motion.

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
