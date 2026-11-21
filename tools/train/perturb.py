"""Self-supervised framing corrections.

Take a well-framed photo, damage the framing on purpose (rotate, shift, zoom, keystone) and record the
fix that undoes it. A model trained on these pairs learns to tell a live camera frame which way to move.

Label conventions match the app (js/coach.js):
  roll    +  the world looks rotated clockwise          -> rotate the phone clockwise
  pan     +  the subject sits right of where it should -> pan right
  tilt    +  too much foreground / horizon too high    -> tilt the phone up
  closer  +  framed too wide                           -> step closer / zoom in   (log of the zoom factor)
  keystone + verticals converge towards the top        -> hold the phone upright, step back
"""
import math, random
from PIL import Image

LABELS = ["roll", "pan", "tilt", "closer", "keystone"]
RANGE = {"roll": 8.0, "pan": 0.15, "tilt": 0.15, "closer": math.log(1.3), "keystone": 0.15}  # max |value|, for normalising
OUT_W, OUT_H = 192, 256   # portrait 3:4 network input


def _quad(cx, cy, w, h, roll, dx, dy, zoom, k):
    """Source-image quad (UL, LL, LR, UR as PIL QUAD wants) for a perturbed crop."""
    pts = []
    for u, v in ((-.5, -.5), (-.5, .5), (.5, .5), (.5, -.5)):
        uu = u * (1 + k * (-2 * v))          # top wider than bottom when k>0 -> content converges at the top
        x, y = uu * w * zoom, v * h * zoom
        r = math.radians(-roll)              # sample the source rotated the other way -> world appears rotated by +roll
        x, y = x * math.cos(r) - y * math.sin(r), x * math.sin(r) + y * math.cos(r)
        pts += [cx + x + dx * w, cy + y + dy * h]
    return pts


def sample(img: Image.Image, rng: random.Random, p_clean=0.25, base_scale=0.72):
    """Return (PIL image OUT_W x OUT_H, labels dict)."""
    W, H = img.size
    # base framing: centred 3:4 portrait crop, leaving margin for the perturbations
    h = min(H, W * 4 / 3) * base_scale
    w = h * 3 / 4
    cx, cy = W / 2, H / 2
    for _ in range(12):
        if rng.random() < p_clean:
            roll = dx = dy = k = 0.0; zoom = 1.0
        else:
            roll = rng.uniform(-RANGE["roll"], RANGE["roll"]) if rng.random() < .7 else 0.0
            dx = rng.uniform(-RANGE["pan"], RANGE["pan"]) if rng.random() < .5 else 0.0
            dy = rng.uniform(-RANGE["tilt"], RANGE["tilt"]) if rng.random() < .5 else 0.0
            zoom = math.exp(rng.uniform(-RANGE["closer"], RANGE["closer"])) if rng.random() < .5 else 1.0
            k = rng.uniform(-RANGE["keystone"], RANGE["keystone"]) if rng.random() < .35 else 0.0
        q = _quad(cx, cy, w, h, roll, dx, dy, zoom, k)
        xs, ys = q[0::2], q[1::2]
        if min(xs) >= 0 and max(xs) <= W and min(ys) >= 0 and max(ys) <= H:
            break
    else:  # could not fit: fall back to a clean sample
        roll = dx = dy = k = 0.0; zoom = 1.0; q = _quad(cx, cy, w, h, 0, 0, 0, 1, 0)
    out = img.transform((OUT_W, OUT_H), Image.QUAD, q, Image.BILINEAR)
    # window shifted right (dx>0) means the subject sits left -> pan left (negative)
    labels = {"roll": roll, "pan": -dx, "tilt": dy, "closer": math.log(zoom), "keystone": k}
    return out, labels
