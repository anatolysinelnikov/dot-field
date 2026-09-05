# Dot Field Architecture

## Document status

- Repository: `anatolysinelnikov/dot-field`
- Architecture: reusable local real-data geographic weather sequence playback
- This document is maintained context, not implementation authority. The current code wins when they differ.

## Project model

This is a browser-native geographic weather prototype. It uses MapLibre GL JS in
Globe projection, a validated real-data precipitation sequence, a globally
anchored Mercator sampling topology, and projection-aware MapLibre custom WebGL
layers. The current active prototype exposes **RAW**, **Dots**, and **Squares**;
RAW is the initial mode and Dots remains available as a selectable mode. Blur
and Areas remain implemented in the repository but are intentionally inactive
pending future viewport-windowed scalar reconstruction.

The weather channels are always independent data channels:

- rain;
- thunderstorm (`storm` in code);
- hail.

The active renderer split is intentional:

```text
real geographic weather sequence
        |
        +-- direct source-grid cells ------------------------------> RAW
        |
        +-- discrete Mercator LOD
        |     +-- shared physical weather summaries --> Dots / Squares presentation mapping
        |
        +-- fixed L14 scalar lattice --> Blur / Areas (+ optional Smooth)
```

The scalar branch remains implemented for later reintroduction but is not part
of the current active application/runtime path.

## Experimental tiled-rain Phase 0A — non-default

The fixed-L13 direct contract described here is the Phase 0A parity baseline
for the opt-in tiled browser path. It exposes Dots and Squares through one
shared tiled runtime/residency owner. Both are presentation modes over the
same physical payloads; switching modes does not duplicate residency or
payload ownership. The non-motion runtime now adds automatic L11–L14 staged
assets as described below, while the motion-warp path remains fixed L13. The
baseline data flow is:

```text
normalized source generation (`data/generated/current/metadata.json`)
        ↓ offline fixed globally anchored L13 reconstruction
128 × 128 samples, UInt16 rain blocks of four frames plus optional aligned
UInt8 storm/hail severity blocks
        ↓ optional gzip sidecars through the local development server
bounded browser tile/block residency
        ↓ WebGL2 R16UI rain and R8 hazard texture arrays
one procedural tiled renderer → Dots or Squares presentation
```

`tools/generate-tiled-rain.py` reads only the normalized metadata and the exact
Float32 rain and Uint8 phenomena frame assets referenced by that metadata. It does not parse
NetCDF/provider data. Experimental assets are written to the ignored
`data/generated/tiled-rain/current/` directory. The manifest records the source
generation identity, and the browser verifies that identity against the current
normalized metadata before requesting any tile. A stale or invalid tile set is
an explicit error; the tiled path never falls back to geographic reconstruction.

The spatial contract is exact and globally anchored: sample identity is the
L13 integer pair `(i, j)` at `x = i / 2^13`, `y = j / 2^13`. Half-open ownership
assigns each sample to one 128-sample tile. Rain tile blocks retain their
documented frame-major, row-major UInt16 layout. Code 0 is NoData, code 1 is valid dry,
and codes 2–65535 linearly decode positive physical `mm/h` using
`(code - 1) / 65534 * physical_max_mmh`; the actual finite maximum is recorded
in the manifest. Presentation mapping remains in the shader and reuses the
Dots rain/strong-rain transfer anchors.

When the normalized v3 phenomena channel is available, each rain block may
also carry `storm` and `hail` descriptors with the same frame-major and sample
ordering. Their optional payloads are UInt8 severity samples decoded as
`code / 255`; an omitted descriptor is an all-zero channel. The generator first
maps codes 10/11/12 and 13/14/15 to the existing real-weather storm/hail
severity anchors, then reconstructs those continuous channels at the exact
global L13 samples. It never interpolates raw categorical codes and never
derives hazard severity from rain. The shared direct GPU tiled renderer linearly
interpolates the reconstructed A/B severity samples and applies the existing
Dots or Squares presentation rules, including hail-over-storm priority.
Hazard visibility is presentation-only. The motion-warp path keeps hazards
unavailable so it cannot display unwarped hazards over warped rain.

The tiled loader selects the conservative visible Mercator tile envelope with a
small deterministic L13 overscan, requests only the current frame pair's
blocks, and keeps a committed renderable frame pair while a newer requested
pair loads. A bounded eight-fetch queue cancels obsolete queued and in-flight
blocks; stale completions cannot commit. The ready-block LRU has a normal
320-block cache target. Protected target blocks are never evicted merely to
meet a fixed numeric ceiling; effective residency expands to fit them and
contracts back toward 320 after protection shrinks. CPU and estimated GPU byte
diagnostics use the actual maximum combined rain plus hazard payload size and
that effective protected bound. It uploads block payloads directly as
WebGL2 integer texture arrays without expanding the tile to Float32 arrays or
constructing per-sample JavaScript positions. Camera movement changes tile
orchestration; it does not reconstruct a weather field or rebuild a geographic
pyramid. RAW remains deferred. The fixed L13 contract and direct A/B
interpolation are the legacy Phase 0A baseline; automatic multi-LOD selection
and transitions are implemented by the staged runtime below.

Phase 0A intentionally does not solve temporal motion: the shader uses direct
`mix(rainA, rainB, progress)` interpolation. The tiled runtime constructs a
separate motion-free shader/program for this reference path; it does not
declare or bind MotionField samplers. Optical flow, advection, radar or model
motion, single/double warp, and materialized subframes remain deferred to Phase
0B.

## Staged multi-LOD tiled-rain assets — offline contract

The browser Phase 0A direct-rendering contract above remains the parity basis.
The offline generator `tools/generate-tiled-rain-lod.py` produces the ignored
`data/generated/tiled-rain-lod/current/` asset set with schema
`dot-field-tiled-rain-lod-v1` and manifest version 1. The fixed selected-level
browser foundation below now consumes this contract without changing the
legacy MotionField path.

The staged asset pyramid covers the active tiled display range L11 through
L14. L13 remains the physical reference level and stores direct UInt16 rain
plus optional UInt8 storm/hail severity samples using the existing Phase 0A
reconstruction, categorical severity mapping, and direct encoding semantics.
Its L13 tile envelope is compatible with the existing Phase 0A envelope and
the generated L13 direct payloads are byte-identical when the normalized
source generation matches. L14 independently reconstructs the normalized
physical source at exact globally anchored L14 identities; it is not an
upsample, subdivision, or interpolation of L13 transport values.

L11 and L12 are centered dyadic aggregate summaries of unquantized Float32 L13
physical samples. The complete selected support domain is
aggregated recursively before output tiling, so a 128-sample tile boundary
cannot change a weather value or become an aggregation edge. Their physical
summary transport uses two frame-major, row-major, four-component little-endian
Float16 planes: Summary A contains `rainWetMeanMmh`, `rainMaxMmh`,
`rainCoverage`, and `strongCoverage`; optional Summary B contains
`stormCoverage`, `stormMaxSeverity`, `hailCoverage`, and `hailMaxSeverity`.
Coverage `-1.0` in Summary A is the deterministic unsupported/NoData sentinel;
supported dry samples remain zero-valued. The hazard mean is intentionally
omitted because the currently active Dots and Squares paths reduce their
monotonic hazard presentation to coverage plus maximum severity. This is a
contract optimized for those current renderers, not a universal future
weather-summary schema.

All levels use 128 × 128 half-open global tile ownership, globally nested
sample identities, four-source-frame temporal blocks, exact source timestamps,
and deterministic gzip sidecars. The manifest records level-specific direct
versus aggregate encoding, support/generated sample extents, tile extents,
source generation identity, payload sizes, and Float16 fidelity diagnostics.
The non-motion browser path now consumes this staged set through automatic
zoom-driven selection of L11–L14. L11 is the weather floor even when the map
continues zooming out, and L14 is the weather ceiling. A diagnostic
`tiledRainLod=11..14` query remains a fixed-level override. Only the tiled
multi-LOD asset set omits L10; the map zoom limits are unchanged.

Only the 19 normalized source timestamps/frames are materialized. No
intermediate coarse temporal frames are generated; the existing temporal block
size remains unchanged. MotionField integration is deferred and is not part of
this asset-contract change.

MotionField remains bound to the existing Phase 0A L13 manifest and source
contract. The motion-warp assets likewise remain separately bound to the
existing Phase 0A L13 manifest and Phase 0B1 MotionField manifest; neither
pipeline is migrated to the staged multi-LOD schema here.

## Automatic multi-LOD tiled runtime — `src/engine/tiled-rain.js`

Non-motion `?tiledRain=1` loads the multi-LOD root manifest and maps the
existing logical geographic zoom to a clamped tiled weather level L11–L14.
The initial load uses the known `WEATHER_REGION.initialZoom` through that same
mapping, so automatic startup begins at the correct level without an artificial
L13 preload transition.
The diagnostic `tiledRainLod=11`, `12`, `13`, or `14` query selects a fixed
level and disables automatic selection. Each endpoint supplies its own grid
size, globally anchored sample identity, tile envelope, spacing
(`1 / grid_size`), temporal block descriptors, encoding, and direct physical
rain maximum. The loader requests only the current level's visible/overscan
tiles and source-frame block pair, plus one adjacent target while preparing a
transition.

The tile store is the single multi-LOD residency owner for both Dots and
Squares. A presentation switch changes only the procedural shader variant and
does not refetch or duplicate block payloads. Source-frame endpoints retain
the manifest's four-frame block semantics. Direct L13/L14 values preserve the
Phase 0A endpoint handling and UInt16 decoding, while aggregate L11/L12 values
use their Float16 summary planes. Runtime block identities include the LOD
level.

Aggregate L11/L12 blocks remain compact raw payloads in browser memory. Summary
A and optional Summary B are uploaded directly as WebGL2 `RGBA16F`
`TEXTURE_2D_ARRAY` textures with `HALF_FLOAT` data and deterministic
`texelFetch`; no CPU half-float decode or Float32 expansion is performed.
Summary A's rain coverage sentinel is validity state, not zero meteorology.
Dots derives each source-frame endpoint radius from the stored coverage and
mean/max summary, then applies the existing temporal radius interpolation and
hail-over-storm priority. Squares interpolates the stored renderer-facing
summary inputs and applies its existing monotonic transfer using maximum
hazard severity. Direct L13/L14 blocks continue to use compact `R16UI` rain
texture arrays and optional `R8` hazard texture arrays.

Residency retains the bounded eight-fetch request queue, stale cancellation,
committed renderable fallback, and LRU behavior. The normal ready target is
320 blocks. During preload or a transition, all required endpoint blocks are
protected and the effective allowed residency expands to fit that protected
set; it is not a fixed 640-block bound and does not depend on global L14 tile
count. Once protection shrinks, eviction returns toward 320. Diagnostics
expose stable, desired, pending-preload, and transition endpoint levels,
dynamic protected-cache bounds, and payload format.

Only adjacent levels transition: L11 ↔ L12 ↔ L13 ↔ L14. The complete target
visible/overscan state and the current source-frame block pair are loaded before
the fade starts. Dots preserve rain → strong rain → storm → hail pass order
across the two endpoint representations; Squares crossfade the two complete
representations. A direction reversal reuses resident endpoints, while a
continued jump chains adjacent transitions. Stale viewport/LOD completions
cannot promote state. MotionField and motion-warp remain on their existing
legacy L13 manifests, validation, residency, and shader path; `tiledRainLod`
does not alter them.

## Experimental tiled-rain Phase 0B1 — offline MotionField, non-default

Phase 0B1 adds a separate physical motion channel without changing the
browser/runtime path. Its boundary is intentionally replaceable:

```text
normalized rain frames + timestamps
        ↓ offline MotionEstimator (radar-derived v1 block matcher)
globally anchored sparse L13 MotionField
        ↓ compact per-spatial-rain-tile assets
future browser GPU temporal warp (Phase 0B2)
```

`MotionEstimator` consumes the physical Float32 L13 reconstruction produced by
the exact Phase 0A `reconstruct_frame` implementation. It does not operate on
the provider longitude/latitude grid, UInt16 transport values, presentation
colors, or browser tiles. The resulting `MotionField` is an independent
renderer-facing contract containing one forward `dx`, `dy`, and `confidence`
triple for every adjacent source-frame interval. It uses the same globally
anchored L13 integer sample identity as rain, with one node every 32 L13
samples. Displacements cover the complete source interval, are measured in L13
samples, and use increasing global x/east and increasing global y/south signs.
Each component is bounded to ±12 samples. Float32 little-endian assets store
interleaved `dx, dy, confidence`; unsupported, dry, ambiguous, or insufficient
evidence is represented by zero displacement and zero confidence.

The v1 estimator uses deterministic globally anchored approximately 512-sample
regional coarse searches, regional refinement, and a small local
approximately 16-sample-radius footprint search around each regional proposal.
Regions can therefore obtain different bounded proposals; no single global
vector is imposed on the field. A finite regional candidate is only a local
search proposal: local evidence may accept a motion-relevant node even when the
regional match itself was rejected, while an unaccepted regional result never
populates the MotionField directly. A strong accepted regional vector may still
be used only as the explicitly reduced-confidence fallback when local evidence
is insufficient. There is no nearest-neighbor fill across dry or unsupported
regions. It matches `log1p(rain_mmh)` with valid/NoData-aware mean absolute
error, requires rain structure, and derives confidence from overlap, signal,
improvement over a zero-motion baseline, and ambiguity margin. Estimator
details and thresholds are recorded in the separate motion manifest, so a
future radar-history, model-wind, DARTS, or hybrid estimator can replace it
without changing the MotionField contract.

Motion assets live under the ignored
`data/generated/tiled-rain-motion/current/` root, separately from Phase 0A
UInt16 rain assets. The motion manifest binds its content to both the normalized
`source_generation_id` and the SHA-256 of the exact Phase 0A rain manifest used
as the RainField basis. Each 128 × 128 rain tile packages the shared global
motion nodes at its 5 × 5 boundary-inclusive footprint for the 32-sample node
spacing; duplicated boundary
nodes are byte-identical because estimation occurs before tile packaging.
Deterministic gzip sidecars and reproducible per-interval quality diagnostics
are emitted alongside the raw Float32 payloads. Benchmark timings are kept out
of deterministic artifact content.

The browser remains unchanged in Phase 0B1 and continues to perform direct A/B
rain interpolation in the Phase 0A tiled path. No browser motion computation,
GPU warp, rain halo, model wind, radar-history prior, or materialized subframe
is introduced here. Future Phase 0B2 will consume this MotionField for GPU
temporal warp while preserving the browser as a bounded tile-residency and
GPU-presentation client.

## Experimental tiled-rain Phase 0B2 — opt-in GPU motion warp

Phase 0B2 consumes the existing offline MotionField without changing the
renderer-facing motion contract or the Phase 0A reference path. The normal
`?tiledRain=1` URL continues to use the original 128 × 128 UInt16 rain assets
and direct A/B interpolation. The experimental `?tiledRain=1&motionWarp=1`
path is a separate browser data path:

```text
Phase 0A encoded rain cores + 13-sample read-only halos
        + separate Phase 0B1 MotionField tiles
        ↓ bounded shared weather fetch queue
154 × 154 R16UI rain textures + manifest-derived RGBA32F motion textures
        ↓ confidence-aware manual GPU sampling
double backward warp -> existing Dots presentation mapping
```

Warp rain assets are generated separately under the ignored
`data/generated/tiled-rain-warp/current/` root. They are stitched directly from
the exact Phase 0A encoded UInt16 core samples: no reconstruction, decoding, or
requantization occurs. Each owned 128 × 128 core is surrounded by a 13-sample
halo derived from the MotionField ±12 component bound plus one bilinear tap
guard, producing a 154 × 154 stored footprint. Halo samples are read-only
sampling support and do not create sample identities or change half-open 128
sample tile ownership. At the outer declared Phase 0A tile bounds, halo samples
are explicit NoData. The warp manifest binds to the normalized source
generation, the exact Phase 0A manifest bytes, and the exact Phase 0B1 motion
manifest bytes.

The browser validates all three identities before requesting payloads. Rain
blocks and spatial MotionField tiles share the existing maximum of eight
in-flight weather requests. Rain remains bounded by the existing committed
target/cache lifecycle; successfully fetched motion tiles are spatial and may
remain resident for the immutable dataset lifetime. A new warp target is
committed only when its visible rain blocks and visible motion tiles are ready.
Diagnostics expose the separate logical and estimated GPU costs, with rain
allocation measured at the actual 154 × 154 size, plus motion request,
fetch, upload, and residency counters.

Motion is interpolated at each stable integer L13 rain sample from its four
surrounding globally anchored nodes. The validated MotionField manifest
supplies the node spacing and boundary-inclusive per-tile dimension (5 × 5
for the current 32-sample experiment); the GPU texture width and interval row
stride derive from that dimension. The interpolation is
confidence-weighted: zero-confidence nodes contribute neither a vector nor a
pull toward zero, while their weights reduce the interpolated confidence. The
shader performs deterministic manual UInt16 bilinear sampling for fractional
warp coordinates, treating code 0 as NoData and code 1 as valid dry; valid taps
are renormalized without using texture-edge clamping as a spatial substitute.
For interval progress `s`, the forward A -> B field is applied as a double
backward warp (`A(p - flow*s)` and `B(p + flow*(1-s))`), then blended toward
direct A/B interpolation by confidence. If the warp is unsupported or invalid,
the direct value is retained, and an unwarped location with no endpoint
support cannot gain precipitation through the warp. Explicit endpoint paths
make `s=0` exactly A(p), `s=1` exactly B(p), and equal endpoint frames remain
direct samples. Dot centers never move.

The renderer consumes the MotionField layout from the validated manifest and
does not depend on the estimator's implementation or a hardcoded sampling
density. The 13-sample rain halo remains unchanged because the displacement
bound remains 12 samples. There is no browser motion estimation, optical-flow dependency, temporal prior,
or materialized subframe. The browser remains a loader, bounded-residency, and
GPU-presentation client. The Phase 0B1 radar-derived estimator is replaceable;
Phase 0B2 depends only on the independent MotionField `dx`, `dy`, and
`confidence` contract. Future implementations can replace the estimator
without changing this downstream channel or the eventual renderer consumer.

The current data/runtime sequence is: (1) mutable discovery metadata pointing
to an immutable generation containing the full support sidecar and independently
delivered exact source frames, (2) viewport- and
LOD-bounded Dots/Squares topology, and (3) reintroduction of Blur/Areas after
viewport-windowed scalar reconstruction.

The spatial runtime separates provider/data bounds from the active render
window and from sample identity:

```text
provider/data bounds
        ↓
viewport + deterministic overscan
        ↓
active canonical topology window
        ↓
Dots / Squares
```

The viewport selects globally anchored canonical identities; it does not define
or reseat them. Panning therefore cannot change a sample's canonical ID,
canonical coordinates, Mercator position, geographic position, or weather value
at a given time. The active sequence's support is read from generated metadata;
it is not a historical JavaScript constant or a final global-provider contract.

The intended provider boundary remains:

```text
provider format -> validation -> temporal/spatial interpolation
-> geographic sampling/reconstruction -> rendering
```

`real-weather.js` owns CSV and sequence validation, physical typed-array
storage, and representation-independent geographic reconstruction. The active
sequence samples physical `rainMmh` bilinearly from four geographic source nodes
and linearly between its adjacent source frames; storm and hail are independent
channels, but the current rain-only sequence explicitly declares both unavailable.
Rain remains physical `mm/h` through interpolation, sampling, LOD reduction, and
scalar-lattice reconstruction; renderer presentation mappings may use the named
50 mm/h visual anchor but do not clamp the data field. The RAW midpoint-cell
diagnostic does not constrain this reconstruction. The legacy synthetic
`field.js` remains independent of MapLibre, WebGL, and UI but is not on the
active data path.

## Runtime ownership

```text
index.html + styles.css
        |
        v
app.js ----------------------> MapLibre GL JS / Globe camera and basemap
 |                                  |
 +-> geography.js -----------------------> real-weather.js ----> raw-weather-layer.js
 |       |
 |       +-------------------------------> geographic-lod.js --> geographic-weather-pyramid.js
 |                                                               +-> geographic-dots-layer.js
 |                                                               +-> geographic-squares-layer.js
 +-> retained scalar engine (inactive) ----> geographic-scalar-layer.js
```

### Application orchestration — `src/app.js`

`app.js` owns UI state, playback, timeline scrubbing, custom camera controls,
logical weather zoom, MapLibre construction, active-layer routing, and readouts.
At startup it begins the MapTiler configuration request and weather metadata
load independently. MapLibre is constructed as soon as its configuration is
available. Metadata and the small immutable support sidecar may load while the
basemap starts. After MapLibre renders the initial tiles, the application asks
only for source frame 0; weather custom layers are created as soon as that
frame is validated.
The active finite sequence uses the same scheduler with full source-frame
residency enabled. Playback becomes available after the initial three-frame
source buffer (0, 1, 2); the remaining frames then fill the same immutable
generation in the background. Initial rendering does not wait for all source
frames. The scheduler has one global fetch slot, not separate interactive and
background pools. Current-time and adjacent temporal requirements are HIGH;
full-sequence fill is LOW.
HIGH work is selected before queued LOW work, while a running fetch is allowed
to finish. If playback reaches an unavailable required pair, application time
holds at the last valid weather state until that pair is available, then
resumes. Manual scrub submits
the latest desired source-frame set under a replacement key, so queued
requirements unique to older finger positions are discarded before fetch;
Dots/Squares submit the requested and next renderer temporal times as one
deduplicated HIGH set. Map movement pauses new LOW work but never blocks
required current weather. After a manual or RAW scrub, the small rolling
playback horizon rebases to the selected time. Independent cooperative
rolling-horizon work may continue requesting nearby missing frames one at a time
as LOW work while full residency is incomplete; HIGH interactive requirements
always outrank it, map movement may pause new LOW work, and the automatic
full-sequence fill eventually makes all timeline requirements local hits.
Timeline jumps request their required source frames without blanking the last
valid weather. The request generation guard remains the final barrier preventing
late availability from committing an older timeline target. This is a
startup/network priority policy, not a renderer
dependency: weather initialization always reads the current camera viewport at
the time it runs. Startup diagnostics exposed at `window.__dotFieldStartup`
record metadata, support, first-source-frame, first-weather, background,
playback, topology, payload, and render milestones relative to module start.
It creates the RAW, Dots, and Squares geographic custom layers once after the
style loads and
changes their active state instead of recreating the map or layers when the
render mode changes. RAW is the initial mode and playback starts paused; the
selector order is RAW, Dots, Squares. The shared `Hazards` control is always
visible and is a presentation-only preference applied to RAW, Dots, and
Squares. The centered timestamp control is owned by the application and uses
provider metadata as its temporal authority. `GeographicScalarLayer` is
deliberately not instantiated or added to MapLibre in this temporary active-mode
configuration.

The MapTiler Dataviz Dark Globe basemap, native label and
administrative-boundary ordering, water tint/boundary context, camera controls,
reset behavior, and raw camera zoom constraints remain owned by the existing
MapLibre setup. MapLibre's default attribution control displays the style's
source attribution, and the application includes the linked MapTiler logo
required for Free accounts. Weather layers remain inserted below the promoted
context.

Local development and the static GitHub Pages deployment both load the same
runtime `config.local.json` shape. The ignored local file is supplied by the
developer; the Pages workflow writes the deployment key into the staged site
artifact only, without adding it to the repository.

### Local LAN compression verification

`scripts/generate-gzip-sidecars.mjs` and `scripts/serve-local.mjs` are
development-only test tooling, not production hosting. The preparation tool
invokes the generator against its unpublished staging directory before
publishing an immutable generation; the generator refuses `current`, published
generation directories, and manifests that already carry a `generation_id`.
It writes ignored gzip-level-9 `.gz` sidecars alongside the logical source frames,
support mask, and experimental `.u16` blocks. The manifest and normal
application request generation-relative `.f32` and `support.mask` URLs after
metadata discovery; the tiled-rain path requests manifest-relative `.u16`
blocks. To test
from a phone/tablet on the same LAN, run either mode from the repository root:

```text
node scripts/serve-local.mjs --host 0.0.0.0 --port 8000 --compression identity
node scripts/serve-local.mjs --host 0.0.0.0 --port 8000 --compression gzip
```

Open `http://<computer-LAN-IP>:8000/` on the device. The server prints a
detected Network URL when possible; it is intentionally an HTTP development
server and must not be exposed to the Internet. In `gzip` mode, a request for a
logical source URL such as `rain/frame-000.f32` receives its `.gz` sidecar only
when the client advertises `Accept-Encoding: gzip`, with `Content-Encoding: gzip`,
`Vary: Accept-Encoding`, and the encoded `Content-Length`. Browser fetch
transparently returns the original exact Float32 bytes; HTTP content coding is
transport behavior, not a provider-format change.

The same optional behavior applies to `.u16` tiled-rain blocks. The local
server does not add a compression dependency or alter logical asset bytes.

The preparation digest uses the `dot-field-generated-weather-v2` namespace for
the gzip-era artifact contract. Logical metadata and weather files determine
the digest; `.gz` transport bytes are excluded. This namespace bump means an
identical logical dataset prepared under the new contract receives a new
immutable generation ID, so already-published Brotli-era directories are never
mutated and old sessions remain able to resolve their original assets.

The finite source forecast maps normalized time 0 to the first provider timestamp and normalized time 1 to the last provider timestamp; the UI duration remains an application constant independent of provider frame count or timestamp spacing. Playback stops at the endpoint rather than creating a
final-to-first seam; pressing Play at the endpoint explicitly restarts it from
the beginning. The application commits the terminal renderer update before it
marks playback paused. The application creates adjacent 100 ms keyframes only
for the active representation, including an exact terminal keyframe; switching a mode
lazily synchronizes that representation to the exact global time before its
next repaint, while preserving time, play/pause state, camera state, and
logical weather zoom. Inactive layers retain lightweight topology/LOD state but
do not evaluate weather, rebuild instance data, or upload temporal GPU data.
Dots and Squares read out their active LOD/sample count. RAW uses the global
timeline as a discrete source-frame selector and never interpolates between
provider frames; entering RAW selects the nearest exact frame without changing
the stored continuous application time. A manual RAW timeline change commits
that exact frame time, while switching back without such a change restores the
previous continuous Dots/Squares time. Playback is disabled while RAW is active.
Dots and Squares retain continuous temporal interpolation. Blur and Areas retain
their fixed-support implementation for a later task but have no active UI or
runtime routing here.

The first Dots/Squares pyramid is created only after the initial camera-derived
window is available; it is never bootstrapped with a complete support topology.
Its materialized range is bounded by the stable display level: L10/L11 use
L10..L13, L12 uses L11..L13, L13 uses L12..L14, and L14 uses L13..L14.
L14 is currently the highest stable display level; L15 remains an explicit
engine/canonical level but is disabled from the normal application path. After
an adjacent LOD morph completes, a changed range is rebuilt at
the same window before any subsequent morph begins; range replacement is not a
visual LOD transition.

For Dots and Squares, each MapLibre camera move is converted to a conservative
Mercator envelope using the map bounds plus a deterministic 5 × 5 screen
unprojection lattice. The envelope expands by 25% of its span on every side,
adds at least one L10 interval of topology/aggregation safety margin, and is
snapped outward to L10-compatible boundaries in the global L15 integer
coordinate system. A move computes a new snapped target on every camera
update, but retains the current overscanned topology while it contains that
target. This deterministic window hysteresis keeps the visible viewport and
centered-aggregation margin covered; a target that exits the retained window
triggers the existing replacement. A pending window update is applied after an
active 0.2 s LOD morph completes, so a window shift is never represented as an
LOD morph.

The application-owned RAF runs only while playback advances or a 0.2 s LOD
transition is active. Paused map navigation and static updates use MapLibre's
own repaint scheduling; beginning or reversing an LOD transition wakes the
application RAF so its progress still completes while paused.

### Runtime performance diagnostics — `src/runtime-diagnostics.js`

The optional runtime diagnostics system is activated only by `?diagnostics=1`.
It owns the lightweight top-left HUD, session lifecycle, bounded rolling frame
timestamps, event collection, Resource Timing observation, IndexedDB
persistence, recovered-session lookup, and JSON export. It samples at 1 Hz and
flushes small batches to IndexedDB at approximately 2-second intervals; idle
maps do not receive a diagnostics-only RAF loop. The persisted session is
created uncleanly, and a prior session left unclean is exposed as `unclean` /
`abrupt` after a later diagnostics-enabled load. Retention is bounded to the
current session plus one previous session, with approximately 15 minutes of
samples and bounded events/resources.

The coordinator consumes the existing weather-loader scheduler snapshot,
application canonical-window timings, `GeographicWeatherPyramid` counters and
known typed-array sizes, and `diagnostics()` snapshots from RAW, Dots, and
Squares. RAW reports exact retained precipitation/hazard geometry bytes and
its existing geometry-build timings. Dots and Squares report active instance
sizes, capacities, lifecycle counters, and estimated Dot Field GPU buffer
bytes. Dots additionally reports exact temporal physical-summary bytes, mapped
presentation bytes, instance-writer allocation bytes, total tracked CPU bytes,
the packed active count for each direct level, and whether each active level is
`dense-summary` or `packed-direct`. The pyramid reports the exact known typed
array floor split between sampling geometry, centered contribution relations,
transition parents, and direct-transition relations. Weather Resource Timing
records retain sanitized same-origin relative paths and expose transfer,
encoded, and decoded sizes for gzip comparison.

The weather-loader diagnostics also expose generation identity, source frame
count and sorted resident indices, exact resident source bytes, the active
full-sequence versus bounded-LRU policy, fetch concurrency, HIGH/LOW queue and
cache counters, validation scans, eviction count, and
`fullSequenceLoadDurationMs`. RAW exact-frame diagnostics identify the selected
frame and confirm whether its `Float32Array` is the resident source payload;
RAW does not own a duplicate source frame.

In tiled-rain mode, the diagnostics source snapshot instead reports the tiled
source generation, visible/resident tile and block counts, pending requests,
logical UInt16 bytes, estimated GPU texture bytes, tile request/fetch/upload
counters, latest and cumulative texture upload timing, first tiled-weather
visible timing, evictions, the current source frame pair and shader progress,
and `sourceFrameStackFetched: false`. It also records direct tiled response
transport evidence: gzip/identity/unknown-encoding response counts, cumulative
`Content-Length` when exposed, logical fetched bytes, and the latest response
encoding. The normal source loader, RAW, Squares, and
`GeographicWeatherPyramid` are not instantiated on this path. The tiled
snapshot also exposes the eight-fetch concurrency ceiling, current in-flight
and queued work, ready/pending/total residency ceilings, peak in-flight and
residency, and aborted obsolete requests.

Export uses schema version 1 with session metadata, environment, limitations,
summary, samples, events, and weather resources. MapTiler keys,
`config.local.json`, MinIO credentials, and resource query strings/fragments
are not exported. Explicit tracked CPU metrics cover only known Dot Field
buffers/arrays; GPU values are estimates of Dot Field-owned WebGL buffers;
total Safari/WebContent memory and CPU/GPU utilization remain unavailable from
page JavaScript. Optional `performance.memory` values retain their browser-
specific origin.

## Real-data geographic adapter — `src/engine/real-weather.js`, `src/engine/geography.js`

The reusable local workflow is:

```text
MinIO/S3 provider
→ local authenticated downloader
→ data/nc/
→ strict offline NetCDF normalization
→ data/generated/<generation-id>/ plus data/generated/current/metadata.json
→ browser loading/interpolation/sampling
→ renderers
```

The provider-ingestion boundary is local-only: `tools/download-latest-real-weather.py`
connects to the configured MinIO/S3-compatible endpoint, selects the newest valid
`YYYYMMDDHHMM.nc` object by filename timestamp, and atomically downloads it into
the ignored `data/nc/` directory. Credentials are read from
`~/.config/dot-field/minio.json`, outside the repository and browser-accessible
files. The downloader has no NetCDF parsing or weather-field responsibility.

The complete preparation path is:

```text
MinIO/S3 provider
→ local authenticated downloader
→ ignored data/nc/
→ strict offline NetCDF normalization
→ ignored data/generated/<generation-id>/ plus metadata-only current/
→ browser loading/interpolation/sampling
→ RAW / Dots / Squares
```

NetCDF parsing remains offline/local preprocessing. The preparation command
selects the newest local `YYYYMMDDHHMM.nc` by filename timestamp, invokes the
existing converter in strict `--sequence` mode, and generates gzip sidecars
in an unpublished staging directory. It validates that complete staging
output, derives a content-based generation ID, rewrites manifest asset paths to
`../<generation-id>/...`, publishes that directory atomically, and only then
atomically replaces the metadata-only `data/generated/current/metadata.json`
discovery pointer. The browser consumes the normalized v2 binary transport
(`metadata.json`, `support.mask`, and Float32 frame assets), never the `.nc`
file. Raw NetCDF files and generated assets remain outside Git. The checked-in CSV is retained only as a reproducible legacy/sample fixture for hazard debugging and targeted verification. If the
deterministic generation already exists, preparation verifies its metadata,
logical assets, and gzip sidecars before reusing it; it never overwrites a
published directory. Any future automatic periodic scheduling should remain a
thin layer around this same updater. No renderer or weather-field semantics
change in this flow.

`data/generated/current/metadata.json` is mutable discovery only. A loaded
manifest's `generation_id` and relative asset paths pin a browser session to
one immutable generation, so later publication cannot change the source bytes
used by an open page or cause an evicted frame to be loaded from another
dataset. Published generation directories are intentionally retained; cleanup
or garbage collection is out of scope because old pages may still request
their generation's frames.

Preparation must explicitly verify and declare physical precipitation units when the source does not provide unambiguous units; the converter rejects missing or ambiguous units without that explicit assumption.

The v2 manifest declares little-endian physical Float32 `mm/h` rain frames;
dimensions, timestamps, crop, union support, and frame addresses are all
dataset metadata. Generated manifests may additionally expose a
provider-layer `generation_id`; the loader preserves it in source diagnostics
without using it as renderer state. Its support is derived from the exact
positive union across
every source node and frame, without connected-component selection. The loader
validates the mask node/byte count and its zero trailing unused bits before
canonical topology initialization; it never rebuilds support by downloading
all frames. Each requested source frame is independently validated for exact
byte count, Float32 alignment, finite non-negative values, and metadata
compatibility. A 404/410 metadata/support/frame failure remains an explicit asset-unavailable error. Geographic axes are constructed deterministically from
metadata.
`RealWeatherSequence` keeps
the existing bilinear spatial sampler and presents temporal frames that
linearly blend source frames. For regular row-major rectangular canonical
levels, prepared geometry is a compact axis-separable descriptor: one source
column index and one Float64 longitude fraction per canonical column, plus one
source row index and one Float64 latitude fraction per canonical row. The
row-major canonical index remains implicit, so the retained lookup storage is
O(width + height), rather than a dense source-cell index and two fractions per
sample. The sequence derives its potential-active set during the same packed
axis traversal. Sequence geometry lazily owns a bounded four-entry LRU of
Float64 spatial rain arrays aligned with its potentially-active canonical
indices, keeping the adjacent source-frame pair needed by playback while
allowing old frames to be recomputed after wide scrubs. Providers that cannot
accept this rectangular contract, and the sequence's arbitrary point-batch
API, retain the dense generic fallback.
These arrays are computation caches rather than a new weather representation;
the single-point sampler remains the semantic reference path. The provider-grid
source-frame cache is a deterministic Float32 residency store. The active
source policy retains every validated frame in the finite generation after the
initial buffer; its resident payload is therefore derived from metadata as
`frameCount × frameByteLength`. The bounded LRU remains available only as an
explicit lower-level compatibility/test configuration. Browser HTTP cache can
improve transport latency but is never a required second frame store. Frame
availability is asynchronous only at the provider loading boundary: once the
latest required frames are available, provider temporal reconstruction,
pyramid evaluation, and renderer updates remain synchronous.
Each downloaded payload is byte/value validated before entering the residency
store. Full-residency frames are never re-downloaded, revalidated, or evicted
by timeline interaction. A source frame is never asynchronously evicted during
a synchronous evaluation. The prepared spatial rain cache remains a separate
bounded four-entry cache and is unchanged by source-frame residency.
The normalized v3 transport retains the full provider `phenomena` channel as
one aligned Uint8 frame per source timestep. Its self-describing GIMET-2010
codebook preserves codes 0–19 and 31 (`missing / NoData`); provider categories
remain separate from downstream continuous presentation severity. The current
renderer derives thunderstorm severity from codes 10–12 and hail severity from
codes 13–15. Other retained codes are future presentation inputs and are not
rendered yet.

The timeline may visualize actual resident source-frame pairs as muted blue
segments inside its existing track. Residency snapshots and change callbacks
come from the loading/provider layer; the app converts adjacent resident
indices to visual intervals without changing timeline semantics, playback
scheduling, or source-loading policy. Non-sequence compatibility/test fields
leave the track neutral. RAW continues to hold its currently selected exact frame
for behavior-preserving geometry updates; source diagnostics expose that payload
separately, including whether it is outside the sequence LRU after eviction.

### Physical weather-summary profiles

`geographic-weather-pyramid.js` retains the generic hazard-capable physical
summary contract: weighted rain, maximum rain, all seven rain-coverage
thresholds, and storm/hail coverage, weighted severity, and maxima. Providers
may explicitly advertise the `rain-only-display` summary profile. The prepared
real-weather sequence uses the generic profile when its normalized phenomena
channel is available, even when a particular frame contains no active hazard.
Provider/engine capability is separate from availability in the currently
loaded dataset. Selection is never a renderer choice
or an inference from a zero-valued frame.

That compact profile is shared by Dots and Squares and contains only weighted
rain, maximum rain, and coverage weights at 0.05 and 2.5 mm/h. Its mutable
Float32 temporal fields therefore use 16 bytes/sample, rather than the generic
hazard-capable 60 bytes/sample. `totalWeight` remains a separately cached,
shared Float32 array and is not duplicated into temporal summaries. Compact
summaries deliberately have no storm or hail arrays: their absence means those
physical channels are unavailable, so renderers map their hazard output to zero
without owning provider semantics. Generic and future hazard-capable providers
continue to use the full contract. Renderers resolve each profile-supported
rain coverage array once before their sample loop; temporal reconstruction
remains provider-owned.

Renderer layouts are selected once from that explicit physical profile, not
from the Hazards UI preference. Rain-only datasets map Dots to rain/strong
radius arrays only and use the compact Squares program/instance record
`centerXY + rainWetMean/coverage` for both temporal endpoints (6 Float32,
24 bytes/sample). Full hazard-capable datasets retain Dots storm/hail radii,
the complete Squares hazard mapped fields, and its existing 18-Float32 layout.
The Hazards checkbox remains presentation-only: it gates hazard compositing on
full data and causes no data/layout rebuild on a rain-only dataset.

During an active L12/L13 transition, a temporal keyframe that must rebuild both
levels is evaluated as one multi-level pyramid request, then mapped into the
separate per-level renderer states. This preserves per-level temporal promotion
and transition ownership while allowing L12 to aggregate from the same retained
L13 physical summary. Other transitions retain their existing independent
sampling behavior.

`geography.js` is the application-facing weather adapter and loading
orchestration layer. Metadata and support loading may begin before MapLibre
initialization, but the application controls when the first source frame is
requested. Source frame 0 is normally requested after the application marks
the initial basemap ready; the resulting sequence is then activated by the
geography adapter. It converts the shared point interface to geographic longitude/latitude. Generated real-weather assets are required by the application; metadata, support, frame availability, inconsistent values/geometry, incorrect support, and incorrect source-frame lengths fail visibly rather than selecting a CSV runtime fallback. The active sequence's `spatial_grid.weather_support` is the
stable grid-aligned support rectangle used for canonical topology creation.
The availability GeoJSON is optional diagnostic observation coverage only, not
a forecast-rain mask; later forecast frames may legitimately leave its
footprint. The deterministic globally anchored Mercator topology derives all
L10–L15 identities from the active metadata support. Dots and Squares materialize
only the current snapped viewport topology window plus its coarse safety margin
and the LOD dependency range required by the active display level. The runtime
never intentionally materializes the complete provider-support topology.
Changing either bound changes only which globally anchored identities are
materialized, not grid anchoring, canonical identity, target spacing, LOD
levels, or parent/child relationships. The full local sequence retains every
positive source node; the converter derives its crop in a first pass and
streams the second-pass crop without loading all frames at once.

## RAW source-grid diagnostic — `src/engine/raw-weather-layer.js`

The source-of-truth weather data is defined at geographic source nodes. RAW is a
separate exact-frame diagnostic representation on the metadata-defined exported provider grid: it interprets each source-node value as a
piecewise-constant midpoint cell
(half-spacing at the outer edges), draws raw `mmh > 0` cells as solid opaque
blue. The rain-only sequence has no storm or hail, so RAW has no phenomenon
markers. These RAW cell boundaries are diagnostic, not assumed meteorological
boundaries. Dots, Squares, Blur, and Areas use the shared reconstructed field;
RAW itself does not interpolate between source frames or source nodes. RAW never calls the
shared bilinear sampler, Mercator LOD, L14 scalar lattice, reconstruction,
smoothing, aggregation, or renderer mappings. The layer stores only nonzero
drawing geometry for performance; zero cells remain inspectable through the
provider's direct regular-grid cell lookup.

RAW interaction is application-owned: pointer coordinates select the source cell
directly from the loaded longitude/latitude axes, including zero-valued cells.
Hover shows a diagnostic tooltip and click/tap pins it; Escape, outside clicks,
or clicking the selected cell again dismiss it. Tooltip values are raw source
coordinates, three-decimal mm/h, and integer phenomenon codes. The sequence
adapter exposes `exactSourceFrameAt(index)`, which returns a cached frame object
sharing immutable axes, cell bounds, and channel metadata while selecting the
corresponding source-value slice. The layer updates its existing buffers when
the exact frame changes, so RAW remains a source diagnostic without rerouting
through temporal interpolation.

The shared `Hazards` preference only controls presentation: RAW skips or draws
storm/hail geometry, Dots skips or draws hazard glyphs, and Squares gates only
the hazard shader compositing. Physical hazard summaries and packed instance
values remain intact, and changing the preference does not trigger weather
evaluation.

## Shared geographic Mercator topology — `src/engine/geographic-lod.js`

The discrete topology is a globally anchored dyadic grid in normalized
Web-Mercator coordinates. A sample identity is its integer L15 canonical
coordinate pair, so inherited vertices retain identity through LOD refinement.
`selectMercatorGridLevel()` is the canonical spatial authority. Each selected
level is a compact descriptor (`level`, `spacing`, `identityScale`, integer
`minI/maxI/minJ/maxJ`, `width`, `height`, `count`, and the canonical window).
Sample identity and indexing are implicit arithmetic conversions between
`(index)`, `(i,j)`, and the global L15 canonical coordinate pair. Mercator X/Y
positions are derived from `(minI + column) * spacing` and
`(minJ + row) * spacing` when consumed; no dense per-sample position array,
per-sample JS objects, geographic coordinate arrays, or string IDs are retained
by level descriptors.
The camera never reseats the grid. Canonical identity resolution remains L15,
while the current maximum displayed Dots/Squares level is L14. L15 is
intentionally disabled from the active application path for now; the engine
retains its explicit L15-capable topology and summary algorithms. Logical
sampling zoom is application-owned and latitude-corrected for Globe camera behavior. An explicit
active window is represented by inclusive L15 integer bounds, snapped outward
to the coarsest L10 interval. A topology also has an explicit contiguous LOD
range; it builds only the requested levels and only the transition parents,
compact direct adjacent-transition relations, and compact centered aggregate
relations whose endpoints exist.
When lower levels are requested, the complete L13→L12→L11→L10 dependency chain
is required; missing levels fail clearly. Thus panning and rotating do not
alter displayed weather density or sample identity, while low display LODs do
not allocate unnecessary finer-level topology beyond their active dependency
range.

## Shared physical weather summaries — `src/engine/geographic-weather-pyramid.js`

The application owns one `GeographicWeatherPyramid` and passes it to both Dots
and Squares. It is representation-independent and uses the canonical samples from
`selectMercatorGridLevel()` but has no dependency on Dots radii, Squares
opacity/color, glyph geometry, WebGL, UI state, presentation mappings, or
hazard-renderer functions. The parsed provider grid is anisotropic geographic
data. `WEATHER_REFERENCE_LEVEL = 13` is the explicit direct/aggregate boundary in the engine; it is not inferred from one dataset’s spacing. L13, L14, and L15 independently evaluate
their own canonical geographic coordinates through the bilinearly reconstructed
physical field. The active application evaluates through L14; explicit engine
verifiers retain L15 coverage. The pyramid lazily owns one reusable provider sampling geometry
for each direct canonical level, so source-cell lookup is not repeated for each
weather frame. For sequence data, that geometry also owns the lazy sparse
provider-frame spatial cache described above; it is invalidated with the
geometry/configuration and is not renderer state. L13/L14 and explicit engine
L15 remain independent direct samples of the reconstructed field; the cache does not
couple temporal summaries or renderers. L14 and explicit engine L15 add
sampling resolution, not meteorological information.
Only L12 through L10 are recursively aggregated spatial summaries from L13;
they are never direct field samples or values from an existing renderer pyramid.

The shared pyramid can replace its active canonical topology or contiguous LOD
range when the retained camera window or stable display level changes. A
canonical-window change is a hard spatial-compatibility boundary: all packed
levels, provider sampling geometry, source-frame caches, temporal summaries,
mapped arrays, and instances are discarded before the new window is evaluated.
For a range-only replacement at the same canonical window, the topology reuses
the exact immutable packed `levelData` objects for overlapping levels when
level, window, integer bounds, dimensions, spacing, and count all match. It
likewise reuses transition-parent and direct adjacent-transition relations when
both endpoint objects are retained. Removed levels become unreachable;
new levels are constructed normally.

Centered aggregation relations and geometric `totalWeight` arrays use bounded
caches keyed by relative dyadic structure (level pair, dimensions,
origins/parity, and clipping shape), never absolute geographic position. A
relation retains compact X- and Y-axis candidate tables: each fine column and
row stores its valid local coarse indices and its untrimmed one- or two-anchor
cardinality. The production evaluator combines those tables in the exact
X-outer/Y-inner order, clips support-edge candidates, and applies the same
per-child normalization as the reference dense relation. Thus retained
aggregation topology is O(width + height), with no offset array, parent-index
list, or Float64 weight per fine sample. Dense contribution construction is
kept only by verification/benchmark reference paths; production cache hits do
not perform an O(sample-count) topology verification traversal. Differently
shaped support-edge windows rebuild their compact relations. Range-only pyramid
replacement carries sampling geometry and its compatible source-frame spatial
cache only when the exact packed level object is retained; this preserves the
provider's prepared lookup and potential-support state without coupling the
provider to a renderer.

Dots and Squares receive the same replacement topology. Their active temporal
states, mapped arrays, and packed instances are retained only when the
canonical window and corresponding immutable `levelData` objects are
compatible. Thus an adjacent transition can promote its already prepared
destination keyframes through the following stable range adjustment without a
second weather evaluation. Reversal retains both endpoint states. Any
incompatible level or window clears the affected state and evaluates the new
configuration at the current weather time. Blur and Areas intentionally do not
use this state: they remain implemented but inactive on the existing fixed
support-derived L14 scalar lattice until viewport-windowed scalar
reconstruction is implemented.

For a multi-frame sequence, the separate packed `support.mask` sidecar delivers
one immutable sequence-wide potential-weather source-node union: positive rain
or a valid non-background phenomenon code 1–19. Code 0 is background and code
31 is NoData; neither contributes support. It is decoded
independently of full source-frame residency and is available before the
complete finite sequence has loaded. Each prepared canonical geometry derives
its potentially-active sample set from this immutable support mask; full
source-frame residency is not required to construct the union. Direct weather
evaluation visits only that potentially-active set; samples guaranteed dry for
the entire sequence remain zero. The pyramid propagates the static set through
its centered aggregate topology, while topology-derived `totalWeight`
arrays are computed once per topology and retained across temporal keyframes.
Aggregation therefore skips guaranteed-dry child statistics but preserves every
dry child in the cached denominators and retains the same summary API and
representation-independent physical semantics.

The sequence geometry owns bounded four-entry prepared spatial source caches,
but the active loader retains every validated rain `Float32Array` and aligned
phenomena `Uint8Array` in paired source-frame maps for the life of the immutable
generation. It does not retain a normal-runtime temporal rain or category array.
A provider frame exposes a prepared temporal sampling capability through
`geography.js`; the current sequence implementation captures prepared Float64
rain, storm-severity, and hail-severity arrays and performs the existing linear
interpolation when a summary consumer requests each active value. The capability is provider-owned so a
future deterministic motion/advection-aware reconstruction can replace linear
interpolation without changing the pyramid or renderers. `samplePreparedBatch()`
remains a lazy compatibility/diagnostic path and allocates its temporal scratch
only when explicitly called.

For the explicit rain-only prepared temporal capability used by the current
local sequence, a coarse-only request for L10, L11, or L12 fuses temporally
reconstructed L13 rain values directly into the L12 summary through the same
centered L13→L12 compact relation. This path does not materialize an L13
summary object or a full temporal rain array; it retains the cached L12 total
weights, tests coverage thresholds against the unrounded physical values, and
applies the existing Float32 L13 storage boundary before weighted sums and
maxima are accumulated. L12→L11→L10 then uses the existing recursive
aggregation. Requests that include L13, providers without this explicit
rain-only capability, and direct levels without a potentially-active set retain
the dense direct-summary fallback, including storm and hail channels. For
direct levels above L13 with a potentially-active set, the pyramid instead
returns a packed direct physical state: canonical active indices remain in
row-major order and rain/storm/hail channel values plus compact coverage masks
are aligned to that list. This state is extensible to independent future
weather channels and contains no full-topology `totalWeight`, weighted-
statistic, or per-threshold arrays. Dots and Squares map packed direct values
into packed presentation arrays; they do not expand L14 back to the rectangular
topology. L13 remains the weather-reference/aggregation boundary and may
remain dense, so an L13→L14 transition intentionally supports mixed
dense-reference and packed-direct temporal state while using the existing
canonical direct-transition relation. Consequently high-LOD temporal CPU
memory scales with potentially-active samples and the two adjacent keyframes
rather than the full L14 rectangle. The active source sequence retains all
validated source frames after the initial three-frame buffer, filling the
remaining finite sequence in LOW-priority background work. HIGH interactive
requirements remain ahead of that fill until completion; after completion,
arbitrary scrub and backward replay require no source fetch. The full source
payload set is a separate memory domain from bounded derived renderer/LOD
state: it does not multiply summaries, temporal keyframes, packed instances,
or renderer-specific copies by frame count. The current LOD materialization
ranges remain `L10..L13` for stable L10/L11, `L11..L13` for stable L12,
`L12..L14` for stable L13, and `L13..L14` for stable L14; the packed L14
representation, L14 ceiling, and visual semantics are unchanged.
Immutable-generation cleanup/GC remains unrelated to this browser
source-residency policy.

```text
provider source grid
        ↓
bilinear reconstructed physical field
        ↓
L15 direct sample
L14 direct sample
L13 direct/effective reference sample
-------------------------------
L12 centered spatial summary
L11 centered spatial summary
L10 centered spatial summary
```

Each generic summary contains 15 per-sample `Float32Array` fields
(60 bytes/sample): `rainWeightedSumMmh`,
`rainMaxMmh`, seven `rainCoverageWeight` arrays for the physical thresholds
0.05, 0.10, 0.30, 1.00, 2.50, 10.0, and 50.0 mm/h,
`stormCoverageWeight`, `stormWeightedSeverity`, `stormMaxSeverity`,
`hailCoverageWeight`, `hailWeightedSeverity`, and `hailMaxSeverity`. Means are
derived as weighted sum divided by the separately cached `totalWeight`; they
are not stored. Rain remains physical mm/h, including values above 50 mm/h. Coverage arrays retain
distribution information that a mean alone would lose, and hazard maxima are
retained alongside coverage and weighted severity.

Aggregate-side centered relations are separate from LOD transition ownership.
They exist only for L13→L12→L11→L10. An aligned fine coordinate contributes with weight 1; a half-step
coordinate splits 0.5/0.5 on that axis, with X/Y weights multiplied. Candidates
outside the finite selected support are omitted and the remaining weights for
that fine sample are divided by their sum, so every child retains total support
weight 1. The compact relation preserves the dense reference's X-outer,
Y-inner candidate order, including one-cell support-edge/corner clipping. For
each child summary contribution `w`, all additive statistics and
coverage weights receive `w * child.totalWeight` or `w * child statistic`, and
maxima retain the maximum over positive support. This makes the summaries
recursively composable without re-thresholding child means. The summary storage
choice was validated against an equivalent Float64 calculation across the
complete L10–L15 topology, deterministic fixtures, recursive composition, and
the real weather snapshot; the verifier records field-specific absolute and
relative error bounds. Contribution weights remain Float64 because their
topology is shared and their smaller memory cost does not justify a precision
tradeoff.

Storm and hail are never inferred from precipitation: they are derived only
from the categorical phenomena channel, while the categorical code remains
available on exact source frames. Dots and Squares map these same summaries into
renderer-owned compact presentation buffers;
neither renderer recursively aggregates radii, colors, opacity, or hazard
glyph values. For sequence summaries, the mapped buffers retain canonical
indexing but evaluate only `potentialActiveIndices`; guaranteed-dry entries
remain zero and stable/transition instance builders skip permanently invisible
samples. L14 and L15 sample the reconstructed field directly and
independently; neither interpolates a lower discrete summary.

Only the active discrete renderer retains temporal summary/mapping buffers;
switching away releases that renderer's temporal state while retaining the
shared topology and reusable GPU capacities. A range-only topology replacement
does not by itself release compatible active renderer state; canonical-window
replacement remains the explicit invalidation boundary.
Within an active Dots or Squares renderer, temporal state is owned per LOD
level: a stable renderer retains the current level's frame 0/frame 1 summary
and mapped state, while a transition retains those states for both `fromLevel`
and `toLevel`. Starting an adjacent transition preserves the prepared source
and evaluates/maps only a missing destination level. Completion promotes the
prepared destination state without reevaluating it; reversal swaps transition
ownership and reuses both level states. When the temporal frame advances, each
active level promotes its previous next frame and prepares only its missing
future frame.

## Dots — `src/engine/geographic-dots-layer.js`

Dots map each shared physical summary after it is produced. Base rain uses
`spacing * sqrt(rainCoverage) * rainMmhToRadiusFraction(wetMeanMmh)`, where
coverage is the shared 0.05 mm/h coverage and wet mean divides the rain weighted
sum by that wet support. L13, L14, and L15 are direct point samples and use the
exact strong-rain presentation mapping from physical `rainMmh`. Coarse L10–L12
strong-blue uses shared 2.5 mm/h coverage plus the retained peak:
`spacing * sqrt(strongCoverage) *
dotsStrongRainMmhToRadiusFraction(rainMaxMmh)`. Dots strong-blue saturation is
now a fixed 35 mm/h presentation setting; the temporary tuning slider and
mutable state were removed. Coarse storm/hail glyphs use independent shared coverage,
positive mean severity, and retained maximum severity; the presentation severity
retains the peak, coverage scales glyph area, and hail wins only when its mapped
glyph is visible. Direct L13/L14/L15 hazards retain the existing
`geographicHazardRadii()` mapping.

`GeographicLodTopology` in `geographic-lod.js` owns compact canonical grid
descriptors and the deterministic one-parent child ownership used only for
Dots geometric morphing. Mercator positions for instance construction are
derived arithmetically from each descriptor and sample index.
That mapping is deliberately separate from the centered multi-parent weather
contribution topology. Parent ownership is packed as CSR
`childOffsets/childIndices` plus `parentIndexByChild`, preserving parent-major
and fine-row-major iteration without an array of child arrays. Direct adjacent
LOD transitions use a compact deterministic arithmetic relation: it references
the two immutable level descriptors and keeps only O(width + height) axis
metadata, emitting all lower samples row-major and then higher-only samples
row-major without materializing an `Int32Array` pair stream. A shared identity
is an aligned canonical coordinate inside both selected rectangles, so clipped
edges remain exact. This direct visual relation is distinct from hierarchical
transition-parent ownership and centered weather aggregation. LOD transitions
therefore keep canonical identity/order, world-space positions, and no-grid-
jump behavior.

The application and Dots/Squares retain compact level descriptors rather than
sample arrays. Provider sampling geometry derives the regular packed grid axes
separately: longitude and source-column lookup are prepared once per column,
latitude and source-row lookup once per row, and the row-major sample index
combines those axis lookups at sampling time. The regular sequence therefore
does not retain a dense per-sample source-cell index or fraction arrays. It
still does not materialize dense geographic coordinate batches or one
geographic coordinate array per canonical sample in topology; generic
non-rectangular providers retain their appropriate dense fallback.

The custom MapLibre layer draws instanced Mercator-space circles, storm stars,
and hail hexagons with MapLibre's `projectTile` projection path. Its 0.2 s LOD
transitions use deterministic parent/child topology below/equal to L13 and
direct adjacent-relation refinement for the active L13↔L14 transition. The
engine retains the direct L14↔L15 relation for explicit future configurations.
Dots retain the stable same-level temporal/mapped state for a source LOD while
a transition builds the required pair representation; promoting a destination
therefore only performs the unavoidable same-level instance pass. A subsequent
same-window stable-range replacement retains the promoted temporal/mapped state
and compatible packed instances, so it does not reevaluate the destination.
Reversals reuse physical and mapped states and rebuild only the
direction-specific pair instance representation.
Rain glyph radii use the shared monotonic physical anchor transfer in squared
radius/visual area; the light-blue base saturates at 0.86 spacing near 10 mm/h,
while the nested Dots-only strong-blue overlay starts visually at 1.6 mm/h and
uses a fixed monotonic squared-area shape stretched from that onset to 35 mm/h.
This fixed presentation setting does not affect other renderers.

## Squares — `src/engine/geographic-squares-layer.js`

Squares use the same active globally anchored L10–L14 Mercator topology and
shared physical summaries as Dots, but map them into square color and opacity.
The canonical topology and renderer algorithms remain capable of explicit L15
evaluation, but the normal application path stops at L14.
Mapped arrays retain canonical indexing, while sequence summaries pack only
their static `potentialActiveIndices` into GPU instances; every retained sample
instantiates a square centered on its Mercator grid point and guaranteed-dry
canonical samples have no instance because their weather alpha is always zero.
the cell side equals the active grid spacing. Geometry is projected by the same
MapLibre custom-layer shader path, so it follows Globe curvature, pitch,
bearing, perspective, pan, and depth. Rain color/strength uses wet-area mean
rain; its visibility is the existing rain transfer multiplied by 0.05 mm/h
coverage. Storm/hail retain coverage, positive mean severity, and maximum
severity as separate attributes; coverage controls contribution while mean/max
control strength, with hail composited after storm. LOD changes crossfade the
deterministic parent and child cell sets during the existing 0.2 s transition;
no new grid is created and no camera-dependent identity is introduced. Rain square visibility and
light-to-strong blue color use the same physical rain transfer anchors as Dots;
rain values above 3 mm/h therefore remain distinguishable through the
progressive strong-color transfer. Squares assign each active LOD to one of
two reusable instance groups. A transition builds and uploads only its new
destination group; completion promotes that group as stable, and reversal
swaps group ownership without repacking or reuploading unchanged data. A
same-window stable-range replacement retains that promoted group and its two
prepared temporal keyframes when their packed level object is unchanged;
canonical-window changes clear both groups as incompatible.
Temporal updates dirty only groups whose mapped frame data changed.

## Fixed scalar reconstruction — `src/engine/geographic-scalar-lattice.js`

Blur and Areas share one explicitly fixed `SCALAR_GRID_LEVEL = 14` lattice.
The scalar lattice remains independent of the discrete maximum display LOD. Its
inactive fixed-support implementation can be large because allocation scales
with dataset support; viewport-windowed scalar reconstruction is required
before Blur/Areas can be safely reactivated.
Its rows,
columns, Mercator positions, and triangle indices are created once from the
globally anchored geographic topology and cached for the life of the layer.
Panning,
rotation, pitch, resizing, and ordinary camera zoom only reproject this mesh;
they do not rebuild it or reevaluate weather values.

Each temporal keyframe evaluates the bilinearly reconstructed source field at
those fixed L14 vertices using the prepared geographic field. Smooth state and
coverage remapping are computed only for Areas with Smooth enabled. Both Blur
and Areas pack the selected L14 channel values into two reusable RGBA32F
textures sized exactly to the inactive support-derived lattice; the fragment
shader performs explicit four-texel bilinear sampling from those textures. The indexed mesh is
surface/projection tessellation only. The scalar mesh is a surface-attached
MapLibre custom 3D layer.

Dots, Squares, and Scalar share the same 100 ms temporal-frame boundary helper
and MapLibre/WebGL projection-uniform helper. Squares retain CPU and GPU
instance capacity across updates, and Scalar retains its two fixed-size CPU/GPU
texture pairs; only data contents are updated for ordinary keyframes.

## Blur — `src/engine/geographic-scalar-layer.js`

In Blur mode the fragment shader bilinearly reconstructs rain/storm/hail from
the shared unsmoothed L14 textures, then applies the continuous physical rain
visibility transfer: a soft 0.05 mm/h onset, clearly readable light rain near
0.30 mm/h, and a progressive light-blue to strong-blue transfer from 2.5 to
50 mm/h. Magenta storm and yellow hail remain composited above it, with hail
last. The indexed triangles do not define scalar geometry, and no per-vertex
weather attribute buffer is used.

## Areas reconstruction and Smooth — `src/engine/geographic-scalar-layer.js`, `src/engine/geographic-scalar-lattice.js`

Areas uses the same shared L14 RGBA32F textures and explicit four-texel
bilinear reconstruction as Blur. With Smooth off, this raw L14 → bilinear field
is mapped through five physical rain bands at 0.10, 0.30, 1.00, 2.50, and
10.0 mm/h (`#0090FF` through `#0000FF`), storm/hail thresholds, translucent
magenta/yellow fills, hail-over-storm order, and derivative-based edge
treatment. The default Areas field therefore differs from Blur only by
transfer semantics, not by scalar reconstruction; values above 10 mm/h use
the darkest discrete rain band.

The two texture arrays and two GPU textures are allocated lazily and retained
for the life of the layer. On ordinary 100 ms temporal advancement, the
previous state1 texture becomes state0 and only the new state1 texture data is
rewritten and uploaded. Mode switching and arbitrary timeline jumps rebuild the
same reusable L14 texture pair, so Blur, Areas, and Areas Smooth cannot retain a
stale reconstruction path.

The static L14 indexed triangles remain projection-only surface tessellation
for MapLibre Globe. Their diagonals never determine Areas scalar contours, and
camera movement only reprojects the surface; it does not rebuild scalar data.

Smooth generalizes field data before Areas rendering. Only while Areas Smooth is
enabled, each needed scalar keyframe receives two deterministic radius-three
box-filter passes on the fixed L14 lattice. The filter uses running separable
windows while retaining the
same edge-clamping semantics. This
removes local detail without changing the lattice or responding to camera zoom.
Rain band thresholds and storm/hail presence thresholds are coverage-remapped
against the unsmoothed lattice, preserving the visual-coverage intent. Both
filtered values and remapped thresholds are interpolated between temporal
keyframes, so Smooth does not introduce visible 100 ms contour steps. Its
deterministic generalized L14 values feed the same shared bilinear texture
reconstruction; Smooth is therefore a deterministic L14 generalization rather
than a separate spatial interpolant. Blur always uses the raw unsmoothed L14
values.
