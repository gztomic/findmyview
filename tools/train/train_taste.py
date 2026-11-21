#!/usr/bin/env python3
"""Personal taste model from the app's Smart-burst picks (Data tab -> Export JSON).

Each record says "of these 8 frames, I kept frame i". We fit a linear scorer on the CLIP embeddings
(Bradley-Terry: P(i beats j) = sigmoid(w.(e_i - e_j))), starting from and regularised towards the
generic LAION aesthetic head, so a handful of picks nudges it rather than replacing it.

  python3 tools/train/train_taste.py findmyview-preferences.json [more.json ...] --out models/taste.json
Output has the same format as models/aesthetic_vitb32.json ({w, b}), so the app can swap it in.
Only needs numpy.
"""
import argparse, base64, json, pathlib, sys
import numpy as np

ROOT = pathlib.Path(__file__).resolve().parents[2]


def decode(b64):
    q = np.frombuffer(base64.b64decode(b64), dtype=np.int8).astype(np.float32)
    e = q * 0.25 / 127
    return e / (np.linalg.norm(e) + 1e-9)


def pairs_from(records):
    X, n_rec = [], 0
    for r in records:
        fr = r.get("frames", [])
        c = r.get("chosen")
        if c is None or c >= len(fr) or not fr[c].get("emb"):
            continue
        ec = decode(fr[c]["emb"]); n_rec += 1
        for j, f in enumerate(fr):
            if j != c and f.get("emb"):
                X.append(ec - decode(f["emb"]))
    return np.array(X, dtype=np.float32), n_rec


def fit(X, w0, lam=5.0, steps=3000, lr=0.5):
    """Bradley-Terry logistic regression on winner-minus-loser rows X.
    score(e) = alpha * (w0 . e) + v . e : alpha re-weights the generic head, v is the personal part (L2 = lam)."""
    g0 = X @ w0
    s = X.std() + 1e-9
    Z = np.hstack([g0[:, None] / (g0.std() + 1e-9), X / s])
    theta = np.zeros(Z.shape[1], dtype=np.float64); theta[0] = 1.0
    reg = np.full(Z.shape[1], lam / len(X)); reg[0] = 0
    for _ in range(steps):
        p = 1 / (1 + np.exp(-(Z @ theta)))
        grad = -(Z.T @ (1 - p)) / len(X) + reg * theta
        theta -= lr * grad
    alpha = theta[0] / (g0.std() + 1e-9)
    return (alpha * w0 + theta[1:] / s).astype(np.float32)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("files", nargs="+")
    ap.add_argument("--out", default="models/taste.json")
    ap.add_argument("--lam", type=float, default=2.0, help="L2 on the personal part (higher = trust picks less)")
    a = ap.parse_args()
    recs = []
    for f in a.files:
        d = json.loads(pathlib.Path(f).read_text())
        recs += d["records"] if isinstance(d, dict) else d
    X, n = pairs_from(recs)
    if n < 5:
        sys.exit(f"only {n} usable picks with embeddings; collect at least 5 (turn on the smart model before Smart burst)")
    base = json.loads((ROOT / "models/aesthetic_vitb32.json").read_text())
    w0 = np.array(base["w"], dtype=np.float32)
    acc0 = float(((X @ w0) > 0).mean())
    # hold out 20% of pairs to report whether the personal head generalises
    rng = np.random.default_rng(0); idx = rng.permutation(len(X)); cut = int(len(X) * .8)
    w = fit(X[idx[:cut]], w0, a.lam)
    acc_val = float(((X[idx[cut:]] @ w) > 0).mean()) if cut < len(X) else float("nan")
    acc_val0 = float(((X[idx[cut:]] @ w0) > 0).mean()) if cut < len(X) else float("nan")
    w = fit(X, w0, a.lam)
    out = {"model": base["model"], "source": f"personal taste head fitted on {n} picks ({len(X)} pairs), prior = LAION aesthetic",
           "w": [round(float(x), 6) for x in w], "b": base["b"],
           "metrics": {"picks": n, "pairs": int(len(X)), "generic_pair_acc": round(acc0, 3), "heldout_generic": round(acc_val0, 3), "heldout_personal": round(acc_val, 3)}}
    pathlib.Path(a.out).parent.mkdir(parents=True, exist_ok=True)
    pathlib.Path(a.out).write_text(json.dumps(out))
    print(json.dumps(out["metrics"]))


if __name__ == "__main__":
    main()
