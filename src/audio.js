// ---------------------------------------------------------------------------
// Sound for the basketball game.
//
// This is not decoration. Alpha rises when you close your eyes, so the most
// effective way to play is with your eyes shut — at which point a purely visual
// game tells you nothing. A tone that tracks the ball's height is what makes it
// playable blind, and it's how real alpha neurofeedback has been run since the
// 1960s.
// ---------------------------------------------------------------------------

let ctx = null;
let tone = null;
let toneGain = null;

function getCtx() {
  if (!ctx) ctx = new (window.AudioContext || window.webkitAudioContext)();
  if (ctx.state === "suspended") ctx.resume();
  return ctx;
}

export function startTone() {
  try {
    const c = getCtx();
    if (tone) return;
    tone = c.createOscillator();
    toneGain = c.createGain();
    tone.type = "sine";
    tone.frequency.value = 200;
    toneGain.gain.value = 0.0001;
    tone.connect(toneGain).connect(c.destination);
    tone.start();
  } catch {
    /* no audio available — the game still plays, just silently */
  }
}

export function stopTone() {
  try {
    if (!tone) return;
    toneGain.gain.setTargetAtTime(0.0001, ctx.currentTime, 0.05);
    tone.stop(ctx.currentTime + 0.3);
  } catch {
    /* nothing to stop */
  }
  tone = null;
  toneGain = null;
}

/** lift 0..1 → pitch from a low hum to a clear tone. */
export function setToneLift(lift) {
  if (!tone) return;
  const t = ctx.currentTime;
  const hz = 180 * Math.pow(2, 1.6 * Math.max(0, Math.min(1, lift))); // ~180 → ~545 Hz
  tone.frequency.setTargetAtTime(hz, t, 0.08);
  toneGain.gain.setTargetAtTime(0.02 + 0.05 * lift, t, 0.08);
}

/** The sound of the net. Filtered noise burst, quick decay. */
export function swish() {
  try {
    const c = getCtx();
    const len = Math.floor(c.sampleRate * 0.45);
    const buf = c.createBuffer(1, len, c.sampleRate);
    const data = buf.getChannelData(0);
    for (let i = 0; i < len; i++) data[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / len, 2.5);
    const src = c.createBufferSource();
    src.buffer = buf;
    const band = c.createBiquadFilter();
    band.type = "bandpass";
    band.frequency.value = 3200;
    band.Q.value = 1.2;
    const gain = c.createGain();
    gain.gain.value = 0.5;
    src.connect(band).connect(gain).connect(c.destination);
    src.start();
  } catch {
    /* silent is fine */
  }
}

/** A soft thud when the ball lands back on the floor. */
export function bounce() {
  try {
    const c = getCtx();
    const osc = c.createOscillator();
    const gain = c.createGain();
    osc.type = "sine";
    osc.frequency.setValueAtTime(150, c.currentTime);
    osc.frequency.exponentialRampToValueAtTime(60, c.currentTime + 0.18);
    gain.gain.setValueAtTime(0.18, c.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.0001, c.currentTime + 0.22);
    osc.connect(gain).connect(c.destination);
    osc.start();
    osc.stop(c.currentTime + 0.25);
  } catch {
    /* silent is fine */
  }
}

export function resumeAudio() {
  try {
    getCtx();
  } catch {
    /* ignore */
  }
}
