# Dot Field Agent Instructions

These instructions apply to the entire repository.

## Purpose

This repository is a reference implementation of deterministic geographic weather visualization.

When analyzing or modifying the project, distinguish between:

- the **visual and behavioral contract** that defines how weather phenomena should appear and behave;
- the current **reference implementation** used to demonstrate that contract.

Do not assume that the current rendering, GPU, sampling, or synthetic-data implementation must be reproduced literally in another implementation.

## Source of truth

- The current code on the requested branch or commit is the implementation source of truth.
- `ARCHITECTURE.md` describes the intended visual and behavioral contract and the relevant implementation structure.
- If documentation and code disagree, trust the code and report the discrepancy.
- Do not invent files, constants, thresholds, APIs, or behavior that have not been verified.

## Read first

For work involving weather phenomena, read:

1. `ARCHITECTURE.md`
2. `src/engine/precipitation-mapping.js`
3. `src/engine/hazard-renderer.js`
4. `src/engine/geographic-dots-layer.js`

For spatial or LOD behavior, also inspect:

- `src/engine/geographic-symbol-pyramid.js`
- `src/engine/geographic-lod.js`

Use `src/engine/field.js` only to understand the synthetic demonstration data. The synthetic field generator is not the visualization contract.

## Core visualization principles

Weather phenomena are independent data channels:

- thunderstorm (`storm`);
- hail;
- squall;
- hurricane.

Keep data semantics separate from presentation.

The presentation layer converts those channels into mutually exclusive symbols only after sampling and interpolation.

Preserve these behaviors unless a task explicitly changes them:

- sample positions are deterministic and spatially stable;
- camera movement does not randomly move or reseed weather samples;
- temporal animation changes weather values, not sample identity;
- zoom/LOD changes must not cause random symbol relocation;
- phenomenon channels remain independent until presentation;
- only one phenomenon glyph is displayed at a sample position;
- winner priority is `hurricane > squall > hail > storm`;
- winner selection happens after interpolation of the underlying phenomenon values;
- glyphs are data-driven symbols, not decorative particle effects.

## Phenomenon presentation contract

The current reference presentation is:

- **Thunderstorm** — magenta four-point star.
- **Hail** — yellow filled triangle.
- **Squall** — orange filled diamond with three presentation grades.
- **Hurricane** — red filled square.

Squall severity changes the diamond size.

Hurricane intensity does not continuously scale the square. The hurricane square is tied to the active sample spacing.

Exact colors, thresholds, numerical sizing rules, interpolation behavior, and LOD handling are documented in `ARCHITECTURE.md` and implemented in the files listed above. Numerical values describe the current reference implementation; preserve the visual hierarchy and semantics when adapting the visualization to a different sampling or rendering system rather than treating every coefficient as universal.

## Dots and Areas

Dots and Areas use different precipitation representations but share the same phenomenon-symbol semantics.

In Areas mode, precipitation is rendered by the scalar Areas layer while the same hazard-symbol layer is rendered above it in hazards-only mode.

Do not create separate phenomenon mappings for Dots and Areas unless explicitly required.

## Reference implementation vs. contract

The following are implementation details of this prototype and should not automatically be treated as requirements:

- synthetic Gaussian weather generation;
- the exact MapLibre custom-layer structure;
- current WebGL buffer layout;
- current shader organization;
- the exact geographic LOD implementation.

What should be preserved when reproducing the visualization is the observable contract:

- independent phenomenon values;
- stable spatial placement;
- temporal continuity;
- overlap priority;
- glyph shape;
- glyph color;
- relative size hierarchy;
- severity grading;
- consistent behavior across precipitation representations.

## Change discipline

Prefer small, focused changes.

Do not introduce unrelated architecture, dependencies, tooling, or rendering changes.

When modifying phenomenon visualization:

1. verify the current constants and shader/CPU mappings;
2. preserve CPU and GPU presentation semantics where both exist;
3. verify temporal transitions;
4. verify LOD transitions;
5. verify overlap cases where more than one phenomenon is present;
6. verify both Dots and Areas.

If a change materially alters the visualization contract, update `ARCHITECTURE.md` in the same change.
