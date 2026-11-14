#!/usr/bin/env python3
"""Generate the PWA icon set with no image-library dependency.

A navy exclamation mark on the app's pale-blue ground, the same mark as the
login screen: a heavy tapering bar over a square dot, legible at 48px.
"""
import struct
import zlib
from pathlib import Path

OUT = Path(__file__).resolve().parent.parent / "public" / "icons"
OUT.mkdir(parents=True, exist_ok=True)

BLUE = (220, 232, 255, 255)
NAVY = (10, 26, 63, 255)
WHITE = (255, 255, 255, 255)
CLEAR = (0, 0, 0, 0)


def rounded_square(size, radius_ratio=0.22):
    """Coverage mask for a rounded square, 4x supersampled for smooth edges."""
    r = size * radius_ratio
    mask = [[0.0] * size for _ in range(size)]
    for y in range(size):
        for x in range(size):
            hits = 0
            for sy in range(4):
                for sx in range(4):
                    px = x + (sx + 0.5) / 4
                    py = y + (sy + 0.5) / 4
                    # Distance into the nearest corner's arc, if any.
                    cx = min(max(px, r), size - r)
                    cy = min(max(py, r), size - r)
                    dx, dy = px - cx, py - cy
                    if dx * dx + dy * dy <= r * r:
                        hits += 1
            mask[y][x] = hits / 16
    return mask


def draw(size, bg, fg, pad_ratio=0.0, bleed=False):
    """Compose the icon: optional rounded background plus an exclamation mark."""
    px = [[CLEAR] * size for _ in range(size)]

    if bg is not None and bleed:
        # Maskable icons must fill the canvas; the launcher does the cropping.
        px = [[bg] * size for _ in range(size)]
    elif bg is not None:
        mask = rounded_square(size)
        for y in range(size):
            for x in range(size):
                a = mask[y][x]
                if a > 0:
                    px[y][x] = (bg[0], bg[1], bg[2], int(255 * a))

    # Exclamation mark: a tapering bar over a square dot, 4x supersampled.
    inset = size * pad_ratio
    usable = size - 2 * inset
    top_w = usable * 0.24
    bot_w = usable * 0.15
    bar_top = inset + usable * 0.14
    bar_bot = inset + usable * 0.62
    dot_top = inset + usable * 0.69
    dot_bot = inset + usable * 0.86
    dot_w = usable * 0.19
    cx = size / 2

    def inside(fx, fy):
        if bar_top <= fy <= bar_bot:
            t = (fy - bar_top) / (bar_bot - bar_top)
            return abs(fx - cx) <= (top_w + (bot_w - top_w) * t) / 2
        return dot_top <= fy <= dot_bot and abs(fx - cx) <= dot_w / 2

    for y in range(int(bar_top) - 1, int(dot_bot) + 2):
        for x in range(int(cx - top_w) , int(cx + top_w) + 1):
            hits = sum(
                inside(x + (sx + 0.5) / 4, y + (sy + 0.5) / 4)
                for sy in range(4)
                for sx in range(4)
            )
            if not hits:
                continue
            a = hits / 16
            under = px[y][x]
            if under[3] == 0:
                px[y][x] = (fg[0], fg[1], fg[2], int(255 * a))
            else:
                px[y][x] = tuple(
                    int(fg[i] * a + under[i] * (1 - a)) for i in range(3)
                ) + (under[3],)
    return px


def write_png(path, px):
    size = len(px)
    raw = bytearray()
    for row in px:
        raw.append(0)  # filter type: none
        for r, g, b, a in row:
            raw += bytes((r, g, b, a))

    def chunk(tag, data):
        return (
            struct.pack(">I", len(data))
            + tag
            + data
            + struct.pack(">I", zlib.crc32(tag + data) & 0xFFFFFFFF)
        )

    png = b"\x89PNG\r\n\x1a\n"
    png += chunk(b"IHDR", struct.pack(">IIBBBBB", size, size, 8, 6, 0, 0, 0))
    png += chunk(b"IDAT", zlib.compress(bytes(raw), 9))
    png += chunk(b"IEND", b"")
    path.write_bytes(png)
    print(f"  {path.name}  ({size}x{size}, {len(png)} bytes)")


print("Generating icons:")
for size in (192, 512):
    write_png(OUT / f"icon-{size}.png", draw(size, BLUE, NAVY))
# Maskable variant: art stays inside the safe zone so launchers can crop it.
write_png(OUT / "icon-512-maskable.png", draw(512, BLUE, NAVY, pad_ratio=0.18, bleed=True))
# Android status-bar badge: silhouette only, the OS recolours it.
write_png(OUT / "badge-72.png", draw(72, None, WHITE))
print("Done.")
