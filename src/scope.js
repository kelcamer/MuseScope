// ---------------------------------------------------------------------------
// The trace display: four stacked lanes on one canvas.
//
// Drawn min/max per pixel column rather than point-per-sample, which is how a
// real scope does it — at 256 Hz across a 4-second window the sample count and
// the pixel count are close, and min/max keeps spikes visible either way.
// ---------------------------------------------------------------------------

import { CHANNELS, SAMPLE_RATE } from "./muse.js";
import { RING_LEN, WINDOW_SEC } from "./signal.js";

const LANE_GAP = 6;
const LABEL_W = 52;

export class Scope {
  constructor(canvas) {
    this.canvas = canvas;
    this.ctx = canvas.getContext("2d");
    this.scan = new Float32Array(RING_LEN);
    this.scale = 100; // µV at the top of a lane; 0 means auto
    this.autoScale = new Float32Array(CHANNELS.length).fill(100);
    this.colors = null;
    this.labels = CHANNELS.slice();
  }

  setLabels(names) {
    if (names && names.length) this.labels = names.slice();
  }

  // Read the palette out of CSS once. Doing this per frame means a full style
  // resolution 60 times a second for values that never change.
  _palette() {
    if (this.colors) return this.colors;
    const style = getComputedStyle(document.documentElement);
    const pick = (name, fallback) => style.getPropertyValue(name).trim() || fallback;
    this.colors = {
      ink: pick("--ink", "#eaf3ee"),
      faint: pick("--line", "#28453d"),
      accent: pick("--accent", "#3fc8d6"),
      warn: pick("--amber", "#f5b94d"),
      bad: pick("--danger", "#e6626e"),
    };
    return this.colors;
  }

  setScale(uv) {
    this.scale = uv;
  }

  draw(channels, grades) {
    const dpr = window.devicePixelRatio || 1;
    const cssW = this.canvas.clientWidth;
    const cssH = this.canvas.clientHeight;
    const w = Math.round(cssW * dpr);
    const h = Math.round(cssH * dpr);
    if (this.canvas.width !== w || this.canvas.height !== h) {
      this.canvas.width = w;
      this.canvas.height = h;
    }
    const ctx = this.ctx;
    const { ink, faint, accent, warn, bad } = this._palette();

    ctx.clearRect(0, 0, w, h);
    const laneH = (h - LANE_GAP * (CHANNELS.length - 1)) / CHANNELS.length;
    const left = LABEL_W * dpr;
    const plotW = w - left;

    ctx.font = `${11 * dpr}px "JetBrains Mono", monospace`;
    ctx.textBaseline = "middle";

    for (let c = 0; c < CHANNELS.length; c++) {
      const top = c * (laneH + LANE_GAP);
      const mid = top + laneH / 2;

      // lane frame + second ticks
      ctx.strokeStyle = faint;
      ctx.lineWidth = 1 * dpr;
      ctx.beginPath();
      ctx.moveTo(left, mid);
      ctx.lineTo(w, mid);
      ctx.stroke();
      ctx.beginPath();
      for (let s = 1; s < WINDOW_SEC; s++) {
        const x = left + (plotW * s) / WINDOW_SEC;
        ctx.moveTo(x, top + 2 * dpr);
        ctx.lineTo(x, top + laneH - 2 * dpr);
      }
      ctx.stroke();

      const state = channels[c];
      const n = state.view.tail(RING_LEN, this.scan);

      // per-lane scale: fixed, or tracking the recent peak with a slow decay so
      // the trace doesn't jump every frame
      let span = this.scale;
      if (!span) {
        let peak = 1;
        for (let i = 0; i < n; i++) {
          const a = Math.abs(this.scan[i]);
          if (a > peak) peak = a;
        }
        const prev = this.autoScale[c];
        span = peak > prev ? peak : prev * 0.97 + peak * 0.03;
        this.autoScale[c] = span;
      }

      const grade = grades[c];
      ctx.strokeStyle = grade === "poor" ? bad : grade === "fair" ? warn : accent;
      ctx.lineWidth = 1.2 * dpr;

      if (n > 1) {
        const half = (laneH / 2) * 0.92;
        const cols = Math.max(1, Math.floor(plotW));
        const per = n / cols;
        ctx.beginPath();
        for (let x = 0; x < cols; x++) {
          const from = Math.floor(x * per);
          const to = Math.min(n, Math.floor((x + 1) * per) + 1);
          let lo = Infinity;
          let hi = -Infinity;
          for (let i = from; i < to; i++) {
            const v = this.scan[i];
            if (v < lo) lo = v;
            if (v > hi) hi = v;
          }
          if (lo === Infinity) continue;
          const px = left + x;
          const yHi = mid - Math.max(-1, Math.min(1, hi / span)) * half;
          const yLo = mid - Math.max(-1, Math.min(1, lo / span)) * half;
          ctx.moveTo(px, yHi);
          ctx.lineTo(px, yLo === yHi ? yLo + 0.5 * dpr : yLo);
        }
        ctx.stroke();
      }

      // labels: channel name, and what the lane's full height means
      ctx.fillStyle = ink;
      ctx.textAlign = "left";
      ctx.fillText(this.labels[c] || `ch${c + 1}`, 4 * dpr, mid - 7 * dpr);
      ctx.fillStyle = faint;
      ctx.fillText(`±${Math.round(span)}µV`, 4 * dpr, mid + 8 * dpr);
    }

    // time axis note, bottom right
    ctx.fillStyle = faint;
    ctx.textAlign = "right";
    ctx.fillText(`${WINDOW_SEC}s · ${SAMPLE_RATE}Hz`, w - 4 * dpr, h - 8 * dpr);
  }
}
