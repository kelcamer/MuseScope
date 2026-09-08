// ---------------------------------------------------------------------------
// Alpha estimation for the neurofeedback game.
//
// Reports alpha as a SHARE of total power (8-12 Hz over 2-30 Hz), not as raw
// microvolts squared. Absolute power moves with how wet the electrode is, how
// thick your hair is and how the band happens to be sitting, so an absolute
// threshold would mostly measure the fit. A ratio cancels all of that.
//
// It also makes the game harder to cheat: clenching your jaw or blinking adds
// power, but it lands broadband and low-frequency, so it grows the denominator
// and pushes the ball DOWN.
// ---------------------------------------------------------------------------

import { SAMPLE_RATE } from "./muse.js";
import { binPower } from "./signal.js";

const WIN = SAMPLE_RATE; // 1 second → 1 Hz bin spacing
const ALPHA_LO = 8;
const ALPHA_HI = 12;
const TOTAL_LO = 2;
const TOTAL_HI = 30;

// Anything this big in a one-second window is a blink, a jaw clench or a bumped
// electrode, not brain rhythm. Those windows are dropped rather than scored.
const ARTIFACT_SD_UV = 150;

/** Relative alpha for one window of raw microvolts. */
export function relativeAlpha(buf, n) {
  let alpha = 0;
  let total = 0;
  for (let f = TOTAL_LO; f <= TOTAL_HI; f++) {
    const p = binPower(buf, n, f);
    total += p;
    if (f >= ALPHA_LO && f <= ALPHA_HI) alpha += p;
  }
  return { alpha, total, rel: total > 0 ? alpha / total : 0 };
}

function sd(buf, n) {
  let sum = 0;
  for (let i = 0; i < n; i++) sum += buf[i];
  const mean = sum / n;
  let acc = 0;
  for (let i = 0; i < n; i++) {
    const d = buf[i] - mean;
    acc += d * d;
  }
  return Math.sqrt(acc / n);
}

export class AlphaMeter {
  constructor(channels, names) {
    this.channels = channels;
    this.names = names;
    this.buf = new Float32Array(WIN);
    this.rel = 0; // smoothed
    this.raw = 0; // this window
    this.artifact = true;
    this.used = [];
    this.tau = 0.45; // seconds of smoothing — enough to stop jitter, not enough to lag
    this.last = 0;
  }

  setNames(names) {
    this.names = names;
  }

  /**
   * Prefers the two electrodes behind the ears. They're the most posterior thing
   * a Muse has, and alpha is a back-of-the-head rhythm — the forehead pair sees
   * far less of it and far more eye movement. Falls back to whatever has usable
   * contact.
   */
  _pick() {
    const posterior = [];
    const other = [];
    this.channels.forEach((c, i) => {
      if (c.quality.grade === "poor" || c.quality.grade === "waiting") return;
      const name = this.names[i] || "";
      (name === "TP9" || name === "TP10" ? posterior : other).push(i);
    });
    return posterior.length ? posterior : other;
  }

  /** Call ~10×/s. Returns the smoothed share of power in the alpha band. */
  update(now = performance.now()) {
    const dt = this.last ? Math.min(0.5, (now - this.last) / 1000) : 0.1;
    this.last = now;

    const picks = this._pick();
    let sum = 0;
    let count = 0;
    let artifact = picks.length === 0;

    for (const i of picks) {
      const n = this.channels[i].raw.tail(WIN, this.buf);
      if (n < WIN) {
        artifact = true;
        continue;
      }
      if (sd(this.buf, n) > ARTIFACT_SD_UV) {
        artifact = true;
        continue;
      }
      sum += relativeAlpha(this.buf, n).rel;
      count++;
    }

    this.used = picks;
    this.artifact = artifact || count === 0;
    if (count) {
      this.raw = sum / count;
      // exponential smoothing, frame-rate independent
      const a = 1 - Math.exp(-dt / this.tau);
      this.rel += (this.raw - this.rel) * a;
    }
    return this.rel;
  }
}

/** Turn a set of calibration samples into the floor and ceiling of the game. */
export function baselineFrom(samples) {
  if (samples.length < 20) return null;
  const sorted = samples.slice().sort((a, b) => a - b);
  const q = (p) => sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))];
  return { floor: q(0.5), ceiling: Math.max(q(0.9), q(0.5) * 1.25), n: samples.length };
}

/** 0 at your resting alpha, 1 at the top of your own range. */
export function liftFrom(rel, baseline, sensitivity = 1) {
  if (!baseline) return 0;
  const span = Math.max(1e-6, (baseline.ceiling - baseline.floor) / sensitivity);
  return Math.max(0, Math.min(1, (rel - baseline.floor) / span));
}
