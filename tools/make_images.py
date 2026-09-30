"""Generates ARAN+ bitmap assets for the Samsung app (icon, glows).

Run from the repo root:  python3 tools/make_images.py   (or npm run images)
Needs Pillow (pip install pillow). The look matches the Roku app's
tools/make_images.py: a deep plum night, lavender for focus, small pops of
bubblegum pink and butter yellow.
"""

import math
from pathlib import Path

from PIL import Image, ImageDraw, ImageFilter, ImageFont

ROOT = Path(__file__).resolve().parent.parent
IMAGES = ROOT / "assets" / "images"
FONT_DISPLAY = ROOT / "assets" / "fonts" / "Fredoka-SemiBold.ttf"

BG = (21, 16, 40)
LAVENDER = (185, 163, 255)
LAVENDER_LIGHT = (226, 216, 255)
PINK = (255, 158, 207)
BUTTER = (255, 217, 138)
WHITE = (255, 255, 255)

NAME = "ARAN"
PLUS = "+"


def smooth(t):
    return t * t * (3 - 2 * t)


def gradient_fill(size, top, bottom):
    w, h = size
    grad = Image.new("RGBA", (1, h))
    for y in range(h):
        t = y / max(h - 1, 1)
        grad.putpixel((0, y), tuple(int(top[i] + (bottom[i] - top[i]) * t) for i in range(3)) + (255,))
    return grad.resize((w, h))


def wordmark_image(text_size, scale=4):
    """'ARAN' in a lavender gradient with a pink '+', on transparent."""
    font = ImageFont.truetype(str(FONT_DISPLAY), text_size * scale)
    plus_font = ImageFont.truetype(str(FONT_DISPLAY), int(text_size * scale * 1.05))
    probe = ImageDraw.Draw(Image.new("RGBA", (1, 1)))
    tracking = text_size * scale * 0.04
    widths = [probe.textlength(ch, font=font) for ch in NAME]
    name_w = sum(widths) + tracking * (len(NAME) - 1)
    plus_w = probe.textlength(PLUS, font=plus_font)
    gap = text_size * scale * 0.06
    ascent, descent = font.getmetrics()
    w = int(name_w + gap + plus_w + 8 * scale)
    h = int(ascent + descent + 4 * scale)

    mask = Image.new("L", (w, h), 0)
    d = ImageDraw.Draw(mask)
    x = 4 * scale
    for ch, cw in zip(NAME, widths):
        d.text((x, 0), ch, font=font, fill=255)
        x += cw + tracking
    img = Image.new("RGBA", (w, h), (0, 0, 0, 0))
    img.paste(gradient_fill((w, h), LAVENDER_LIGHT, LAVENDER), (0, 0), mask)

    plus_layer = Image.new("RGBA", (w, h), (0, 0, 0, 0))
    ImageDraw.Draw(plus_layer).text((x + gap - tracking, -text_size * scale * 0.08), PLUS, font=plus_font, fill=PINK + (255,))
    img.alpha_composite(plus_layer)
    return img


def sparkle(draw, cx, cy, r, color):
    """A soft four-point star."""
    pts = []
    for i in range(8):
        angle = math.pi / 4 * i - math.pi / 2
        radius = r if i % 2 == 0 else r * 0.28
        pts.append((cx + math.cos(angle) * radius, cy + math.sin(angle) * radius))
    draw.polygon(pts, fill=color)


def glow_layer(size, cx, cy, radius, color, strength):
    layer = Image.new("RGBA", size, (0, 0, 0, 0))
    ImageDraw.Draw(layer).ellipse((cx - radius, cy - radius, cx + radius, cy + radius), fill=color + (strength,))
    return layer.filter(ImageFilter.GaussianBlur(radius * 0.55))


def brand_card(width, height, text_size):
    """Logo centred on the plum night with lavender and pink glows and a few sparkles."""
    scale = 2
    W, H = width * scale, height * scale
    img = Image.new("RGBA", (W, H), BG + (255,))
    img.alpha_composite(glow_layer((W, H), W * 0.22, H * 0.25, min(W, H) * 0.55, LAVENDER, 110))
    img.alpha_composite(glow_layer((W, H), W * 0.82, H * 0.85, min(W, H) * 0.5, PINK, 80))

    mark = wordmark_image(text_size * scale, scale=2)
    mark = mark.resize((mark.width // 2, mark.height // 2), Image.LANCZOS)
    mx = (W - mark.width) // 2
    my = (H - mark.height) // 2
    img.alpha_composite(mark, (mx, my))

    d = ImageDraw.Draw(img)
    u = text_size * scale
    sparkle(d, mx - u * 0.35, my + u * 0.25, u * 0.22, BUTTER + (255,))
    sparkle(d, mx + mark.width + u * 0.25, my + u * 0.05, u * 0.15, WHITE + (230,))
    sparkle(d, mx + mark.width * 0.72, my + mark.height + u * 0.15, u * 0.12, LAVENDER_LIGHT + (220,))
    return img.convert("RGB").resize((width, height), Image.LANCZOS)


def tinted_glow(size, color):
    """Soft radial glow in one colour. CSS scales it up and sets its opacity."""
    img = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    px = img.load()
    c = (size - 1) / 2
    for y in range(size):
        for x in range(size):
            t = min(math.hypot(x - c, y - c) / c, 1)
            px[x, y] = color + (int(255 * (1 - smooth(t)) ** 1.6),)
    return img


def main():
    IMAGES.mkdir(parents=True, exist_ok=True)
    # Samsung asks for a 512x423 launcher icon.
    brand_card(512, 423, 80).save(ROOT / "icon.png")
    tinted_glow(256, LAVENDER).save(IMAGES / "glow_lavender.png")
    tinted_glow(256, PINK).save(IMAGES / "glow_pink.png")
    for p in [ROOT / "icon.png"] + sorted(IMAGES.iterdir()):
        print(p.relative_to(ROOT), Image.open(p).size)


if __name__ == "__main__":
    main()
