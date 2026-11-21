/* Coaching rules per scene type. Pure functions, no DOM, so they can be unit-tested in Node.
 *
 * coach(s) with s = {
 *   type     : "horizon" | "architecture" | "food" | "people" | "subject" | "night"
 *   scene    : scene id from the smart model (e.g. "beach", "sunset") or null
 *   hz       : SceneAnalyzer.analyze() result (horizon, tilt, hConf, sand, ...)
 *   vert     : Geo.verticals() result      sym : Geo.symmetry() result
 *   exp      : Geo.exposure() result        motion : Geo.motion() value
 *   att      : Geo.attitude() result or null (phone sensors)
 *   look     : beach-profile look stats {horizon:{lo,med,hi}, sand:{...}, sandShare} or null
 *   foodMode : "auto" | "overhead" | "angle"
 * }
 * returns { cues:[{level:"fix"|"tip"|"ok", text, sub}], worldRoll, rollSource, targets:{...}, match }
 * worldRoll: degrees the world appears rotated clockwise in the frame (+ => rotate the phone clockwise).
 */
(function (root) {
  "use strict";
  const pct = v => Math.round(v * 100) + "%";
  const LEVEL_TOL = 1.0;

  function worldRoll(s) {
    const okHz = s.hz && s.hz.horizon != null && s.hz.hConf > 0.15;
    const okV = s.vert && s.vert.conf > 0.3;
    // image evidence first (it is what the photo will show), sensor as fallback
    if (s.type === "horizon" && okHz) return [s.hz.tilt, "horizon"];
    if ((s.type === "architecture" || s.type === "night") && okV) return [s.vert.roll, "verticals"];
    if (s.att && !(s.type === "food" && s.att.elevation < -65)) return [s.att.roll, "sensor"];
    if (okHz) return [s.hz.tilt, "horizon"];
    if (okV) return [s.vert.roll, "verticals"];
    return [null, null];
  }

  function horizonBand(s) {
    if (s.look && s.look.horizon) return { lo: s.look.horizon.lo, med: s.look.horizon.med, hi: s.look.horizon.hi, why: "your style" };
    // rule of thirds: dramatic skies get the lower third (more sky), otherwise the upper third (more foreground)
    const y = s.hz && s.hz.horizon != null ? s.hz.horizon : 0.4;
    const dramatic = s.scene === "sunset" || (s.hz && s.hz.sunY != null);
    const low = dramatic || y > 0.5;
    return low ? { lo: 0.61, med: 0.667, hi: 0.72, why: dramatic ? "dramatic sky: give it two thirds" : "lower third" }
               : { lo: 0.28, med: 0.333, hi: 0.39, why: "upper third" };
  }

  function coach(s) {
    const cues = [], targets = {};
    const [roll, rollSource] = worldRoll(s);
    const fix = (text, sub = "") => cues.push({ level: "fix", text, sub });
    const tip = (text, sub = "") => cues.push({ level: "tip", text, sub });
    const ok = (text, sub = "") => cues.push({ level: "ok", text, sub });

    // 1. level (everything except overhead food)
    const overhead = s.type === "food" && s.att && s.att.elevation < -65;
    if (!overhead && roll != null) {
      if (Math.abs(roll) > LEVEL_TOL) fix(roll > 0 ? "Rotate ↻ dip the right edge" : "Rotate ↺ dip the left edge", `${Math.abs(roll).toFixed(1)}° off level (from the ${rollSource})`);
      else ok("Level");
    }

    // 2. composition, per scene type
    if (s.type === "horizon") {
      const hz = s.hz, band = horizonBand(s); targets.horizon = band;
      if (!hz || hz.horizon == null || hz.hConf <= 0.15) fix("Find the horizon", "Point at where the land or sea meets the sky.");
      else if (hz.horizon < band.lo || hz.horizon > band.hi) fix(hz.horizon > band.hi ? "Tilt the phone down" : "Tilt the phone up", `Put the horizon in the green band (${band.why}).`);
      else ok("Horizon placed", band.why);
      if (s.look && s.look.sandShare >= 0.5 && s.look.sand && hz && hz.horizon != null) {
        const sand = hz.shore == null ? 0 : hz.sand;
        targets.sand = s.look.sand;
        if (sand < s.look.sand.lo) fix("Step back from the water", `Your style keeps ${pct(s.look.sand.lo)}–${pct(s.look.sand.hi)} beach; you have ${pct(sand)}.`);
        else if (sand > s.look.sand.hi) fix("Walk closer to the water", `Your style keeps ${pct(s.look.sand.lo)}–${pct(s.look.sand.hi)} beach; you have ${pct(sand)}.`);
      }
    } else if (s.type === "architecture") {
      const v = s.vert, e = s.att ? s.att.elevation : null;
      if (v && v.conf > 0.3) {
        targets.keystone = v.keystone;
        const looksUp = e != null && e > 25;
        if (Math.abs(v.keystone) > 1.8 && !looksUp) {
          if (v.keystone > 0) fix("Hold the phone upright and step back", `Verticals lean together by ${v.keystone.toFixed(1)}°. Keep the camera level, then step back to fit the top in.`);
          else fix("Point the phone a little higher", `Verticals spread apart by ${Math.abs(v.keystone).toFixed(1)}°: you're pointing down.`);
        } else if (looksUp) tip("Dramatic upward angle", "Fine if it's deliberate. Commit to it: tilt up further than feels natural.");
        else ok("Verticals straight");
      } else tip("Find strong vertical lines", "Edges of buildings, doors or columns help the coach level the shot.");
      if (s.sym && s.sym.score > 0.6) {
        targets.symAxis = s.sym.axis;
        const off = s.sym.axis - 0.5;
        if (Math.abs(off) > 0.035) tip(off < 0 ? "Pan left to centre it" : "Pan right to centre it", "This scene is symmetrical: centre the axis exactly.");
        else ok("Symmetry centred");
      }
    } else if (s.type === "food") {
      const a = s.att;
      if (!a) tip("Shoot from straight above or at about 45°", "Allow motion sensors for live angle guidance.");
      else {
        const mode = s.foodMode === "auto" ? (a.elevation < -65 ? "overhead" : "angle") : s.foodMode;
        targets.food = { mode, elevation: a.elevation, flatTilt: a.flatTilt };
        if (mode === "overhead") {
          if (a.flatTilt > 4) fix("Hold the phone flat", `${a.flatTilt.toFixed(0)}° off a true overhead shot. Centre the bubble.`);
          else ok("Perfect overhead");
        } else {
          const el = a.elevation;
          if (el > -25) fix("Raise the phone and look down", `Aim for about 45° down (now ${Math.round(-el)}°).`);
          else if (el < -55) fix("Lower the phone a little", `Aim for about 45° down (now ${Math.round(-el)}°), or go fully overhead.`);
          else ok("Nice 45° diner's view");
        }
      }
      if (s.exp && s.exp.mean < 0.32) tip("Move to window light", "Food looks best in soft side light. Skip the flash.");
    } else if (s.type === "people") {
      tip("Portrait mode: use Find My Angle", "It coaches the person's best angle.");
    } else if (s.type === "night") {
      if (s.motion != null && s.motion > 0.02) fix("Hold still", "Brace the phone on something and let Night mode finish.");
      else ok("Steady");
    } else if (s.type === "subject") {
      tip("Fill the frame with the subject", "Get close, and keep a clean background behind it.");
    }

    // 3. exposure (all scenes)
    if (s.exp) {
      if (s.exp.hi > 0.05 && s.type !== "night") tip("Highlights are blowing out", "Tap the brightest area, then drag exposure down.");
      else if (s.exp.lo > 0.25 && s.exp.mean < 0.25 && s.type !== "night") tip("Too dark", "Tap the subject to expose for it, or find more light.");
    }
    const match = cues.length > 0 && !cues.some(c => c.level === "fix");
    return { cues, worldRoll: roll, rollSource, targets, match };
  }

  const api = { coach, horizonBand, worldRoll };
  if (typeof module !== "undefined" && module.exports) module.exports = api; else root.Coach = api;
})(typeof self !== "undefined" ? self : this);
