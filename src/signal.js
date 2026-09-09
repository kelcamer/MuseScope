// ---------------------------------------------------------------------------
// Signal handling: ring buffers, display filters, and the contact check.
//
// Two rules kept throughout: filtering is for the *eyes only* — every quality
// number is computed from raw microvolts — and nothing here allocates inside
// the sample path, because samples arrive 256×/s on four channels.
// ---------------------------------------------------------------------------

import { SAMPLE_RATE } from "./muse.js";

export const WINDOW_SEC = 4;
export const RING_LEN = SAMPLE_RATE * WINDOW_SEC;
const QUALITY_LEN = SAMPLE_RATE; // the contact check looks at the last second
// The band the contact check judges by — the same one the game measures in, so
// the two never disagree about whether a channel is usable.
const BAND_LO = 5;
const BAND_HI = 30;

/** Fixed-length circular buffer of samples. */
export class Ring {
  constructor(len = RING_LEN) {
    this.buf = new Float32Array(len);
    this.len = len;
    this.head = 0; // next write position
    this.filled = 0;
  }
  push(v) {
    this.buf[this.head] = v;
    this.head = (this.head + 1) % this.len;
    if (this.filled < this.len) this.filled++;
  }
  /** Oldest-to-newest index, 0 <= i < filled. */
  at(i) {
    return this.buf[(this.head - this.filled + i + this.len) % this.len];
  }
  /** Copy the most recent n samples, oldest first, into `out`. */
  tail(n, out) {
    const take = Math.min(n, this.filled);
    for (let i = 0; i < take; i++) out[i] = this.at(this.filled - take + i);
    return take;
  }
}

/**
 * One-pole high-pass, ~0.4 Hz at 256 Hz. Muse raw EEG rides on a large, slowly
 * wandering DC offset; without this the traces sit off-screen and drift.
 * Display only.
 */
export class HighPass {
  constructor(a = 0.99) {
    this.a = a;
    this.prevIn = 0;
    this.prevOut = 0;
  }
  step(x) {
    const y = this.a * (this.prevOut + x - this.prevIn);
    this.prevIn = x;
    this.prevOut = y;
    return y;
  }
}

/** Second-order notch at `freq`, for scrubbing mains hum out of the display. */
export class Notch {
  constructor(freq, rate = SAMPLE_RATE, Q = 6) {
    const w = (2 * Math.PI * freq) / rate;
    const alpha = Math.sin(w) / (2 * Q);
    const cos = Math.cos(w);
    const a0 = 1 + alpha;
    this.b0 = 1 / a0;
    this.b1 = (-2 * cos) / a0;
    this.b2 = 1 / a0;
    this.a1 = (-2 * cos) / a0;
    this.a2 = (1 - alpha) / a0;
    this.x1 = this.x2 = this.y1 = this.y2 = 0;
  }
  step(x) {
    const y = this.b0 * x + this.b1 * this.x1 + this.b2 * this.x2 - this.a1 * this.y1 - this.a2 * this.y2;
    this.x2 = this.x1;
    this.x1 = x;
    this.y2 = this.y1;
    this.y1 = y;
    return y;
  }
}

/**
 * Power at a single frequency, by Goertzel. One bin costs a handful of
 * multiplies per sample, where an FFT would compute 128 bins we don't need.
 */
export function binPower(samples, n, freq, rate = SAMPLE_RATE) {
  const k = (2 * Math.PI * freq) / rate;
  const coeff = 2 * Math.cos(k);
  let s1 = 0;
  let s2 = 0;
  for (let i = 0; i < n; i++) {
    const s = samples[i] + coeff * s1 - s2;
    s2 = s1;
    s1 = s;
  }
  // The ×2 makes this directly comparable to variance: a pure sine at `freq`
  // returns its own variance (A²/2), so power ratios land on 0..1 instead of
  // topping out at a half. Verified against synthesized tones.
  return (2 * (s1 * s1 + s2 * s2 - coeff * s1 * s2)) / (n * n);
}

/**
 * Subtract the DC offset and the linear drift, in place.
 *
 * Muse's raw counts sit on a large offset that wanders — over a one-second
 * window that alone can be hundreds of microvolts, while the rhythm anyone
 * actually wants is tens. Any amplitude or power measured without removing it
 * is mostly a measurement of the drift.
 *
 * Returns the standard deviation of what's left, plus how much drift was taken
 * out (peak to peak), because a wandering electrode is itself a symptom.
 */
export function detrend(buf, n) {
  let sx = 0;
  let sy = 0;
  let sxy = 0;
  let sxx = 0;
  for (let i = 0; i < n; i++) {
    sx += i;
    sy += buf[i];
    sxy += i * buf[i];
    sxx += i * i;
  }
  const denom = n * sxx - sx * sx;
  const slope = denom !== 0 ? (n * sxy - sx * sy) / denom : 0;
  const intercept = (sy - slope * sx) / n;
  let acc = 0;
  for (let i = 0; i < n; i++) {
    buf[i] -= intercept + slope * i;
    acc += buf[i] * buf[i];
  }
  return { sd: Math.sqrt(acc / n), driftPP: Math.abs(slope) * n };
}

/**
 * Contact quality for one electrode, from the last second of RAW samples.
 *
 * This is a heuristic, not Muse's own headband-status indicator — the official
 * HSI comes through the native SDK and isn't exposed over BLE. Three things
 * that a bad electrode does, in the order they're worth trusting:
 *
 *  1. Rails. A dry electrode that isn't touching skin swings to the ADC limits.
 *  2. Picks up mains. Contact impedance turns the wire into an antenna, so
 *     50/60 Hz power relative to total power is the single best tell.
 *  3. Flatlines or drifts. Near-zero variance means nothing is connected;
 *     enormous variance means movement, sweat, or hair in the way.
 *
 * Returns µV standard deviation, % of samples railed, the mains ratio, and a
 * grade of good | fair | poor.
 */
export function contactQuality(raw, n, mainsHz) {
  if (n < SAMPLE_RATE / 4) return { sd: 0, broadbandSd: 0, railPct: 0, mains: 0, driftPP: 0, grade: "waiting" };

  // Railing is judged on the untouched samples — it's about hitting the ADC
  // limits, which detrending would hide.
  let railed = 0;
  for (let i = 0; i < n; i++) if (Math.abs(raw[i]) > 800) railed++;
  const railPct = (railed / n) * 100;

  // Everything else is judged on the signal with offset and drift removed, so
  // "amplitude" means the size of the oscillation rather than the size of the
  // wander, and the mains ratio isn't diluted by drift power.
  const { sd, driftPP } = detrend(raw, n);

  // Hum is judged against the band it competes with, not against total power.
  // "Is there more mains here than brain rhythm?" is the question a fit check
  // is actually asking, and the answer shouldn't change because the electrode
  // happens to also be drifting or picking up muscle at 70 Hz.
  const mainsPower = binPower(raw, n, mainsHz) + binPower(raw, n, mainsHz * 2);
  let inBand = 0;
  for (let f = BAND_LO; f <= BAND_HI; f++) inBand += binPower(raw, n, f);
  const rms = Math.sqrt(inBand);
  const mains = Math.min(1, mainsPower / (mainsPower + inBand || 1));

  // Thresholds are judgement calls checked against synthesized signals, not
  // against a gold standard. They read off the 5-30 Hz RMS, where ordinary EEG
  // runs 5-30 µV: far below that is a dead electrode, far above it is muscle,
  // and a mains share past half means there's more hum here than rhythm.
  let grade = "good";
  if (railPct > 2 || rms < 0.8 || rms > 200 || mains > 0.8 || driftPP > 1500) grade = "poor";
  else if (rms > 80 || mains > 0.5 || driftPP > 500) grade = "fair";
  return { sd: rms, broadbandSd: sd, railPct, mains, driftPP, grade };
}

/** Per-channel state: raw ring for measurement, filtered ring for the trace. */
export class ChannelState {
  constructor() {
    this.raw = new Ring();
    this.view = new Ring();
    this.hp = new HighPass();
    this.notch = null;
    this.quality = { sd: 0, railPct: 0, mains: 0, grade: "waiting" };
    this._qbuf = new Float32Array(QUALITY_LEN);
  }
  setNotch(freq) {
    this.notch = freq ? new Notch(freq) : null;
  }
  push(uv) {
    this.raw.push(uv);
    let v = this.hp.step(uv);
    if (this.notch) v = this.notch.step(v);
    this.view.push(v);
  }
  measure(mainsHz) {
    const n = this.raw.tail(QUALITY_LEN, this._qbuf);
    this.quality = contactQuality(this._qbuf, n, mainsHz);
    return this.quality;
  }
}
