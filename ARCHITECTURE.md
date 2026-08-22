# Dot Field Architecture

## Document status

- Repository: `anatolysinelnikov/dot-field`
- Architecture: `experiment/globe-dots` geographic Dots experiment
- This document is maintained context, not implementation authority. The current code wins when they differ.

## Project model

This branch is a browser-native geographic weather visualization prototype. It keeps the deterministic synthetic weather field, but replaces the active Canvas/fixed-square-grid path with MapLibre GL JS, a globally anchored square Mercator render lattice, and a custom WebGL weather layer.

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
 +-> geographic-lod.js
 |          |
 |          +-> globally anchored Mercator grid samples
 |
 +-> geographic-dots-layer.js -> MapLibre custom 3D WebGL layer
            |
            +-> geography.js -> field.js
```

### Application orchestration — `src/app.js`

`app.js` owns UI state, play/pause, timeline scrubbing, projection buttons, MapLibre construction, logical sampling-zoom selection, weather refresh scheduling, and readouts. It does not implement camera controls; MapLibre owns those.

The map uses the OpenFreeMap Dark style at `https://tiles.openfreemap.org/styles/dark`; the normal MapLibre attribution control remains enabled. MapLibre handles desktop and touch navigation, resize, DPR, and the map WebGL context.

The initial projection is Globe. The explicit UI switches between `globe` and `mercator` through `map.setProjection`. The center/zoom are retained by MapLibre, and no weather/sample data is regenerated for a projection switch. Projection changes temporarily suppress sampling-zoom deltas and rebase the raw camera baseline after two render frames, so the visual A/B does not change LOD.

Animation is deterministic and has the existing 18-second loop. Weather values and symbol buffers are refreshed at a modest cadence while playing because field movement is slow. Grid samples are rebuilt only when the discrete logical-zoom-derived grid level changes. MapLibre camera movement and projection changes only reproject the existing layer geometry.

MapLibre raw zoom is not used directly for weather LOD. `app.js` maintains an application-owned logical sampling zoom. In Globe mode, each raw zoom delta is corrected by `log2(cos(new latitude) / cos(old latitude))`, matching MapLibre's latitude adjustment; a camera pan/rotation therefore does not alter weather density. Mercator applies the raw zoom delta directly. The UI `zoom` readout shows this logical sampling zoom rather than MapLibre's internal raw zoom.

## Geographic synthetic field adapter — `src/engine/geography.js`

`WEATHER_REGION` centralizes the test anchor, scale, trajectory, and normalized synthetic support:

```text
center: [-0.1, 51.5]         # London
longitudeSpan: 1.8 degrees
latitudeSpan: 1.2 degrees
trajectory: x = 0.33..0.67
field support: x radius 0.92, y radius 0.76
```

The exported `WEATHER_SUPPORT` bounds are derived from that same configuration and are the only support bounds consumed by the geographic lattice sampler. Moving the experiment to another region requires changing this one geographic configuration. `geographicIntensityAt(longitude, latitude, time)` converts a geographic sample into the old synthetic field coordinate system, then calls `field.intensityAt`. Its deterministic horizontal travel is derived only from time. Pan, zoom, viewport size, and Globe/Mercator mode do not affect it.

`field.js` remains independent of MapLibre, WebGL, UI, and sampling topology.

## Square Mercator render sampling — `src/engine/geographic-lod.js`

Active weather samples are vertices of a globally anchored dyadic grid in normalized Web-Mercator world coordinates. At level `L`, the step is `1 / 2^L`; only the centralized `WEATHER_SUPPORT` converted to Mercator bounds, plus a fixed conservative canonical-resolution overscan, is enumerated. The grid is independent of viewport visibility, pan, globe rotation, and projection mode.

Each sample stores its Mercator coordinate and its converted longitude/latitude. Its identity is a compact `canonicalX:canonicalY` integer pair at the fixed maximum grid resolution. A point inherited by a finer level therefore keeps exactly the same identity; IDs do not depend on enumeration order, camera history, device, or projection. Finer levels contain every coarser grid vertex, so refinement never moves existing samples.

Mercator render sampling is intentionally not equal-area on the Earth surface. It is a visualization choice that preserves the stable orthogonal Dot Field lattice, not a claim about physical sample area or a future provider's native grid.

## Uniform zoom LOD — `src/engine/geographic-lod.js`

`zoomToMercatorGridLevel` selects one discrete level for the whole active weather region. It rounds `logical zoom + log2(512 / 9)`, clamped to levels 10 through 13: MapLibre's world is 512 CSS pixels wide at zoom zero and the target nominal neighboring-sample spacing is 9 CSS pixels. The mapping is centralized, deterministic, and independent of screen position, viewport, bearing, pan, projection, globe horizon, and `map.project`.

The initial logical zoom is 6.2 and selects level 12. Near London, L10/L11/L12/L13 are approximately 24/12/6/3 km between grid vertices. About 4 km is the nominal future provider resolution, so L13 is the maximum meaningful visualization and analysis level; further visual zoom makes those samples larger without inventing sub-provider detail. The Mercator lattice remains independent of a provider grid.

The active sample set and count remain unchanged when the same logical zoom map is panned, rotated, resized, or switched between Globe and Mercator. Zooming across a discrete threshold replaces the active level with the deterministically nested coarser or finer grid.

Grid step is exact and uniform at an active level, so it is stored as each sample's spacing for the marker-radius transfer. There is no screen-space, latitude, horizon, or perspective compensation.

## Dots rendering — `src/engine/geographic-dots-layer.js`

`GeographicDotsLayer` is a MapLibre `type: 'custom'`, `renderingMode: '3d'` layer. It builds geometry directly in whole-world Mercator surface coordinates and uses MapLibre’s projection-aware `projectTile` shader interface. The injected MapLibre shader code handles Globe, Mercator, and their internal transition/depth semantics.

Rain and strong rain each use one shared unit quad and an instanced center/radius buffer. The vertex shader expands that quad in Mercator surface coordinates; the fragment shader evaluates an antialiased analytic circle. This keeps rain circular in Mercator, surface-attached in both projections, and naturally foreshortened near the globe horizon without a screen-facing billboard or polygon facets.

Storm and hail retain simple batched polygon geometry. Storm's long tips remain north/east/south/west in the Mercator lattice with diagonal inner points; hail remains a hexagon. The layer emits at most four draw calls per frame:

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
- marker radius is computed from intensity relative to the active Mercator grid step, so symbol and sampling geometry pass through the same projection together.

Hazards use a fixed native analysis lattice at L13, independently of the active rain display level. The cached L13 probes are assigned to their nearest active dyadic parent using canonical integer Mercator coordinates, with support-edge clamping. Per active sample, visible hail uses the maximum native hail value; otherwise visible storm uses the maximum native storm value. Hail retains priority over storm, so a localized hail cell cannot be averaged away or disappear only because display LOD is reduced.

## Legacy modules

The following files remain for comparison or future work but are inactive in this experiment:

- `dots-renderer.js`, `squares-renderer.js`, `blur-renderer.js`, `areas-renderer.js`;
- `scalar-reconstruction.js`;
- fixed-grid portions of `lod.js` and `hazard-renderer.js`.

They still describe the pre-experiment square-grid / Canvas architecture. Do not route new geographic Dots behavior through them beyond the shared pure weather-transfer helpers noted above.
