/* Find My View v2: multi-scene live coach, check-a-shot, smart burst and preference log.
 * Uses globals from index.html (profile, looks, nearestLook, assess, statsFor, analyzeImage, loadImg, $, clamp, pct)
 * plus SceneAnalyzer (analyze.js), Geo (js/geometry.js), Coach (js/coach.js). The smart model is js/smart.js. */
"use strict";

const SCENES_FALLBACK = [
  { id: "beach", label: "Beach & ocean", coach: "horizon" }, { id: "sunset", label: "Sunset & sky", coach: "horizon" },
  { id: "landscape", label: "Landscape", coach: "horizon" }, { id: "city", label: "City & street", coach: "architecture" },
  { id: "building", label: "Building & landmark", coach: "architecture" }, { id: "interior", label: "Interior", coach: "architecture" },
  { id: "food", label: "Food & drink", coach: "food" }, { id: "people", label: "People", coach: "people" },
  { id: "closeup", label: "Close-up & nature", coach: "subject" }, { id: "animal", label: "Animals", coach: "subject" },
  { id: "night", label: "Night", coach: "night" }
];
const sceneById = id => SCENES_FALLBACK.find(s => s.id === id);
const PREFS_KEY = "fmv.prefs.v1";

/* ---------------- smart model ---------------- */
let Smart = null, smartState = "off";   // off | loading | ready | error
async function ensureSmart() {
  if (smartState === "ready") return true;
  if (smartState === "loading") return false;
  smartState = "loading"; renderSmartStatus(0);
  try {
    Smart = await import("./smart.js");
    await Smart.load((p, total) => renderSmartStatus(p, total));
    smartState = "ready"; renderSmartStatus(1); return true;
  } catch (e) {
    console.error(e); smartState = "error"; renderSmartStatus(0, 0, e.message); return false;
  }
}
function renderSmartStatus(p, total, err) {
  const t = smartState === "ready" ? "Smart model on: auto scene detection and look score"
    : smartState === "loading" ? `Downloading smart model… ${Math.round(p * 100)}%${total ? ` of ${Math.round(total / 1e6)} MB` : ""} (one time)`
    : smartState === "error" ? `Smart model failed to load: ${err || "check your connection"}. Tap to retry.`
    : "Turn on the smart model (about 90 MB, one-time download) for automatic scene detection and a look score.";
  document.querySelectorAll(".smartStatus").forEach(el => { el.textContent = t; el.classList.toggle("on", smartState === "ready"); });
  document.querySelectorAll(".smartBtn").forEach(b => b.style.display = smartState === "ready" || smartState === "loading" ? "none" : "");
}
document.querySelectorAll(".smartBtn").forEach(b => b.onclick = () => { try { localStorage.setItem("fmv.smart", "1"); } catch (e) {} ensureSmart(); });

/* ---------------- scene chips ---------------- */
let sceneMode = "auto";
function renderSceneSeg(el, current, onPick) {
  el.innerHTML = "";
  [{ id: "auto", label: "Auto" }, ...SCENES_FALLBACK].forEach(s => {
    const b = document.createElement("button"); b.textContent = s.id === "auto" ? "Auto" : s.label.split(" & ")[0];
    b.className = current === s.id ? "on" : ""; b.onclick = () => onPick(s.id); el.appendChild(b);
  });
}
function onLiveTab() {
  renderSceneSeg($("#sceneSeg"), sceneMode, id => { sceneMode = id; sceneAvg = null; onLiveTab(); });
  renderSmartStatus(0);
}

/* ---------------- sensors ---------------- */
let att = null, sensorsOn = false, beta = null;
async function startSensors() {
  try {
    if (typeof DeviceMotionEvent !== "undefined" && DeviceMotionEvent.requestPermission) { if (await DeviceMotionEvent.requestPermission() !== "granted") return; }
    if (typeof DeviceOrientationEvent !== "undefined" && DeviceOrientationEvent.requestPermission) { try { await DeviceOrientationEvent.requestPermission(); } catch (e) {} }
  } catch (e) { return; }
  if (sensorsOn) return; sensorsOn = true;
  addEventListener("deviceorientation", e => { if (e.beta != null) beta = e.beta; });
  addEventListener("devicemotion", e => {
    const g = e.accelerationIncludingGravity; if (!g || g.x == null) return;
    let ax = g.x, ay = g.y, az = g.z;
    const ang = (screen.orientation && screen.orientation.angle) || window.orientation || 0;   // undo screen rotation
    if (ang) { const r = -ang * Math.PI / 180, c = Math.cos(r), s = Math.sin(r); [ax, ay] = [ax * c - ay * s, ax * s + ay * c]; }
    const a = Geo.attitude(ax, ay, az);
    // some browsers report gravity with the opposite sign: an upright phone then reads roll ≈ ±180
    if (Math.abs(a.roll) > 90) { a.roll = +(a.roll - 180 * Math.sign(a.roll)).toFixed(1); a.elevation = -a.elevation; }
    if (beta != null) a.elevation = +(beta - 90).toFixed(1);   // deviceorientation beta is consistent across platforms
    att = att ? { roll: att.roll + (a.roll - att.roll) * .3, elevation: att.elevation + (a.elevation - att.elevation) * .3, flatTilt: att.flatTilt + (a.flatTilt - att.flatTilt) * .3, ax, ay } : { ...a, ax, ay };
  });
}

/* ---------------- live loop ---------------- */
const lv = { video: $("#video"), ov: $("#overlay") };
const octx = lv.ov.getContext("2d");
const small = Object.assign(document.createElement("canvas"), { width: AW, height: AH });
const sctx = small.getContext("2d", { willReadFrequently: true });
const clipC = Object.assign(document.createElement("canvas"), { width: 168, height: 224 });
const cctx = clipC.getContext("2d", { willReadFrequently: true });
let stream = null, raf = 0, lastA = 0, lastSmart = 0, smartBusy = false;
let L = null;            // smoothed measurements
let prevImg = null, sceneAvg = null, curScene = null, aesAvg = null, lastCoach = null, foodMode = "auto";

function cover(srcW, srcH, dstW, dstH) { const s = Math.max(dstW / srcW, dstH / srcH), w = dstW / s, h = dstH / s; return [(srcW - w) / 2, (srcH - h) / 2, w, h]; }
async function startLive() {
  startSensors();
  if (localStorage.getItem("fmv.smart") === "1") ensureSmart();
  try {
    stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: { ideal: "environment" }, width: { ideal: 1920 }, height: { ideal: 1440 } }, audio: false });
    lv.video.srcObject = stream; await lv.video.play();
    $("#startBtn").textContent = "Stop"; $("#snapBtn").disabled = false; $("#burstBtn").disabled = false;
    L = null; prevImg = null; loop();
  } catch (e) { $("#cue").textContent = "Camera unavailable"; $("#cue2").textContent = "Allow camera access, and open the page over https."; }
}
function stopLive() {
  cancelAnimationFrame(raf); raf = 0;
  if (stream) stream.getTracks().forEach(t => t.stop()); stream = null;
  $("#startBtn").textContent = "Start camera"; $("#snapBtn").disabled = true; $("#burstBtn").disabled = true; $("#stage").classList.remove("match");
}
$("#startBtn").onclick = () => stream ? stopLive() : startLive();

const ema = (p, v, a) => p == null || v == null ? v : p + (v - p) * a;
function currentSceneInfo() {
  if (sceneMode !== "auto") return { ...sceneById(sceneMode), p: 1, src: "manual" };
  if (curScene) return { ...curScene, src: "smart" };
  // no smart model: guess from geometry and phone angle
  if (att && att.elevation < -35) return { ...sceneById("food"), p: 0, src: "guess" };
  if (L && L.vert && L.vert.density > 0.09) return { ...sceneById("building"), p: 0, src: "guess" };
  return { ...sceneById("landscape"), p: 0, src: "guess" };
}
function measure(img) {
  const hz = SceneAnalyzer.analyze(img), vert = Geo.verticals(img), sym = Geo.symmetry(img), exp = Geo.exposure(img), motion = Geo.motion(prevImg, img);
  prevImg = img;
  if (!L) { L = { hz: { ...hz }, vert: { ...vert }, sym, exp, motion, seenH: 0 }; return; }
  const okH = hz.horizon != null && hz.hConf > .15;
  if (okH) {
    const a = L.hz.horizon == null || Math.abs(hz.horizon - L.hz.horizon) > .15 ? 1 : .35;
    for (const k of ["horizon", "tilt", "sand", "hConf"]) L.hz[k] = ema(L.hz[k], hz[k], a);
    L.hz.shore = hz.shore == null ? null : ema(L.hz.shore, hz.shore, a); L.hz.sunY = hz.sunY; L.seenH = Math.min(L.seenH + 1, 30);
  } else { L.seenH = Math.max(0, L.seenH - 2); if (!L.seenH) { L.hz.horizon = null; L.hz.hConf = 0; } }
  for (const k of ["roll", "keystone", "conf", "density"]) L.vert[k] = ema(L.vert[k], vert[k], .35);
  L.sym = sym; L.exp = exp; L.motion = ema(L.motion, motion, .3);
}
async function smartTick() {
  if (smartBusy || smartState !== "ready") return;
  smartBusy = true;
  try {
    const r = await Smart.analyze(clipC);
    aesAvg = ema(aesAvg, r.aesthetic, .4);
    const probs = Object.fromEntries(r.scenes.map(s => [s.id, s.p]));
    sceneAvg = sceneAvg ? Object.fromEntries(Object.keys(probs).map(k => [k, sceneAvg[k] * .6 + probs[k] * .4])) : probs;
    const top = Object.entries(sceneAvg).sort((a, b) => b[1] - a[1])[0];
    if (!curScene || (top[0] !== curScene.id && top[1] > (sceneAvg[curScene.id] || 0) + .1)) curScene = { ...sceneById(top[0]), p: top[1] };
    else curScene.p = sceneAvg[curScene.id];
  } catch (e) { console.error(e); }
  smartBusy = false;
}
function loop() {
  raf = requestAnimationFrame(loop);
  const v = lv.video; if (!v.videoWidth) return;
  const dpr = Math.min(2, devicePixelRatio || 1), W = Math.round(lv.ov.clientWidth * dpr), H = Math.round(lv.ov.clientHeight * dpr);
  if (lv.ov.width !== W || lv.ov.height !== H) { lv.ov.width = W; lv.ov.height = H; }
  const [sx, sy, sw, sh] = cover(v.videoWidth, v.videoHeight, W, H);
  octx.drawImage(v, sx, sy, sw, sh, 0, 0, W, H);
  const now = performance.now();
  if (now - lastA > 100) {
    lastA = now;
    sctx.drawImage(v, sx, sy, sw, sh, 0, 0, AW, AH);
    measure(sctx.getImageData(0, 0, AW, AH));
  }
  if (smartState === "ready" && now - lastSmart > 1200 && !smartBusy) {
    lastSmart = now; cctx.drawImage(v, sx, sy, sw, sh, 0, 0, 168, 224); smartTick();
  }
  if (L) drawLive(W, H, dpr);
}

function beachLook(sc, hz) {
  if (!sc || sc.id !== "beach" || !looks || !looks.length) return null;
  const l = nearestLook(hz && hz.horizon != null ? hz : { horizon: null });
  return l ? l.stats : null;
}
function runCoach(sc, meas, attitude) {
  const look = beachLook(sc, meas.hz);
  return Coach.coach({ type: sc.coach, scene: sc.id, hz: meas.hz, vert: meas.vert, sym: meas.sym, exp: meas.exp, motion: meas.motion, att: attitude, look, foodMode });
}

function drawLive(W, H, dpr) {
  const sc = currentSceneInfo(), meas = { ...L, hz: L.seenH > 2 ? L.hz : { ...L.hz, horizon: null, hConf: 0 } };
  const r = runCoach(sc, meas, att); lastCoach = r;
  const font = (w, s) => `${w} ${s * dpr}px -apple-system,sans-serif`;
  // thirds
  octx.strokeStyle = "#ffffff22"; octx.lineWidth = dpr; octx.beginPath();
  [1 / 3, 2 / 3].forEach(t => { octx.moveTo(t * W, 0); octx.lineTo(t * W, H); octx.moveTo(0, t * H); octx.lineTo(W, t * H); }); octx.stroke();

  if (sc.coach === "horizon" && r.targets.horizon) {
    const b = r.targets.horizon;
    octx.fillStyle = "#7fd49b30"; octx.fillRect(0, b.lo * H, W, (b.hi - b.lo) * H);
    octx.strokeStyle = "#7fd49bcc"; octx.lineWidth = 2 * dpr; octx.setLineDash([10 * dpr, 8 * dpr]);
    octx.beginPath(); octx.moveTo(0, b.med * H); octx.lineTo(W, b.med * H); octx.stroke(); octx.setLineDash([]);
    if (meas.hz.horizon != null) {
      const y = meas.hz.horizon * H, dy = Math.tan(meas.hz.tilt * Math.PI / 180) * W / 2, lvl = Math.abs(meas.hz.tilt) <= 1;
      octx.strokeStyle = lvl ? "#fff" : "#f0a35e"; octx.lineWidth = 3 * dpr; octx.beginPath(); octx.moveTo(0, y - dy); octx.lineTo(W, y + dy); octx.stroke();
      if (meas.hz.horizon < b.lo || meas.hz.horizon > b.hi) arrow(W / 2, y, b.med * H, "#ffffffdd", dpr);
    }
  }
  if (sc.coach === "architecture" || sc.coach === "night") {
    // true verticals drawn as reference; they tilt with the detected roll so the mismatch is visible
    const rl = r.worldRoll || 0, t = Math.tan(rl * Math.PI / 180);
    octx.strokeStyle = Math.abs(rl) <= 1 ? "#7fd49b99" : "#f0a35e99"; octx.lineWidth = 2 * dpr; octx.setLineDash([8 * dpr, 6 * dpr]);
    [0.2, 0.8].forEach(fx => { octx.beginPath(); octx.moveTo(fx * W - t * H / 2, 0); octx.lineTo(fx * W + t * H / 2, H); octx.stroke(); });
    if (r.targets.symAxis != null) {
      octx.strokeStyle = "#5fd0c4"; octx.beginPath(); octx.moveTo(r.targets.symAxis * W, 0); octx.lineTo(r.targets.symAxis * W, H); octx.stroke();
      octx.strokeStyle = "#ffffff55"; octx.beginPath(); octx.moveTo(W / 2, 0); octx.lineTo(W / 2, H); octx.stroke();
    }
    octx.setLineDash([]);
  }
  if (sc.coach === "food" && r.targets.food) {
    const f = r.targets.food, cx = W / 2, cy = H * .45, R = W * .18;
    if (f.mode === "overhead" && att) {
      octx.strokeStyle = "#ffffffaa"; octx.lineWidth = 2 * dpr; octx.beginPath(); octx.arc(cx, cy, R, 0, 7); octx.stroke();
      octx.beginPath(); octx.arc(cx, cy, R * .18, 0, 7); octx.stroke();
      const bx = clamp(-att.ax / 9.81 * R * 3, -R, R), by = clamp(att.ay / 9.81 * R * 3, -R, R);
      octx.fillStyle = f.flatTilt <= 4 ? "#7fd49b" : "#f0a35e"; octx.beginPath(); octx.arc(cx + bx, cy + by, R * .14, 0, 7); octx.fill();
    } else {
      octx.fillStyle = "#0008"; octx.beginPath(); octx.roundRect(W * .08, H * .08, W * .5, 30 * dpr, 8 * dpr); octx.fill();
      octx.fillStyle = "#fff"; octx.font = font(700, 13); octx.textAlign = "left";
      octx.fillText(`Angle ${Math.round(-f.elevation)}° down · aim 30–55°`, W * .08 + 10 * dpr, H * .08 + 20 * dpr);
    }
  }
  // level bubble (all but overhead food)
  if (r.worldRoll != null && !(sc.coach === "food" && r.targets.food && r.targets.food.mode === "overhead")) {
    const t = r.worldRoll, bx = W / 2, by = H * .07, bw = W * .28, lvl = Math.abs(t) <= 1;
    octx.fillStyle = "#0009"; octx.beginPath(); octx.roundRect(bx - bw / 2, by - 9 * dpr, bw, 18 * dpr, 9 * dpr); octx.fill();
    octx.fillStyle = "#7fd49b55"; octx.fillRect(bx - bw * .06, by - 9 * dpr, bw * .12, 18 * dpr);
    octx.fillStyle = lvl ? "#7fd49b" : "#f0a35e"; octx.beginPath(); octx.arc(bx + clamp(t / 6, -1, 1) * bw / 2, by, 7 * dpr, 0, 7); octx.fill();
    octx.fillStyle = "#fff"; octx.font = font(700, 11); octx.textAlign = "center"; octx.fillText(`${t < 0 ? "−" : ""}${Math.abs(t).toFixed(1)}°`, bx, by + 24 * dpr);
  }
  // scene + look score chips
  octx.textAlign = "left"; octx.font = font(700, 12);
  const chip = `${sc.label}${sc.src === "smart" ? ` ${Math.round(sc.p * 100)}%` : sc.src === "guess" ? " (guess)" : ""}`;
  const cw = octx.measureText(chip).width + 16 * dpr;
  octx.fillStyle = "#000a"; octx.beginPath(); octx.roundRect(8 * dpr, H * .12, cw, 24 * dpr, 12 * dpr); octx.fill();
  octx.fillStyle = "#fff"; octx.fillText(chip, 16 * dpr, H * .12 + 16 * dpr);
  if (aesAvg != null && smartState === "ready") {
    const s = aesToTen(aesAvg), txt = `Look ${s.toFixed(1)}`, w2 = octx.measureText(txt).width + 16 * dpr;
    octx.fillStyle = "#000a"; octx.beginPath(); octx.roundRect(W - w2 - 8 * dpr, H * .12, w2, 24 * dpr, 12 * dpr); octx.fill();
    octx.fillStyle = s >= 6.5 ? "#7fd49b" : s >= 5 ? "#fff" : "#f0a35e"; octx.fillText(txt, W - w2, H * .12 + 16 * dpr);
  }
  // HUD text
  const first = r.cues.find(c => c.level === "fix") || r.cues.find(c => c.level === "tip");
  $("#stage").classList.toggle("match", r.match);
  $("#cue").textContent = r.match ? "Looks great, shoot!" : first ? first.text : "";
  $("#cue2").textContent = r.match ? (first && first.level === "tip" ? first.text : "Tap Smart burst to grab the best frame.") : first ? first.sub : "";
  $("#foodSeg").style.display = sc.coach === "food" ? "" : "none";
}
function arrow(x, y1, y2, col, dpr) {
  octx.strokeStyle = col; octx.fillStyle = col; octx.lineWidth = 5 * dpr; octx.lineCap = "round";
  octx.beginPath(); octx.moveTo(x, y1); octx.lineTo(x, y2); octx.stroke();
  const d = Math.sign(y2 - y1) || 1, s = 14 * dpr;
  octx.beginPath(); octx.moveTo(x, y2 + d * s * .3); octx.lineTo(x - s, y2 - d * s); octx.lineTo(x + s, y2 - d * s); octx.closePath(); octx.fill();
}
// LAION aesthetic scores on phone photos mostly fall between ~3.5 and ~7; stretch to a friendlier 0–10
function aesToTen(a) { return clamp((a - 3.5) / 3.5 * 10, 0, 10); }
function aesWord(a) { const s = aesToTen(a); return s >= 7.5 ? "great" : s >= 6 ? "good" : s >= 4 ? "decent" : "snapshot"; }

document.querySelectorAll("#foodSeg button").forEach(b => b.onclick = () => {
  foodMode = b.dataset.mode; document.querySelectorAll("#foodSeg button").forEach(x => x.classList.toggle("on", x === b));
});

/* ---------------- capture + smart burst ---------------- */
function grabFrame(maxW = 1440) {
  const v = lv.video, [sx, sy, sw, sh] = cover(v.videoWidth, v.videoHeight, 3, 4);
  const s = Math.min(1, maxW / sh), c = document.createElement("canvas");
  c.width = Math.round(sw * s); c.height = Math.round(sh * s);
  c.getContext("2d").drawImage(v, sx, sy, sw, sh, 0, 0, c.width, c.height);
  return c;
}
function shotEl(c, label) {
  const a = document.createElement("a"); a.href = c.toDataURL("image/jpeg", .9); a.download = "findmyview-" + Date.now() + ".jpg";
  const im = new Image(); im.src = a.href; a.appendChild(im);
  if (label) { const b = document.createElement("b"); b.textContent = label; a.appendChild(b); }
  return a;
}
$("#snapBtn").onclick = () => { if (lv.video.videoWidth) $("#shots").prepend(shotEl(grabFrame())); };

$("#burstBtn").onclick = async () => {
  if (!lv.video.videoWidth) return;
  const btn = $("#burstBtn"); btn.disabled = true; btn.textContent = "Hold steady…";
  const frames = [];
  for (let i = 0; i < 8; i++) {
    const c = grabFrame();
    frames.push({ c, coach: lastCoach, att: att ? { ...att } : null, scene: currentSceneInfo() });
    await new Promise(r => setTimeout(r, 300));
  }
  btn.textContent = "Scoring…";
  const smartOn = smartState === "ready" || (localStorage.getItem("fmv.smart") === "1" && await ensureSmart());
  for (const f of frames) {
    const sm = Object.assign(document.createElement("canvas"), { width: AW, height: AH });
    sm.getContext("2d").drawImage(f.c, 0, 0, AW, AH);
    const img = sm.getContext("2d").getImageData(0, 0, AW, AH);
    f.meas = { hz: SceneAnalyzer.analyze(img), vert: Geo.verticals(img), sym: Geo.symmetry(img), exp: Geo.exposure(img), motion: 0 };
    f.rule = runCoach(f.scene, f.meas, f.att);
    f.fixes = f.rule.cues.filter(c => c.level === "fix").length;
    if (smartOn) {
      const cc = Object.assign(document.createElement("canvas"), { width: 168, height: 224 }); cc.getContext("2d").drawImage(f.c, 0, 0, 168, 224);
      const r = await Smart.analyze(cc); f.aes = r.aesthetic; f.embed = r.embed;
    }
    f.sharp = sharpness(img);
    f.score = (f.aes != null ? aesToTen(f.aes) : 5) - f.fixes * 1.5 + Math.min(1, f.sharp / 20);
  }
  const best = frames.reduce((a, b) => b.score > a.score ? b : a);
  renderBurst(frames, best);
  btn.disabled = false; btn.textContent = "Smart burst";
};
function sharpness(img) { // mean absolute Laplacian on luminance
  const { data: d, width: W, height: H } = img; let s = 0, n = 0;
  const l = i => 0.299 * d[i * 4] + 0.587 * d[i * 4 + 1] + 0.114 * d[i * 4 + 2];
  for (let y = 1; y < H - 1; y += 2) for (let x = 1; x < W - 1; x += 2) { const i = y * W + x; s += Math.abs(4 * l(i) - l(i - 1) - l(i + 1) - l(i - W) - l(i + W)); n++; }
  return s / n;
}
function renderBurst(frames, best) {
  const box = $("#burst"); box.innerHTML = "";
  const h = document.createElement("div"); h.className = "mut"; h.style.margin = "10px 0 6px";
  h.textContent = "Tap the one you'd keep. Your pick trains your personal taste (stored on this phone; see the Data tab).";
  box.appendChild(h);
  const strip = document.createElement("div"); strip.className = "burst";
  frames.forEach((f, i) => {
    const d = document.createElement("button"); d.className = "bframe" + (f === best ? " best" : "");
    const im = new Image(); im.src = f.c.toDataURL("image/jpeg", .6); d.appendChild(im);
    const b = document.createElement("b"); b.textContent = (f === best ? "★ " : "") + (f.aes != null ? aesToTen(f.aes).toFixed(1) : f.score.toFixed(1)); d.appendChild(b);
    d.onclick = () => {
      logPreference(frames, i, best);
      $("#shots").prepend(shotEl(f.c, f === best ? "your pick = app's pick" : "your pick"));
      box.innerHTML = `<div class="mut" style="margin:10px 0">Saved. ${f === best ? "You agreed with the app." : "You overruled the app: that's the most useful kind of feedback."}</div>`;
    };
    strip.appendChild(d);
  });
  box.appendChild(strip);
}

/* ---------------- preference log (training data) ---------------- */
function b64int8(f32) { // quantise a unit vector to int8 and base64 it (512 floats -> ~684 chars)
  const q = new Int8Array(f32.length); for (let i = 0; i < f32.length; i++) q[i] = clamp(Math.round(f32[i] * 127 / 0.25), -127, 127);
  let s = ""; new Uint8Array(q.buffer).forEach(b => s += String.fromCharCode(b)); return btoa(s);
}
function loadPrefs() { try { return JSON.parse(localStorage.getItem(PREFS_KEY)) || []; } catch (e) { return []; } }
function logPreference(frames, chosen, best) {
  const prefs = loadPrefs();
  prefs.push({
    v: 1, t: new Date().toISOString(), scene: frames[chosen].scene.id, sceneSrc: frames[chosen].scene.src, coach: frames[chosen].scene.coach,
    chosen, appPick: frames.indexOf(best),
    frames: frames.map(f => ({
      aes: f.aes != null ? +f.aes.toFixed(3) : null, fixes: f.fixes, sharp: +f.sharp.toFixed(2),
      roll: f.rule.worldRoll, horizon: f.meas.hz.horizon, hConf: f.meas.hz.hConf, keystone: f.meas.vert.keystone, sym: f.meas.sym.score,
      exp: f.meas.exp, elevation: f.att ? +f.att.elevation.toFixed(1) : null,
      emb: f.embed ? b64int8(f.embed) : null
    }))
  });
  while (prefs.length > 300) prefs.shift();
  try { localStorage.setItem(PREFS_KEY, JSON.stringify(prefs)); } catch (e) { prefs.splice(0, 50); localStorage.setItem(PREFS_KEY, JSON.stringify(prefs)); }
  renderData();
}
function renderData() {
  const p = loadPrefs(), agree = p.filter(x => x.chosen === x.appPick).length;
  const by = {}; p.forEach(x => by[x.scene] = (by[x.scene] || 0) + 1);
  $("#dataStats").innerHTML = p.length
    ? `<b>${p.length}</b> picks logged · app agreed with you ${Math.round(agree / p.length * 100)}% of the time<br><span class="mut">${Object.entries(by).map(([k, n]) => `${(sceneById(k) || { label: k }).label}: ${n}`).join(" · ")}</span>`
    : "No picks yet. Use Smart burst in the Coach tab and tap the frame you'd keep.";
}
$("#exportPrefs").onclick = () => {
  const blob = new Blob([JSON.stringify({ app: "findmyview", kind: "burst-preferences", embedding: "clip-vit-base-patch32 image_embeds, L2-normalised, int8 (x/0.25*127), base64", records: loadPrefs() })], { type: "application/json" });
  const a = document.createElement("a"); a.href = URL.createObjectURL(blob); a.download = "findmyview-preferences.json"; a.click();
};
$("#clearPrefs").onclick = () => { if (confirm("Delete all logged picks on this phone?")) { localStorage.removeItem(PREFS_KEY); renderData(); } };

/* ---------------- check a shot ---------------- */
let checkScene = "auto", checkImg = null;
function renderCheckSeg() { renderSceneSeg($("#checkSceneSeg"), checkScene, id => { checkScene = id; renderCheckSeg(); if (checkImg) runCheck(checkImg); }); }
$("#checkInput").onchange = async e => {
  const file = e.target.files[0]; e.target.value = ""; if (!file) return;
  checkImg = await loadImg(file); runCheck(checkImg);
};
async function runCheck(img) {
  const cv = $("#checkView"), w = img.naturalWidth, h = img.naturalHeight, s = Math.min(1, 1200 / Math.max(w, h));
  cv.width = Math.round(w * s); cv.height = Math.round(h * s); cv.style.display = "block";
  const x = cv.getContext("2d"); x.drawImage(img, 0, 0, cv.width, cv.height);
  const res = $("#checkResult"); res.style.display = "block"; res.innerHTML = "<div class='mut'>Analyzing…</div>";
  // measurements on a small copy (long side 160)
  const k = 160 / Math.max(w, h), sm = Object.assign(document.createElement("canvas"), { width: Math.max(8, Math.round(w * k)), height: Math.max(8, Math.round(h * k)) });
  sm.getContext("2d").drawImage(img, 0, 0, sm.width, sm.height);
  const id = sm.getContext("2d").getImageData(0, 0, sm.width, sm.height);
  const meas = { hz: SceneAnalyzer.analyze(id), vert: Geo.verticals(id), sym: Geo.symmetry(id), exp: Geo.exposure(id), motion: null };
  let sc = checkScene !== "auto" ? { ...sceneById(checkScene), src: "manual", p: 1 } : null, smart = null;
  if (smartState === "ready" || localStorage.getItem("fmv.smart") === "1") {
    if (await ensureSmart()) {
      const cc = Object.assign(document.createElement("canvas"), { width: 224, height: 224 }), ccx = cc.getContext("2d");
      const [sx, sy, sw, sh] = cover(w, h, 224, 224); ccx.drawImage(img, sx, sy, sw, sh, 0, 0, 224, 224);
      smart = await Smart.analyze(cc);
      if (!sc) sc = { ...sceneById(smart.top.id), src: "smart", p: smart.top.p };
    }
  }
  if (!sc) sc = meas.vert.density > 0.09 ? { ...sceneById("building"), src: "guess", p: 0 } : { ...sceneById("landscape"), src: "guess", p: 0 };
  const r = runCoach(sc, meas, null);
  // overlay
  const W = cv.width, H = cv.height, lw = Math.max(2, W / 300);
  if (sc.coach === "horizon" && r.targets.horizon) {
    const b = r.targets.horizon; x.fillStyle = "#7fd49b33"; x.fillRect(0, b.lo * H, W, (b.hi - b.lo) * H);
    if (meas.hz.horizon != null) {
      const dy = Math.tan(meas.hz.tilt * Math.PI / 180) * W / 2; x.strokeStyle = Math.abs(meas.hz.tilt) <= 1 ? "#fff" : "#f0a35e"; x.lineWidth = lw; x.setLineDash([lw * 5, lw * 3]);
      x.beginPath(); x.moveTo(0, meas.hz.horizon * H - dy); x.lineTo(W, meas.hz.horizon * H + dy); x.stroke(); x.setLineDash([]);
    }
  }
  if (sc.coach === "architecture" && r.targets.symAxis != null) { x.strokeStyle = "#5fd0c4"; x.lineWidth = lw; x.setLineDash([lw * 5, lw * 3]); x.beginPath(); x.moveTo(r.targets.symAxis * W, 0); x.lineTo(r.targets.symAxis * W, H); x.stroke(); x.setLineDash([]); }
  // beach style score if relevant
  let styleHtml = "";
  if (sc.id === "beach" && looks && looks.length && meas.hz.horizon != null) {
    const look = nearestLook(meas.hz), a = assess(meas.hz, look);
    styleHtml = `<div class="mut" style="margin-top:10px">Against your beach style (“${look.name}”): <b style="color:var(--tx)">${a.score == null ? "—" : a.score}/100</b></div>`;
  }
  const col = { ok: "var(--ok)", tip: "var(--warn)", fix: "var(--bad)" };
  const cues = r.cues.length ? r.cues : [{ level: "ok", text: "Nothing to fix from the rules for this scene type.", sub: "" }];
  const stillCues = cues.filter(c => !/^Rotate/.test(c.text)).map(c => c.level === "fix" ? { ...c, text: "Next time: " + c.text.charAt(0).toLowerCase() + c.text.slice(1) } : c).concat(r.worldRoll != null && Math.abs(r.worldRoll) > 1 ? [{ level: "fix", text: `Straighten by ${Math.abs(r.worldRoll).toFixed(1)}° (rotate ${r.worldRoll > 0 ? "counter-clockwise" : "clockwise"} when editing)`, sub: `measured from the ${r.rollSource}` }] : []);
  res.innerHTML =
    `<div class="row" style="align-items:baseline;gap:12px">` +
      (smart ? `<div class="score">${aesToTen(smart.aesthetic).toFixed(1)}</div><div class="mut">look score (${aesWord(smart.aesthetic)})<br>generic model, not yet your taste</div>` : `<div class="mut">Turn on the smart model for a look score and automatic scene detection.</div>`) +
    `</div>` +
    `<div class="mut" style="margin:8px 0">Scene: <b style="color:var(--tx)">${sc.label}</b>${sc.src === "smart" ? ` (${Math.round(sc.p * 100)}% sure${smart.scenes[1] ? `; next: ${smart.scenes[1].label} ${Math.round(smart.scenes[1].p * 100)}%` : ""})` : sc.src === "guess" ? " (guessed; pick the scene above to change)" : ""}</div>` +
    stillCues.map(q => `<div class="fix"><span class="dot" style="background:${col[q.level]}"></span><span>${q.text}${q.sub ? `<br><span class="mut">${q.sub}</span>` : ""}</span></div>`).join("") + styleHtml;
}

/* ---------------- boot ---------------- */
renderCheckSeg(); onLiveTab(); renderData(); renderSmartStatus(0);
if (localStorage.getItem("fmv.smart") === "1") ensureSmart();
