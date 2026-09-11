// ---------------------------------------------------------------------------
// Beta focus — a tapeless forehead trainer that ACTUALLY MOVES. No ears, tape,
// or calibration.
//
// The old hoop-beta wouldn't budge for a good reason: it needs a 20 s
// calibration that fails when the forehead runs hot (>150 µV), and it scores
// beta as a SHARE built to resist muscle — so on marginal contact the ball just
// freezes. This one throws all that out:
//
//   • self-calibrating — it learns your own beta range live, no 20 s ritual;
//   • scores beta AMPLITUDE (13–25 Hz) on the forehead, which has real dynamic
//     range you can actually drive (engage / do mental math — and yes, on a
//     forehead sensor a little jaw/brow tension counts too; beta up front is
//     part arousal, part muscle, and this is honest about that);
//   • forehead only (AF7/AF8), so it works with nothing taped.
//
// Rising tone so you can play it with your eyes open or closed.
// ---------------------------------------------------------------------------

import { SAMPLE_RATE } from "./muse.js";
import { binPower, detrend } from "./signal.js";
import { startTone, stopTone, setToneLift, resumeAudio } from "./audio.js";

const WIN = SAMPLE_RATE;
const BETA_LO = 13, BETA_HI = 25;
const ZONE = 0.6;
const TAU = 0.45;
const el = (id) => document.getElementById(id);

export function createBetaFocus({ channels, getNames, isMuted }) {
  const buf = new Float32Array(WIN);
  let raf = 0, audioOn = false, toneStarted = false;
  let level = 0;                 // smoothed 0..1
  let floorUv = 4, ceilUv = 25;  // adaptive beta-amplitude range (µV), learned live
  let zoneSecs = 0, best = 0, lastNow = 0;

  function foreheadIndices() {
    const names = (getNames && getNames()) || [];
    const a = names.indexOf("AF7"), b = names.indexOf("AF8");
    if (a >= 0 && b >= 0) return [a, b];
    return [1, 2];
  }
  function betaUv(i) {
    const n = channels[i].raw.tail(WIN, buf);
    if (n < WIN) return null;
    let railed = 0;
    for (let j = 0; j < n; j++) if (Math.abs(buf[j]) > 800) railed++;
    if ((railed / n) * 100 > 20) return null;
    detrend(buf, n);
    let p = 0;
    for (let f = BETA_LO; f <= BETA_HI; f++) {
      if (f >= 21 && f <= 22) continue; // skip the headband's ~21.5 Hz device hum (subharmonic of the 42.5 Hz line) — it's not brain
      p += binPower(buf, n, f);
    }
    return Math.sqrt(p);
  }

  function tick(now) {
    const dt = lastNow ? Math.min(0.5, (now - lastNow) / 1000) : 0.1;
    lastNow = now;
    const [a, b] = foreheadIndices();
    const va = betaUv(a), vb = betaUv(b);
    const vals = [va, vb].filter((v) => v != null);
    const cur = vals.length ? Math.max(...vals) : null; // the livelier forehead channel

    if (cur != null) {
      floorUv = Math.min(cur, floorUv + (cur - floorUv) * 0.002 + 0.01);
      ceilUv = Math.max(cur, ceilUv + (cur - ceilUv) * 0.002 - 0.03);
      if (ceilUv < floorUv + 3) ceilUv = floorUv + 3;
      const raw = Math.max(0, Math.min(1, (cur - floorUv) / (ceilUv - floorUv)));
      level += (raw - level) * (1 - Math.exp(-dt / TAU));
    }
    const inZone = cur != null && level >= ZONE;

    const wantTone = audioOn && el("bf-sound")?.checked && !(isMuted && isMuted());
    if (wantTone && !toneStarted) { resumeAudio(); startTone(); toneStarted = true; }
    if (!wantTone && toneStarted) { stopTone(); toneStarted = false; }
    if (toneStarted) setToneLift(cur == null ? 0 : level);

    if (audioOn && cur != null) { if (inZone) zoneSecs += dt; if (level > best) best = level; }

    let state;
    if (cur == null) state = ["no forehead signal", "off"];
    else if (inZone) state = ["focused — hold it", "zone"];
    else if (level >= 0.35) state = ["climbing…", "build"];
    else state = ["quiet — engage: count back from 300 by 7s", "quiet"];

    render({ cur, level, inZone, va, vb, state });
    raf = requestAnimationFrame(tick);
  }
  function dot(id, v) {
    const node = el(id); if (!node) return;
    if (v == null) { node.textContent = "·"; node.className = "eardot warn"; node.title = "no contact"; }
    else { node.textContent = "●"; node.className = "eardot ok"; node.title = `${v.toFixed(0)} µV beta`; }
  }
  function render({ cur, level, inZone, va, vb, state }) {
    const fill = el("bf-fill");
    if (fill) { fill.style.height = `${(level * 100).toFixed(1)}%`; fill.classList.toggle("is-zone", inZone); }
    if (el("bf-level")) el("bf-level").textContent = cur == null ? "—" : `${Math.round(level * 100)}%`;
    if (el("bf-uv")) el("bf-uv").textContent = cur == null ? "—" : `${cur.toFixed(0)} µV`;
    if (el("bf-time")) el("bf-time").textContent = `${zoneSecs.toFixed(0)}s`;
    if (el("bf-best")) el("bf-best").textContent = best ? `${Math.round(best * 100)}%` : "—";
    const s = el("bf-state"); if (s) { s.textContent = state[0]; s.className = `train-state ${state[1]}`; }
    dot("bf-af7", va); dot("bf-af8", vb);
  }
  function begin() { audioOn = true; zoneSecs = 0; best = 0; resumeAudio(); const b = el("bf-begin"); if (b) { b.textContent = "Stop"; b.classList.add("btn--primary"); } }
  function pause() { audioOn = false; if (toneStarted) { stopTone(); toneStarted = false; } const b = el("bf-begin"); if (b) { b.textContent = "Begin"; b.classList.remove("btn--primary"); } }

  el("bf-begin")?.addEventListener("click", () => (audioOn ? pause() : begin()));
  el("bf-reset")?.addEventListener("click", () => { zoneSecs = 0; best = 0; floorUv = 4; ceilUv = 25; });

  return {
    enter() { lastNow = 0; if (!raf) raf = requestAnimationFrame(tick); },
    leave() { if (raf) cancelAnimationFrame(raf); raf = 0; pause(); },
  };
}
