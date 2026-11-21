// Framing-correction model (trained by tools/train/train_correction.py) running in the browser
// with ONNX Runtime Web. Predicts roll / pan / tilt / closer / keystone corrections from one frame.
const VER = "1.31.1";
const ORT = `https://cdn.jsdelivr.net/npm/onnxruntime-web@${VER}/dist/ort.wasm.min.mjs`;
let ort = null, session = null, meta = null, trusted = null, loading = null;
const canvas = Object.assign(document.createElement("canvas"), { width: 192, height: 256 });
const ctx = canvas.getContext("2d", { willReadFrequently: true });

export function ready() { return !!session; }
export function info() { return meta && { trusted, photos: meta.photos, built: meta.built, last: meta.history[meta.history.length - 1] }; }

export function load() {
  if (loading) return loading;
  loading = (async () => {
    const base = new URL("./", document.baseURI);
    const r = await fetch(new URL("models/correction/meta.json", base), { cache: "no-cache" });
    if (!r.ok) throw new Error("no trained correction model yet");
    meta = await r.json();
    // only use outputs whose suggested direction was right at least 70% of the time on held-out photos
    const last = meta.history[meta.history.length - 1].val_direction_acc;
    trusted = meta.labels.filter(k => (last[k] || 0) >= 0.7);
    ort = await import(ORT);
    ort.env.wasm.wasmPaths = `https://cdn.jsdelivr.net/npm/onnxruntime-web@${VER}/dist/`;
    ort.env.wasm.numThreads = 1;
    session = await ort.InferenceSession.create(new URL("models/correction/correction.onnx", base).href, { executionProviders: ["wasm"] });
  })();
  loading.catch(() => { loading = null; });
  return loading;
}

/** source: video/canvas/image, crop [sx,sy,sw,sh] (3:4 portrait region) -> {roll,pan,tilt,closer,keystone} in real units */
export async function predict(source, crop) {
  if (!session) return null;
  const [sx, sy, sw, sh] = crop;
  ctx.drawImage(source, sx, sy, sw, sh, 0, 0, 192, 256);
  const d = ctx.getImageData(0, 0, 192, 256).data, n = 192 * 256, x = new Float32Array(3 * n);
  const { mean, std } = meta.input;
  for (let i = 0; i < n; i++) for (let c = 0; c < 3; c++) x[c * n + i] = (d[i * 4 + c] / 255 - mean[c]) / std[c];
  const out = await session.run({ image: new ort.Tensor("float32", x, [1, 3, 256, 192]) });
  const y = out.fix.data, res = {};
  meta.labels.forEach((k, i) => res[k] = y[i] * meta.scale[i]);
  res.trusted = trusted;
  return res;
}
