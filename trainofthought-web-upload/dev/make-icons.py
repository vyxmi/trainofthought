#!/usr/bin/env python3
"""Generate Trainyard toolbar icons.

The mark is a turnout: one line in, two lines out, and a filled dot on the route
that was taken. At 16px that reads as "a choice of tracks", which is the product.
Anything more detailed turns to mush at toolbar size, so detail is added only at
48px and above.
"""
from PIL import Image, ImageDraw
import os

OUT = os.path.join(os.path.dirname(__file__), '..', 'ext', 'icons')
os.makedirs(OUT, exist_ok=True)

BG = (168, 65, 44, 255)      # oxide red
INK = (250, 245, 236, 255)   # cream
DIM = (250, 245, 236, 140)

S = 512  # supersample, then downscale


def draw(size, detailed):
    img = Image.new('RGBA', (S, S), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)

    r = int(S * 0.22)
    d.rounded_rectangle([0, 0, S - 1, S - 1], radius=r, fill=BG)

    w = int(S * 0.062)
    left = int(S * 0.16)
    right = int(S * 0.86)
    mid = int(S * 0.42)
    y_in = int(S * 0.50)
    y_up = int(S * 0.335)
    y_dn = int(S * 0.665)

    # trunk in
    d.line([(left, y_in), (mid, y_in)], fill=INK, width=w)

    # diverging route (up) — drawn as a short arc approximation
    pts_up = [(mid, y_in)]
    for i in range(1, 13):
        t = i / 12
        x = mid + (right - mid) * t
        y = y_in + (y_up - y_in) * (t * t * (3 - 2 * t))
        pts_up.append((x, y))
    d.line(pts_up, fill=INK, width=w, joint='curve')

    # through route (down)
    pts_dn = [(mid, y_in)]
    for i in range(1, 13):
        t = i / 12
        x = mid + (right - mid) * t
        y = y_in + (y_dn - y_in) * (t * t * (3 - 2 * t))
        pts_dn.append((x, y))
    d.line(pts_dn, fill=DIM, width=w, joint='curve')

    # the locomotive: it took the upper route
    rad = int(S * 0.085)
    cx, cy = int(S * 0.735), y_up
    d.ellipse([cx - rad, cy - rad, cx + rad, cy + rad], fill=INK)

    if detailed:
        # sleepers under the trunk, visible only at larger sizes
        for i in range(3):
            x = left + int(S * 0.03) + i * int(S * 0.085)
            d.line([(x, y_in - int(S * 0.055)), (x, y_in + int(S * 0.055))], fill=DIM, width=int(S * 0.02))

    return img.resize((size, size), Image.LANCZOS)


for size in (16, 32, 48, 128):
    img = draw(size, detailed=size >= 48)
    img.save(os.path.join(OUT, f'icon{size}.png'))
    print('wrote', f'icon{size}.png')
