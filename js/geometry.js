/* Scene-agnostic geometry & exposure measurements on a small frame ({data,width,height}).
 * verticals(img) -> { roll, keystone, n, conf, density }   density > ~0.09 means lots of straight verticals (buildings)
 *   roll     : degrees the near-vertical lines lean on average (+ = tops lean right),
 *              i.e. how far the camera is rotated off level, judged from buildings / poles / doors
 *   keystone : how much verticals converge (+ = tops converge: camera pointing up)
 * symmetry(img) -> { axis, score }  best mirror axis (0..1 across) and how symmetric (0..1)
 * exposure(img) -> { mean, hi, lo }  mean luminance, share of clipped highlights / crushed shadows
 * motion(a, b)  -> mean absolute luminance difference between two frames (0..1)
 */
(function (root) {
  "use strict";
  const DEG = 180 / Math.PI;
  function lum(img) {
    const { data: d, width: W, height: H } = img, L = new Float32Array(W * H);
    for (let i = 0, p = 0; i < W * H; i++, p += 4) L[i] = 0.299 * d[p] + 0.587 * d[p + 1] + 0.114 * d[p + 2];
    return L;
  }

  function verticals(img) {
    const W = img.width, H = img.height, L = lum(img);
    const ds = [], xs = [], ws = [];
    for (let y = 1; y < H - 1; y++) for (let x = 1; x < W - 1; x++) {
      const i = y * W + x;
      const gx = (L[i - W + 1] + 2 * L[i + 1] + L[i + W + 1]) - (L[i - W - 1] + 2 * L[i - 1] + L[i + W - 1]);
      const gy = (L[i + W - 1] + 2 * L[i + W] + L[i + W + 1]) - (L[i - W - 1] + 2 * L[i - W] + L[i - W + 1]);
      const m = Math.hypot(gx, gy);
      if (m < 90 || Math.abs(gx) < 1e-6) continue;
      const d = Math.atan(gy / gx) * DEG;          // 0 for a vertical edge, + when the top leans right
      if (Math.abs(d) > 20) continue;
      // keep only pixels that belong to a vertical *line*: the pixels above and below must share the orientation
      let ok = 0;
      for (const o of [-2 * W, -W, W, 2 * W]) {
        const j = i + o; if (j - W - 1 < 0 || j + W + 1 >= L.length) continue;
        const gx2 = (L[j - W + 1] + 2 * L[j + 1] + L[j + W + 1]) - (L[j - W - 1] + 2 * L[j - 1] + L[j + W - 1]);
        if (Math.sign(gx2) === Math.sign(gx) && Math.abs(gx2) > 60) ok++;
      }
      if (ok < 3) continue;
      ds.push(d); xs.push(x / W * 2 - 1); ws.push(m);
    }
    const n = ds.length;
    if (n < W * H * 0.004) return { roll: 0, keystone: 0, n, conf: 0, density: +(n / (W * H)).toFixed(4) };
    // weighted least squares d = roll + k * x  (k>0 would mean tops spread; tops converging gives k<0)
    let sw = 0, sx = 0, sy = 0, sxx = 0, sxy = 0;
    for (let i = 0; i < n; i++) { const w = ws[i]; sw += w; sx += w * xs[i]; sy += w * ds[i]; sxx += w * xs[i] * xs[i]; sxy += w * xs[i] * ds[i]; }
    const den = sw * sxx - sx * sx, k = den ? (sw * sxy - sx * sy) / den : 0, r = (sy - k * sx) / sw;
    // robust roll: weighted median of residual-corrected angles
    const corr = ds.map((d, i) => [d - k * xs[i], ws[i]]).sort((a, b) => a[0] - b[0]);
    let acc = 0, med = r; for (const [v, w] of corr) { acc += w; if (acc >= sw / 2) { med = v; break; } }
    return { roll: +med.toFixed(2), keystone: +(-k).toFixed(2), n, conf: +Math.min(1, n / (W * H * 0.03)).toFixed(2), density: +(n / (W * H)).toFixed(4) };
  }

  function symmetry(img) {
    const W = img.width, H = img.height, L = lum(img);
    // column profile of vertical-edge energy + luminance, compared with its mirror image
    const col = new Float32Array(W);
    for (let y = 0; y < H; y++) for (let x = 1; x < W - 1; x++) col[x] += Math.abs(L[y * W + x + 1] - L[y * W + x - 1]);
    let best = { axis: 0.5, score: 0 };
    for (let a = Math.round(W * 0.3); a <= Math.round(W * 0.7); a++) {
      const half = Math.min(a, W - a) - 1; if (half < W * 0.2) continue;
      let num = 0, den = 0;
      for (let i = 1; i < half; i++) { const p = col[a - i], q = col[a + i]; num += Math.min(p, q); den += Math.max(p, q); }
      // also compare the actual pixels, row by row
      let pd = 0, pc = 0;
      for (let y = 0; y < H; y += 2) for (let i = 1; i < half; i += 2) { pd += Math.abs(L[y * W + a - i] - L[y * W + a + i]); pc++; }
      const s = (den ? num / den : 0) * 0.5 + (1 - pd / pc / 60) * 0.5;
      if (s > best.score) best = { axis: a / W, score: s };
    }
    best.score = +Math.max(0, best.score).toFixed(3); best.axis = +best.axis.toFixed(3);
    return best;
  }

  function exposure(img) {
    const L = lum(img), n = L.length; let s = 0, hi = 0, lo = 0;
    for (const v of L) { s += v; if (v >= 250) hi++; if (v <= 6) lo++; }
    return { mean: +(s / n / 255).toFixed(3), hi: +(hi / n).toFixed(4), lo: +(lo / n).toFixed(4) };
  }

  function motion(a, b) {
    if (!a || !b || a.width !== b.width || a.height !== b.height) return 0;
    const A = lum(a), B = lum(b); let s = 0;
    for (let i = 0; i < A.length; i++) s += Math.abs(A[i] - B[i]);
    return +(s / A.length / 255).toFixed(4);
  }

  /** Phone orientation from DeviceMotion accelerationIncludingGravity (spec: flat face-up = (0,0,+9.81)).
   * roll: rotation in the screen plane (0 = upright portrait), elevation: where the back camera points
   * (0 = horizon, -90 = straight down, +90 = straight up). */
  function attitude(ax, ay, az) {
    const g = Math.hypot(ax, ay, az) || 1;
    return { roll: +(Math.atan2(ax, ay) * DEG).toFixed(1), elevation: +(Math.asin(Math.max(-1, Math.min(1, -az / g))) * DEG).toFixed(1), flatTilt: +(Math.atan2(Math.hypot(ax, ay), Math.abs(az)) * DEG).toFixed(1) };
  }

  const api = { verticals, symmetry, exposure, motion, attitude };
  if (typeof module !== "undefined" && module.exports) module.exports = api; else root.Geo = api;
})(typeof self !== "undefined" ? self : this);
