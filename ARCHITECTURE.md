# Dot Field Architecture

## Document status

- Repository: `anatolysinelnikov/dot-field`
- Current branch context: reusable local real-data geographic weather playback.
- This document is maintained architectural context, not implementation authority. Current code on the selected branch wins when it differs.
- Repository-wide invariants and coding-agent rules live in `AGENTS.md`.

## System model

Dot Field is a browser-native geographic weather visualization prototype built on MapLibre GL JS, deterministic spatial sampling, fixed-grid identity, and representation-independent weather reconstruction.

The current `real-data` runtime exposes:

- **RAW** — exact source-grid diagnostic cells;
- **Dots** — deterministic Mercator grid/LOD point representation;
- **Squares** — the same canonical grid/LOD identity rendered as cells.

Blur and Areas remain implemented but are intentionally inactive until their scalar reconstruction is viewport-windowed. They must continue to represent a reconstructed scalar field, not a blur or contour pass over another renderer.

Weather channels remain independent data channels:

- rain;
- thunderstorm (`storm` in code);
- hail.

The current prepared real-data sequence is rain-only and explicitly declares storm/hail unavailable. The engine keeps the generic hazard-capable path for future datasets.

## Dependency direction and ownership

Preferred dependency direction:

```text
app/UI -> renderers -> sampling/reconstruction/field -> math/config
```

Current ownership is approximately:

```text
index.html + styles.css
        |
        v
src/app.js --------------------------> MapLibre GL JS / Globe camera / basemap
  |
  +-> src/engine/geography.js -------> src/engine/real-weather.js
  |                                      |
  |                                      +-> src/engine/raw-weather-layer.js
  |
  +-> src/engine/geographic-lod.js
  |        |
  |        +-> src/engine/geographic-weather-pyramid.js
  |                    |
  |                    +-> src/engine/geographic-dots-layer.js
  |                    +-> src/engine/geographic-squares-layer.js
  |
  +-> retained inactive scalar path -> geographic-scalar-lattice.js
                                      -> geographic-scalar-layer.js
```

`src/app.js` owns DOM interaction, mutable application state, camera setup, playback, timeline scrubbing, render-mode routing, and MapLibre orchestration. Renderers receive state/drawing inputs and do not own DOM state. Provider normalization and weather semantics remain below the renderer boundary.

## Real-weather data flow

The reusable local workflow is:

```text
MinIO/S3-compatible provider
        ↓
tools/download-latest-real-weather.py
        ↓
ignored data/nc/
        ↓
tools/prepare-latest-real-weather.py
        ↓
tools/convert-netcdf-weather.py
        ↓
ignored data/generated/<generation-id>/
        + data/generated/current/metadata.json
        ↓
src/engine/real-weather.js
        ↓
geographic sampling / temporal reconstruction
        ↓
RAW / Dots / Squares
```

The browser never parses NetCDF directly. NetCDF parsing and normalization are offline/local preprocessing concerns.

The normalized browser transport is v2 and consists of:

- `metadata.json`;
- `support.mask`;
- little-endian Float32 rain frame assets.

Dataset dimensions, timestamps, crop, support bounds, frame count, frame byte length, and source-grid spacing are metadata. They must not be treated as repository constants.

The converter remains strict about physical precipitation units. Missing or ambiguous source units require an explicit verified assumption during preparation rather than a renderer-side guess.

### Immutable generations

`data/generated/current/metadata.json` is mutable discovery metadata only. It points to an immutable generation directory whose relative asset paths pin an open browser session to one generation.

Publishing order is:

```text
normalize into unpublished staging
        ↓
generate transport sidecars
        ↓
validate staging
        ↓
derive generation ID
        ↓
publish immutable generation
        ↓
atomically update current/metadata.json
```

Published generation directories are never mutated in place. Generation cleanup/GC is intentionally separate because an already-open page may still reference an older generation.

The gzip-era generation digest uses the `dot-field-generated-weather-v2` namespace. Logical weather content determines the digest; transport sidecar bytes do not. The namespace boundary prevents an older Brotli-era generation from being silently republished with different sidecars under the same ID.

### Gzip transport

`scripts/generate-gzip-sidecars.mjs` writes gzip level-9 `.gz` files next to the logical `support.mask` and `.f32` assets in unpublished staging.

`scripts/serve-local.mjs` is development-only LAN tooling. In `--compression gzip` mode it serves the `.gz` sidecar only when the client advertises `Accept-Encoding: gzip`, with:

- `Content-Encoding: gzip`;
- `Vary: Accept-Encoding`;
- encoded `Content-Length`.

Otherwise it serves the logical identity asset. The browser continues requesting the logical `.f32` / `support.mask` URLs and transparently receives the original decoded bytes. Compression is transport behavior, not a provider-format or renderer change.

## Source residency and scheduling

The active finite forecast intentionally becomes fully resident in RAM after startup.

`geography.js` configures the active sequence with:

- `retainAllSourceFrames: true`;
- `sourceFrameFetchConcurrency: 1`.

Startup does not wait for the entire sequence. The first required frame is requested after the initial basemap is considered visible. Playback becomes available after the initial three-frame source buffer; remaining frames fill in LOW-priority background work.

The scheduler has one global fetch slot. Current/adjacent temporal requirements are HIGH priority and outrank queued LOW work. A running request is allowed to finish. Map movement may pause starting new LOW work but does not block required HIGH weather.

Manual scrub requests replace stale queued temporal targets. A request-generation guard prevents a late source load from committing an older timeline target.

After full residency completes:

- all source-frame timeline access is local;
- frames are not evicted or re-downloaded by timeline interaction;
- renderer/LOD derived state remains separately bounded and is not multiplied by source frame count.

The lower-level bounded source LRU remains available for verification/compatibility paths but is not the active application policy.

## Runtime source requirement

The current `real-data` application requires the generated weather sequence. Missing `metadata.json`, `support.mask`, or rain frame assets fail visibly through the real-weather loading path; the application does not switch to an old CSV snapshot.

`data/mrl_z3_t+40min_376x239.csv` remains checked in only as a legacy sample/fixture with thunderstorm and hail values for targeted renderer/provider verification and manual hazard debugging. `real-weather.js` may retain CSV parsing utilities for those tests, but the application-facing `geography.js` does not use the CSV as runtime fallback.

This distinction is intentional: stale partial-coverage sample data must not hide broken or missing generated real-data assets.

## Spatial contract

Provider data is sampled into a deterministic, globally anchored Web-Mercator topology.

```text
provider/data support
        ↓
viewport + deterministic overscan
        ↓
active canonical topology window
        ↓
Dots / Squares
```

The viewport selects which canonical identities are materialized; it never defines or reseats the grid. For a fixed weather time, panning and zooming must not change a sample's canonical identity or world-space position.

Canonical identity resolution remains L15. The current normal application displays L10 through L14; L15 remains an explicit engine/canonical level for verification and future use.

The active window is represented by inclusive L15 integer bounds snapped outward to L10-compatible boundaries. Camera bounds are supplemented by a deterministic screen unprojection lattice and deterministic overscan/hysteresis. A new topology window is installed only when the retained window no longer contains the target window.

A window replacement is a spatial-compatibility boundary. Incompatible provider sampling geometry, temporal summaries, mapped state, and instances are discarded rather than visually morphed as if they were an LOD transition.

## LOD contract

`src/engine/geographic-lod.js` owns compact level descriptors and deterministic parent/child relationships. Levels are arithmetic grid descriptors rather than dense JS sample objects.

Current materialized ranges are bounded by stable display level:

- stable L10/L11 -> L10..L13;
- stable L12 -> L11..L13;
- stable L13 -> L12..L14;
- stable L14 -> L13..L14.

`LOD_MORPH_SECONDS` is currently `0.2` seconds. Adjacent LOD changes preserve deterministic spatial identity and avoid grid jumps. Range replacement after a completed morph is not itself a visual transition.

L13 is the current `WEATHER_REFERENCE_LEVEL` / direct-to-aggregate boundary. This is an explicit engine constant, not something inferred dynamically from one particular generated dataset.

- L13 and higher direct levels evaluate their own canonical positions against the reconstructed provider field.
- L12 -> L10 are recursively aggregated physical summaries from L13.
- Higher LOD adds sampling resolution; it does not invent additional meteorological information.

## Provider reconstruction

`src/engine/real-weather.js` owns validated physical weather storage and provider reconstruction.

Spatial reconstruction for the active regular grid is bilinear between source nodes. Temporal reconstruction for Dots/Squares is currently linear between adjacent provider source frames.

That temporal interpolation remains provider-owned. The pyramid and renderers consume reconstructed weather rather than owning interpolation semantics. This is important for a future deterministic motion/advection-aware temporal method: it should be replaceable below the pyramid without changing canonical sample identity or renderer contracts.

For regular rectangular canonical sampling, the provider uses compact axis-separable sampling geometry rather than retaining dense source-cell lookup tuples per canonical sample. Arbitrary/non-rectangular provider paths retain their generic fallback implementation.

The packed `support.mask` is a sequence-wide union of source nodes that can contain positive rain. It is available independently of full source-frame residency and allows guaranteed-dry canonical samples to be skipped while preserving deterministic geometry and aggregation denominators.

Prepared spatial rain arrays are computation caches, not a new weather representation. Their lifecycle is independent of source-frame residency.

## Shared physical weather pyramid

`src/engine/geographic-weather-pyramid.js` is representation-independent. One application-owned pyramid is shared by Dots and Squares.

It depends on:

- canonical topology;
- provider sampling/reconstruction;
- physical weather-summary semantics.

It does not depend on Dots radii, Squares colors/opacity, WebGL glyph geometry, DOM state, or UI preferences.

The generic physical summary contract retains rain distribution statistics and independent storm/hail statistics. Providers may explicitly advertise a compact `rain-only-display` profile when hazard channels are unavailable.

For the current rain-only sequence, the compact profile retains only the physical rain fields needed by Dots/Squares. Missing hazard arrays mean that those channels are unavailable; they are not inferred from zero-valued rain.

Direct high-LOD sequence states can use packed physical storage aligned to potentially-active canonical indices. L14 therefore avoids the old full-rectangle temporal allocation. L13 may remain dense as the aggregation/reference boundary, so L13<->L14 transitions intentionally support mixed dense-reference and packed-direct states.

The important memory contract is:

- source frames are one residency domain;
- topology/relations are another domain;
- active temporal physical summaries are bounded to active level/keyframe state;
- renderer presentation buffers are bounded to the active representation;
- no all-frame x all-LOD derived cache is retained.

## Temporal renderer lifecycle

The UI duration remains controlled by `LOOP_SECONDS` (`18` seconds), independently of provider timestamp spacing and source frame count.

Normalized time `0` maps to the first provider timestamp and normalized time `1` maps to the last provider timestamp. Playback stops at the endpoint; pressing Play at the endpoint explicitly restarts from the beginning. There is no implicit last-to-first weather interpolation seam.

Dots and Squares use adjacent renderer temporal keyframes and continuously interpolate the reconstructed field. RAW is discrete and selects exact source frames only.

Only the active discrete representation retains temporal weather/mapping state. Inactive Dots/Squares layers keep lightweight reusable topology/GPU capacity but do not continue evaluating weather.

## RAW

`src/engine/raw-weather-layer.js` is an exact source-grid diagnostic renderer.

RAW:

- reads one exact provider frame;
- treats each source-node value as a piecewise-constant midpoint cell for display;
- does not spatially interpolate provider values;
- does not temporally interpolate between provider frames;
- does not use Mercator weather aggregation or renderer presentation mapping.

Source-grid width, height, spacing, bounds, and timestamps come from the active dataset metadata. RAW must not hard-code dimensions from a previously tested generation.

The layer retains only nonzero precipitation drawing geometry for performance, while direct source-grid lookup remains available for inspecting zero-valued cells. The selected RAW frame reuses the resident source Float32 payload rather than owning a duplicate source frame.

## Dots

`src/engine/geographic-dots-layer.js` maps shared physical weather state into instanced Mercator-space circles and hazard glyphs.

Core semantics:

- radius/overlap communicate precipitation intensity;
- strong rain is a nested presentation mapping, not another weather source;
- sample positions and identities remain canonical and deterministic;
- direct L13/L14 values come from independently reconstructed physical samples;
- coarse values come from the shared physical summary pyramid;
- hazards remain independent data channels and hail wins presentation priority only when its mapped glyph is visible.

Dots does not recursively aggregate renderer radii or colors.

## Squares

`src/engine/geographic-squares-layer.js` uses the same canonical topology, physical weather pyramid, temporal ownership, and LOD lifecycle as Dots.

Squares maps that physical state into square instance attributes and shader presentation. It must not create an independent camera-relative grid or separate weather field.

The Hazards checkbox is presentation-only for both Dots and Squares. It does not change provider capability, summary layout, or physical data availability.

## Blur / Areas retained scalar path

`src/engine/geographic-scalar-lattice.js` and `src/engine/geographic-scalar-layer.js` remain implemented but inactive in the current app.

They currently use a fixed `SCALAR_GRID_LEVEL = 14` support-derived scalar lattice. Because full-support scalar allocation scales with dataset support rather than viewport, Blur/Areas must remain inactive until scalar reconstruction is viewport-windowed.

Blur semantics remain a continuous reconstructed scalar field. Areas remains a discrete contour/band representation of that reconstructed field. Areas Smooth remains deterministic world-space generalization, not camera-dependent smoothing and not post-processing of another renderer.

Do not preserve old dataset-specific full-support vertex counts or local-kilometre estimates as architecture constants; those are properties of a particular support extent, not of the scalar contract.

## Application and MapLibre orchestration

`src/app.js` owns:

- MapLibre construction and Globe projection;
- MapTiler configuration loading;
- camera/logical weather zoom state;
- viewport-to-canonical-window selection;
- playback and timeline interaction;
- RAW/Dots/Squares activation;
- timestamp display;
- Hazards UI preference;
- weather startup sequencing.

RAW, Dots, and Squares custom layers are created once and switched active/inactive rather than recreating the map. The current selector order is RAW, Dots, Squares and playback starts paused.

Map labels, administrative boundaries, water context, attribution, and camera controls remain application/MapLibre concerns, not weather-engine responsibilities.

## Diagnostics

`src/runtime-diagnostics.js` is retained as official opt-in engineering diagnostics, activated by `?diagnostics=1`.

When disabled, `createRuntimeDiagnostics()` returns `null`; diagnostics timers, IndexedDB persistence, resource observation, and HUD work do not start.

When enabled it records bounded information about:

- frame timing/stalls;
- camera and active LOD;
- canonical-window rebuild timing;
- source residency/scheduler state;
- known Dot Field CPU allocations;
- estimated Dot Field GPU buffer bytes;
- renderer lifecycle counters;
- weather Resource Timing encoded/decoded sizes;
- selected runtime events and WebGL/context failures.

It cannot report total Safari/WebContent process memory or total CPU/GPU utilization. Tracked CPU and GPU values must continue to be described as partial Dot Field-owned accounting.

Startup timing markers exposed through `window.__dotFieldStartup` and lightweight weather diagnostics remain engineering observability, not weather semantics.

## Verification tooling

The `scripts/benchmark-*` and `scripts/verify-*` files are retained regression/performance tooling, not runtime features. They cover important contracts introduced during real-data, LOD, packing, residency, generation, and transport work.

In particular, keep coverage for:

- real-weather loader validation;
- immutable weather generations;
- gzip local transport;
- source scheduler/full residency;
- packed high-LOD weather state;
- renderer layouts;
- canonical window/LOD transitions;
- physical summary and sampling correctness.

Reference/dense implementations used only by verifiers may remain when they provide a correctness oracle for optimized production paths.

## Checked-in samples versus active data

Raw NetCDF and generated weather assets are intentionally ignored by Git.

The checked-in CSV is not current product data and is not a coverage fallback. It is a reproducible legacy fixture useful because it contains thunderstorm/hail examples that the current rain-only generated sequence does not provide.

Code and documentation should label it accordingly and must not silently activate it when generated real-weather assets are missing.

## Current known follow-up areas

These are current engineering directions, not implemented contracts:

1. **Temporal motion quality** — current provider temporal reconstruction is value-linear between adjacent source frames. Real data shows non-uniform/morph-like motion; a deterministic motion/advection-aware method should be investigated below the sampling/pyramid boundary.
2. **Transition relation memory** — packed L14 removed the previous fatal high-LOD temporal allocation, but some LOD transition/topology relation states can still be large and remain a measured optimization target if device testing requires it.
3. **Viewport-windowed scalar reconstruction** — required before Blur/Areas return to the active runtime.
4. **Hazard-capable real provider data** — current generated sequence is rain-only; future hazard ingestion must preserve independent channel semantics and must not couple renderers directly to provider format.

These follow-up items must preserve deterministic spatial identity, world-space stability, physical weather semantics, and the provider -> reconstruction -> sampling -> rendering separation.
