// Builds models/scenes.json: one averaged CLIP text embedding per scene, so the phone only
// needs the CLIP *vision* encoder. Then sanity-checks the image path on the reference photos.
// Usage (needs Hugging Face access, runs in GitHub Actions): node tools/models/build_scenes.mjs
import { AutoTokenizer, CLIPTextModelWithProjection, AutoProcessor, CLIPVisionModelWithProjection, RawImage } from "@huggingface/transformers";
import fs from "node:fs";
import path from "node:path";

const MODEL = "Xenova/clip-vit-base-patch32";
const DTYPE = "q8";
const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), "../..");
const src = JSON.parse(fs.readFileSync(path.join(root, "tools/models/scenes.src.json"), "utf8"));

const norm = v => { const n = Math.hypot(...v); return v.map(x => x / n); };

const tok = await AutoTokenizer.from_pretrained(MODEL);
const text = await CLIPTextModelWithProjection.from_pretrained(MODEL, { dtype: DTYPE });
const scenes = [];
for (const s of src.scenes) {
  const inputs = tok(s.prompts, { padding: true, truncation: true });
  const { text_embeds } = await text(inputs);
  const [n, d] = text_embeds.dims, data = text_embeds.data;
  const mean = new Array(d).fill(0);
  for (let i = 0; i < n; i++) { const e = norm(Array.from(data.slice(i * d, (i + 1) * d))); e.forEach((v, j) => mean[j] += v / n); }
  scenes.push({ id: s.id, label: s.label, coach: s.coach, e: norm(mean).map(v => +v.toFixed(5)) });
  console.log("embedded", s.id, s.prompts.length, "prompts");
}
const out = { model: MODEL, dtype: DTYPE, logitScale: 100, built: new Date().toISOString().slice(0, 10), scenes };
fs.writeFileSync(path.join(root, "models/scenes.json"), JSON.stringify(out));
console.log("wrote models/scenes.json");

// ---- sanity check: classify + aesthetic-score the reference photos with the vision encoder ----
const aes = JSON.parse(fs.readFileSync(path.join(root, "models/aesthetic_vitb32.json"), "utf8"));
const proc = await AutoProcessor.from_pretrained(MODEL);
const vision = await CLIPVisionModelWithProjection.from_pretrained(MODEL, { dtype: DTYPE });
const dir = path.join(root, "refs/beach");
const files = fs.existsSync(dir) ? fs.readdirSync(dir).filter(f => f.endsWith(".jpg")).slice(0, 8) : [];
const extra = (process.env.EXTRA_IMAGES || "").split(",").filter(Boolean);
for (const f of [...files.map(f => path.join(dir, f)), ...extra]) {
  const img = await RawImage.read(f);
  const { image_embeds } = await vision(await proc(img));
  const e = norm(Array.from(image_embeds.data));
  const logits = scenes.map(s => 100 * s.e.reduce((a, v, i) => a + v * e[i], 0));
  const mx = Math.max(...logits), ex = logits.map(l => Math.exp(l - mx)), Z = ex.reduce((a, b) => a + b, 0);
  const ranked = scenes.map((s, i) => [s.id, ex[i] / Z]).sort((a, b) => b[1] - a[1]).slice(0, 3);
  const score = aes.w.reduce((a, w, i) => a + w * e[i], aes.b);
  console.log(path.basename(f).padEnd(14), "aesthetic", score.toFixed(2), "|", ranked.map(([id, p]) => `${id} ${(p * 100).toFixed(0)}%`).join(", "));
}
