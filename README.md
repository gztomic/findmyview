# Find My View

A phone-first shot coach for **scenery**: like [Find My Angle](https://gztomic.github.io/findmyangle/), but instead of a person's best angle it learns the composition of landscape photos you love and coaches you into the same shot. It starts with **beach and ocean**.

**Live:** https://gztomic.github.io/findmyview/

## How it works
1. **Your style:** add 10–50 reference photos, or tap *Use starter photos*. Each photo is analyzed on the device:
   - horizon position and tilt (strongest straight colour step, searched over ±10°, refined to sub-degree)
   - beach amount and shoreline angle (per-column sea/sand split)
   - light: brightness, contrast, warmth, saturation; sun position; dark foreground framing
2. **Looks:** photos are clustered (k-means, auto k by silhouette) into distinct compositions such as *Golden hour, low sky, a strip of beach*.
3. **Live coach:** the camera view shows a level bubble, your horizon band, a beach meter and an arrow: level it, tilt until the horizon sits in the green band, step back or forward until the beach matches.
4. **Check a shot:** scores a photo against your closest look and tells you what to change.

Nothing is uploaded; it's a single static page (`index.html` + `analyze.js`), no build step.

## Starter photos
`refs/beach/sources.json` lists 21 CC0 photos from the [WordPress Photo Directory](https://wordpress.org/photos/). The **Fetch reference photos** GitHub Action downloads them into `refs/beach/` (resized to 1200px) and writes `manifest.json`. It runs when `sources.json` changes, or manually from the Actions tab. To add more scenes later, create `refs/<scene>/sources.json` and run `python3 tools/fetch_refs.py <scene>`.
