#!/usr/bin/env python3
"""Download the photos listed in refs/<scene>/sources.json, resize them to 1200px on the
long edge, and write refs/<scene>/manifest.json (what the app's starter button reads).
Usage: python3 tools/fetch_refs.py [scene]   (needs Pillow)"""
import json, sys, io, pathlib, urllib.request
from PIL import Image, ImageOps

scene = sys.argv[1] if len(sys.argv) > 1 else "beach"
d = pathlib.Path(__file__).resolve().parent.parent / "refs" / scene
src = json.loads((d / "sources.json").read_text())
out = []
for p in src["photos"]:
    fn = f"{p['id']}.jpg"
    path = d / fn
    if not path.exists():
        data = None
        for url in (p["url"], p.get("thumb")):  # full size first, thumbnail as fallback
            if not url: continue
            try:
                req = urllib.request.Request(url, headers={"User-Agent": "findmyview-fetch/1.0"})
                data = urllib.request.urlopen(req, timeout=60).read(); break
            except Exception as e:
                print(f"  {url}: {e}")
        if data is None:
            print(f"SKIP {p['id']} {p['title']}"); continue
        im = ImageOps.exif_transpose(Image.open(io.BytesIO(data))).convert("RGB")
        im.thumbnail((1200, 1200), Image.LANCZOS)
        im.save(path, "JPEG", quality=85, optimize=True, progressive=True)
        print(f"OK   {fn} {im.size} {p['title']}")
    out.append({"file": fn, "title": p["title"], "page": p["page"], "license": p["license"]})
(d / "manifest.json").write_text(json.dumps({"scene": scene, "photos": out}, indent=1, ensure_ascii=False))
print(f"{len(out)}/{len(src['photos'])} photos in manifest")
