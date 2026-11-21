# Find My View

A phone-first shot coach for travel photos: beaches, food, buildings, cities, landscapes. It recognises the scene, coaches you into a better framing live, scores the result, and learns your taste from the frames you keep. Sister project of [Find My Angle](https://gztomic.github.io/findmyangle/) (people).

**Live:** https://gztomic.github.io/findmyview/

## What it does
| Tab | |
|---|---|
| **Coach** | Live camera with a scene chip (auto-detected or picked), level bubble, and per-scene guides and cues. **Smart burst** grabs 8 frames, scores them, suggests the best and logs which one you keep. |
| **Check** | Scene, look score (0–10) and concrete fixes for any photo. |
| **Beach style** | Learn your preferred horizon / beach / light from reference photos (v1 feature). |
| **Data** | Your logged picks: the training data for your personal taste model. Export as JSON. |

## How it works
**Rules (instant, no download):** `analyze.js` (horizon, beach, light), `js/geometry.js` (vertical lines → roll and keystone, symmetry, exposure, motion, phone attitude), `js/coach.js` (per-scene rules):
- *horizon scenes:* level, horizon on a third (dramatic skies get two thirds), your beach style if set
- *architecture:* verticals straight (roll + keystone), centre symmetrical facades
- *food:* phone sensors guide a true overhead shot or a 30–55° diner's view; nudge toward window light
- *night:* hold still; *all:* blown highlights / too dark

**Smart model (opt-in, ~90 MB once):** CLIP ViT-B/32 via transformers.js in the browser.
- scene detection = similarity to scene prompts (`tools/models/scenes.src.json`, embedded by the *Build models* action → `models/scenes.json`)
- look score = LAION aesthetic linear head (`models/aesthetic_vitb32.json`)

**Trained framing model:** MobileNetV3-small (`models/correction/`, via ONNX Runtime Web) suggests pan / step closer / step back. Only outputs that were right ≥70% of the time on held-out photos are used.

## Training data & models
| Data | Source | Trains |
|---|---|---|
| CC0 travel photos per scene | `tools/train/fetch_dataset.py` (WordPress Photo Directory) | framing-correction model |
| Self-generated perturbations | `tools/train/perturb.py`: rotate / shift / zoom / keystone a good photo, label = the fix | framing-correction model |
| Your Smart-burst picks | Data tab → Export JSON | `tools/train/train_taste.py` → personal taste head (same format as the LAION head) |

Run **Actions → Train correction model** (inputs: photos per scene, epochs). It fetches photos, trains on CPU, exports ONNX and commits `models/correction/`. For bigger models run `train_correction.py` on a GPU.

Licences: training photos are CC0. The LAION aesthetic head's repository declares no licence; check before commercial use.
