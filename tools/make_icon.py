#!/usr/bin/env python3
"""Generate the app's icon and the README banner.

Run from the repo root:  python3 tools/make_icon.py

Produces:
  strimmer/icon.png             128x128, shown in the Apps list
  assets/banner.png             1200x320, white, shown at the top of the README

The mark is a blade of grass being cut: one tall blade sliced by a strimmer line, its tip falling
away, with two shorter blades beside it that sit BELOW the line and are left alone. That is the
app in one picture — only what stands above the line gets trimmed — and it matches `mdi:grass`,
the panel_icon on the Ingress sidebar entry. (MDI has no strimmer or hedge-trimmer glyph; all
7,447 were checked.) It replaced a funnel drawn to echo `mdi:filter-variant`.

Chosen 2026-09-19 from ten candidates and two rounds of refinement. `assets/icon.svg` is the
same drawing as a vector, and the geometry below is copied from it on its 128-unit grid — change
both together.

There is deliberately **no logo.png**. Home Assistant renders that small enough on the app
page that a wordmark and tagline are illegible, so the app ships the mark alone and the
wordmark lives on the README, where there is room for it.

The banner is on a solid white ground rather than transparent: GitHub renders READMEs on both
light and dark, and a transparent PNG would need text that works on both, which no single
colour does. White is legible either way.

Everything is drawn at 4x and downsampled — PIL has no antialiased polygon fill, and the
blades are all curves.
"""

from pathlib import Path

from PIL import Image, ImageChops, ImageDraw, ImageFont

SS = 4  # supersample factor

# The tile: a clear sky, lighter toward the ground.
SKY_TOP = (142, 197, 234)      # #8ec5ea
SKY_BOTTOM = (216, 238, 250)   # #d8eefa
BLADE_DARK = (27, 94, 32)      # #1b5e20
BLADE_LIGHT = (46, 125, 50)    # #2e7d32
SHORT_LEFT = (67, 160, 71)     # #43a047
SHORT_RIGHT = (56, 142, 60)    # #388e3c
WHITE = (255, 255, 255)

# Banner text. Dark ink for the name, grey for the tagline; the tile beside them is the colour.
INK = (15, 23, 42)
SLATE = (100, 116, 139)

NAME = "Strimmer"
TAGLINE = "cuts what your panel never shows"

ROOT = Path(__file__).resolve().parent.parent
APP_DIR = "strimmer"                 # the add-on folder, renamed from websocket-stripper
FONTS = (
    "/System/Library/Fonts/HelveticaNeue.ttc",
    "/System/Library/Fonts/Helvetica.ttc",
    "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf",
)

# ---- the mark, in the SVG's own 128-unit coordinates ----
# Each blade is two cubic Béziers sharing a tip: up one side, down the other.
TALL_FULL = ((38, 128), (40, 86), (54, 42), (92, 10), (82, 50), (80, 88), (82, 128))
TALL_LIT = ((38, 128), (40, 86), (54, 42), (92, 10), (72, 46), (62, 88), (60, 128))
SHORT_L = ((36, 128), (34, 112), (27, 100), (13, 91), (17, 104), (17, 116), (16, 128))
SHORT_R = ((88, 128), (89, 108), (96, 91), (111, 77), (105, 95), (105, 112), (107, 128))
# The cut runs between these two half-planes; the gap between them is where the line sits.
BELOW_CUT = ((0, 128), (128, 128), (128, 50), (0, 82))
ABOVE_CUT = ((0, 0), (128, 0), (128, 42), (0, 74))
LINE = ((22, 80), (112, 57.5))
LINE_WIDTH = 5
# The severed tip: rotated 16 degrees clockwise about (78, 50), then nudged right and up.
TIP_ROTATE, TIP_PIVOT, TIP_SHIFT = 16, (78, 50), (14, -2)
CORNER = 24


def _cubic(p0, p1, p2, p3, n=48):
    for i in range(n + 1):
        t = i / n
        a, b, c, e = (1 - t) ** 3, 3 * (1 - t) ** 2 * t, 3 * (1 - t) * t * t, t ** 3
        yield (a * p0[0] + b * p1[0] + c * p2[0] + e * p3[0],
               a * p0[1] + b * p1[1] + c * p2[1] + e * p3[1])


def _blade(pts, k):
    """A blade's outline as a polygon, scaled by k."""
    outline = list(_cubic(*pts[0:4])) + list(_cubic(*pts[3:7]))
    return [(x * k, y * k) for x, y in outline]


def _mask(size, polygon):
    m = Image.new("L", (size, size), 0)
    ImageDraw.Draw(m).polygon(polygon, fill=255)
    return m


def draw_tile(px):
    """The whole mark on its rounded sky tile, px square, antialiased."""
    S = px * SS
    k = S / 128
    sc = lambda pts: [(x * k, y * k) for x, y in pts]

    # Sky: a vertical gradient, built one pixel wide and stretched.
    col = Image.new("RGB", (1, S))
    for y in range(S):
        t = y / (S - 1)
        col.putpixel((0, y), tuple(round(a + (b - a) * t) for a, b in zip(SKY_TOP, SKY_BOTTOM)))
    tile = col.resize((S, S)).convert("RGBA")

    def paint(colour, mask):
        tile.paste(Image.new("RGBA", (S, S), colour + (255,)), (0, 0), mask)

    # Short blades first, so the tall one overlaps them as it does in the SVG.
    paint(SHORT_LEFT, _mask(S, _blade(SHORT_L, k)))
    paint(SHORT_RIGHT, _mask(S, _blade(SHORT_R, k)))

    full, lit = _mask(S, _blade(TALL_FULL, k)), _mask(S, _blade(TALL_LIT, k))
    below, above = _mask(S, sc(BELOW_CUT)), _mask(S, sc(ABOVE_CUT))
    paint(BLADE_DARK, ImageChops.multiply(full, below))
    paint(BLADE_LIGHT, ImageChops.multiply(lit, below))

    # The tip is cut out where it grew, THEN moved — the same order the SVG applies its clip
    # and its transform in. PIL rotates counter-clockwise and y points down, hence the sign.
    def moved(mask):
        return mask.rotate(-TIP_ROTATE, resample=Image.BICUBIC,
                           center=(TIP_PIVOT[0] * k, TIP_PIVOT[1] * k),
                           translate=(TIP_SHIFT[0] * k, TIP_SHIFT[1] * k))
    paint(BLADE_DARK, moved(ImageChops.multiply(full, above)))
    paint(BLADE_LIGHT, moved(ImageChops.multiply(lit, above)))

    # The strimmer line, with round caps (PIL's line has none).
    d = ImageDraw.Draw(tile)
    (x1, y1), (x2, y2) = sc(LINE)
    w = LINE_WIDTH * k
    d.line([(x1, y1), (x2, y2)], fill=WHITE, width=round(w))
    for x, y in ((x1, y1), (x2, y2)):
        d.ellipse([x - w / 2, y - w / 2, x + w / 2, y + w / 2], fill=WHITE)

    # Rounded corners last, so everything above is clipped to the tile.
    corners = Image.new("L", (S, S), 0)
    ImageDraw.Draw(corners).rounded_rectangle([0, 0, S - 1, S - 1], radius=CORNER * k, fill=255)
    out = Image.new("RGBA", (S, S), (0, 0, 0, 0))
    out.paste(tile, (0, 0), corners)
    return out.resize((px, px), Image.LANCZOS)


def _face(size):
    for path in FONTS:
        try:
            return ImageFont.truetype(path, size, index=0)
        except OSError:
            continue
    return None


def make_icon(px=128):
    return draw_tile(px)


def make_banner(w=1200, h=320):
    W, H = w * SS, h * SS
    img = Image.new("RGB", (W, H), WHITE)
    d = ImageDraw.Draw(img)

    margin = int(W * 0.045)
    side = int(H * 0.70)                                  # the tile, as a share of the banner
    tile = draw_tile(side // SS * SS)
    side = tile.width
    img.paste(tile, (margin, (H - side) // 2), tile)

    tx = margin + side + int(W * 0.04)
    f_big = _face(int(H * 0.26))
    if not f_big:
        return img.resize((w, h), Image.LANCZOS)

    # One word, one colour. It used to be two — "WebSocket" in ink and "Stripper" in the accent —
    # which is a device for a two-part name and has nothing to colour in a one-word one. The tile
    # beside it carries the colour; a single dark wordmark next to it reads as a title rather than
    # competing with it.
    d.text((tx, int(H * 0.28)), NAME, font=f_big, fill=INK)

    # Fit the tagline to what is left, so editing TAGLINE can never push it off the canvas.
    avail = W - tx - margin
    size = int(H * 0.13)
    while size > 10 and _face(size).getlength(TAGLINE) > avail:
        size -= 2
    d.text((tx + 3, int(H * 0.60)), TAGLINE, font=_face(size), fill=SLATE)
    return img.resize((w, h), Image.LANCZOS)


if __name__ == "__main__":
    (ROOT / APP_DIR).mkdir(exist_ok=True)
    (ROOT / "assets").mkdir(exist_ok=True)
    make_icon().save(ROOT / APP_DIR / "icon.png")
    make_banner().save(ROOT / "assets" / "banner.png")
    print(f"wrote {APP_DIR}/icon.png and assets/banner.png")
