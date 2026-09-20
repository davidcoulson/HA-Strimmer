# Icon candidates

The drawings considered before Strimmer's icon was chosen, kept so the decision can be revisited
without starting from a blank page.

- `01`–`10` — the first round: ten different concepts, not ten recolours. The contact sheet shows
  each at 128 / 64 / 32px on a dark and a light tile, which is the only honest way to judge one:
  an icon that reads beautifully at 128 and turns to mush at 32 is the wrong icon, because 32 is
  the size the Apps list actually uses.
- `round-2/` — the chosen concept (07, one blade sliced by the trimmer line) with two shorter
  blades added below the cut, on nine blue and grey backgrounds. The short blades are the point:
  they sit under the line and are left alone, so the mark says "only what stands above the line
  gets trimmed", which is what the app does to the entity stream.
- `round-3/` — the overcast variant with a white line, and two near-identical tweaks.

**`7s2-sky-gradient.svg` won** and is now `assets/icon.svg`, rendered to `strimmer/icon.png` and
the README banner by `tools/make_icon.py`. That script draws the mark from the same geometry on a
128-unit grid — change the SVG and the script together, or they drift.

Open each `contact-sheet.html` in a browser; they inline the SVGs, so they render from anywhere.
