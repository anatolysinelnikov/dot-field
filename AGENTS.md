# Dot Field Agent Instructions

These instructions apply to the entire repository.

## Source of truth

- The code on the branch or commit requested by the task is the source of truth for current behavior.
- `ARCHITECTURE.md` is maintained architectural context. Use it to understand system boundaries, invariants, data flow, and where to look.
- For implementation-dependent work, inspect the relevant current files before proposing or making changes.
- If code and `ARCHITECTURE.md` disagree, trust the code, report the discrepancy, and update `ARCHITECTURE.md` when the task changes or clarifies architecture.
- Do not invent files, functions, constants, APIs, or behavior that you have not verified.

## Before changing code

For non-trivial rendering, algorithm, architecture, LOD, sampling, reconstruction, Areas, Blur, hazard, or performance work:

1. Read `ARCHITECTURE.md`.
2. Inspect the relevant implementation files on the requested branch.
3. Identify whether the problem is primarily visual/design, algorithm/math, data-model, architecture, performance, or implementation.
4. Preserve the invariants below unless the task explicitly changes them.

For small isolated UI/CSS/documentation changes, keep the inspection proportional to the task.

## Core invariants

- Grid/sample positions are deterministic and spatially stable.
- Do not add random placement, jitter, or random particle motion.
- Animation changes the underlying weather field; it must not randomly move sample positions.
- Zoom must not change the spatial identity of samples.
- LOD must preserve visual density while adding detail on zoom-in.
- LOD transitions must not introduce popping, grid jumps, or spatial discontinuities.
- Rain, thunderstorm, hail, and future weather layers are data, not decorative effects.
- Hazard visualization must remain derived from the same deterministic weather field/grid semantics.
- Do not hide mathematical or spatial bugs with decorative workarounds.

### Dots

- Precipitation intensity is communicated primarily through radius and overlap.
- Strong rain may merge into a continuous-looking field.
- The intended boundary progression is continuous field -> dots -> small sparse dots -> none.
- Do not introduce a hard polygon-like precipitation boundary.

### Squares

- Squares use the same fixed-grid/LOD identity as Dots.
- Keep precipitation and hazard semantics aligned with the shared field rather than creating an independent effect layer.

### Areas

- Areas are a discrete contour representation of the same weather field.
- Boundaries are crisp; precipitation intensity is expressed as nested discrete regions.
- Default Areas geometry is the detailed reconstructed field.
- The `Smooth` option enables deterministic generalization; it is not a separate weather mode.
- Generalization must remain deterministic, world-space stable, and zoom-independent.
- Preserve major position, asymmetry, lobes, and disconnected systems; do not collapse systems into generic circles/blobs.
- Thunderstorm and hail remain data channels reconstructed on the deterministic base grid.
- Coverage remapping currently has visual semantics. If thresholds gain physical meteorological meaning, reconsider that remapping instead of silently retaining it.

### Blur

- Blur is a continuous scalar-field representation.
- It must be reconstructed from weather data; do not implement it as post-processing blur of Dots, Squares, or Areas.

## Architecture boundaries

Preferred dependency direction:

`app/UI -> renderers -> sampling/reconstruction/field -> math/config`

Keep these boundaries unless a concrete task justifies changing them:

- `src/app.js` owns DOM interaction, mutable UI/application state, camera setup, animation, and render routing.
- Renderer modules receive drawing/state inputs; they should not own DOM/UI state.
- `field.js` is the synthetic weather data source and must stay independent of renderers and UI.
- Shared sampling/reconstruction/mapping code should remain reusable by representations that need it.
- Engine/data layers should remain as independent from DOM/UI as practical.
- Do not couple renderers directly to a future weather provider. Keep provider format -> normalization -> temporal/spatial interpolation -> sampling/reconstruction -> rendering separable.

## Rendering and algorithm checks

When working on rendering or spatial algorithms, explicitly inspect:

- coordinate systems and world/screen transforms;
- grid anchoring and sample positions;
- interpolation/reconstruction behavior;
- contour extraction and support bounds;
- LOD boundaries and parent/child relationships;
- thresholds, radius mapping, aggregation, and hazard priority;
- camera transform and zoom/world-space invariance;
- DPR/Canvas scaling;
- temporal continuity and loop seams.

## Change discipline

- Prefer minimal, focused changes.
- Avoid unrelated cleanup/refactors in the same task.
- Do not introduce frameworks, dependencies, build tooling, or abstractions without practical need.
- Evolve architecture incrementally; do not rewrite working subsystems only for architectural purity.
- Behavior-preserving visual changes that produce unexpected visual differences are potential regressions.
- Keep comments and repository documentation in English unless the task asks otherwise.

## Verification

There is currently no automated test/build pipeline in the repository, so verification is primarily static review plus manual smoke testing.

At minimum for code changes:

- run `git diff --check`;
- inspect the final diff for unrelated changes;
- check the browser console for errors when manually testing.

For meaningful rendering changes, manually smoke-test as relevant:

- initial render;
- Dots / Squares / Blur / Areas;
- Areas with `Smooth` both off and on when affected;
- play/pause and timeline scrubbing;
- zoom and LOD transitions;
- rain/thunderstorm/hail, including hail priority;
- resize, DPR, and mobile/responsive UI.

Do not claim manual verification that was not actually performed.

## Documentation maintenance

Update `ARCHITECTURE.md` in the same task when a change materially alters:

- module responsibilities or dependencies;
- data flow;
- coordinate/grid/LOD contracts;
- reconstruction or contour pipelines;
- representation semantics;
- important architectural constants or verification requirements.

Keep `AGENTS.md` short and instruction-focused. Put implementation architecture and current system description in `ARCHITECTURE.md`.

## Git safety

- Work on the branch requested by the task; otherwise inspect the current branch before changing anything.
- Prefer a separate branch for meaningful features/refactors; small isolated low-risk fixes may be made directly on `main` when explicitly appropriate.
- Do not merge, delete branches, force-push, or rewrite history unless explicitly requested.
