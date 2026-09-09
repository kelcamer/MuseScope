// ---------------------------------------------------------------------------
// The basketball court. Ball height is driven by one number — `lift`, 0 to 1,
// where 1 is your own alpha ceiling measured during calibration.
//
// The ball chases the target rather than snapping to it: raw alpha jitters
// several times a second, and a ball that twitched with it would be unreadable
// and unrewarding. ~0.35s of lag is slow enough to look like physics and fast
// enough that you can still feel what you did.
// ---------------------------------------------------------------------------

const HOLD_MS = 350; // time inside the hoop before it counts
const DROP_MS = 700;

export class Hoop {
  constructor(canvas) {
    this.canvas = canvas;
    this.ctx = canvas.getContext("2d");
    this.lift = 0;
    this.target = 0;
    this.y = 0; // 0 = floor, 1 = through the rim
    this.artifact = false;
    this.inZoneSince = 0;
    this.dropUntil = 0;
    this.score = 0;
    this.bestHoldMs = 0;
    this.zoneMs = 0;
    this.totalMs = 0;
    this.flash = 0;
    this.last = 0;
    this.colors = null;
    this.theme = null;
  }

  reset() {
    this.score = 0;
    this.bestHoldMs = 0;
    this.zoneMs = 0;
    this.totalMs = 0;
    this.y = 0;
    this.inZoneSince = 0;
  }

  /** Ball colours, so two bands can share one court without looking identical. */
  setTheme(theme) {
    this.theme = theme;
    this.colors = null; // re-resolve on the next frame
  }

  setLift(v, artifact) {
    this.target = Math.max(0, Math.min(1, v));
    this.artifact = artifact;
  }

  _palette() {
    if (this.colors) return this.colors;
    const s = getComputedStyle(document.documentElement);
    const pick = (n, f) => s.getPropertyValue(n).trim() || f;
    this.colors = {
      line: pick("--line", "#24383f"),
      ink: pick("--ink", "#e9f2f4"),
      dim: pick("--ink-faint", "#67818a"),
      accent: pick("--accent", "#3fc8d6"),
      good: pick("--good", "#5ecf9e"),
      ball: (this.theme && this.theme.ball) || "#e8823c",
      ballDark: (this.theme && this.theme.ballDark) || "#b8551b",
    };
    return this.colors;
  }

  /** Returns "scored" on the frame a basket lands, else null. */
  step(now) {
    const dt = this.last ? Math.min(0.1, (now - this.last) / 1000) : 0.016;
    this.last = now;
    let event = null;

    if (now < this.dropUntil) {
      // falling back to the floor after a made basket
      const k = 1 - (this.dropUntil - now) / DROP_MS;
      this.y = Math.max(0, 1 - k * k * 1.05);
      this.inZoneSince = 0;
    } else {
      // artifact windows freeze the ball instead of throwing it around
      const target = this.artifact ? this.y : this.target;
      this.y += (target - this.y) * (1 - Math.exp(-dt / 0.35));

      this.totalMs += dt * 1000;
      if (this.y >= 0.97 && !this.artifact) {
        this.zoneMs += dt * 1000;
        if (!this.inZoneSince) this.inZoneSince = now;
        const held = now - this.inZoneSince;
        if (held > this.bestHoldMs) this.bestHoldMs = held;
        if (held >= HOLD_MS) {
          this.score++;
          this.flash = now;
          this.dropUntil = now + DROP_MS;
          this.inZoneSince = 0;
          event = "scored";
        }
      } else {
        this.inZoneSince = 0;
      }
    }

    this.draw(now);
    return event;
  }

  draw(now) {
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
    const c = this._palette();
    const S = (v) => v * dpr;

    ctx.clearRect(0, 0, w, h);
    const sky = ctx.createLinearGradient(0, 0, 0, h);
    sky.addColorStop(0, "#0e1a20");
    sky.addColorStop(1, "#080e11");
    ctx.fillStyle = sky;
    ctx.fillRect(0, 0, w, h);

    const cx = w * 0.56;
    const floorY = h - S(34);
    const rimY = S(76);
    const r = S(17);

    // ---- floor
    ctx.strokeStyle = c.line;
    ctx.lineWidth = S(1);
    ctx.beginPath();
    ctx.moveTo(0, floorY);
    ctx.lineTo(w, floorY);
    ctx.stroke();

    // ---- backboard and rim
    ctx.strokeStyle = c.dim;
    ctx.lineWidth = S(2);
    ctx.strokeRect(cx - S(52), rimY - S(52), S(104), S(58));
    ctx.strokeRect(cx - S(19), rimY - S(26), S(38), S(28));

    const rimW = S(46);
    ctx.strokeStyle = c.ball;
    ctx.lineWidth = S(3.5);
    ctx.beginPath();
    ctx.ellipse(cx, rimY, rimW / 2, S(6), 0, 0, Math.PI * 2);
    ctx.stroke();

    // net
    ctx.strokeStyle = c.dim;
    ctx.lineWidth = S(1);
    ctx.beginPath();
    for (let i = 0; i <= 6; i++) {
      const t = i / 6;
      const x0 = cx - rimW / 2 + rimW * t;
      ctx.moveTo(x0, rimY + S(4));
      ctx.lineTo(cx + (x0 - cx) * 0.45, rimY + S(30));
    }
    for (let row = 1; row <= 2; row++) {
      const k = row / 3;
      const halfW = (rimW / 2) * (1 - 0.55 * k);
      ctx.moveTo(cx - halfW, rimY + S(4) + S(26) * k);
      ctx.lineTo(cx + halfW, rimY + S(4) + S(26) * k);
    }
    ctx.stroke();

    // ---- the height the ball has to reach
    ctx.setLineDash([S(5), S(5)]);
    ctx.strokeStyle = c.line;
    ctx.beginPath();
    ctx.moveTo(S(16), rimY);
    ctx.lineTo(w - S(16), rimY);
    ctx.stroke();
    ctx.setLineDash([]);

    // ---- alpha column, left edge
    const colX = S(26);
    const colTop = rimY;
    const colBot = floorY;
    ctx.strokeStyle = c.line;
    ctx.lineWidth = S(1);
    ctx.beginPath();
    ctx.moveTo(colX, colTop);
    ctx.lineTo(colX, colBot);
    ctx.stroke();
    const fillH = (colBot - colTop) * Math.max(0, Math.min(1, this.target));
    ctx.strokeStyle = this.artifact ? c.dim : c.accent;
    ctx.lineWidth = S(6);
    ctx.lineCap = "round";
    ctx.beginPath();
    ctx.moveTo(colX, colBot);
    ctx.lineTo(colX, colBot - fillH);
    ctx.stroke();
    ctx.lineCap = "butt";

    ctx.fillStyle = c.dim;
    ctx.font = `${S(10)}px "JetBrains Mono", monospace`;
    ctx.textAlign = "center";
    ctx.fillText("ALPHA", colX, colBot + S(18));

    // ---- the ball
    const ballY = floorY - r - (floorY - r - rimY) * this.y;
    const grad = ctx.createRadialGradient(cx - r * 0.35, ballY - r * 0.4, r * 0.1, cx, ballY, r);
    grad.addColorStop(0, c.ball);
    grad.addColorStop(1, c.ballDark);
    ctx.globalAlpha = this.artifact ? 0.4 : 1;
    ctx.fillStyle = grad;
    ctx.beginPath();
    ctx.arc(cx, ballY, r, 0, Math.PI * 2);
    ctx.fill();

    // seams
    ctx.strokeStyle = "rgba(60,20,0,0.75)";
    ctx.lineWidth = S(1.4);
    ctx.beginPath();
    ctx.arc(cx, ballY, r, 0, Math.PI * 2);
    ctx.moveTo(cx - r, ballY);
    ctx.lineTo(cx + r, ballY);
    ctx.moveTo(cx, ballY - r);
    ctx.lineTo(cx, ballY + r);
    ctx.stroke();
    ctx.beginPath();
    ctx.ellipse(cx, ballY, r * 0.45, r, 0, 0, Math.PI * 2);
    ctx.stroke();
    ctx.globalAlpha = 1;

    // ---- swish flash
    if (now - this.flash < 900) {
      const k = 1 - (now - this.flash) / 900;
      ctx.globalAlpha = k;
      ctx.fillStyle = c.good;
      ctx.font = `800 ${S(30)}px "Big Shoulders Display", sans-serif`;
      ctx.textAlign = "center";
      ctx.fillText("SWISH", cx, rimY - S(66) - (1 - k) * S(20));
      ctx.globalAlpha = 1;
    }

    if (this.artifact) {
      ctx.fillStyle = c.dim;
      ctx.font = `${S(12)}px "Archivo", sans-serif`;
      ctx.textAlign = "center";
      ctx.fillText("no usable forehead signal — check AF7 / AF8 contact", w / 2, floorY + S(22));
    }
  }
}
