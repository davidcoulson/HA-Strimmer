#!/usr/bin/env python3
"""Generate the add-on's icon.png and logo.png.

Kept as a script rather than checked-in-blobs-only so the artwork can be adjusted without
redrawing it by hand. Run from the repo root:  python3 tools/make_icon.py

The mark is a funnel: many entities go in, few come out — the whole add-on in one shape. It
deliberately echoes `mdi:filter-variant`, the panel_icon used for the Ingress sidebar entry,
so the sidebar and the add-on list read as the same thing.

Everything is drawn at 4x and downsampled, which is how the diagonals get clean edges;
PIL has no antialiased polygon fill.
"""
from PIL import Image, ImageDraw, ImageFont
from pathlib import Path

SS = 4                                  # supersample factor
NAVY = (18, 38, 58)                     # background, matches the stats panel's dark ground
BLUE = (79, 195, 247)                   # funnel, the panel's dark-mode accent
WHITE = (255, 255, 255)
OUT = Path(__file__).resolve().parent.parent / "websocket-stripper"


def rounded(size, radius, colour):
    img = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    ImageDraw.Draw(img).rounded_rectangle([0, 0, size - 1, size - 1], radius=radius, fill=colour)
    return img


def funnel(d, cx, top, half_w, neck_y, neck_half, stem_bottom, colour):
    """A filter/funnel: wide mouth, converging walls, short stem."""
    d.polygon(
        [
            (cx - half_w, top), (cx + half_w, top),
            (cx + neck_half, neck_y), (cx + neck_half, stem_bottom),
            (cx - neck_half, stem_bottom), (cx - neck_half, neck_y),
        ],
        fill=colour,
    )


def dots(d, xs, y, r, colour):
    for x in xs:
        d.ellipse([x - r, y - r, x + r, y + r], fill=colour)


def make_icon(px=128):
    S = px * SS
    img = rounded(S, int(S * 0.18), NAVY)
    d = ImageDraw.Draw(img)
    u = S / 1024                                  # design units -> pixels
    # Five entities in, one out: the ratio is the point, so the counts are not decorative.
    dots(d, [int(x * u) for x in (250, 381, 512, 643, 774)], int(215 * u), int(34 * u), WHITE)
    funnel(d, int(512 * u), int(345 * u), int(322 * u), int(585 * u), int(46 * u), int(725 * u), BLUE)
    dots(d, [int(512 * u)], int(815 * u), int(34 * u), WHITE)
    return img.resize((px, px), Image.LANCZOS)


def make_logo(w=500, h=200):
    """The mark in a left gutter, wordmark to its right.

    The mark's box is computed rather than eyeballed: at this size, drawing it from the same
    design units as the icon put the funnel's mouth off the left edge and the dots behind the
    text. Derive the scale from the width the mark should occupy, then centre it vertically.
    """
    W, H = w * SS, h * SS
    img = Image.new("RGBA", (W, H), NAVY)
    d = ImageDraw.Draw(img)

    margin = int(W * 0.03)
    mouth = W * 0.17                              # how wide the funnel's mouth should be
    u = mouth / 644                               # 644 = the mouth's width in design units
    cx = margin + int(322 * u)

    # Design-space extremes: top of the dot row, bottom of the outflow dot.
    top_u, bot_u = 215 - 34, 815 + 34
    oy = (H - (bot_u - top_u) * u) / 2 - top_u * u

    y = lambda v: int(v * u + oy)
    dots(d, [cx + int((x - 512) * u) for x in (250, 381, 512, 643, 774)], y(215), int(34 * u), WHITE)
    funnel(d, cx, y(345), int(322 * u), y(585), int(46 * u), y(725), BLUE)
    dots(d, [cx], y(815), int(34 * u), WHITE)

    f_big = f_small = None
    for path in ("/System/Library/Fonts/HelveticaNeue.ttc", "/System/Library/Fonts/Helvetica.ttc"):
        try:
            f_big = ImageFont.truetype(path, int(H * 0.19), index=0)
            f_small = ImageFont.truetype(path, int(H * 0.095), index=0)
            break
        except OSError:
            continue
    if f_big:
        tx = cx + int(322 * u) + int(W * 0.06)
        d.text((tx, int(H * 0.26)), "WebSocket", font=f_big, fill=WHITE)
        d.text((tx, int(H * 0.48)), "Stripper", font=f_big, fill=BLUE)
        d.text((tx + 2, int(H * 0.74)), "only what the dashboard uses", font=f_small, fill=(150, 170, 190))
    return img.resize((w, h), Image.LANCZOS)


if __name__ == "__main__":
    OUT.mkdir(exist_ok=True)
    make_icon().save(OUT / "icon.png")
    make_logo().save(OUT / "logo.png")
    print(f"wrote {OUT/'icon.png'} and {OUT/'logo.png'}")
