#!/usr/bin/env python3
"""Collect CC0 travel photos per scene from the WordPress Photo Directory (all photos there are CC0).

Writes <out>/<scene>/<id>.jpg (resized to <=768px long side) and <out>/index.jsonl.
Usage: python3 tools/train/fetch_dataset.py --out data/train --per-category 150
Needs internet access (runs in GitHub Actions); only stdlib + Pillow.
"""
import argparse, io, json, pathlib, re, sys, time, urllib.parse, urllib.request
from PIL import Image, ImageOps

API = "https://wordpress.org/photos/wp-json/wp/v2/photos"
UA = {"User-Agent": "findmyview-dataset/1.0 (+https://github.com/gztomic/findmyview)"}
SIZE_RE = re.compile(r"-\d+x\d+(\.(?:jpe?g|png|webp))$", re.I)


def get(url, timeout=60):
    req = urllib.request.Request(url, headers=UA)
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return r.read(), dict(r.headers)


def image_urls(photo):
    """Best-effort list of candidate image URLs for one photo record, preferred first."""
    urls = []
    try:  # embedded featured media sizes: pick the one closest to 1024px wide
        sizes = photo["_embedded"]["wp:featuredmedia"][0]["media_details"]["sizes"]
        ranked = sorted(sizes.values(), key=lambda s: abs(int(s.get("width", 0)) - 1024))
        urls += [s["source_url"] for s in ranked if s.get("source_url")]
    except Exception:
        pass
    for key in ("photo-thumbnail-url", "photo_thumbnail_url"):
        t = photo.get(key)
        if t:
            urls += [SIZE_RE.sub(r"\1", t), t]  # full size first, thumbnail as fallback
    html = (photo.get("content") or {}).get("rendered", "")
    for m in re.findall(r'src="(https://pd\.w\.org/[^"]+)"', html):
        urls += [SIZE_RE.sub(r"\1", m), m]
    seen, out = set(), []
    for u in urls:
        if u not in seen:
            seen.add(u); out.append(u)
    return out


def search(query, page, per_page=50):
    q = urllib.parse.urlencode({"search": query, "per_page": per_page, "page": page, "_embed": "wp:featuredmedia"})
    data, hdr = get(f"{API}?{q}")
    return json.loads(data), int(hdr.get("X-WP-TotalPages", hdr.get("x-wp-totalpages", 1)) or 1)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--out", default="data/train")
    ap.add_argument("--per-category", type=int, default=150)
    ap.add_argument("--max-side", type=int, default=768)
    ap.add_argument("--only", default="", help="comma-separated scene ids")
    a = ap.parse_args()
    cats = json.loads((pathlib.Path(__file__).parent / "categories.json").read_text())["categories"]
    if a.only:
        cats = {k: v for k, v in cats.items() if k in a.only.split(",")}
    out = pathlib.Path(a.out); out.mkdir(parents=True, exist_ok=True)
    index_path = out / "index.jsonl"
    seen = set()
    if index_path.exists():
        for line in index_path.read_text().splitlines():
            seen.add(json.loads(line)["id"])
    index = index_path.open("a")
    for scene, queries in cats.items():
        (out / scene).mkdir(exist_ok=True)
        have = len(list((out / scene).glob("*.jpg")))
        per_q = max(1, -(-a.per_category // len(queries)))
        for q in queries:
            got, page, pages = 0, 1, 1
            while got < per_q and have < a.per_category and page <= pages:
                try:
                    photos, pages = search(q, page)
                except Exception as e:
                    print(f"  search failed {q!r} p{page}: {e}", file=sys.stderr); break
                page += 1
                for p in photos:
                    pid = p.get("id")
                    if pid in seen or got >= per_q or have >= a.per_category:
                        continue
                    for url in image_urls(p):
                        try:
                            data, _ = get(url)
                            im = ImageOps.exif_transpose(Image.open(io.BytesIO(data))).convert("RGB")
                            if min(im.size) < 320:
                                continue
                            im.thumbnail((a.max_side, a.max_side), Image.LANCZOS)
                            im.save(out / scene / f"{pid}.jpg", "JPEG", quality=88)
                            index.write(json.dumps({"id": pid, "scene": scene, "query": q, "file": f"{scene}/{pid}.jpg",
                                                    "page": p.get("link"), "license": "CC0", "source": "WordPress Photo Directory"}) + "\n")
                            seen.add(pid); got += 1; have += 1
                            break
                        except Exception as e:
                            print(f"  {url}: {e}", file=sys.stderr)
                time.sleep(0.3)
            print(f"{scene:10s} {q!r}: +{got}")
        print(f"== {scene}: {have} photos")
    index.close()


if __name__ == "__main__":
    main()
