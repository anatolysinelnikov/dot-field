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

The current data/runtime sequence is: (1) an immutable full-sequence support
sidecar plus independently delivered exact source frames, (2) viewport- and
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
channels but are zero for this rain-only sequence. Rain remains physical `mm/h`
through interpolation, sampling, LOD reduction, and scalar-lattice
reconstruction; renderer presentation mappings may use the named 50 mm/h visual
anchor but do not clamp the data field. The RAW midpoint-cell diagnostic does
not constrain this reconstruction. The legacy synthetic
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
frame is validated. Playback becomes available when the initial three-frame
source buffer (0, 1, 2) is ready; it does not wait for all 19 source frames.
The active finite sequence then keeps its rolling source horizon through the
same scheduler and begins a cooperative one-frame-at-a-time LOW fill of the
remaining sequence after the initial rolling horizon is serviced. Every exact
Float32 source frame that passes validation is retained for the lifetime of the
sequence under the `retainAllSourceFrames` policy. The six-entry LRU remains
available as the bounded default for comparison and for non-resident callers,
but the active real-weather path eventually retains all 19 source frames. Once
complete, source timeline jumps are served from resident memory without
another transport or validation scan. The scheduler has one global fetch slot,
not separate interactive and background pools. Current-time and adjacent
temporal requirements are HIGH; rolling-forward and resident-fill work is LOW.
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
full-sequence resident fill continues requesting still-missing frames one at
a time as LOW work; HIGH interactive requirements always outrank it, map
movement may pause new LOW work, and there is no giant queued full-sequence
prefetch request.
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

`scripts/generate-brotli-sidecars.mjs` and `scripts/serve-local.mjs` are
development-only test tooling, not production hosting. The generator writes
ignored Brotli-9 `.br` sidecars alongside the logical source frames and support
mask; the manifest and application continue to request the original `.f32` and
`.mask` URLs. To test from a phone/tablet on the same LAN, first generate the
sidecars, then run either mode from the repository root:

```text
node scripts/generate-brotli-sidecars.mjs
node scripts/serve-local.mjs --host 0.0.0.0 --port 8000 --compression identity
node scripts/serve-local.mjs --host 0.0.0.0 --port 8000 --compression br
```

Open `http://<computer-LAN-IP>:8000/` on the device. The server prints a
detected Network URL when possible; it is intentionally an HTTP development
server and must not be exposed to the Internet. In `br` mode, a request for a
logical source URL such as `rain/frame-000.f32` receives its `.br` sidecar only
when the client advertises `Accept-Encoding: br`, with `Content-Encoding: br`,
`Vary: Accept-Encoding`, and the encoded `Content-Length`. Browser fetch
transparently returns the original exact Float32 bytes; HTTP content coding is
transport behavior, not a provider-format change.

The finite source forecast traverses from 22:00 to 01:00 in the existing
18-second UI duration: normalized time 0 samples frame 0 and normalized time 1
samples frame 18. Playback stops at the endpoint rather than creating a
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

## Real-data geographic adapter — `src/engine/real-weather.js`, `src/engine/geography.js`

The reusable local workflow is:

```text
MinIO/S3 provider
→ local authenticated downloader
→ data/nc/
→ strict offline NetCDF normalization
→ data/generated/current/
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
→ ignored data/generated/current/
→ browser loading/interpolation/sampling
→ RAW / Dots / Squares
```

NetCDF parsing remains offline/local preprocessing. The preparation command
selects the newest local `YYYYMMDDHHMM.nc` by filename timestamp, invokes the
existing converter in strict `--sequence` mode, and atomically publishes a
complete generated directory. The browser consumes the normalized v2 binary
transport (`metadata.json`, `support.mask`, and Float32 frame assets), never the
`.nc` file. Raw NetCDF files and generated assets remain outside Git. The
one-click updater is idempotent: when the newest remote NC is already local and
`metadata.json` records the same `source.filename`, it skips reconversion. Any
future automatic periodic scheduling should remain a thin layer around this
same updater. No renderer or weather-field semantics change in this flow.

The current local NC omits precipitation units, so its preparation invocation
must explicitly add `--assume-units mm/h` after the source semantics have been
verified. The converter continues to reject missing or ambiguous units without
that explicit assumption.

The v2 manifest declares little-endian physical Float32 `mm/h` rain frames;
dimensions, timestamps, crop, union support, and frame addresses are all
dataset metadata. Its support is derived from the exact positive union across
every source node and frame, without connected-component selection. The loader
validates the mask node/byte count and its zero trailing unused bits before
canonical topology initialization; it never rebuilds support by downloading
all frames. Each requested source frame is independently validated for exact
byte count, Float32 alignment, finite non-negative values, and metadata
compatibility. A 404/410 metadata/support/frame failure preserves the existing
CSV fallback signal. Geographic axes are constructed deterministically from
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
source-frame cache is a deterministic Float32 residency store. In the active
finite sequence, it retains every validated frame rather than evicting old
frames: 19 frames × 3,022,676 bytes = 57,430,844 resident source bytes (about
54.8 MiB). Browser HTTP cache can improve transport latency but is never a
required second frame store. The bounded six-entry LRU (about 17.3 MiB for
this fixture) remains the default policy for comparison. Frame availability is
asynchronous only at the provider loading boundary: once the latest required
frames are available, provider temporal reconstruction, pyramid evaluation,
and renderer updates remain synchronous. Each downloaded payload is
byte/value validated before entering the residency store, and a resident frame
is never re-downloaded or revalidated. A source frame is never asynchronously
evicted during a synchronous evaluation. The prepared spatial rain cache
remains a separate bounded four-entry cache and is unchanged by source-frame
residency. Optional future
phenomena are represented in metadata
as one mutually-exclusive Uint8 node enum per source frame: 0 none, 1–3 storm,
4–6 hail, 7 reserved. The current rain-only sequence declares this channel
unavailable and fabricates no phenomenon data.

The timeline may visualize actual resident source-frame pairs as muted blue
segments inside its existing track. Residency snapshots and change callbacks
come from the loading/provider layer; the app converts adjacent resident
indices to visual intervals without changing timeline semantics, playback
scheduling, or source-loading policy. Non-sequence fallback sources leave the
track neutral.

### Physical weather-summary profiles

`geographic-weather-pyramid.js` retains the generic hazard-capable physical
summary contract: weighted rain, maximum rain, all seven rain-coverage
thresholds, and storm/hail coverage, weighted severity, and maxima. Providers
may explicitly advertise the `rain-only-display` summary profile. The current
prepared real-weather sequence does so together with explicit unavailable storm
and hail channels. Provider/engine capability is separate from availability in
the currently loaded dataset: a future sequence from the same provider may
expose hazard channels and must use the generic profile even when a particular
frame contains only zero hazard values. Selection is never a renderer choice
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
geography adapter. It converts the shared point interface to geographic
longitude/latitude and falls back to the checked-in
`data/mrl_z3_t+40min_376x239.csv` snapshot only when the local sequence assets
are unavailable (such as HTTP 404), with one concise warning; malformed
metadata, inconsistent values/geometry, incorrect support, or an incorrect
source-frame length fail
visibly instead. The active sequence's `spatial_grid.weather_support` is the
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
separate exact-frame diagnostic representation on the `1051 × 719` exported
provider grid: it interprets each source-node value as a
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
data; near `WEATHER_REGION.center` its roughly 0.04° longitude/latitude source
spacing is closest to canonical L13. `WEATHER_REFERENCE_LEVEL = 13` is thus the
effective direct/aggregate boundary. L13, L14, and L15 independently evaluate
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
one immutable sequence-wide positive source-node union. It is decoded
independently of full source-frame residency and is available before the
complete 19-frame sequence has loaded. Each prepared canonical geometry derives
its potentially-active sample set from this immutable support mask; full
source-frame residency is not required to construct the union. Direct weather
evaluation visits only that potentially-active set; samples guaranteed dry for
the entire sequence remain zero. The pyramid propagates the static set through
its centered aggregate topology, while topology-derived `totalWeight`
arrays are computed once per topology and retained across temporal keyframes.
Aggregation therefore skips guaranteed-dry child statistics but preserves every
dry child in the cached denominators and retains the same summary API and
representation-independent physical semantics.

The sequence geometry owns the bounded four-entry spatial source-frame LRU, but
it does not retain a normal-runtime temporal rain array. A provider frame
exposes a prepared temporal sampling capability through `geography.js`; the
current sequence implementation captures its two prepared Float64 spatial
source arrays and performs the existing linear interpolation when a summary
consumer requests each active value. The capability is provider-owned so a
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
aggregation. Requests that include L13, direct L14/L15 engine requests, and
providers without this explicit rain-only capability retain the direct-summary
fallback, including storm and hail channels.

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

Each summary is a struct of typed arrays with 16 `Float32Array` fields per
sample (64 bytes/sample): `totalWeight`, `rainWeightedSumMmh`,
`rainMaxMmh`, seven `rainCoverageWeight` arrays for the physical thresholds
0.05, 0.10, 0.30, 1.00, 2.50, 10.0, and 50.0 mm/h,
`stormCoverageWeight`, `stormWeightedSeverity`, `stormMaxSeverity`,
`hailCoverageWeight`, `hailWeightedSeverity`, and `hailMaxSeverity`. Means are
derived as weighted sum divided by `totalWeight`; they are not stored. Rain
remains physical mm/h, including values above 50 mm/h. Coverage arrays retain
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

Storm and hail are zero throughout the active rain-only sequence and are never
inferred from precipitation. Dots and Squares map these same summaries into
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
The scalar lattice remains independent of the discrete maximum display LOD. With
the current full-support bounds, its inactive fixed L14 implementation would
contain 4,753,990 vertices (1,910 × 2,489); viewport-windowed scalar
reconstruction is required before Blur/Areas can be safely reactivated.
Its rows,
columns, Mercator positions, and triangle indices are created once from the
globally anchored geographic topology and cached for the life of the layer.
L14 gives roughly 1.8 km local east-west grid spacing near the experiment
anchor. Panning,
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
box-filter passes on the fixed L14 lattice (an approximately 10 km local
low-pass scale). The filter uses running separable windows while retaining the
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
