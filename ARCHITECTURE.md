# Dot Field Architecture

## Document status

- Repository: `anatolysinelnikov/dot-field`
- Architecture: `experiment/3d-dot-rain`, static Dot-emitter 3D rain experiment
- This document is maintained context, not implementation authority. Current code wins when they differ.

## Project model

This branch is a marketing-oriented, frozen-weather rain scene on a MapLibre
Globe. It uses the main-compatible surface Dots precipitation renderer at every
display LOD, with deterministic 3D Dot-emitter rain added at close LODs.
The synthetic geographic field remains independent of MapLibre and rendering,
and the existing time-aware field API remains available for later steps.

```text
app/UI
├── GeographicDotsLayer -> surface precipitation
└── GeographicRainLayer -> 3D rain
        ↓
shared geographic LOD / geography -> field -> math/config
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
the existing latitude correction for Globe camera movement. This experiment
uses the same latitude-aware raw camera maximum as main, with the camera limit
tied to `MAX_LOGICAL_SAMPLING_ZOOM` and therefore the maximum displayed L14
weather LOD.

On a level transition the renderer builds deterministic old and new instance
sets once, and crossfades them with the existing smooth 0.2-second transition.
No weather values are reevaluated during camera movement or transition frames.
Surface Dots receive each L10–L14 level and the app-owned adjacent-level
transition directly, retaining their normal deterministic parent/child or
direct-pair LOD behavior. Rain is absent at L10–L12, fades at L12↔L13, and
crossfades independently built emitter sets at L13↔L14.

## Surface Dots and 3D rain representations

`GeographicDotsLayer` is the real surface Dots renderer at L10–L14. It owns
the shared `GeographicSymbolPyramid`: L13 is its reference grid, lower levels
use deterministic area-preserving rain and strong-rain radius reduction, and
the surface renderer retains main's colors, draw order, blending, depth, and
polygon offset. This experiment constructs it with `renderHazards: false`, so
only its rain and strong-rain passes are drawn; its default behavior still
renders storm and hail for normal usage.

`GeographicRainLayer` is independent and 3D-only. It owns a separate
`GeographicSymbolPyramid`, evaluates the fixed `t = 0.5` frame, and consumes
that pyramid's exact `anchors`, `rainRadius`, and `strongRadius` states. It
never reads `GeographicDotsLayer` buffers. At L13/L14 every active Surface Dot
owns exactly one emitter at the same anchor; there is no horizontal scatter,
bilinear candidate reconstruction, random motion, or camera-dependent identity.

An emitter produces 3, 4, or 5 large teardrops from `rainRadius / sampleSpacing`
(weak, medium, strongest visible rain). Each slot gets a deterministic positive
0.8–1.2 gap weight; normalized cumulative weights make irregular cyclic phases
that retain their order. All slots in an emitter share one 0.90×–1.10× speed,
hashed from stable sample identity, while different emitters are asynchronous.
`strongFraction = strongRadius² / rainRadius²` deterministically quantizes to
distributed dark-blue slots; remaining drops use the existing normal-rain blue.

The vertical column is deliberately exaggerated from 150 m to 15,000 m for the
normal main-compatible camera. `projectTileFor3D(vec2 posInTile, float elevation)`
follows the local Globe radial direction. One instanced quad per drop is
screen-facing but aligned to that projected radial direction. Its width is
projected every frame from world-space `rainRadius` (target 52% of the Surface
Dot diameter), with a 1.65× teardrop height and small deterministic slot
variation. The fragment shader gives it anti-aliased procedural coverage: a
rounded lower bulb toward Earth and a pointed upper end away from it, with no trail.

Instances store only anchor, deterministic phase, shared column speed,
`rainRadius`, size variation, and normal/strong color choice. The shader uses
`fract(phase - fallingCycles * speed)` for altitude, so accumulated app-owned
`fallingCycles` moves rain without rebuilding instances. The 0×–2× slider
defaults to 2×; 0× freezes exactly in place. Ripples, splashes, storm, hail,
lightning, clouds, wind, and weather-time animation are not implemented.

Both renderers use reusable buffers and rebuild only when an LOD set changes.
The static surface Dots never drive an animation RAF. The layers follow current-main MapTiler context
ordering: basemap/background, surface Dots, 3D rain, semi-transparent water
tint, coastline/water boundary, administrative boundaries, water labels, then
geographic/place labels. Native `Water shadow` is hidden, and other symbol
layers are moved below the weather stack as on main. This branch has no
storm/lightning, hail, clouds, or weather-time animation.

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
