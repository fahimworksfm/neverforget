#!/usr/bin/env python3
"""Generate the PWA icon set with no image-library dependency.

A red rounded square with a white exclamation mark: legible at 48px, and the
right emotional register for an app whose entire job is to be alarming.
"""
import struct
import zlib
from pathlib import Path

OUT = Path(__file__).resolve().parent.parent / "public" / "icons"
OUT.mkdir(parents=True, exist_ok=True)

RED = (220, 38, 38, 255)
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


def draw(size, bg, fg, pad_ratio=0.0):
    """Compose the icon: optional rounded background plus an exclamation mark."""
    px = [[CLEAR] * size for _ in range(size)]

    if bg is not None:
        mask = rounded_square(size)
        for y in range(size):
            for x in range(size):
                a = mask[y][x]
                if a > 0:
                    px[y][x] = (bg[0], bg[1], bg[2], int(255 * a))

    # Exclamation mark: a tapering bar over a square dot.
    inset = size * pad_ratio
    usable = size - 2 * inset
    bar_w = usable * 0.135
    bar_top = inset + usable * 0.22
    bar_bot = inset + usable * 0.60
    dot_top = inset + usable * 0.68
    dot_bot = inset + usable * 0.80
    cx = size / 2

    for y in range(size):
        for x in range(size):
            fy = y + 0.5
            fx = x + 0.5
            in_bar = bar_top <= fy <= bar_bot and abs(fx - cx) <= bar_w / 2
            in_dot = dot_top <= fy <= dot_bot and abs(fx - cx) <= bar_w / 2
            if in_bar or in_dot:
                px[y][x] = fg
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
    write_png(OUT / f"icon-{size}.png", draw(size, RED, WHITE))
# Maskable variant: art stays inside the safe zone so launchers can crop it.
write_png(OUT / "icon-512-maskable.png", draw(512, RED, WHITE, pad_ratio=0.18))
# Android status-bar badge: silhouette only, the OS recolours it.
write_png(OUT / "badge-72.png", draw(72, None, WHITE))
print("Done.")
