/* FindMyView scene analyzer — pure JS, runs in the browser and in Node.
 * analyze({data,width,height}) -> features of a beach/ocean scene:
 *   horizon  : y of the horizon at frame centre, fraction from top (0..1), null if none
 *   tilt     : horizon tilt in degrees (+ = right side lower in the image)
 *   hConf    : 0..1 confidence in the horizon
 *   sand     : fraction of the frame that is beach (below the shoreline)
 *   shore    : mean y of the shoreline, fraction from top (null if no beach)
 *   shoreAngle: shoreline slope in degrees (+ = right side lower)
 *   bright, contrast, warmth, sat : light & colour (0..1-ish)
 *   frame    : fraction of very dark pixels (silhouettes / foliage framing)
 *   sunX,sunY: position of the sun / brightest spot, null if none
 *   aspect   : width/height
 */
(function (root) {
  "use strict";
  const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
  const DEG = 180 / Math.PI;

  function analyze(img) {
    const W = img.width, H = img.height, d = img.data, N = W * H;
    const R = new Float32Array(N), G = new Float32Array(N), B = new Float32Array(N), L = new Float32Array(N);
    let sumL = 0, sumL2 = 0, sumWarm = 0, sumSat = 0, dark = 0;
    for (let i = 0, p = 0; i < N; i++, p += 4) {
      const r = d[p], g = d[p + 1], b = d[p + 2];
      R[i] = r; G[i] = g; B[i] = b;
      const l = 0.299 * r + 0.587 * g + 0.114 * b; L[i] = l;
      sumL += l; sumL2 += l * l; sumWarm += r - b;
      const mx = Math.max(r, g, b), mn = Math.min(r, g, b);
      sumSat += mx ? (mx - mn) / mx : 0;
      if (l < 38) dark++;
    }
    const meanL = sumL / N;
    const out = {
      aspect: +(W / H).toFixed(3),
      bright: +(meanL / 255).toFixed(3),
      contrast: +(Math.sqrt(Math.max(0, sumL2 / N - meanL * meanL)) / 255).toFixed(3),
      warmth: +(sumWarm / N / 255).toFixed(3),
      sat: +(sumSat / N).toFixed(3),
      frame: +(dark / N).toFixed(3),
      horizon: null, tilt: 0, hConf: 0,
      sand: 0, shore: null, shoreAngle: 0,
      sunX: null, sunY: null
    };

    /* ---- horizon: strongest straight colour step, searched over small tilts ---- */
    const k = Math.max(2, Math.round(H * 0.035));
    const y0 = Math.round(H * 0.06), y1 = Math.round(H * 0.94);
    let best = { s: 0, y: -1, a: 0 };
    const rowR = new Float32Array(H), rowG = new Float32Array(H), rowB = new Float32Array(H), rowL = new Float32Array(H), rowC = new Float32Array(H);
    for (let a = -10; a <= 10; a += 1) {
      const t = Math.tan(a / DEG);
      rowR.fill(0); rowG.fill(0); rowB.fill(0); rowL.fill(0); rowC.fill(0);
      // accumulate along slanted lines: line index y = round(py - (px - W/2) * t)
      for (let py = 0; py < H; py++) {
        const base = py * W;
        for (let px = 0; px < W; px += 1) {
          const y = Math.round(py - (px - W / 2) * t);
          if (y < 0 || y >= H) continue;
          const i = base + px;
          rowR[y] += R[i]; rowG[y] += G[i]; rowB[y] += B[i]; rowL[y] += L[i]; rowC[y]++;
        }
      }
      for (let y = 0; y < H; y++) if (rowC[y]) { const c = rowC[y]; rowR[y] /= c; rowG[y] /= c; rowB[y] /= c; rowL[y] /= c; }
      for (let y = Math.max(y0, k); y < Math.min(y1, H - k); y++) {
        let ar = 0, ag = 0, ab = 0, al = 0, br = 0, bg = 0, bb = 0, bl = 0, na = 0, nb = 0;
        for (let j = 1; j <= k; j++) {
          const u = y - j, v = y + j - 1;
          if (rowC[u] > W * 0.5) { ar += rowR[u]; ag += rowG[u]; ab += rowB[u]; al += rowL[u]; na++; }
          if (rowC[v] > W * 0.5) { br += rowR[v]; bg += rowG[v]; bb += rowB[v]; bl += rowL[v]; nb++; }
        }
        if (na < k * 0.7 || nb < k * 0.7) continue;
        ar /= na; ag /= na; ab /= na; al /= na; br /= nb; bg /= nb; bb /= nb; bl /= nb;
        let s = Math.hypot(ar - br, ag - bg, ab - bb);
        // sky is normally brighter than the sea right under it; sand is brighter than the sea above it
        s *= al >= bl ? 1.2 : 0.8;
        if (s > best.s) best = { s, y, a };
      }
    }
    if (best.y >= 0) {
      out.horizon = +(best.y / H).toFixed(4);
      out.tilt = best.a;
      out.hConf = +clamp((best.s - 8) / 40, 0, 1).toFixed(3);
      // refine tilt to sub-degree using per-strip edge positions
      const strips = 8, ys = [], xs = [];
      const win = Math.max(3, Math.round(H * 0.06)), t = Math.tan(best.a / DEG);
      for (let s = 0; s < strips; s++) {
        const xa = Math.floor(s * W / strips), xb = Math.floor((s + 1) * W / strips), xc = (xa + xb) / 2;
        const yc = Math.round(best.y + (xc - W / 2) * t);
        let bestE = 0, bestY = -1;
        for (let y = Math.max(1, yc - win); y < Math.min(H - 1, yc + win); y++) {
          let e = 0;
          for (let x = xa; x < xb; x++) {
            const i = y * W + x, j = (y - 1) * W + x;
            e += Math.abs(R[i] - R[j]) + Math.abs(G[i] - G[j]) + Math.abs(B[i] - B[j]);
          }
          if (e > bestE) { bestE = e; bestY = y - 0.5; }
        }
        if (bestY >= 0) { xs.push(xc); ys.push(bestY); }
      }
      if (xs.length >= 5) {
        // robust line fit: drop the worst residuals once
        let fit = lsq(xs, ys);
        const res = xs.map((x, i) => Math.abs(ys[i] - (fit.m * x + fit.c)));
        const cut = [...res].sort((a, b) => a - b)[Math.floor(res.length * 0.7)];
        const fx = [], fy = [];
        xs.forEach((x, i) => { if (res[i] <= cut + 0.5) { fx.push(x); fy.push(ys[i]); } });
        if (fx.length >= 4) fit = lsq(fx, fy);
        const a2 = Math.atan(fit.m) * DEG;
        if (Math.abs(a2 - best.a) < 2.5) {
          out.tilt = +a2.toFixed(2);
          out.horizon = +clamp((fit.m * W / 2 + fit.c) / H, 0, 1).toFixed(4);
        }
      }
    }

    /* ---- beach: per-column optimal split between sea (above) and sand (below) ---- */
    if (out.horizon != null) {
      const hy = out.horizon * H, tt = Math.tan(out.tilt / DEG);
      const shoreY = new Float32Array(W).fill(-1);
      let sandPx = 0;
      for (let x = 0; x < W; x++) {
        const top = Math.max(0, Math.ceil(hy + (x - W / 2) * tt + H * 0.02));
        if (top >= H - 2) continue;
        // prefix count of sand pixels
        const n = H - top; const pre = new Int32Array(n + 1);
        for (let y = top; y < H; y++) pre[y - top + 1] = pre[y - top] + (isSand(x, y) ? 1 : 0);
        const totalSand = pre[n];
        let bestV = -1, bestS = n; // split index: rows [0,s) sea, [s,n) sand
        for (let s = 0; s <= n; s++) {
          const v = (s - pre[s]) + (totalSand - pre[s]); // non-sand above + sand below
          if (v > bestV) { bestV = v; bestS = s; }
        }
        const sandRows = n - bestS;
        if (sandRows >= H * 0.03 && (totalSand - pre[bestS]) / sandRows > 0.55) {
          shoreY[x] = top + bestS; sandPx += sandRows;
        }
      }
      const sx = [], sy = [];
      for (let x = 0; x < W; x++) if (shoreY[x] >= 0) { sx.push(x); sy.push(shoreY[x]); }
      if (sx.length > W * 0.25) {
        const f = lsq(sx, sy);
        out.sand = +(sandPx / N).toFixed(3);
        out.shore = +clamp(sy.reduce((a, b) => a + b, 0) / sy.length / H, 0, 1).toFixed(4);
        out.shoreAngle = +(Math.atan(f.m) * DEG).toFixed(1);
      }
    }
    function isSand(x, y) {
      const i = y * W + x, r = R[i], g = G[i], b = B[i];
      const mx = Math.max(r, g, b), mn = Math.min(r, g, b);
      if (mx < 55) return false;                 // too dark: rock / silhouette / night water
      const s = (mx - mn) / mx;
      if (r < b + 8 || r < g - 12) return false;  // blue / green / teal: water or foliage
      if (s < 0.08) return mx > 150 && r > b + 12; // pale dry sand
      if (s > 0.75) return false;                // saturated orange: sunset glare on water
      return true;
    }

    /* ---- sun / brightest spot ---- */
    let thr = 250, cnt = 0, cx = 0, cy = 0;
    for (let i = 0; i < N; i++) if (L[i] >= thr) { cnt++; cx += i % W; cy += (i / W) | 0; }
    if (cnt >= N * 0.0015 && cnt <= N * 0.12) {
      cx /= cnt; cy /= cnt;
      // compactness: mean distance from centroid should be small
      let md = 0;
      for (let i = 0; i < N; i++) if (L[i] >= thr) md += Math.hypot(i % W - cx, ((i / W) | 0) - cy);
      md /= cnt;
      if (md < Math.max(W, H) * 0.12) { out.sunX = +(cx / W).toFixed(3); out.sunY = +(cy / H).toFixed(3); }
    }
    return out;
  }

  function lsq(xs, ys) {
    const n = xs.length; let sx = 0, sy = 0, sxx = 0, sxy = 0;
    for (let i = 0; i < n; i++) { sx += xs[i]; sy += ys[i]; sxx += xs[i] * xs[i]; sxy += xs[i] * ys[i]; }
    const den = n * sxx - sx * sx;
    const m = den ? (n * sxy - sx * sy) / den : 0;
    return { m, c: (sy - m * sx) / n };
  }

  const api = { analyze };
  if (typeof module !== "undefined" && module.exports) module.exports = api; else root.SceneAnalyzer = api;
})(typeof self !== "undefined" ? self : this);
