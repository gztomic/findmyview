#!/usr/bin/env python3
"""Train the framing-correction model on self-generated perturbations (see perturb.py) and export ONNX.

  python3 tools/train/train_correction.py --data data/train --epochs 8 --out models/correction

Outputs: correction.onnx (input "image" 1x3x256x192, ImageNet-normalised RGB; output "fix" 1x5 in the
units of perturb.LABELS), meta.json (labels, units, normalisation, validation metrics).
CPU is fine for a first model (MobileNetV3-small); use a GPU for bigger runs.
"""
import argparse, json, math, pathlib, random, sys, time
import torch, torch.nn as nn
from torch.utils.data import Dataset, DataLoader
from PIL import Image
sys.path.insert(0, str(pathlib.Path(__file__).parent))
from perturb import sample, LABELS, RANGE, OUT_W, OUT_H

MEAN, STD = [0.485, 0.456, 0.406], [0.229, 0.224, 0.225]


def to_tensor(im):
    t = torch.frombuffer(bytearray(im.tobytes()), dtype=torch.uint8).view(OUT_H, OUT_W, 3).permute(2, 0, 1).float() / 255
    return (t - torch.tensor(MEAN)[:, None, None]) / torch.tensor(STD)[:, None, None]


class Perturbed(Dataset):
    def __init__(self, files, samples_per_image, seed):
        self.files, self.k, self.seed, self.cache = files, samples_per_image, seed, {}
    def __len__(self):
        return len(self.files) * self.k
    def __getitem__(self, i):
        f = self.files[i // self.k]
        img = self.cache.get(f)
        if img is None:
            img = Image.open(f).convert("RGB")
            if len(self.cache) < 3000: self.cache[f] = img
        rng = random.Random() if self.seed is None else random.Random(self.seed * 1000003 + i)
        im, lab = sample(img, rng)
        if rng.random() < .5:   # colour jitter so the model ignores exposure
            from PIL import ImageEnhance
            im = ImageEnhance.Brightness(im).enhance(rng.uniform(.7, 1.3))
        y = torch.tensor([lab[k] / RANGE[k] for k in LABELS], dtype=torch.float32)
        return to_tensor(im), y


def build_model(pretrained=True):
    from torchvision.models import mobilenet_v3_small, MobileNet_V3_Small_Weights
    m = mobilenet_v3_small(weights=MobileNet_V3_Small_Weights.DEFAULT if pretrained else None)
    m.classifier[-1] = nn.Linear(m.classifier[-1].in_features, len(LABELS))
    return m


def evaluate(model, loader):
    model.eval(); err = torch.zeros(len(LABELS)); n = 0; dir_ok = torch.zeros(len(LABELS)); dir_n = torch.zeros(len(LABELS))
    with torch.no_grad():
        for x, y in loader:
            p = model(x)
            err += (p - y).abs().sum(0); n += len(y)
            big = y.abs() > 0.25           # meaningful perturbations: is the suggested direction right?
            dir_ok += ((p.sign() == y.sign()) & big).sum(0).float(); dir_n += big.sum(0).float()
    mae = {k: round(float(err[i] / n * RANGE[k]), 4) for i, k in enumerate(LABELS)}
    acc = {k: round(float(dir_ok[i] / max(1, dir_n[i])), 3) for i, k in enumerate(LABELS)}
    return mae, acc


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--data", default="data/train")
    ap.add_argument("--out", default="models/correction")
    ap.add_argument("--epochs", type=int, default=8)
    ap.add_argument("--batch", type=int, default=32)
    ap.add_argument("--per-image", type=int, default=4, help="perturbed samples per photo per epoch")
    ap.add_argument("--lr", type=float, default=1e-3)
    ap.add_argument("--max-images", type=int, default=0)
    ap.add_argument("--no-pretrained", action="store_true")
    ap.add_argument("--workers", type=int, default=2)
    a = ap.parse_args()
    torch.manual_seed(0); random.seed(0)
    files = sorted(str(p) for p in pathlib.Path(a.data).rglob("*.jpg"))
    if a.max_images: random.shuffle(files); files = sorted(files[:a.max_images])
    if len(files) < 10: sys.exit(f"need photos in {a.data}, found {len(files)}")
    random.Random(1).shuffle(files)
    nval = max(5, len(files) // 10)
    val_files, tr_files = files[:nval], files[nval:]
    print(f"{len(tr_files)} train photos, {len(val_files)} validation photos")
    tr = DataLoader(Perturbed(tr_files, a.per_image, None), batch_size=a.batch, shuffle=True, num_workers=a.workers)
    va = DataLoader(Perturbed(val_files, 6, 123), batch_size=a.batch, num_workers=a.workers)
    model = build_model(not a.no_pretrained)
    opt = torch.optim.AdamW(model.parameters(), lr=a.lr, weight_decay=1e-4)
    sched = torch.optim.lr_scheduler.OneCycleLR(opt, max_lr=a.lr, total_steps=a.epochs * len(tr))
    loss_fn = nn.SmoothL1Loss(beta=0.1)
    hist = []
    for ep in range(a.epochs):
        model.train(); t0 = time.time(); tot = 0; n = 0
        for x, y in tr:
            opt.zero_grad(); loss = loss_fn(model(x), y); loss.backward(); opt.step(); sched.step()
            tot += loss.item() * len(y); n += len(y)
        mae, acc = evaluate(model, va)
        hist.append({"epoch": ep + 1, "loss": round(tot / n, 4), "val_mae": mae, "val_direction_acc": acc})
        print(f"epoch {ep + 1}/{a.epochs} loss {tot / n:.4f} {time.time() - t0:.0f}s | MAE {mae} | direction {acc}", flush=True)
    out = pathlib.Path(a.out); out.mkdir(parents=True, exist_ok=True)
    model.eval()
    dummy = torch.zeros(1, 3, OUT_H, OUT_W)
    torch.onnx.export(model, dummy, str(out / "correction.onnx"), input_names=["image"], output_names=["fix"],
                      opset_version=17, dynamo=False)
    meta = {"labels": LABELS, "scale": [RANGE[k] for k in LABELS], "units": {"roll": "degrees", "pan": "fraction of width", "tilt": "fraction of height", "closer": "log zoom", "keystone": "fraction"},
            "input": {"name": "image", "shape": [1, 3, OUT_H, OUT_W], "mean": MEAN, "std": STD, "layout": "NCHW RGB 0-1 then normalised"},
            "output": "fix[i] * scale[i] = correction in units", "photos": {"train": len(tr_files), "val": len(val_files)},
            "epochs": a.epochs, "history": hist, "built": time.strftime("%Y-%m-%d")}
    (out / "meta.json").write_text(json.dumps(meta, indent=1))
    print("exported", out / "correction.onnx", f"{(out / 'correction.onnx').stat().st_size / 1e6:.1f} MB")


if __name__ == "__main__":
    main()
