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
the same colour at the same spot: plain bold letters when the 'AI' sits on
the white envelope (v4+), or with a 1px white outline when it sits on the
gradient (v2/v3 style)."""
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

def _env_radius():
    return max(4, int(0.03 * W))


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
# Columns measured on the envelope's lower half only, so the star's glow
# (top right) does not widen it.
_r0, _r1 = int(rows.min()), int(rows.max()) + 1
_low = white[_r0 + (_r1 - _r0) // 2:_r1]
cols = np.where(_low.sum(0) > 0.6 * _low.shape[0])[0]
ENV = (int(cols.min()), _r0, int(cols.max()) + 1, _r1)



_cx, _cy = (AI[0] + AI[2]) / 2, (AI[1] + AI[3]) / 2
ON_ENVELOPE = ENV[0] < _cx < ENV[2] and ENV[1] < _cy < ENV[3]


def _flap_lines():
    """Envelope flap lines (v5+): a green V from the top corners to the apex
    and grey lines from the bottom corners. Source coords, or [] if none."""
    if not ON_ENVELOPE:
        return []
    e = int(0.012 * W)
    x0, y0 = ENV[0] + e, ENV[1] + e
    sub = arr[y0:ENV[3] - e, x0:ENV[2] - e]
    sr, sg, sb = sub[..., 0], sub[..., 1], sub[..., 2]
    lines = []
    gm = (sg - sr > 40) & (sg - sb > 10)
    if gm.sum() > 0.002 * W * H:
        ys, xs = np.where(gm)
        col = tuple(int(v) for v in np.median(sub[gm], 0))
        apex = (int(xs[ys.argmax()]) + x0, int(ys.max()) + y0)
        left = (int(xs.min()) + x0, int(ys[xs.argmin()]) + y0)
        right = (int(xs.max()) + x0, int(ys[xs.argmax()]) + y0)
        lines += [(col, left, apex), (col, apex, right)]
    gr = (sub.min(2) < 228) & (sub.max(2) - sub.min(2) < 25) & (sub.min(2) > 150) & ~ai_mask[y0:ENV[3] - e, x0:ENV[2] - e]
    if gr.sum() > 0.002 * W * H:
        ys, xs = np.where(gr)
        wid = sub.shape[1]
        for side in (xs < 0.4 * wid, xs > 0.6 * wid):
            if side.sum() < 50:
                continue
            sx, sy = xs[side], ys[side]
            outer = sx.argmin() if sx.mean() < wid / 2 else sx.argmax()
            inner = sy.argmin()
            lines.append(((150, 150, 158), (int(sx[outer]) + x0, int(sy[outer]) + y0),
                          (int(sx[inner]) + x0, int(sy[inner]) + y0)))
    return lines


FLAP = _flap_lines()


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
    if ON_ENVELOPE:
        # Letters on the envelope: paint them out with the envelope white,
        # keeping a margin inside the envelope edge.
        e = 0.02 * W
        box = (xx >= max(bx0, ENV[0] + e)) & (xx < min(bx1, ENV[2] - e)) & \
              (yy >= max(by0, ENV[1] + e)) & (yy < min(by1, ENV[3] - e))
        out[box] = np.median(arr[white], 0)
        return Image.fromarray(np.clip(out, 0, 255).astype('uint8'))
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
# Bold 24px letters (2px strokes) for the plain on-envelope style.
A7B = ['.####.', '##..##', '##..##', '######', '##..##', '##..##', '##..##']
# 16px letters one row shorter when the flap V needs room.
A4 = ['.##.', '#..#', '####', '#..#']
I4 = ['##'] * 4
A6B = ['.####.', '##..##', '######', '##..##', '##..##', '##..##']
I6 = ['##'] * 6


def glyph_pixels(A, I, x0, y0):
    pts = set()
    for gl, ox in ((A, x0), (I, x0 + len(A[0]) + 1)):
        for j, line in enumerate(gl):
            for i, c in enumerate(line):
                if c == '#':
                    pts.add((ox + i, y0 + j))
    if ON_ENVELOPE:
        return pts, set()
    ring = {(x + dx, y + dy) for (x, y) in pts for dx in (-1, 0, 1) for dy in (-1, 0, 1)} - pts
    return pts, ring


def pixel_ai(n, A, I):
    im = MASTER_NOAI.resize((n, n), Image.LANCZOS)
    px = im.load()
    gw, gh = len(A[0]) + 1 + len(I[0]), len(A)
    s = n / SIDE
    cx, cy = ((AI[0] + AI[2]) / 2 + OX) * s, ((AI[1] + AI[3]) / 2 + OY) * s
    if ON_ENVELOPE:
        # Centre on the envelope; with flap lines sit the letters low so the
        # top of the V stays visible above them.
        cx, cy = ((ENV[0] + ENV[2]) / 2 + OX) * s, ((ENV[1] + ENV[3]) / 2 + OY) * s
        if FLAP:
            cy = (ENV[3] + OY) * s - gh / 2 - 1.0
    bx, by = int(round(cx - gw / 2)), int(round(cy - gh / 2))
    # Nearest spot to the artwork's letters where the outline stays inside.
    cands = sorted(((dx * dx + dy * dy, bx + dx, by + dy) for dx in range(-3, 4) for dy in range(-3, 4)))
    for _, x0, y0 in cands:
        pts, ring = glyph_pixels(A, I, x0, y0)
        if all(0 <= x < n and 0 <= y < n and px[x, y][3] >= 140 for x, y in pts | ring):
            if FLAP:
                # Flap lines redrawn 1px wide so the envelope still reads as
                # one; the letters are drawn on top, so the V runs behind them.
                s0 = n / SIDE
                layer = Image.new('RGBA', (n, n), (0, 0, 0, 0))
                d = ImageDraw.Draw(layer)
                # Small sizes: just the green V (top corners -> apex), the
                # grey lower lines would run into the letters.
                vs = [(c, p, q) for c, p, q in FLAP if c[1] - c[0] > 40] or FLAP
                for col, p, q in vs:
                    d.line([((p[0] + OX) * s0, (p[1] + OY) * s0), ((q[0] + OX) * s0, (q[1] + OY) * s0)],
                           fill=col + (255,), width=1)
                # Keep the line out of the A itself (its counter), so the A
                # stays an A; it still shows between and around the letters.
                d.rectangle([x0, y0, x0 + len(A[0]) - 1, y0 + gh - 1], fill=(0, 0, 0, 0))
                lp = layer.load()
                for yy_ in range(n):
                    for xx_ in range(n):
                        if lp[xx_, yy_][3]:
                            px[xx_, yy_] = lp[xx_, yy_][:3] + (px[xx_, yy_][3],)
            for (x, y) in ring:
                px[x, y] = WHITE + (px[x, y][3],)
            for (x, y) in pts:
                px[x, y] = AI_COLOR[:3] + (px[x, y][3],)
            return im
    raise SystemExit(f'no room for the {n}px letters')


def icon(n):
    if n == 16:
        return pixel_ai(16, A4, I4) if FLAP else pixel_ai(16, A5, I5)
    if n == 24:
        if FLAP:
            return pixel_ai(24, A6B, I6)
        return pixel_ai(24, A7B if ON_ENVELOPE else A7, I7)
    return MASTER.resize((n, n), Image.LANCZOS)


os.makedirs(OUT, exist_ok=True)
imgs = {n: icon(n) for n in SIZES}
for n, im in imgs.items():
    im.save(os.path.join(OUT, f'mail-ai-{n}.png'))
imgs[256].save(os.path.join(OUT, 'mail-ai.ico'), format='ICO', sizes=[(n, n) for n in ICO_SIZES],
               append_images=[imgs[n] for n in ICO_SIZES if n != 256])
print('square', (X0, Y0, X1, Y1), 'r', R, '| AI', AI, AI_COLOR[:3], 'on envelope' if ON_ENVELOPE else 'outlined',
      '| envelope', ENV, '| flap lines', len(FLAP), '->', OUT)
