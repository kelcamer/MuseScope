// ---------------------------------------------------------------------------
// α-train — the ONE honest alpha trainer on this headband.
//
// Every other game scores a band as a SHARE of power. That is fooled by
// movement (band power tracks the eyes and the drift), and it reads the
// forehead, where real alpha barely reaches. This one is different on purpose,
// following what the 2026-09-10 analysis established:
//
//   • It reads the EARS (TP9/TP10) — real alpha is posterior.
//   • It scores the PEAK, not band power: prominence = power at 9–10.5 Hz over
//     the 6.5–7.5 & 12–13 Hz shoulders. A peak that stands above its background
//     is a rhythm; raised band power without a peak is just movement.
//   • It demands BOTH ears (a real posterior rhythm is bilateral; one ear alone
//     is contact noise). With both, the score is the harmonic mean — the weaker
//     ear dominates, so you can't win with one.
//   • Movement and muscle push it DOWN (they fail the amplitude gate), so the
//     honest way up is to go still and let go.
//
// Feedback is a rising tone, because you train this with your eyes closed.
// ---------------------------------------------------------------------------

import { SAMPLE_RATE } from "./muse.js";
import { binPower, detrend } from "./signal.js";
import { startTone, stopTone, setToneLift, resumeAudio } from "./audio.js";

const WIN = SAMPLE_RATE * 2;            // 2 s window → ~0.5 Hz resolution for a clean peak
const ART_RMS_UV = 150;                 // 5–30 Hz RMS above this = movement/muscle → drop the ear
const RAIL_PCT = 20;                    // more than this fraction railing = no contact (tape slipped)
const PEAK_FREQS = [9, 9.5, 10, 10.5];  // Kelsey's IAF ≈ 9.4 Hz sits in here
const BASE_FREQS = [6.5, 7, 7.5, 12, 12.5, 13];
const ZONE = 1.5;                       // prominence at/above this = a real peak is present
const FULL = 2.6;                       // prominence that pins the meter to the top
const TAU = 0.6;                        // seconds of smoothing

const el = (id) => document.getElementById(id);

export function createAlphaTrainer({ channels, getNames, isMuted }) {
  const buf = new Float32Array(WIN);
  let raf = 0;
  let audioOn = false;      // tone + scoring only run after "Begin"
  let toneStarted = false;
  let prom = 1;             // smoothed combined prominence
  let best = 0;
  let zoneSecs = 0;
  let sessionSecs = 0;
  let lastNow = 0;

  function earIndices() {
    const names = (getNames && getNames()) || [];
    const L = names.indexOf("TP9");
    const R = names.indexOf("TP10");
    if (L >= 0 && R >= 0) return { L, R };
    return { L: 0, R: 3 }; // CHANNELS default order: TP9, AF7, AF8, TP10
  }

  // One ear → {usable, prom, pf, reason}
  function measureEar(i) {
    const n = channels[i].raw.tail(WIN, buf);
    if (n < WIN) return { usable: false, reason: "wait" };
    let railed = 0;
    for (let j = 0; j < n; j++) if (Math.abs(buf[j]) > 800) railed++;
    if ((railed / n) * 100 > RAIL_PCT) return { usable: false, reason: "rail" };
    detrend(buf, n);
    let inBand = 0;
    for (let f = 5; f <= 30; f++) inBand += binPower(buf, n, f);
    if (Math.sqrt(inBand) > ART_RMS_UV) return { usable: false, reason: "move" };
    let peak = 0, pf = 9.5;
    for (const f of PEAK_FREQS) { const p = binPower(buf, n, f); if (p > peak) { peak = p; pf = f; } }
    // refine the peak frequency across the whole alpha band for the readout
    let hp = 0;
    for (let f = 8; f <= 12; f += 0.25) { const p = binPower(buf, n, f); if (p > hp) { hp = p; pf = f; } }
    let base = 0;
    for (const f of BASE_FREQS) base += binPower(buf, n, f);
    base /= BASE_FREQS.length;
    if (base <= 0) return { usable: false, reason: "wait" };
    return { usable: true, prom: peak / base, pf };
  }

  function tick(now) {
    const dt = lastNow ? Math.min(0.5, (now - lastNow) / 1000) : 0.1;
    lastNow = now;
    const { L, R } = earIndices();
    const eL = measureEar(L);
    const eR = measureEar(R);

    let raw = null, both = false, pf = null, state, ok = 0;
    if (eL.usable && eR.usable) {
      raw = (2 * eL.prom * eR.prom) / (eL.prom + eR.prom); // harmonic mean — weaker ear dominates
      both = true; ok = 2; pf = eL.prom >= eR.prom ? eL.pf : eR.pf;
    } else if (eL.usable) { raw = eL.prom; pf = eL.pf; ok = 1; }
    else if (eR.usable) { raw = eR.prom; pf = eR.pf; ok = 1; }

    if (raw != null) prom += (raw - prom) * (1 - Math.exp(-dt / TAU));
    const lift = raw == null ? 0 : Math.max(0, Math.min(1, (prom - 1) / (FULL - 1)));
    const inZone = raw != null && prom >= ZONE;

    // audio — the eyes-closed guide
    const wantTone = audioOn && el("tr-sound")?.checked && !(isMuted && isMuted());
    if (wantTone && !toneStarted) { resumeAudio(); startTone(); toneStarted = true; }
    if (!wantTone && toneStarted) { stopTone(); toneStarted = false; }
    if (toneStarted) setToneLift(lift);

    // scoring (only once you've hit Begin)
    if (audioOn && raw != null) {
      sessionSecs += dt;
      if (inZone) zoneSecs += dt;
      if (prom > best) best = prom;
    }

    // state message
    if (raw == null) state = ["no ear signal", "off"];
    else if (!both && ok === 1) state = ["one ear only — tape the other", "warn"];
    else if (inZone) state = ["in the zone — hold it, don't chase", "zone"];
    else if (prom >= 1.25) state = ["building… let it come", "build"];
    else state = ["quiet — eyes closed, let go", "quiet"];

    render({ raw, prom, lift, inZone, pf, eL, eR, state });
    raf = requestAnimationFrame(tick);
  }

  function earDot(id, e) {
    const node = el(id);
    if (!node) return;
    const map = { rail: ["✕", "no contact — re-tape"], move: ["~", "movement / muscle"], wait: ["·", "waiting"] };
    if (e.usable) { node.textContent = "●"; node.className = "eardot ok"; node.title = `alpha peak ${e.prom.toFixed(2)}×`; }
    else { node.textContent = map[e.reason][0]; node.className = `eardot ${e.reason === "rail" ? "bad" : "warn"}`; node.title = map[e.reason][1]; }
  }

  function render({ raw, prom, lift, inZone, pf, eL, eR, state }) {
    const fill = el("tr-fill");
    if (fill) { fill.style.height = `${(lift * 100).toFixed(1)}%`; fill.classList.toggle("is-zone", inZone); }
    if (el("tr-prom")) el("tr-prom").textContent = raw == null ? "—" : `${prom.toFixed(2)}×`;
    if (el("tr-freq")) el("tr-freq").textContent = raw == null ? "—" : `${pf.toFixed(1)} Hz`;
    if (el("tr-zone")) el("tr-zone").textContent = `${zoneSecs.toFixed(0)}s`;
    if (el("tr-best")) el("tr-best").textContent = best ? `${best.toFixed(2)}×` : "—";
    const s = el("tr-state");
    if (s) { s.textContent = state[0]; s.className = `train-state ${state[1]}`; }
    earDot("tr-ear-L", eL);
    earDot("tr-ear-R", eR);
  }

  function begin() {
    audioOn = true;
    sessionSecs = 0; zoneSecs = 0; best = 0;
    resumeAudio();
    const b = el("tr-begin");
    if (b) { b.textContent = "Stop"; b.classList.add("btn--primary"); }
  }
  function pause() {
    audioOn = false;
    if (toneStarted) { stopTone(); toneStarted = false; }
    const b = el("tr-begin");
    if (b) { b.textContent = "Begin"; b.classList.remove("btn--primary"); }
  }

  // wire the panel's controls once
  el("tr-begin")?.addEventListener("click", () => (audioOn ? pause() : begin()));
  el("tr-reset")?.addEventListener("click", () => { best = 0; zoneSecs = 0; sessionSecs = 0; });

  return {
    enter() { lastNow = 0; if (!raf) raf = requestAnimationFrame(tick); },
    leave() {
      if (raf) cancelAnimationFrame(raf);
      raf = 0;
      pause();
    },
  };
}
