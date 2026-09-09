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
// The four bands, in Hz. Each one is scored as its share of everything from
// TOTAL_LO to TOTAL_HI, so they're directly comparable and one pass computes
// all four.
//
// Two of these are compromises worth stating outright:
//
// theta really starts at 4 Hz, but 4-5 Hz is exactly where blink energy lives,
// and letting that in is what broke calibration in the first place. 5-8 Hz is
// theta minus its dirtiest octave.
//
// gamma at the scalp, on a dry consumer headband, is mostly muscle. 30-45 Hz at
// least dodges 60 Hz mains and its harmonic entirely, but nothing can separate
// frontal EMG from cortical gamma here. It's a real measurement of something —
// it just isn't only brain.
export const BAND_DEFS = {
  // Delta (2-4 Hz) sits BELOW the 5 Hz analysis floor the other bands share.
  // It is the slow, drowsy rhythm — and also exactly where blinks, eye-rolls
  // and head movement live, so on a dry forehead headband it is the least
  // brain-pure game of all. It gets its own measurement pass (see bandShares)
  // and doubles as the drift monitor that guards theta from low-frequency leak.
  delta: [2, 4],
  theta: [5, 7],
  alpha: [8, 12],
  beta: [13, 25],
  gamma: [30, 45],
};
export const BAND_NAMES = Object.keys(BAND_DEFS);
// The analysis band starts at 5 Hz, not 2. Blinks and slow drift live below
// that and are enormous on forehead electrodes — hundreds of microvolts against
// tens for the rhythms. Including them meant every window looked like an
// artifact and calibration collected nothing. Excluding them costs a sliver of
// theta and buys a measurement that is actually about brain rhythm.
const TOTAL_LO = 5;
const TOTAL_HI = 45;
// Delta's own range, measured separately so it can't shift the 5-45 Hz
// denominator the other four bands share.
const DELTA_LO = 2;
const DELTA_HI = 4;

// Anything this big in a one-second window is a bumped electrode or a hard
// clench, not brain rhythm, and gets dropped. Set well above an ordinary blink:
// on forehead electrodes a blink alone can pass 150 µV, and holding the ball
// every time someone blinks makes the game unplayable. Blinks don't need to be
// rejected to be handled — they land outside the alpha band, so they already
// push the ratio down on their own.
// Rejection threshold, applied to the RMS of the 5-30 Hz band rather than to
// the raw swing. In-band EEG runs 5-30 µV; muscle and a knocked electrode run
// far above. A blink can be 400 µV peak and still pass, which is correct — it
// isn't alpha, but it also isn't a reason to stop measuring.
const ARTIFACT_RMS_UV = 150;

// Per-band drift guard. If this fraction of a band's power is jammed into its
// lowest 1-Hz bin, the reading is spillover from the rhythm below it, not the
// band itself, and the game holds the ball instead of scoring it. Only theta
// needs it: it borders the 5 Hz floor where delta and slow movement pile up,
// and that leak is exactly what was faking theta scores. The other bands sit
// far enough from their neighbours that the same leak never reaches them.
const DRIFT_GUARD = { theta: 0.5 };

/**
 * Each band's share of 5-30 Hz, plus that band's RMS in microvolts. Both bands
 * come out of one pass over the bins, so a second game costs nothing.
 */
export function bandShares(buf, n) {
  const acc = {};
  const lowBin = {}; // power in each band's lowest 1-Hz bin, for the drift edge
  for (const name of BAND_NAMES) acc[name] = 0;

  // Delta gets its own pass below 5 Hz. It does NOT enter `total`, so adding it
  // cannot move the other four bands' scores by a hair.
  let deltaPow = 0;
  let deltaLowBin = 0;
  for (let f = DELTA_LO; f <= DELTA_HI; f++) {
    const p = binPower(buf, n, f);
    deltaPow += p;
    if (f === DELTA_LO) deltaLowBin = p;
  }

  let total = 0;
  for (let f = TOTAL_LO; f <= TOTAL_HI; f++) {
    const p = binPower(buf, n, f);
    total += p;
    for (const name of BAND_NAMES) {
      const [lo, hi] = BAND_DEFS[name];
      if (f >= lo && f <= hi) {
        acc[name] += p;
        if (f === lo) lowBin[name] = p;
      }
    }
  }
  const safe = total > 0 ? total : 1;
  // Three figures per band: its share of the analysed range, its own amplitude
  // in microvolts, and `edge` — the fraction of the band's power sitting in its
  // lowest 1-Hz bin. A strong rhythm one band below leaks upward into that bin,
  // so a high edge means the reading is spillover, not the band itself. That's
  // what the theta drift guard watches.
  const out = { rms: Math.sqrt(total), uv: {}, edge: {} };
  for (const name of BAND_NAMES) {
    if (name === "delta") {
      out.delta = deltaPow / (deltaPow + safe);
      out.uv.delta = Math.sqrt(deltaPow);
      out.edge.delta = deltaPow > 0 ? deltaLowBin / deltaPow : 0;
    } else {
      out[name] = acc[name] / safe;
      out.uv[name] = Math.sqrt(acc[name]);
      out.edge[name] = acc[name] > 0 ? (lowBin[name] || 0) / acc[name] : 0;
    }
  }
  return out;
}

/** Kept for the alpha-only callers and the unit checks. */
export function relativeAlpha(buf, n) {
  const b = bandShares(buf, n);
  return { rel: b.alpha, rms: b.rms };
}

export class AlphaMeter {
  constructor(channels, names) {
    this.channels = channels;
    this.names = names;
    this.buf = new Float32Array(WIN);
    // smoothed shares, 0..1, one per band, plus each band's own amplitude in µV
    // and its bottom-bin `edge` (how much of the band is spillover from below).
    this.uv = {};
    this.edge = {};
    BAND_NAMES.forEach((n) => {
      this[n] = 0;
      this.uv[n] = 0;
      this.edge[n] = 0;
    });
    this.rel = 0; // alias for the alpha share, kept for older call sites
    this.artifact = true;
    this.used = [];
    // false: score from the forehead pair only (AF7 + AF8), the reliable default.
    // true: also fold in the ear channels (TP9 + TP10). They rail and pick up
    // muscle, so clean windows help and dirty ones drop out on the amplitude gate.
    this.useAll = false;
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
    const all = [];
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
        all.push(i);
      } else if (name === "TP9" || name === "TP10") {
        named = true;
        all.push(i);
      }
    });
    if (named) return this.useAll ? all : front;
    return this.channels.map((_, i) => i).filter((i) => this.channels[i].quality.grade === "good" || this.channels[i].quality.grade === "fair");
  }

  /** Call ~10×/s. Updates `alpha` and `beta`; returns the alpha share. */
  update(now = performance.now()) {
    const dt = this.last ? Math.min(0.5, (now - this.last) / 1000) : 0.1;
    this.last = now;

    const picks = this._pick();
    let count = 0;
    const used = [];

    let bandRms = 0;
    const sums = {};
    const uvSums = {};
    const edgeSums = {};
    for (const name of BAND_NAMES) {
      sums[name] = 0;
      uvSums[name] = 0;
      edgeSums[name] = 0;
    }
    for (const i of picks) {
      const n = this.channels[i].raw.tail(WIN, this.buf);
      if (n < WIN) continue;
      detrend(this.buf, n); // kill the offset so it can't leak across the bins
      const band = bandShares(this.buf, n);
      if (band.rms > bandRms) bandRms = band.rms;
      if (band.rms > ARTIFACT_RMS_UV) continue;
      for (const name of BAND_NAMES) {
        sums[name] += band[name];
        uvSums[name] += band.uv[name];
        edgeSums[name] += band.edge[name];
      }
      count++;
      used.push(i);
    }
    this.lastSd = bandRms;

    // One channel having a moment shouldn't veto a clean one — the ball is only
    // held when there is nothing usable left to read.
    this.used = used;
    this.artifact = count === 0;
    if (count) {
      // exponential smoothing, frame-rate independent
      const a = 1 - Math.exp(-dt / this.tau);
      for (const name of BAND_NAMES) {
        this[name] += (sums[name] / count - this[name]) * a;
        this.uv[name] += (uvSums[name] / count - this.uv[name]) * a;
        this.edge[name] += (edgeSums[name] / count - this.edge[name]) * a;
      }
      this.rel = this.alpha;
    }
    return this.alpha;
  }

  /** Is the scored band mostly spillover from the rhythm below it? When true,
   *  the game holds the ball rather than counting a drift-faked score. */
  contamFor(name) {
    const limit = DRIFT_GUARD[name];
    return limit != null && this.edge[name] > limit;
  }
}

/** Turn a set of calibration samples into the floor and ceiling of the game. */
export function baselineFrom(samples) {
  if (samples.length < 10) return null;
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
