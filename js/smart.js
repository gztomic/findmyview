// Smart layer: CLIP ViT-B/32 vision encoder in the browser (transformers.js, ONNX, q8).
// - scene detection: cosine similarity to precomputed scene text embeddings (models/scenes.json)
// - aesthetic score: LAION linear head on the normalised embedding (models/aesthetic_vitb32.json)
// The model (~90 MB) downloads once from Hugging Face and is cached by the browser.
const TJS = "https://cdn.jsdelivr.net/npm/@huggingface/transformers@4.3.2/dist/transformers.web.min.js";

let T = null, proc = null, vision = null, scenes = null, aes = null, loading = null;

export function ready() { return !!vision; }

export function load(onProgress = () => {}) {
  if (loading) return loading;
  loading = (async () => {
    const base = new URL("./", document.baseURI);
    [scenes, aes] = await Promise.all([
      fetch(new URL("models/scenes.json", base)).then(r => { if (!r.ok) throw new Error("models/scenes.json missing: run the Build models action"); return r.json(); }),
      fetch(new URL("models/aesthetic_vitb32.json", base)).then(r => r.json())
    ]);
    T = await import(TJS);
    T.env.allowLocalModels = false;
    const files = {};
    const progress_callback = p => {
      if (p.status === "progress" && p.total) { files[p.file] = [p.loaded, p.total]; }
      const v = Object.values(files), loaded = v.reduce((a, x) => a + x[0], 0), total = v.reduce((a, x) => a + x[1], 0);
      onProgress(total ? loaded / total : 0, total);
    };
    proc = await T.AutoProcessor.from_pretrained(scenes.model, { progress_callback });
    vision = await T.CLIPVisionModelWithProjection.from_pretrained(scenes.model, { dtype: scenes.dtype, device: "wasm", progress_callback });
    onProgress(1, 0);
  })();
  loading.catch(() => { loading = null; });
  return loading;
}

const norm = v => { let n = 0; for (const x of v) n += x * x; n = Math.sqrt(n) || 1; return v.map(x => x / n); };

/** canvas -> { scenes:[{id,label,coach,p}], top, aesthetic, embed:Float32Array(512) } */
export async function analyze(canvas) {
  if (!vision) throw new Error("smart model not loaded");
  const img = T.RawImage.fromCanvas(canvas);
  const { image_embeds } = await vision(await proc(img));
  const e = norm(Array.from(image_embeds.data));
  const logits = scenes.scenes.map(s => scenes.logitScale * s.e.reduce((a, v, i) => a + v * e[i], 0));
  const mx = Math.max(...logits), ex = logits.map(l => Math.exp(l - mx)), Z = ex.reduce((a, b) => a + b, 0);
  const ranked = scenes.scenes.map((s, i) => ({ id: s.id, label: s.label, coach: s.coach, p: ex[i] / Z })).sort((a, b) => b.p - a.p);
  const aesthetic = aes.w.reduce((a, w, i) => a + w * e[i], aes.b);
  return { scenes: ranked, top: ranked[0], aesthetic, embed: Float32Array.from(e) };
}

export function sceneList() { return scenes ? scenes.scenes.map(({ id, label, coach }) => ({ id, label, coach })) : []; }
