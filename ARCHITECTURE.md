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
 |                                  +-- MapTiler Dataviz Dark basemap + attribution/logo
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

The map loads the MapTiler Dataviz Dark MapLibre style (`dataviz-v4-dark`) from the Maps API using the local-only `config.local.json` key; the normal compact MapLibre attribution control and a visible MapTiler logo remain enabled. MapLibre handles desktop and touch navigation, resize, DPR, and the map WebGL context; camera zoom is constrained to raw MapLibre zoom 1.5 or higher. The custom weather layer is attached from the style-ready lifecycle (`style.load`) with an idempotent `getLayer` check. The MapTiler-specific context step keeps roads and minor symbols below weather while moving the verified geographic upper context above it: major settlement labels, selected water labels, country/first-order boundaries, river lines, water-boundary outlines, and a derived inner water-edge shadow. The native Water fill and native Water shadow remain below weather; a very low-opacity derived water wash and line-based edge shadow above weather improve hydrographic readability without obscuring precipitation. Unavailable optional context layers are skipped without preventing weather initialization. MapLibre error events remain visible in the console without exposing the authenticated style URL.

The initial projection is Globe. The explicit UI switches between `globe` and `mercator` through `map.setProjection`. The center/zoom are retained by MapLibre, and no weather/sample data is regenerated for a projection switch. Projection changes temporarily suppress sampling-zoom deltas and rebase the raw camera baseline after two render frames, so the visual A/B does not change LOD.

Animation is deterministic and has the existing 18-second loop. CPU weather evaluation produces adjacent 100 ms temporal keyframes; the custom layer interpolates their symbol radii every rendered frame. Grid samples are rebuilt only when the discrete logical-zoom-derived grid level changes. MapLibre camera movement and projection changes only reproject the existing layer geometry.

MapLibre raw zoom is not used directly for weather LOD. `app.js` maintains an application-owned logical sampling zoom. In Globe mode, each raw zoom delta is corrected by `log2(cos(new latitude) / cos(old latitude))`, matching MapLibre's latitude adjustment; a camera pan/rotation therefore does not alter weather density. Mercator applies the raw zoom delta directly. The UI `zoom` readout shows this logical sampling zoom rather than MapLibre's internal raw zoom.

## Geographic synthetic field adapter — `src/engine/geography.js`

`WEATHER_REGION` centralizes the test anchor, scale, trajectory, and normalized synthetic support:

```text
center: [30.3158, 59.9391]    # Saint Petersburg
longitudeSpan: 1.8 degrees
latitudeSpan: 1.2 degrees
trajectory: x = 0.33..0.67
field support: x radius 0.92, y radius 0.76
```

The exported `WEATHER_SUPPORT` bounds are derived from that same configuration and are the only support bounds consumed by the geographic lattice sampler. Moving the experiment to another region requires changing this one geographic configuration. `geographicIntensityAt(longitude, latitude, time)` remains available for legacy use. Geographic Dots instead caches every node's geographic-to-synthetic coordinate and evaluates it against a prepared temporal field frame. Its deterministic horizontal travel is derived only from time. Pan, zoom, viewport size, and Globe/Mercator mode do not affect it.

`field.js` remains independent of MapLibre, WebGL, UI, and sampling topology. `prepareFieldFrame` precomputes time-only component amplitudes, widths, rotations, trigonometry, and inverse variances once per temporal keyframe; `evaluatePreparedField` then performs only the spatial evaluation.

## Square Mercator render sampling — `src/engine/geographic-lod.js`

Active weather samples are vertices of a globally anchored dyadic grid in normalized Web-Mercator world coordinates. At level `L`, the step is `1 / 2^L`; only the centralized `WEATHER_SUPPORT` converted to Mercator bounds, plus a fixed conservative canonical-resolution overscan, is enumerated. The grid is independent of viewport visibility, pan, globe rotation, and projection mode.

Each sample stores its Mercator coordinate and its converted longitude/latitude. Its identity is a compact `canonicalX:canonicalY` integer pair at the fixed maximum grid resolution. A point inherited by a finer level therefore keeps exactly the same identity; IDs do not depend on enumeration order, camera history, device, or projection. Finer levels contain every coarser grid vertex, so refinement never moves existing samples.

Mercator render sampling is intentionally not equal-area on the Earth surface. It is a visualization choice that preserves the stable orthogonal Dot Field lattice, not a claim about physical sample area or a future provider's native grid.

## Uniform zoom LOD — `src/engine/geographic-lod.js`

`zoomToMercatorGridLevel` selects one discrete level for the whole active weather region. It rounds `logical zoom + log2(512 / 9)`, clamped to levels 10 through 15: MapLibre's world is 512 CSS pixels wide at zoom zero and the target nominal neighboring-sample spacing is 9 CSS pixels. The mapping is centralized, deterministic, and independent of screen position, viewport, bearing, pan, projection, globe horizon, and `map.project`.

The initial logical zoom is 6.2 and selects level 12. Near Saint Petersburg, L10 through L15 are approximately 24, 12, 6, 3, 1.5, and 0.75 km between grid vertices. L13 is approximately the nominal future provider scale. L14 and L15 are finer deterministic render/reconstruction sampling of an interpolated field, not additional measured provider observations. The Mercator lattice remains independent of a provider grid.

The active sample set and count remain unchanged when the same logical zoom map is panned, rotated, resized, or switched between Globe and Mercator. Zooming across a discrete threshold replaces the active level with the deterministically nested coarser or finer grid.

Grid step is exact and uniform at an active level, so it is stored as each sample's spacing for the marker-radius transfer. There is no screen-space, latitude, horizon, or perspective compensation.

## Dots rendering — `src/engine/geographic-dots-layer.js`

`GeographicDotsLayer` is a MapLibre `type: 'custom'`, `renderingMode: '3d'` layer. It builds geometry directly in whole-world Mercator surface coordinates and uses MapLibre’s projection-aware `projectTile` shader interface. The injected MapLibre shader code handles Globe, Mercator, and their internal transition/depth semantics.

Rain and strong rain each use one shared unit quad and an instanced start/end center-and-radius buffer. The vertex shader interpolates the center and expands that quad in Mercator surface coordinates; the fragment shader evaluates an antialiased analytic circle. This keeps rain circular in Mercator, surface-attached in both projections, and naturally foreshortened near the globe horizon without a screen-facing billboard or polygon facets.

Storm and hail use static unit polygon meshes with the same instanced start/end center-and-radius transition attributes as rain. Storm's long tips remain north/east/south/west in the Mercator lattice with diagonal inner points; hail remains a hexagon. The layer emits at most four draw calls per frame:

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

`geographic-symbol-pyramid.js` caches the L10–L15 samples, immediate dyadic ownership below L13, static packed render anchors, direct-grid pair indices, and packed synthetic field coordinates for direct levels. Temporal weather state is separate from this topology: each evaluated level contains four `Float64Array` radius channels (`rain`, `strong`, `storm`, and `hail`) and no per-sample symbol objects. Normal playback rolls the old `time1` state to `time0` and reuses the retired `time0` arrays for the new `time1`; static topology is never rebuilt for a temporal update. L13 is evaluated directly as the provider-scale reference. L12 through L10 recursively reduce only from the immediately finer reference representation required for the current display or adjacent transition. L14 and L15 independently evaluate the reconstructed geographic field directly; neither needs L15 as a source for coarser levels. A fine grid vertex below L13 owns exactly one parent chosen by canonical Mercator coordinates with `floor` ownership; interior parents own their stable 2×2 child group, while support-edge groups are deterministically partial.

Topology identity and render position are deliberately separate for reduced symbols. The parent retains its canonical lattice ID, while its cached render anchor is the unweighted geometric mean of its immediate child anchors. This is applied recursively from L13 down to L10, including partial support-edge groups. Anchors are static topology data, never weighted by weather values, so animation cannot move a representation's spatial identity.

Rain and strong precipitation conserve their visible areas independently: each parent radius is `sqrt(sum(child radius²))`. Hazards separate priority from footprint. Direct temporal state stores storm and hail radii in independent channels, with only the resolved direct hazard channel nonzero. A parent is hail if any child has a hail radius, otherwise storm if any child has a storm radius; its winning channel radius preserves the sum of all child hazard painted areas. The hail hexagon coefficient is `3√3/2`; the current eight-point storm star coefficient is `2 * 0.38 * √2`, derived from its alternating outer/inner polygon geometry. The winning parent glyph radius is converted from the combined area using its own coefficient.

This produces a demand-driven deterministic symbol pyramid: L14 and L15 both carry finer reconstructed storm/hail symbols; L13 remains the useful provider-scale reference rather than a hard hazard ceiling; and L12 through L10 are recursive reductions rather than direct reassignment from an arbitrary source level. A normal coarse update evaluates only the L13 reference set and the reductions it needs; it does not build the full L15-to-L10 hierarchy.

Adjacent display levels morph over `LOD_MORPH_SECONDS` (currently 0.2 seconds). For reduced-level transitions L10 through L13, the cached immediate parent/child ownership explicitly controls the transition instead of matching endpoint IDs. Each coarse parent shrinks at its centered anchor while every child, including the child sharing the parent's canonical ID, grows from that same anchor and moves to its own cached anchor. Circle and polygon radii interpolate in squared-radius (area) space, so the parent contribution falls with `1 - progress` while child contributions rise with `progress`.

Storm and hail use that same true split/merge rather than an endpoint crossfade. Each contribution retains its endpoint glyph type during the morph: a hail parent can shrink while storm and hail children grow, preserving hail-over-storm endpoint priority without inventing an intermediate shape. The renderer stores two temporal radii for each LOD endpoint and independently interpolates weather time and LOD progress in squared-radius space. Storm and hail can therefore transition through zero radius at a fixed anchor when their weather state changes, with hail still drawn after storm. Pure temporal-progress and LOD-transition-progress updates only update shader uniforms and request a repaint; weather values and dynamic instance data rebuild when a temporal keyframe rolls forward or active LOD topology changes through `setSamples()` / `setTransition()`. L13–L14 and L14–L15 remain direct vertex-grid transitions, using cached direct pair indices and zero-radius growth/shrink for fine-only samples; they are not claimed to be centered four-to-one reductions.

Normal same-level playback uses a dedicated indexed fast path rather than generic endpoint joining. Instance construction reads the numeric temporal channels and cached packed anchors directly. Program attribute/uniform locations are cached at creation, and dynamic instance buffers retain capacity and use `bufferSubData` when possible. The timeline uses a continuous normalized range and spans the viewport between compact margins.

## Legacy modules

The following files remain for comparison or future work but are inactive in this experiment:

- `dots-renderer.js`, `squares-renderer.js`, `blur-renderer.js`, `areas-renderer.js`;
- `scalar-reconstruction.js`;
- fixed-grid portions of `lod.js` and `hazard-renderer.js`.

They still describe the pre-experiment square-grid / Canvas architecture. Do not route new geographic Dots behavior through them beyond the shared pure weather-transfer helpers noted above.
