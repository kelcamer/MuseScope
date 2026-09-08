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
import { binPower, detrend } from "./signal.js";

const WIN = SAMPLE_RATE; // 1 second → 1 Hz bin spacing
const ALPHA_LO = 8;
const ALPHA_HI = 12;
const TOTAL_LO = 2;
const TOTAL_HI = 30;

// Anything this big in a one-second window is a bumped electrode or a hard
// clench, not brain rhythm, and gets dropped. Set well above an ordinary blink:
// on forehead electrodes a blink alone can pass 150 µV, and holding the ball
// every time someone blinks makes the game unplayable. Blinks don't need to be
// rejected to be handled — they land outside the alpha band, so they already
// push the ratio down on their own.
const ARTIFACT_SD_UV = 180;

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
    this.lastSd = 0; // amplitude of the noisiest channel last window, for diagnostics
  }

  setNames(names) {
    this.names = names;
  }

  /**
   * The forehead pair, AF7 and AF8 — whatever their contact grade says.
   *
   *
   * Textbook says use the posterior electrodes — alpha is a back-of-the-head
   * rhythm and TP9/TP10 are the most posterior thing a Muse has. In practice on
   * this headband the ear contacts are the ones that rail and pick up muscle,
   * and an unusable electrode with better theory behind it is still unusable.
   * The forehead pair sees less alpha but sees it reliably.
   *
   * Only falls back to other channels when the headband reports names we don't
   * recognise at all (an unknown firmware layout), never to quietly substitute
   * the ear channels.
   */
  _pick() {
    const front = [];
    let named = false;
    this.channels.forEach((c, i) => {
      const name = this.names[i] || "";
      if (name === "AF7" || name === "AF8") {
        named = true;
        // The grade is advisory here on purpose. Gating on it meant a single
        // "poor" reading dropped the game to no usable channels at all, which
        // is how calibration ended up collecting nothing. The amplitude check
        // below is the real gate.
        front.push(i);
      }
    });
    if (named) return front;
    return this.channels.map((_, i) => i).filter((i) => this.channels[i].quality.grade === "good" || this.channels[i].quality.grade === "fair");
  }

  /** Call ~10×/s. Returns the smoothed share of power in the alpha band. */
  update(now = performance.now()) {
    const dt = this.last ? Math.min(0.5, (now - this.last) / 1000) : 0.1;
    this.last = now;

    const picks = this._pick();
    let sum = 0;
    let count = 0;
    const used = [];

    let worstSd = 0;
    for (const i of picks) {
      const n = this.channels[i].raw.tail(WIN, this.buf);
      if (n < WIN) continue;
      const amp = detrend(this.buf, n).sd;
      if (amp > worstSd) worstSd = amp;
      if (amp > ARTIFACT_SD_UV) continue;
      sum += relativeAlpha(this.buf, n).rel;
      count++;
      used.push(i);
    }
    this.lastSd = worstSd;

    // One channel having a moment shouldn't veto a clean one — the ball is only
    // held when there is nothing usable left to read.
    this.used = used;
    this.artifact = count === 0;
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
  if (samples.length < 15) return null;
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
