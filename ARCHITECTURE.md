# Dot Field Architecture

## Document status

- Repository: `anatolysinelnikov/dot-field`
- Architecture: `experiment/globe-dots` geographic Dots experiment
- This document is maintained context, not implementation authority. The current code wins when they differ.

## Project model

This branch is a browser-native geographic weather visualization prototype. It keeps the deterministic synthetic weather field, but replaces the active Canvas/fixed-square-grid path with MapLibre GL JS, a hierarchical icosphere, and a custom WebGL weather layer.

Only **Dots** is active in this experiment. Squares, Blur, Areas, their reconstruction code, and the older fixed-grid Dots renderer remain as legacy modules and are not routed by `src/app.js`.

The data channels remain:

- rain;
- thunderstorm (`storm` in code);
- hail.

The intended future boundary remains:

```text
provider format -> normalization -> temporal/spatial interpolation
-> geographic sampling -> rendering
```

`field.js` is only the current synthetic implementation of the data-source side of that boundary.

## Runtime ownership

```text
index.html + styles.css
        |
        v
app.js ----------------------> MapLibre GL JS
 |                                  |
 |                                  +-- camera / pan / zoom / projection / navigation
 |                                  +-- OpenFreeMap Dark basemap + attribution
 |
 +-> geographic-lod.js -> icosphere.js
 |          |                    |
 |          +-> active samples   +-> deterministic hierarchical sphere topology
 |
 +-> geographic-dots-layer.js -> MapLibre custom 3D WebGL layer
            |
            +-> geography.js -> field.js
```

### Application orchestration — `src/app.js`

`app.js` owns UI state, play/pause, timeline scrubbing, projection buttons, MapLibre construction, zoom-to-topology selection, weather refresh scheduling, and readouts. It does not implement camera controls; MapLibre owns those.

The map uses the OpenFreeMap Dark style at `https://tiles.openfreemap.org/styles/dark`; the normal MapLibre attribution control remains enabled. MapLibre handles desktop and touch navigation, resize, DPR, and the map WebGL context.

The initial projection is Globe. The explicit UI switches between `globe` and `mercator` through `map.setProjection`. The center/zoom are retained by MapLibre, and no weather/sample data is regenerated for a projection switch.

Animation is deterministic and has the existing 18-second loop. Weather values and symbol buffers are refreshed at a modest cadence while playing because field movement is slow. Topology is rebuilt only when the discrete zoom-derived icosphere level changes. MapLibre camera movement and projection changes only reproject the existing layer geometry.

## Geographic synthetic field adapter — `src/engine/geography.js`

`WEATHER_REGION` centralizes the test anchor, scale, trajectory, and normalized synthetic support:

```text
center: [-3, 54.5]           # central Great Britain
longitudeSpan: 15 degrees
latitudeSpan: 9.5 degrees
trajectory: x = 0.33..0.67
field support: x radius 0.92, y radius 0.76
```

The exported `WEATHER_SUPPORT` bounds are derived from that same configuration and are the only support bounds consumed by the icosphere sampler. Moving the experiment to another region requires changing this one geographic configuration. `geographicIntensityAt(longitude, latitude, time)` converts a geographic sample into the old synthetic field coordinate system, then calls `field.intensityAt`. Its deterministic horizontal travel is derived only from time. Pan, zoom, viewport size, and Globe/Mercator mode do not affect it.

`field.js` remains independent of MapLibre, WebGL, UI, and sampling topology.

## Hierarchical geographic sampling — `src/engine/icosphere.js`

The sampling topology starts with an icosahedron. A face subdivision creates the three normalized edge midpoints and four child triangles. The 12 root vertices have deterministic identities (`root-0` … `root-11`). Every midpoint identity is the canonical string `midpoint(<sorted endpoint identity>|<sorted endpoint identity>)`; it is looked up in a topology identity map, so adjacent faces share the exact same vertex regardless of lazy traversal order.

Each vertex also has an internal array index for storage and a fixed normalized sphere position / `[longitude, latitude]`. The array index is not the sample identity. Existing vertices are never moved or replaced by a finer level. Face IDs are deterministic paths from their icosahedron root face.

Subdivision is lazy: only faces requested by the LOD traversal are materialized. This retains the additive hierarchy without building a globally dense icosphere up front.

## Uniform zoom LOD — `src/engine/geographic-lod.js`

`zoomToIcosphereLevel` maps MapLibre zoom to one discrete level for the entire active weather region: `clamp(floor(zoom) + 3, 3, 8)`. The mapping is centralized, deterministic, and independent of screen position, viewport, bearing, pan, projection, globe horizon, and `map.project`.

The traversal chooses the support tile set once at level 3 from the centralized `WEATHER_SUPPORT` bounds, then recursively reaches the selected uniform level inside those tiles. Descendants are not re-cropped at finer levels; this camera-independent support cull preserves additive parent samples. The active sample set and count therefore remain unchanged when the same zoomed map is panned or rotated.

Refinement is additive: parent face vertices remain part of the finer active triangulation and finer levels add deterministic vertices. Coarsening returns to the same topology-derived identities. Projection changes use the same stored sample set and only change MapLibre’s projection.

For each active vertex, incident edges of the selected triangulation are measured with spherical angular distance. The mean incident-edge angle is stored as that sample’s spacing for marker-radius transfer; no global nominal edge-angle formula or screen-space compensation is used.

## Dots rendering — `src/engine/geographic-dots-layer.js`

`GeographicDotsLayer` is a MapLibre `type: 'custom'`, `renderingMode: '3d'` layer. It builds surface geometry in local longitude/latitude tangent directions, converts vertices to whole-world Mercator coordinates, and uses MapLibre’s projection-aware `projectTile` shader interface. The injected MapLibre shader code handles Globe, Mercator, and their internal transition/depth semantics.

The layer uploads four batched buffers and emits at most four draw calls per frame:

1. rain circles (`#0090FF`);
2. strong-rain circles (`#0000FF`);
3. thunderstorm eight-point stars (`#FF00FF`);
4. hail hexagons (`#FFD400`).

There is no draw call per symbol. Geometry is planar in the sample’s local surface tangent frame, so symbols follow the map surface and naturally distort toward the globe horizon. A polygon depth offset prevents surface z-fighting; this is not a weather altitude model.

The current Dots mapping remains sourced from `precipitation-mapping.js`, `lod.js`, and `hazard-renderer.js`:

- visibility thresholds and nonlinear intensity transfer are retained;
- rain / strong-rain color split is retained;
- hail keeps priority over thunderstorm;
- storm and hail retain their star/hexagon appearances;
- marker radius is computed from intensity relative to that sample’s local icosphere spacing, so symbol and sampling geometry pass through the same projection together.

## Legacy modules

The following files remain for comparison or future work but are inactive in this experiment:

- `dots-renderer.js`, `squares-renderer.js`, `blur-renderer.js`, `areas-renderer.js`;
- `scalar-reconstruction.js`;
- fixed-grid portions of `lod.js` and `hazard-renderer.js`.

They still describe the pre-experiment square-grid / Canvas architecture. Do not route new geographic Dots behavior through them beyond the shared pure weather-transfer helpers noted above.
