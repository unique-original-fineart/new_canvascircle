#!/usr/bin/env python3
# =============================================================================
# og_image_generate.py
# =============================================================================
# Generates assets/og-image.png — the 1200x630 social-share preview used by
# Facebook, Twitter, iMessage, etc. when a CanvasCircle URL is shared.
#
# Design:
#   - Navy page background matching the site's --bg (#0A1538)
#   - Logo SVG rendered at 320x320, left-anchored, vertically centered
#   - "CanvasCircle" wordmark on the right in the brand gradient
#     (orange → magenta → purple → blue), drawn as a gradient-filled text mask
#   - Tagline below the wordmark in muted text color
#   - "canvascircle.art" URL at the bottom-right corner
#   - 6px brand-gradient stripe across the bottom edge of the canvas
#
# Re-run whenever the logo or brand palette changes:
#   pip install --break-system-packages pillow cairosvg
#   python3 scripts/og_image_generate.py
# =============================================================================

from PIL import Image, ImageDraw, ImageFont
import cairosvg
import io
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.abspath(os.path.join(HERE, ".."))
LOGO_SVG = os.path.join(ROOT, "assets", "logo-on-white.svg")
DST = os.path.join(ROOT, "assets", "og-image.png")

# ---- Brand constants (mirror /assets/theme.css) -----------------------------
W, H = 1200, 630
BG = (0x0A, 0x15, 0x38)            # --bg, navy
TEXT_SOFT = (0xA8, 0xB0, 0xC2)     # --text-soft
TEXT_MUTED = (0x7C, 0x84, 0x99)    # --text-muted
TEXT_INVERSE = (255, 255, 255)
# Brand gradient stops (warm orange → cool electric blue), with positions.
GRADIENT_STOPS = [
    (0.00, (0xFF, 0x6A, 0x1A)),    # orange
    (0.35, (0xE9, 0x1E, 0x63)),    # magenta
    (0.65, (0x8B, 0x1F, 0xC4)),    # purple
    (1.00, (0x2D, 0x7F, 0xFF)),    # blue
]

TAGLINE = "A modern art listing platform built for collectors."
URL_TEXT = "canvascircle.art"

FONT_CANDIDATES_SERIF_BOLD = [
    "/Library/Fonts/Georgia Bold.ttf",
    "/System/Library/Fonts/Supplemental/Georgia Bold.ttf",
    "/usr/share/fonts/truetype/liberation/LiberationSerif-Bold.ttf",
    "/usr/share/fonts/truetype/dejavu/DejaVuSerif-Bold.ttf",
]
FONT_CANDIDATES_SANS = [
    "/System/Library/Fonts/Supplemental/Helvetica.ttc",
    "/Library/Fonts/Arial.ttf",
    "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf",
    "/usr/share/fonts/truetype/liberation/LiberationSans-Regular.ttf",
]
FONT_CANDIDATES_SANS_BOLD = [
    "/System/Library/Fonts/Supplemental/Helvetica.ttc",
    "/Library/Fonts/Arial Bold.ttf",
    "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf",
    "/usr/share/fonts/truetype/liberation/LiberationSans-Bold.ttf",
]


def pick(paths):
    for p in paths:
        if os.path.exists(p):
            return p
    sys.exit(f"ERROR: no usable font found among {paths}")


def build_gradient_image(width, height):
    """Build a horizontal 4-stop brand-gradient image as RGB."""
    img = Image.new("RGB", (width, height))
    px = img.load()
    for x in range(width):
        t = x / max(1, width - 1)
        for i in range(len(GRADIENT_STOPS) - 1):
            t1, c1 = GRADIENT_STOPS[i]
            t2, c2 = GRADIENT_STOPS[i + 1]
            if t1 <= t <= t2:
                f = (t - t1) / max(1e-9, (t2 - t1))
                r = int(c1[0] + (c2[0] - c1[0]) * f)
                g = int(c1[1] + (c2[1] - c1[1]) * f)
                b = int(c1[2] + (c2[2] - c1[2]) * f)
                for y in range(height):
                    px[x, y] = (r, g, b)
                break
    return img


def main():
    if not os.path.exists(LOGO_SVG):
        sys.exit(f"ERROR: logo not found at {LOGO_SVG}")

    # ---- Canvas ----
    img = Image.new("RGB", (W, H), BG)

    # ---- Subtle radial wash at top center (mirrors site's body bg) ----
    # We draw a faint lighter-navy ellipse using paste with an alpha mask.
    wash = Image.new("RGB", (W, H), (0x0E, 0x1B, 0x48))
    mask = Image.new("L", (W, H), 0)
    md = ImageDraw.Draw(mask)
    # Big ellipse anchored at top-center, very soft edges
    cx, cy = W // 2, -100
    rx, ry = 900, 500
    md.ellipse((cx - rx, cy - ry, cx + rx, cy + ry), fill=120)
    # Blur the mask for a soft edge
    try:
        from PIL import ImageFilter
        mask = mask.filter(ImageFilter.GaussianBlur(radius=80))
    except Exception:
        pass
    img.paste(wash, (0, 0), mask)

    # ---- Logo (left side, vertically centered) ----
    LOGO_SIZE = 360
    logo_png = cairosvg.svg2png(
        url=LOGO_SVG,
        output_width=LOGO_SIZE,
        output_height=LOGO_SIZE,
    )
    logo = Image.open(io.BytesIO(logo_png)).convert("RGBA")

    # Round the corners of the logo to match the site's 12px on a 48px
    # header logo, scaled up — about 90px on a 360px image. Slightly
    # softer than the header treatment, since at this size the logo is
    # more prominent and the corners stand out more.
    corner_radius = 90
    rounded_mask = Image.new("L", (LOGO_SIZE, LOGO_SIZE), 0)
    rdraw = ImageDraw.Draw(rounded_mask)
    rdraw.rounded_rectangle((0, 0, LOGO_SIZE, LOGO_SIZE), radius=corner_radius, fill=255)
    rounded_logo = Image.new("RGBA", (LOGO_SIZE, LOGO_SIZE), (0, 0, 0, 0))
    rounded_logo.paste(logo, (0, 0), rounded_mask)

    logo_x = 90
    logo_y = (H - LOGO_SIZE) // 2
    img.paste(rounded_logo, (logo_x, logo_y), rounded_logo)

    # ---- Wordmark (right side, gradient text) ----
    serif_bold = pick(FONT_CANDIDATES_SERIF_BOLD)
    sans = pick(FONT_CANDIDATES_SANS)
    sans_bold = pick(FONT_CANDIDATES_SANS_BOLD)

    wordmark = "CanvasCircle"
    wm_font = ImageFont.truetype(serif_bold, 100)
    wm_x = logo_x + LOGO_SIZE + 50
    # Vertically align so the wordmark + tagline group is centered against the logo.
    # Tagline goes below; we'll place wordmark slightly above the vertical center.
    wm_y = 215

    # Build the gradient image and a text-shaped mask.
    grad = build_gradient_image(W, H)
    text_mask = Image.new("L", (W, H), 0)
    tmask_draw = ImageDraw.Draw(text_mask)
    tmask_draw.text((wm_x, wm_y), wordmark, font=wm_font, fill=255)
    # Composite the gradient onto the canvas, using the wordmark shape as mask.
    img.paste(grad, (0, 0), text_mask)

    # Small ™ glyph after the wordmark (white, smaller, baseline-aligned to top)
    wm_bbox = wm_font.getbbox(wordmark)
    wm_w = wm_bbox[2] - wm_bbox[0]
    wm_top = wm_bbox[1]
    tm_font = ImageFont.truetype(sans_bold, 28)
    draw = ImageDraw.Draw(img)
    draw.text(
        (wm_x + wm_w + 8, wm_y + wm_top + 4),
        "™",
        font=tm_font,
        fill=TEXT_SOFT,
    )

    # ---- Tagline (below the wordmark) ----
    # Auto-shrink the font so the tagline fits within the available width
    # (between wm_x and a 60px right margin). Keeps the design robust if
    # the tagline copy changes later.
    available_w = W - wm_x - 60
    tag_size = 32
    while tag_size > 18:
        tag_font_try = ImageFont.truetype(sans, tag_size)
        bbox = draw.textbbox((0, 0), TAGLINE, font=tag_font_try)
        if bbox[2] - bbox[0] <= available_w:
            break
        tag_size -= 1
    tag_font = ImageFont.truetype(sans, tag_size)
    tag_y = wm_y + 130
    draw.text((wm_x, tag_y), TAGLINE, font=tag_font, fill=TEXT_SOFT)

    # ---- URL footer (bottom-right) ----
    url_font = ImageFont.truetype(sans, 24)
    url_bbox = draw.textbbox((0, 0), URL_TEXT, font=url_font)
    url_w = url_bbox[2] - url_bbox[0]
    draw.text(
        (W - url_w - 60, H - 60),
        URL_TEXT,
        font=url_font,
        fill=TEXT_MUTED,
    )

    # ---- Bottom gradient stripe (echoes the site's header seam) ----
    STRIPE_HEIGHT = 8
    stripe = build_gradient_image(W, STRIPE_HEIGHT)
    img.paste(stripe, (0, H - STRIPE_HEIGHT))

    img.save(DST, optimize=True)
    print(f"OK: wrote {DST}  size={os.path.getsize(DST):,} bytes")


if __name__ == "__main__":
    main()
