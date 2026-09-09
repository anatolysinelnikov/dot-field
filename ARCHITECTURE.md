# Dot Field Public Prototype Architecture

## Scope

This repository contains a browser-native synthetic weather visualization.
The page uses MapLibre GL JS with a Globe projection, a dark MapTiler basemap,
and custom WebGL weather layers. The public UI exposes **Dots** and **Areas**.

## Runtime flow

```text
index.html + styles.css
        |
        v
      src/app.js ------------------> MapLibre globe and basemap
        |
        +--> src/engine/field.js --> deterministic weather channels
        |
        +--> geographic grid ------> Dots weather and phenomenon symbols
        |
        +--> scalar reconstruction -> Areas precipitation layer
```

`src/app.js` owns the page state, map setup, timeline, animation, camera
controls, and switching between the public views. The renderer modules receive
weather and camera state from the application and draw through MapLibre custom
layers.

## Synthetic weather field

`src/engine/field.js` is a deterministic data source. It evaluates a moving,
repeatable synthetic field over time and supplies independent channels for
rain, thunderstorm, hail, squall, and hurricane activity. The field is sampled
at stable geographic positions; camera movement changes projection only and
does not move or reseed samples.

## Public representations

Dots uses a globally anchored Mercator grid with deterministic levels of detail.
Precipitation intensity is conveyed by sample size and overlap. Phenomena are
data-driven symbols with a fixed priority: hurricane, squall, hail, then
thunderstorm.

Areas starts from the same geographic samples and reconstructs precipitation on
a denser scalar lattice. Its nested color bands make precipitation boundaries
crisp while the phenomenon symbols remain independently derived from their
original channels.

Both representations interpolate between adjacent deterministic time states,
so timeline playback and scrubbing do not introduce random motion.

## Time and configuration

The animation is an 18-second deterministic loop with 100 ms temporal states.
Local development reads `config.local.json`, which is intentionally ignored;
the Pages workflow supplies the MapTiler key only in its staged deployment
artifact. The key is never committed to this repository.

The main browser files are `index.html`, `styles.css`, `src/app.js`, and the
renderer and field modules under `src/engine/`.
