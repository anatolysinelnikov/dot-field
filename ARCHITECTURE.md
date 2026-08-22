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

`app.js` owns UI state, play/pause, timeline scrubbing, projection buttons, MapLibre construction, LOD refresh scheduling, and readouts. It does not implement camera controls; MapLibre owns those.

The map uses the OpenFreeMap Dark style at `https://tiles.openfreemap.org/styles/dark`; the normal MapLibre attribution control remains enabled. MapLibre handles desktop and touch navigation, resize, DPR, and the map WebGL context.

The initial projection is Globe. The explicit UI switches between `globe` and `mercator` through `map.setProjection`. The center/zoom are retained by MapLibre, and no weather/sample data is regenerated for a projection switch.

Animation is deterministic and has the existing 18-second loop. Weather geometry is refreshed at a modest cadence while playing because field movement is slow; a map move, resize, projection change, or timeline scrub queues a fresh selection immediately.

## Geographic synthetic field adapter — `src/engine/geography.js`

`WEATHER_REGION` centralizes the test anchor:

```text
center: [-4, 55]             # United Kingdom / North Atlantic / North Sea
longitudeSpan: 32 degrees
latitudeSpan: 20 degrees
```

`geographicIntensityAt(longitude, latitude, time)` converts a geographic sample into the old synthetic field coordinate system, then calls `field.intensityAt`. Its deterministic horizontal travel is derived only from time. Pan, zoom, viewport size, and Globe/Mercator mode do not affect it.

`field.js` remains independent of MapLibre, WebGL, UI, and sampling topology.

## Hierarchical geographic sampling — `src/engine/icosphere.js`

The sampling topology starts with an icosahedron. A face subdivision creates the three normalized edge midpoints and four child triangles. Midpoint identity is keyed by its sorted parent-vertex IDs, so adjacent faces share the exact same vertex.

Each vertex has a stable numeric ID and a fixed normalized sphere position / `[longitude, latitude]`. Existing vertices are never moved or replaced by a finer level. Face IDs are deterministic paths from their icosahedron root face.

Subdivision is lazy: only faces requested by the LOD traversal are materialized. This retains the additive hierarchy without building a globally dense icosphere up front.

## Local screen-space LOD — `src/engine/geographic-lod.js`

LOD recursively tests each face’s projected edge length from `map.project`. A visible face is subdivided while its longest projected edge exceeds the screen-spacing threshold. This is a projected-geometric criterion, not a distance-from-screen-center rule.

The traversal only materializes the geographic support that can contain the current synthetic system across its complete deterministic trajectory. That support test is a data cull; it does not alter the topology or sample identities. Off-screen leaf faces are not selected. Visible leaf faces contribute their vertices to the active set, and a shared vertex uses the finest adjacent active leaf level for its local spacing.

Refinement is additive: parent face vertices stay selected after child faces are selected. Coarsening removes only finer vertices. Projection changes use the same stored icosphere vertices and hierarchy.

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
