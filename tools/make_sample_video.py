"""Makes a short test video for the desktop harness: dev/media/sample.webm.

Run from the repo root:  python3 tools/make_sample_video.py
The fake server (dev/mock-xtream.mjs) plays it for every movie and episode, so the
player can be tried without a real account. It is a clock on a plum background,
so jumps and resumes are easy to check by eye. Needs Pillow and an ffmpeg with VP8:
the one on PATH, the one at FFMPEG, or Playwright's copy. dev/media/ is gitignored.
"""

import os
import shutil
import subprocess
import sys
from io import BytesIO
from pathlib import Path

from PIL import Image, ImageDraw, ImageFont

ROOT = Path(__file__).resolve().parent.parent
OUT = ROOT / "dev" / "media" / "sample.webm"
FONT = ROOT / "assets" / "fonts" / "Fredoka-SemiBold.ttf"

SECONDS = 40
FPS = 5
W, H = 640, 360

BG = (21, 16, 40)
LAVENDER = (201, 184, 255)
PINK = (255, 158, 207)


def find_ffmpeg():
    if os.environ.get("FFMPEG"):
        return os.environ["FFMPEG"]
    on_path = shutil.which("ffmpeg")
    if on_path:
        return on_path
    playwright = Path(os.environ.get("PLAYWRIGHT_BROWSERS_PATH", "/opt/pw-browsers"))
    for candidate in sorted(playwright.glob("ffmpeg-*/ffmpeg-linux")):
        return str(candidate)
    sys.exit("No ffmpeg found. Install one, or set FFMPEG to its path.")


def frame(n, font):
    secs = n / FPS
    img = Image.new("RGB", (W, H), BG)
    draw = ImageDraw.Draw(img)
    text = "%d:%02d" % (int(secs) // 60, int(secs) % 60)
    box = draw.textbbox((0, 0), text, font=font)
    draw.text(((W - (box[2] - box[0])) / 2, 110 - box[1]), text, font=font, fill=LAVENDER)
    # A dot that moves every frame, clear of where the player's controls sit.
    x = 220 + (n % FPS) * 200 / (FPS - 1)
    draw.ellipse((x - 8, 240, x + 8, 256), fill=PINK)
    out = BytesIO()
    img.save(out, "JPEG", quality=85)
    return out.getvalue()


def main():
    OUT.parent.mkdir(parents=True, exist_ok=True)
    font = ImageFont.truetype(str(FONT), 120)
    # Playwright's ffmpeg only reads JPEG frames and only writes VP8, which is enough.
    cmd = [find_ffmpeg(), "-y", "-loglevel", "error", "-f", "image2pipe", "-framerate", str(FPS), "-c:v", "mjpeg", "-i", "pipe:0", "-c:v", "vp8", "-b:v", "300k", str(OUT)]
    proc = subprocess.Popen(cmd, stdin=subprocess.PIPE)
    for n in range(SECONDS * FPS):
        proc.stdin.write(frame(n, font))
    proc.stdin.close()
    if proc.wait() != 0:
        sys.exit("ffmpeg failed")
    print("wrote", OUT.relative_to(ROOT), "(%d s)" % SECONDS)


if __name__ == "__main__":
    main()
