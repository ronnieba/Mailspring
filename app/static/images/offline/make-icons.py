#!/usr/bin/env python3
"""Mail AI icon pipeline (offline experiment). Single re-runnable script.

    python3 make-icons.py [SOURCE.jpg] [OUT_DIR]

Defaults: SOURCE = mail-ai-source.jpg next to this script, OUT_DIR = this
script's folder. Writes mail-ai-{16,24,32,48,64,128,256,512}.png
(transparent outside the rounded square) and mail-ai.ico (16-256).

Everything is measured from the artwork, so a tweaked logo only needs a
re-run: the rounded square (saturated pixels), the white envelope, and the
'AI' letters (purple/lavender pixels: blue and red well above green). At 16
and 24 px the big letters are removed and redrawn as crisp pixel glyphs in
the same colour with a 1px white outline, at the same spot."""
import os
import sys
import numpy as np
from PIL import Image, ImageDraw

HERE = os.path.dirname(os.path.abspath(__file__))
SRC = sys.argv[1] if len(sys.argv) > 1 else os.path.join(HERE, 'mail-ai-source.jpg')
OUT = sys.argv[2] if len(sys.argv) > 2 else HERE
SIZES = [16, 24, 32, 48, 64, 128, 256, 512]
ICO_SIZES = [16, 24, 32, 48, 64, 128, 256]
SS, INSET = 4, 2
WHITE = (255, 255, 255)

src = Image.open(SRC).convert('RGB')
W, H = src.size
arr = np.asarray(src).astype(int)
r, g, b = arr[..., 0], arr[..., 1], arr[..., 2]
yy, xx = np.mgrid[0:H, 0:W]


def bbox(mask):
    ys, xs = np.where(mask)
    return int(xs.min()), int(ys.min()), int(xs.max()) + 1, int(ys.max()) + 1


# Rounded square = saturated pixels; corner radius from the top row's inset.
X0, Y0, X1, Y1 = bbox((arr.max(2) - arr.min(2)) > 60)

sat = (arr.max(2) - arr.min(2)) > 60


def _inset(k):
    hit = np.where(sat[Y0 + k, X0:X1])[0]
    return int(hit[0]) if len(hit) else None


_obs = [(k, _inset(k)) for k in range(2, (X1 - X0) // 6, 4)]
_obs = [(k, d) for k, d in _obs if d is not None]


def _err(rad):
    e = 0.0
    for k, d in _obs:
        model = rad - np.sqrt(max(0.0, rad * rad - (rad - k) ** 2)) if k < rad else 0.0
        e += (model - d) ** 2
    return e


R = min(range(8, (X1 - X0) // 2), key=_err)

# 'AI' letters and their colour.
ai_mask = (b - g > 40) & (r - g > 20)
AI = bbox(ai_mask)
AI_COLOR = tuple(int(v) for v in np.median(arr[ai_mask], 0)) + (255,)

def rr_mask(w, h, box, rad):
    m = Image.new('L', (w * SS, h * SS), 0)
    ImageDraw.Draw(m).rounded_rectangle(
        [box[0] * SS, box[1] * SS, box[2] * SS - 1, box[3] * SS - 1], radius=rad * SS, fill=255)
    return m.resize((w, h), Image.LANCZOS)


# Envelope = big white block (rows/cols with many near-white pixels).
SQUARE = np.asarray(rr_mask(W, H, (X0 + 12, Y0 + 12, X1 - 12, Y1 - 12), max(4, R - 12))) > 250
white = (arr.min(2) > 232) & SQUARE
rows = np.where(white.sum(1) > 0.25 * W)[0]
cols = np.where(white.sum(0) > 0.18 * H)[0]
ENV = (int(cols.min()), int(rows.min()), int(cols.max()) + 1, int(rows.max()) + 1)




def without_ai(img):
    """Artwork with the big letters painted out (gradient + envelope edge)."""
    pad = int(0.03 * W)
    bx0, by0, bx1, by1 = AI[0] - pad, AI[1] - pad, AI[2] + pad, AI[3] + pad
    keep = ~((xx >= bx0 - 20) & (xx <= bx1 + 20) & (yy >= by0 - 20) & (yy <= by1 + 20))
    inside = (xx > X0 + R) & (xx < X1 - R) & (yy > Y0 + R) & (yy < Y1 - R)
    bg = keep & inside & sat & ~white & ~ai_mask
    sel = np.where(bg.ravel())[0][:: max(1, int(bg.sum() // 4000))]
    P = np.stack([np.ones(len(sel)), xx.ravel()[sel], yy.ravel()[sel]], 1)
    coef, *_ = np.linalg.lstsq(P, arr.reshape(-1, 3)[sel].astype(float), rcond=None)
    grad = coef[0] + coef[1] * xx[..., None] + coef[2] * yy[..., None]
    box = (xx >= bx0) & (xx < bx1) & (yy >= by0) & (yy < by1)
    out = arr.astype(float).copy()
    out[box] = grad[box]
    clean = Image.fromarray(np.clip(out, 0, 255).astype('uint8'))
    env = np.asarray(rr_mask(W, H, ENV, max(4, int(0.03 * W)))) / 255.0
    m = (env * box * 255).astype('uint8')
    clean.paste(WHITE, (0, 0), Image.fromarray(m))
    return clean


def to_master(img):
    rgba = img.copy()
    rgba.putalpha(rr_mask(W, H, (X0 + INSET, Y0 + INSET, X1 - INSET, Y1 - INSET), R - INSET))
    bw, bh = X1 - X0, Y1 - Y0
    side = max(bw, bh)
    m = Image.new('RGBA', (side, side), (0, 0, 0, 0))
    m.paste(rgba.crop((X0, Y0, X1, Y1)), ((side - bw) // 2, (side - bh) // 2))
    a = np.asarray(m).copy()
    a[a[..., 3] == 0, :3] = 0
    return Image.fromarray(a), side, (side - bw) // 2 - X0, (side - bh) // 2 - Y0


MASTER, SIDE, OX, OY = to_master(src)
MASTER_NOAI = to_master(without_ai(src))[0]

A5 = ['.##.', '#..#', '####', '#..#', '#..#']
I5 = ['##'] * 5
A7 = ['.###.', '#...#', '#...#', '#####', '#...#', '#...#', '#...#']
I7 = ['##'] * 7


def glyph_pixels(A, I, x0, y0):
    pts = set()
    for gl, ox in ((A, x0), (I, x0 + len(A[0]) + 1)):
        for j, line in enumerate(gl):
            for i, c in enumerate(line):
                if c == '#':
                    pts.add((ox + i, y0 + j))
    ring = {(x + dx, y + dy) for (x, y) in pts for dx in (-1, 0, 1) for dy in (-1, 0, 1)} - pts
    return pts, ring


def pixel_ai(n, A, I):
    im = MASTER_NOAI.resize((n, n), Image.LANCZOS)
    px = im.load()
    gw, gh = len(A[0]) + 1 + len(I[0]), len(A)
    s = n / SIDE
    cx, cy = ((AI[0] + AI[2]) / 2 + OX) * s, ((AI[1] + AI[3]) / 2 + OY) * s
    bx, by = int(round(cx - gw / 2)), int(round(cy - gh / 2))
    # Nearest spot to the artwork's letters where the outline stays inside.
    cands = sorted(((dx * dx + dy * dy, bx + dx, by + dy) for dx in range(-3, 4) for dy in range(-3, 4)))
    for _, x0, y0 in cands:
        pts, ring = glyph_pixels(A, I, x0, y0)
        if all(0 <= x < n and 0 <= y < n and px[x, y][3] >= 140 for x, y in pts | ring):
            for (x, y) in ring:
                px[x, y] = WHITE + (px[x, y][3],)
            for (x, y) in pts:
                px[x, y] = AI_COLOR[:3] + (px[x, y][3],)
            return im
    raise SystemExit(f'no room for the {n}px letters')


def icon(n):
    if n == 16:
        return pixel_ai(16, A5, I5)
    if n == 24:
        return pixel_ai(24, A7, I7)
    return MASTER.resize((n, n), Image.LANCZOS)


os.makedirs(OUT, exist_ok=True)
imgs = {n: icon(n) for n in SIZES}
for n, im in imgs.items():
    im.save(os.path.join(OUT, f'mail-ai-{n}.png'))
imgs[256].save(os.path.join(OUT, 'mail-ai.ico'), format='ICO', sizes=[(n, n) for n in ICO_SIZES],
               append_images=[imgs[n] for n in ICO_SIZES if n != 256])
print('square', (X0, Y0, X1, Y1), 'r', R, '| AI', AI, AI_COLOR[:3], '| envelope', ENV, '->', OUT)
