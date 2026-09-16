# Dot Field

Dot Field is a visual and behavioral reference prototype for deterministic geographic weather visualization. It demonstrates one active precipitation view: **Areas**.

[Open the prototype](https://anatolysinelnikov.github.io/dot-field/)

Rain is rendered as the scalar Areas field. Storm, Hail, Squall, and Hurricane are separate aggregate symbols; weather channels stay independent until presentation. Geographic samples and block anchors are deterministic. LOD changes symbol density while keeping icon screen size fixed.

The winner priority is `hurricane > squall > hail > storm`, with this current presentation:

| Channel | Symbol | Size |
| --- | --- | --- |
| Storm | Magenta narrow four-point star | Smooth 18–26 CSS px, with 22 px midpoint |
| Hail | Yellow filled hexagon | Discrete 16 / 20 / 24 CSS px |
| Squall | `squall-dark.svg` | Fixed 28 CSS px |
| Hurricane | `tornado-dark.svg` | Fixed 28 CSS px |

The internal channel is named `hurricane`; its current prototype artwork is Tornado artwork.

![Dot Field](assets/dot-field.jpg)

See [ARCHITECTURE.md](ARCHITECTURE.md) for the observable behavior and [AGENTS.md](AGENTS.md) for repository guidance.
