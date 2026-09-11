// ---------------------------------------------------------------------------
// Relax-your-face — a tapeless forehead trainer. No ears, no tape.
//
// The forehead sensors (AF7/AF8) are mostly an EMG meter: jaw, brow and scalp
// muscle live in the 15–40 Hz band up there, far above the brain rhythms. That
// is useless for measuring alpha — but it is a genuine, honest read of facial
// TENSION, and letting that go is half of the calming response (the body half;
// the alpha half needs the ears). So this rewards muscle going DOWN.
//
// The tone works the opposite way to α-train: it's LOUD and high when your face
// is tense and fades to a soft low hum as you release — you win by making it go
// quiet. Classic EMG biofeedback, honestly labelled.
//
// Self-calibrating: it learns your own tense/slack range over the session, so
// there's no absolute µV threshold pretending the fit doesn't matter.
// ---------------------------------------------------------------------------

import { SAMPLE_RATE } from "./muse.js";
import { binPower, detrend } from "./signal.js";
import { startTone, stopTone, setToneLift, resumeAudio } from "./audio.js";

const WIN = SAMPLE_RATE;          // 1 s — muscle amplitude, no need for fine frequency
const EMG_LO = 15, EMG_HI = 40;   // jaw/brow/scalp muscle band on the forehead
const RELAXED_ZONE = 0.6;         // relaxation ≥ this = "in the zone"
const TAU = 0.5;

const el = (id) => document.getElementById(id);

export function createRelaxTrainer({ channels, getNames, isMuted }) {
  const buf = new Float32Array(WIN);
  let raf = 0;
  let audioOn = false;
  let toneStarted = false;
  let tension = 0.5;                // smoothed 0..1
  let floorUv = 8, ceilUv = 40;     // adaptive tense/slack range (µV), learned live
  let calmSecs = 0, bestRelax = 0, lastNow = 0;

  function foreheadIndices() {
    const names = (getNames && getNames()) || [];
    const a = names.indexOf("AF7");
    const b = names.indexOf("AF8");
    if (a >= 0 && b >= 0) return [a, b];
    return [1, 2]; // CHANNELS default: TP9, AF7, AF8, TP10
  }

  function muscleUv(i) {
    const n = channels[i].raw.tail(WIN, buf);
    if (n < WIN) return null;
    let railed = 0;
    for (let j = 0; j < n; j++) if (Math.abs(buf[j]) > 800) railed++;
    if ((railed / n) * 100 > 20) return null;
    detrend(buf, n);
    let p = 0;
    for (let f = EMG_LO; f <= EMG_HI; f++) p += binPower(buf, n, f);
    return Math.sqrt(p); // µV RMS in the muscle band
  }

  function tick(now) {
    const dt = lastNow ? Math.min(0.5, (now - lastNow) / 1000) : 0.1;
    lastNow = now;
    const [a, b] = foreheadIndices();
    const ua = muscleUv(a);
    const ub = muscleUv(b);
    const vals = [ua, ub].filter((v) => v != null);
    const cur = vals.length ? vals.reduce((s, v) => s + v, 0) / vals.length : null;

    if (cur != null) {
      // learn the range: floor creeps up slowly, ceiling creeps down slowly,
      // but both jump immediately to a new extreme — so it tracks YOUR span.
      floorUv = Math.min(cur, floorUv + (cur - floorUv) * 0.002 + 0.02);
      ceilUv = Math.max(cur, ceilUv + (cur - ceilUv) * 0.002 - 0.05);
      if (ceilUv < floorUv + 4) ceilUv = floorUv + 4; // keep a usable span
      const raw = Math.max(0, Math.min(1, (cur - floorUv) / (ceilUv - floorUv)));
      tension += (raw - tension) * (1 - Math.exp(-dt / TAU));
    }

    const relax = cur == null ? 0 : 1 - tension;
    const inZone = cur != null && relax >= RELAXED_ZONE;

    const wantTone = audioOn && el("rx-sound")?.checked && !(isMuted && isMuted());
    if (wantTone && !toneStarted) { resumeAudio(); startTone(); toneStarted = true; }
    if (!wantTone && toneStarted) { stopTone(); toneStarted = false; }
    if (toneStarted) setToneLift(cur == null ? 0 : tension); // loud/high = tense; fades as you relax

    if (audioOn && cur != null) {
      if (inZone) calmSecs += dt;
      if (relax > bestRelax) bestRelax = relax;
    }

    let state;
    if (cur == null) state = ["no forehead signal", "off"];
    else if (inZone) state = ["relaxed — stay here", "zone"];
    else if (relax >= 0.35) state = ["letting go…", "build"];
    else state = ["tense — soften your jaw & brow", "warn"];

    render({ cur, relax, inZone, ua, ub, state });
    raf = requestAnimationFrame(tick);
  }

  function dot(id, v) {
    const node = el(id);
    if (!node) return;
    if (v == null) { node.textContent = "·"; node.className = "eardot warn"; node.title = "no contact"; }
    else { node.textContent = "●"; node.className = "eardot ok"; node.title = `${v.toFixed(0)} µV muscle`; }
  }

  function render({ cur, relax, inZone, ua, ub, state }) {
    const fill = el("rx-fill");
    if (fill) { fill.style.height = `${(relax * 100).toFixed(1)}%`; fill.classList.toggle("is-zone", inZone); }
    if (el("rx-relax")) el("rx-relax").textContent = cur == null ? "—" : `${Math.round(relax * 100)}%`;
    if (el("rx-muscle")) el("rx-muscle").textContent = cur == null ? "—" : `${cur.toFixed(0)} µV`;
    if (el("rx-calm")) el("rx-calm").textContent = `${calmSecs.toFixed(0)}s`;
    if (el("rx-best")) el("rx-best").textContent = bestRelax ? `${Math.round(bestRelax * 100)}%` : "—";
    const s = el("rx-state");
    if (s) { s.textContent = state[0]; s.className = `train-state ${state[1]}`; }
    dot("rx-af7", ua);
    dot("rx-af8", ub);
  }

  function begin() {
    audioOn = true; calmSecs = 0; bestRelax = 0; resumeAudio();
    const b = el("rx-begin"); if (b) { b.textContent = "Stop"; b.classList.add("btn--primary"); }
  }
  function pause() {
    audioOn = false;
    if (toneStarted) { stopTone(); toneStarted = false; }
    const b = el("rx-begin"); if (b) { b.textContent = "Begin"; b.classList.remove("btn--primary"); }
  }

  el("rx-begin")?.addEventListener("click", () => (audioOn ? pause() : begin()));
  el("rx-reset")?.addEventListener("click", () => { calmSecs = 0; bestRelax = 0; floorUv = 8; ceilUv = 40; });

  return {
    enter() { lastNow = 0; if (!raf) raf = requestAnimationFrame(tick); },
    leave() { if (raf) cancelAnimationFrame(raf); raf = 0; pause(); },
  };
}
