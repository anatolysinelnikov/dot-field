# Dot Field Agent Instructions

Dot Field is a visual and behavioral reference prototype. Prefer the simplest active implementation. Do not retain inactive rendering modes, generalized infrastructure, or speculative abstractions for possible future reuse.

## Source of truth

- Code on the selected branch or commit is the implementation source of truth.
- `ARCHITECTURE.md` describes the intended observable contract.
- If code and documentation disagree, trust the code and report the discrepancy.
- Synthetic weather generation is demonstration data, not the visualization contract.

## Core invariants

- Areas is the sole active precipitation representation. Rain is its scalar field; hazards are separate aggregate symbols.
- Hazard LOD states are independently max-reduced from L14 for each discrete temporal keyframe. At the selected level, interpolate values before final block aggregation and visible winner resolution; winner resolution is presentation-time and does not destroy the independent channels.
- Geographic samples and aggregate anchors are deterministic and spatially stable. Camera movement, time, and LOD must not randomly relocate them.
- Only one hazard symbol is shown per aggregate block, with priority `hurricane > squall > hail > storm`.
- Preserve temporal continuity and the current direct LOD merge/split behavior unless a task explicitly changes them.

## Read first

- For the observable contract and active data flow, read `ARCHITECTURE.md`.
- For hazard presentation or aggregate LOD, inspect `src/engine/precipitation-mapping.js`, `src/engine/geographic-areas-hazard-icons-layer.js`, `src/engine/geographic-symbol-pyramid.js`, and `src/engine/geographic-lod.js` as relevant.
- For Areas rain smoothing and reconstruction, inspect `src/engine/geographic-scalar-lattice.js`, `src/engine/geographic-scalar-layer.js`, and `src/engine/areas-reconstruction.js`.
- Use `src/engine/field.js` only to understand the synthetic demonstration data.

## Change discipline

- Verify files, functions, constants, and APIs in the selected code; do not invent them.
- Prefer small, focused changes. Do not add unrelated dependencies, tooling, or rendering architecture.
- Preserve observable behavior when simplifying implementation details.
- If a change materially alters the visualization contract, update `ARCHITECTURE.md` in the same change.
