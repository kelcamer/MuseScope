// Raw EEG recorder. Captures the four channels straight off the wire while a
// session runs, so a whole sitting can be downloaded as one CSV — the actual
// brain waves, not just the score. Everything stays in memory (RAM); nothing is
// written anywhere until the user clicks Download, and then it goes to their own
// disk, never off the page.
//
// Samples arrive per-channel in packets of 12 at 256 Hz. We keep one growable
// buffer per channel (a list of fixed chunks, so a long session doesn't thrash
// the allocator) and align channels by sample index at export time. Dropped
// packets are rare here — the loss meter reads 0 in practice — so index
// alignment is honest enough for a consumer tool; a big radio drop would shift
// one channel against the others, which is why the header records the start time.

import { SAMPLE_RATE } from "./muse.js";

const CHUNK = 8192; // samples per chunk, per channel

export class Recorder {
  constructor() {
    this.reset();
  }

  reset() {
    this.recording = false;
    this.names = [];
    this.chunks = []; // chunks[ch] = [Float32Array, ...]
    this.counts = []; // chunks[ch] total samples
    this.cursors = []; // fill position in the last chunk of channel ch
    this.startedAt = 0; // Date.now() at record start
  }

  /** Begin a fresh recording for these channel names. */
  start(names) {
    this.reset();
    this.names = names.slice();
    this.chunks = this.names.map(() => [new Float32Array(CHUNK)]);
    this.counts = this.names.map(() => 0);
    this.cursors = this.names.map(() => 0);
    this.startedAt = Date.now();
    this.recording = true;
  }

  /** Freeze the recording but keep the data, so it can still be downloaded. */
  stop() {
    this.recording = false;
  }

  /** The headband reported its channel names. Keep the buffers if the count
   *  still matches; otherwise start over but hold the original start time. */
  setNames(names) {
    if (this.recording && names.length === this.names.length) {
      this.names = names.slice();
      return;
    }
    const t = this.startedAt || Date.now();
    this.start(names);
    this.startedAt = t;
  }

  push(ch, samples) {
    if (!this.recording || ch >= this.chunks.length) return;
    const list = this.chunks[ch];
    let cur = list[list.length - 1];
    let cursor = this.cursors[ch];
    for (let i = 0; i < samples.length; i++) {
      if (cursor >= cur.length) {
        cur = new Float32Array(CHUNK);
        list.push(cur);
        cursor = 0;
      }
      cur[cursor++] = samples[i];
    }
    this.cursors[ch] = cursor;
    this.counts[ch] += samples.length;
  }

  // The shortest channel bounds every complete row.
  get sampleCount() {
    return this.counts.length ? Math.min(...this.counts) : 0;
  }

  get durationSec() {
    return this.sampleCount / SAMPLE_RATE;
  }

  // Flatten one channel's chunks into a single contiguous view.
  channel(ch) {
    const total = this.counts[ch];
    const out = new Float32Array(total);
    let o = 0;
    for (const c of this.chunks[ch]) {
      if (o >= total) break;
      const take = Math.min(c.length, total - o);
      out.set(c.subarray(0, take), o);
      o += take;
    }
    return out;
  }

  /** CSV text: `#`-prefixed header lines, then t_seconds + one column/channel. */
  toCSV(headerLines = []) {
    const n = this.sampleCount;
    const cols = this.names.map((_, ch) => this.channel(ch));
    const rows = [];
    for (const line of headerLines) rows.push(`# ${line}`);
    rows.push(["t_seconds", ...this.names].join(","));
    for (let i = 0; i < n; i++) {
      let row = (i / SAMPLE_RATE).toFixed(4);
      for (let ch = 0; ch < cols.length; ch++) row += "," + cols[ch][i].toFixed(2);
      rows.push(row);
    }
    return rows.join("\n") + "\n";
  }
}
