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
  const P = { tex: 0.8, up: 0.8, tilt: 12 };   // candidate ranking weights (tuned on refs/beach)

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
    const cands = [];
    const rowR = new Float32Array(H), rowG = new Float32Array(H), rowB = new Float32Array(H), rowL = new Float32Array(H), rowC = new Float32Array(H);
    const prof = new Float32Array(H);
    for (let a = -8; a <= 8; a += 1) {
      const t = Math.tan(a / DEG);
      rowR.fill(0); rowG.fill(0); rowB.fill(0); rowL.fill(0); rowC.fill(0); prof.fill(0);
      // accumulate along slanted lines: line index y = round(py - (px - W/2) * t)
      for (let py = 0; py < H; py++) {
        const base = py * W;
        for (let px = 0; px < W; px++) {
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
        let sc = Math.hypot(ar - br, ag - bg, ab - bb);
        // sky is normally brighter than the sea right under it; sand is brighter than the sea above it
        sc *= al >= bl ? 1.15 : 0.85;
        prof[y] = sc;
      }
      // keep local maxima of this angle's profile
      for (let y = 1; y < H - 1; y++) if (prof[y] > 6 && prof[y] >= prof[y - 1] && prof[y] > prof[y + 1]) cands.push({ s: prof[y], y, a });
    }
    cands.sort((p, q) => q.s - p.s);
    const pool = [];
    for (const c of cands) {
      if (pool.length >= 10 || c.s < cands[0].s * 0.3) break;
      if (!pool.some(p => Math.abs(p.y - c.y) < H * 0.04 && Math.abs(p.a - c.a) <= 3)) pool.push(c);
    }
    // straightness: how many vertical strips have their own strongest edge right on the candidate line
    const STR = 12, win = Math.max(3, Math.round(H * 0.05));
    function stripFit(c) {
      const t = Math.tan(c.a / DEG), xs = [], ys = [];
      let hit = 0;
      for (let s = 0; s < STR; s++) {
        const xa = Math.floor(s * W / STR), xb = Math.floor((s + 1) * W / STR), xc = (xa + xb) / 2;
        const yc = c.y + (xc - W / 2) * t;
        let bestE = 0, bestY = -1, atLine = 0;
        for (let y = Math.max(1, Math.round(yc) - win); y < Math.min(H - 1, Math.round(yc) + win); y++) {
          let e = 0;
          for (let x = xa; x < xb; x++) {
            const i = y * W + x, j = (y - 1) * W + x;
            e += Math.abs(R[i] - R[j]) + Math.abs(G[i] - G[j]) + Math.abs(B[i] - B[j]);
          }
          e /= (xb - xa);
          if (Math.abs(y - 0.5 - yc) <= 1.6 && e > atLine) atLine = e;
          if (e > bestE) { bestE = e; bestY = y - 0.5; }
        }
        if (atLine > 6 && atLine >= bestE * 0.5) hit++;
        if (bestY >= 0 && bestE > 6) { xs.push(xc); ys.push(bestY); }
      }
      return { hit: hit / STR, xs, ys };
    }
    // texture (local luminance variation) in a band of rows, following the candidate's tilt
    function texture(c, from, to) {
      const t = Math.tan(c.a / DEG); let sum = 0, n = 0;
      for (let x = 0; x < W - 1; x += 1) {
        const off = (x - W / 2) * t;
        for (let dy = from; dy < to; dy++) {
          const y = Math.round(c.y + off + dy);
          if (y < 0 || y >= H - 1) continue;
          const i = y * W + x;
          sum += Math.abs(L[i] - L[i + 1]) + Math.abs(L[i] - L[i + W]); n++;
        }
      }
      return n ? sum / n : 0;
    }
    let best = null;
    const band = Math.max(3, Math.round(H * 0.08));
    for (const c of pool) {
      const f = stripFit(c);
      c.straight = f.hit; c.fit = f;
      // sky above a horizon is smoother than the sea below it (sand below the sea is smoother than the sea)
      const ta = texture(c, -band - 1, -1), tb = texture(c, 2, band + 2);
      c.tex = clamp((tb + 1.5) / (ta + 1.5), 0.35, 3);
      c.score = c.s * (0.25 + f.hit) * Math.pow(c.tex, P.tex) * (1 + P.up * (1 - c.y / H)) / (1 + (c.a / P.tilt) ** 2);
      if (!best || c.score > best.score) best = c;
    }
    if (best) {
      out.horizon = +(best.y / H).toFixed(4);
      out.tilt = best.a;
      out.hConf = +clamp((best.straight - 0.2) / 0.6, 0, 1).toFixed(3) * clamp(best.s / 25, 0, 1);
      out.hConf = +out.hConf.toFixed(3);
      // refine: RANSAC over edge peaks in vertical strips near the chosen line. A headland or island
      // sitting on the horizon only covers part of the width, so the level sea segment usually wins.
      const t = Math.tan(best.a / DEG), pts = [], RW = Math.max(4, Math.round(H * 0.05));
      for (let sI = 0; sI < STR; sI++) {
        const xa = Math.floor(sI * W / STR), xb = Math.floor((sI + 1) * W / STR), xc = (xa + xb) / 2;
        const yc = best.y + (xc - W / 2) * t, prof = [];
        for (let y = Math.max(1, Math.round(yc) - RW); y < Math.min(H - 1, Math.round(yc) + RW); y++) {
          let e = 0;
          for (let x = xa; x < xb; x++) { const i = y * W + x, j = (y - 1) * W + x; e += Math.abs(R[i] - R[j]) + Math.abs(G[i] - G[j]) + Math.abs(B[i] - B[j]); }
          prof.push([y - 0.5, e / (xb - xa)]);
        }
        const peaks = prof.filter((p, i) => p[1] > 6 && (i === 0 || p[1] >= prof[i - 1][1]) && (i === prof.length - 1 || p[1] > prof[i + 1][1]))
          .sort((p, q) => q[1] - p[1]).slice(0, 3);
        peaks.forEach(p => pts.push({ s: sI, x: xc, y: p[0], e: p[1] }));
      }
      let bestL = null;
      for (let i = 0; i < pts.length; i++) for (let j = i + 1; j < pts.length; j++) {
        const p = pts[i], q = pts[j]; if (p.s === q.s) continue;
        const m = (q.y - p.y) / (q.x - p.x), ang = Math.atan(m) * DEG; if (Math.abs(ang) > 10) continue;
        const c0 = p.y - m * p.x;
        const inl = new Map();
        for (const r of pts) if (Math.abs(r.y - (m * r.x + c0)) <= 1.2) { const o = inl.get(r.s); if (!o || r.e > o.e) inl.set(r.s, r); }
        if (inl.size < 4) continue;
        let sc = 0; inl.forEach(r => sc += Math.sqrt(r.e));
        sc /= 1 + (ang / 6) ** 2;
        if (!bestL || sc > bestL.sc) bestL = { sc, inl: [...inl.values()] };
      }
      if (bestL) {
        const fit = lsq(bestL.inl.map(r => r.x), bestL.inl.map(r => r.y));
        const yMid = (fit.m * W / 2 + fit.c) / H;
        if (Math.abs(yMid - best.y / H) < 0.04) {
          out.tilt = +(Math.atan(fit.m) * DEG).toFixed(2);
          out.horizon = +clamp(yMid, 0, 1).toFixed(4);
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

  const api = { analyze, P };
  if (typeof module !== "undefined" && module.exports) module.exports = api; else root.SceneAnalyzer = api;
})(typeof self !== "undefined" ? self : this);
