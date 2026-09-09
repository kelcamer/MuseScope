// ---------------------------------------------------------------------------
// Muse Scope — connect a Muse S over Web Bluetooth. Two tabs:
//   Scope — four raw EEG traces and an electrode contact check.
//   Hoop  — a basketball driven by your own alpha rhythm.
//
// No framework on purpose: 4 channels × 256 Hz is a stream, not application
// state, so samples go straight into ring buffers, canvases redraw on
// requestAnimationFrame, and only the numbers around the edges touch the DOM.
// ---------------------------------------------------------------------------

import { MuseClient, bluetoothAvailable, CHANNELS, EEG_CHARS, SAMPLES_PER_PACKET } from "./muse.js";
import { ChannelState } from "./signal.js";
import { Scope } from "./scope.js";
import { AlphaMeter, baselineFrom, liftFrom } from "./alpha.js";
import { Hoop } from "./hoop.js";
import { startTone, stopTone, setToneLift, swish, bounce, resumeAudio } from "./audio.js";
import "./styles.css";

const BASELINE_KEY = "museScopeBaselinesV2";
const CAL_SECONDS = 20;

const app = document.getElementById("app");

app.innerHTML = `
  <header class="bar">
    <div class="brand">
      <span class="display">MUSE SCOPE</span>
      <span class="tag">four channels, live</span>
    </div>
    <div class="pills">
      <span class="pill" id="p-status"><span class="dot" id="dot"></span><span id="status">not connected</span></span>
      <span class="pill">device <b id="device">—</b></span>
      <span class="pill">battery <b id="battery">—</b></span>
      <span class="pill">elapsed <b id="elapsed">0:00</b></span>
      <span class="pill" id="p-loss">dropped <b id="loss">0</b></span>
    </div>
  </header>

  <main>
    <section class="panel" id="gate">
      <h1 class="display">Put the headband on, then connect.</h1>
      <p class="lede" id="gate-copy">
        Chrome will ask you to pick the device — it has to be you clicking, a page can't open that chooser by itself.
        The headband must be on and awake (press its button once) or it won't advertise.
      </p>
      <div class="row">
        <button class="btn btn--primary" id="connect">Connect a Muse</button>
        <button class="btn" id="demo">Simulate a signal</button>
      </div>
      <p class="note" id="gate-note"></p>
      <details class="probe" id="probe" hidden>
        <summary>What the headband exposes</summary>
        <p class="note">
          Every service and characteristic Chrome will show for this device. If the connection failed, this is the useful part — the app looks for a
          writable characteristic to send commands to and notifying ones to read EEG from.
        </p>
        <pre id="probe-out" class="mono"></pre>
        <button class="btn btn--sm" id="copy-probe">Copy</button>
      </details>
    </section>

    <nav class="tabs" id="tabs" hidden>
      <button class="tab is-on" data-view="scope">Scope</button>
      <button class="tab" data-view="alpha">Alpha hoop</button>
      <button class="tab" data-view="beta">Beta hoop</button>
    </nav>

    <section class="panel panel--scope" id="view-scope" hidden>
      <div class="controls">
        <label>Scale
          <select id="scale">
            <option value="0">auto</option>
            <option value="25">±25 µV</option>
            <option value="50">±50 µV</option>
            <option value="100" selected>±100 µV</option>
            <option value="250">±250 µV</option>
            <option value="1000">±1000 µV</option>
          </select>
        </label>
        <label>Mains
          <select id="mains">
            <option value="60" selected>60 Hz (US)</option>
            <option value="50">50 Hz (EU)</option>
          </select>
        </label>
        <label class="check"><input type="checkbox" id="notch" checked /> Notch out mains</label>
        <div class="grow"></div>
        <button class="btn btn--sm" id="pause">Pause</button>
        <button class="btn btn--sm" id="disconnect">Disconnect</button>
      </div>

      <canvas id="scope"></canvas>

      <div class="fit">
        <div class="head">
          <svg viewBox="0 0 120 132" aria-label="electrode positions">
            <path d="M60 4 L52 16 H68 Z" fill="currentColor" opacity="0.35" />
            <ellipse cx="60" cy="70" rx="46" ry="54" fill="none" stroke="currentColor" stroke-opacity="0.35" stroke-width="1.5" />
            <circle class="e" id="e-AF7" cx="38" cy="36" r="8" />
            <circle class="e" id="e-AF8" cx="82" cy="36" r="8" />
            <circle class="e" id="e-TP9" cx="21" cy="82" r="8" />
            <circle class="e" id="e-TP10" cx="99" cy="82" r="8" />
          </svg>
        </div>
        <table class="quality">
          <thead>
            <tr><th>Electrode</th><th>Where</th><th>Contact</th><th>Signal 5–30 Hz</th><th>Mains</th></tr>
          </thead>
          <tbody id="qrows"></tbody>
        </table>
      </div>

      <p class="note">
        Contact grades are computed here, not read from the headband — Muse's own fit indicator lives in the native SDK and isn't exposed over
        Bluetooth. <b>Signal</b> is the size of the 5–30 Hz activity, where ordinary EEG runs 5–30 µV; the offset and slow drift are subtracted first,
        so blinks and a wandering baseline don't inflate it. <b>Mains</b> is hum measured against that same band — how much of what's here is the
        room's wiring rather than you. A <b>poor</b> grade means railing, flat, drifting hard, or drowned in hum. It still under-reports muscle: a
        clenched jaw raises the number without necessarily failing it. Display filtering never touches these figures.
      </p>
      <p class="note">
        Quick checks that you're seeing your own body: <b>blink hard</b> — big humps on AF7/AF8 only. <b>Clench your jaw</b> — dense fuzz, worst at
        TP9/TP10. <b>Close your eyes and wait</b> — smooth ~10 Hz waves swell, and collapse when you open them. That last one is alpha, and it's what
        the Hoop tab plays with.
      </p>
    </section>

    <section class="panel" id="view-hoop" hidden>
      <div class="hoop-head">
        <div>
          <span class="eyebrow" id="game-eyebrow">alpha neurofeedback</span>
          <h1 class="display" id="game-title">Alpha hoop</h1>
        </div>
        <div class="pills">
          <span class="pill">baskets <b id="baskets">0</b></span>
          <span class="pill"><span id="band-label">alpha</span> <b id="alpha-pct">—</b></span>
          <span class="pill">lift <b id="lift-pct">—</b></span>
          <span class="pill">in the zone <b id="zone-pct">—</b></span>
        </div>
      </div>

      <div id="cal-wrap">
        <p class="lede">
          The ball rises with a brain rhythm: <b>alpha</b> (8–12 Hz), which grows when your visual system stops working at something, or <b>beta</b>
          (13–25 Hz), which grows when you're working at something. Everyone sits at a different level, so first it measures yours — one calibration
          covers both games.
        </p>
        <p class="note">Sit still, <b>eyes open</b>, jaw slack, for ${CAL_SECONDS} seconds. That becomes the floor. Your ceiling comes from the top of your own range.</p>
        <div class="row">
          <button class="btn btn--primary" id="calibrate">Calibrate (${CAL_SECONDS}s)</button>
          <button class="btn" id="use-saved" hidden>Use last calibration</button>
        </div>
        <div class="calbar" id="calbar" hidden><div class="calbar__fill" id="calbar-fill"></div></div>
        <p class="note" id="cal-note"></p>
      </div>

      <div id="game-wrap" hidden>
        <canvas id="court"></canvas>
        <div class="controls">
          <label title="Right makes the ball rise on less alpha">Easier
            <input type="range" id="sens" min="0.6" max="2" step="0.05" value="1" />
          </label>
          <label class="check"><input type="checkbox" id="sound" checked /> Tone guide (for eyes closed)</label>
          <div class="grow"></div>
          <button class="btn btn--sm" id="recal">Recalibrate</button>
          <button class="btn btn--sm" id="reset-score">Reset score</button>
        </div>
        <p class="note" id="how-to"></p>
        <p class="note">
          Blinks and jaw clenches make the ball go <b>down</b>, not up — the score is alpha as a share of everything else, so anything that adds
          broadband noise dilutes it. Only a window with nothing usable in it freezes the ball. The ball reads the forehead pair,
          <b id="used-chans">AF7 + AF8</b>. Textbook alpha is strongest at the back of the head, but on this headband the ear
          contacts are the ones that rail and pick up jaw muscle, and a better electrode in theory is worth nothing if it won't hold contact.
        </p>
      </div>
    </section>
  </main>

  <footer>
    <p class="note">
      Unofficial. InteraXon publishes no Bluetooth spec; this follows the community protocol that <code>muse-js</code> established, so a firmware
      update could break it. Chrome or Edge on desktop only — Safari and Firefox don't implement Web Bluetooth, and neither does any iOS browser.
      Nothing leaves this page: no upload, no storage beyond your calibration, no account. Not a medical device.
    </p>
  </footer>
`;

const el = (id) => document.getElementById(id);
const channels = CHANNELS.map(() => new ChannelState());
const scope = new Scope(el("scope"));
// One canvas, one court per band: scores and streaks stay separate, and
// switching tabs doesn't wipe what you just did in the other game.
const courts = { alpha: new Hoop(el("court")), beta: new Hoop(el("court")) };
const BANDS = {
  alpha: {
    title: "Alpha hoop",
    eyebrow: "alpha neurofeedback · 8–12 Hz",
    theme: { ball: "#e8823c", ballDark: "#b8551b" },
    howTo:
      "<b>How to score:</b> get the ball to the rim and hold it for a third of a second. The reliable way is to close your eyes and let your attention go " +
      "somewhere soft — that's when alpha climbs. Which is why there's a tone: it rises with the ball, so you can play blind.",
  },
  beta: {
    title: "Beta hoop",
    eyebrow: "beta neurofeedback · 13–25 Hz",
    theme: { ball: "#57b7e8", ballDark: "#1d6c99" },
    howTo:
      "<b>How to score:</b> the opposite skill. Beta rises when you're actively working at something — count backwards from 300 by sevens, hold a phone " +
      "number in your head, plan a route. Eyes open. Closing them will sink the ball, which is the point: this game and the alpha one can't both be won " +
      "at once. <b>Careful:</b> jaw and forehead muscle spill into beta, so clenching raises the score without meaning anything. Keep your jaw slack " +
      "and it stays honest.",
  },
};
let channelNames = CHANNELS.slice();
const meter = new AlphaMeter(channels, channelNames);

const seen = { expected: CHANNELS.map(() => null), dropped: 0, total: 0 };
let mainsHz = 60;
let startedAt = 0;
let running = false;
let demo = null;
let view = "scope";

// calibration
let baselines = loadBaseline() || { alpha: null, beta: null };
let calSamples = null;
let calEndsAt = 0;
let calExtended = false;

function loadBaseline() {
  try {
    const raw = localStorage.getItem(BASELINE_KEY);
    const parsed = raw ? JSON.parse(raw) : null;
    return parsed && parsed.alpha ? parsed : null;
  } catch {
    return null;
  }
}
function saveBaseline(b) {
  try {
    localStorage.setItem(BASELINE_KEY, JSON.stringify(b));
  } catch {
    /* private window — the games still work this session */
  }
}
const band = () => (view === "beta" ? "beta" : "alpha");
const court = () => courts[band()];
const baseline = () => baselines[band()];

function setNotch(on) {
  channels.forEach((c) => c.setNotch(on ? mainsHz : 0));
}
setNotch(true);

function status(text, kind = "") {
  el("status").textContent = text;
  el("dot").className = `dot ${kind}`;
}

function showLive(on) {
  el("gate").hidden = on;
  el("tabs").hidden = !on;
  el("view-scope").hidden = !on || view !== "scope";
  el("view-hoop").hidden = !on || view === "scope";
  if (!on) stopTone();
}

function setView(next) {
  view = next;
  document.querySelectorAll(".tab").forEach((t) => t.classList.toggle("is-on", t.dataset.view === next));
  showLive(!el("tabs").hidden);
  if (next === "scope") {
    stopTone();
    return;
  }
  const cfg = BANDS[band()];
  el("game-title").textContent = cfg.title;
  el("game-eyebrow").textContent = cfg.eyebrow;
  el("band-label").textContent = band();
  el("how-to").innerHTML = cfg.howTo;
  court().setTheme(cfg.theme);
  showCalibrationState();
  if (el("sound").checked && baseline()) {
    resumeAudio();
    startTone();
  }
}

document.querySelectorAll(".tab").forEach((t) => t.addEventListener("click", () => setView(t.dataset.view)));

// ---- sample intake -------------------------------------------------------
function onSamples(channelIndex, samples, seq) {
  const state = channels[channelIndex];
  for (let i = 0; i < SAMPLES_PER_PACKET; i++) state.push(samples[i]);

  // A jump of more than one means the radio lost packets. Implausibly large
  // jumps are ignored rather than believed: the counter's exact semantics are
  // reverse-engineered, and one odd value shouldn't invent thousands of losses.
  const prev = seen.expected[channelIndex];
  if (prev != null) {
    const gap = (seq - prev + 65536) % 65536;
    if (gap > 1 && gap < 500) seen.dropped += gap - 1;
  }
  seen.expected[channelIndex] = seq;
  seen.total++;
}

function showProbe(report) {
  el("probe").hidden = false;
  el("probe-out").textContent = report || "nothing discovered";
}

const client = new MuseClient({
  onSamples,
  onProbe: (_services, report) => showProbe(report),
  onChannels: (names) => {
    channelNames = names;
    scope.setLabels(names);
    meter.setNames(names);
  },
  onTelemetry: ({ battery }) => {
    el("battery").textContent = `${Math.round(battery)}%`;
  },
  onStatus: (s) => status(s, s === "streaming" ? "ok" : ""),
  onDeviceInfo: (info) => {
    if (info && (info.fw || info.hw)) {
      el("device").textContent = `${client.device?.name || "Muse"} · fw ${info.fw || "?"}`;
    }
  },
  onDisconnect: () => {
    running = false;
    status("headband disconnected", "bad");
    el("gate-note").textContent = "The headband dropped the connection. Press its button and connect again.";
    showLive(false);
  },
});

// ---- connect / disconnect ----------------------------------------------
el("connect").addEventListener("click", async () => {
  el("gate-note").textContent = "";
  try {
    const name = await client.connect();
    el("device").textContent = name;
    await client.deviceInfo();
    await client.start();
    startedAt = Date.now();
    running = true;
    showLive(true);
    setView(view);
  } catch (err) {
    const msg = String(err && err.message ? err.message : err);
    if (/cancel/i.test(msg)) {
      el("gate-note").textContent = "No device picked.";
    } else if (/globally disabled|bluetooth adapter|not available/i.test(msg)) {
      el("gate-note").textContent =
        "Chrome can't reach Bluetooth. On macOS, allow it in System Settings → Privacy & Security → Bluetooth, then restart Chrome.";
    } else {
      const [headline] = msg.split("\n\n");
      el("gate-note").textContent = headline;
      if (client.report) showProbe(client.report);
    }
    status("not connected", "bad");
  }
});

el("disconnect").addEventListener("click", () => {
  stopDemo();
  el("pause").disabled = false;
  el("pause").textContent = "Pause";
  client.disconnect();
  running = false;
  showLive(false);
});

el("pause").addEventListener("click", async () => {
  if (demo) return;
  if (client.streaming) {
    await client.stop();
    el("pause").textContent = "Resume";
  } else {
    await client.start();
    el("pause").textContent = "Pause";
  }
});

el("copy-probe").addEventListener("click", () => {
  navigator.clipboard?.writeText(el("probe-out").textContent || "");
  el("copy-probe").textContent = "Copied";
  setTimeout(() => (el("copy-probe").textContent = "Copy"), 1500);
});

el("scale").addEventListener("change", (e) => scope.setScale(Number(e.target.value)));
el("notch").addEventListener("change", (e) => setNotch(e.target.checked));
el("mains").addEventListener("change", (e) => {
  mainsHz = Number(e.target.value);
  setNotch(el("notch").checked);
});

// ---- the game ------------------------------------------------------------
function showCalibrationState() {
  const calibrating = calSamples !== null;
  el("cal-wrap").hidden = !!baseline() && !calibrating;
  el("game-wrap").hidden = !baseline() || calibrating;
  el("calbar").hidden = !calibrating;
  el("calibrate").disabled = calibrating;
  el("use-saved").hidden = !(loadBaseline() && !baseline());
}

function startCalibration() {
  calSamples = { alpha: [], beta: [] };
  calExtended = false;
  calEndsAt = performance.now() + CAL_SECONDS * 1000;
  showCalibrationState();
}

el("calibrate").addEventListener("click", startCalibration);
el("recal").addEventListener("click", () => {
  // One pass measures both bands, so recalibrating clears both.
  baselines = { alpha: null, beta: null };
  startCalibration();
});
el("use-saved").addEventListener("click", () => {
  baselines = loadBaseline() || baselines;
  showCalibrationState();
});
el("reset-score").addEventListener("click", () => court().reset());
el("sound").addEventListener("change", (e) => {
  if (e.target.checked && view !== "scope") {
    resumeAudio();
    startTone();
  } else {
    stopTone();
  }
});

// ---- a synthetic headband, so the display can be checked without hardware ---
function stopDemo() {
  if (demo) clearInterval(demo);
  demo = null;
}

el("demo").addEventListener("click", () => {
  stopDemo();
  showLive(true);
  setView(view);
  startedAt = Date.now();
  running = true;
  status("simulated — no headband", "warn");
  el("device").textContent = "simulator";
  el("battery").textContent = "—";
  el("pause").disabled = true;

  let t = 0;
  const buf = new Float32Array(SAMPLES_PER_PACKET);
  demo = setInterval(() => {
    for (let c = 0; c < CHANNELS.length; c++) {
      for (let i = 0; i < SAMPLES_PER_PACKET; i++) {
        const s = (t + i) / 256;
        // alpha waxes and wanes on a slow cycle, so the simulated ball actually
        // rises and falls instead of sitting still
        const alpha = 22 * Math.sin(2 * Math.PI * 10.2 * s) * (0.5 + 0.5 * Math.sin(2 * Math.PI * 0.06 * s));
        const theta = 9 * Math.sin(2 * Math.PI * 5.5 * s + c);
        const noise = (Math.random() - 0.5) * 12;
        const hum = (c === 3 ? 55 : 4) * Math.sin(2 * Math.PI * mainsHz * s);
        buf[i] = alpha + theta + noise + hum + 40 * Math.sin(2 * Math.PI * 0.05 * s);
      }
      onSamples(c, buf, (t / SAMPLES_PER_PACKET) & 0xffff);
    }
    t += SAMPLES_PER_PACKET;
  }, (SAMPLES_PER_PACKET / 256) * 1000);
});

// ---- render loop ---------------------------------------------------------
function frame(now) {
  requestAnimationFrame(frame);
  if (view === "scope") {
    if (el("view-scope").hidden) return;
    scope.draw(channels, channels.map((c) => c.quality.grade));
  } else {
    // a hidden canvas has zero width — never try to draw into it
    if (el("view-hoop").hidden || el("game-wrap").hidden) return;
    if (court().step(now) === "scored") {
      swish();
      setTimeout(bounce, 720);
    }
  }
}
requestAnimationFrame(frame);

// ---- alpha, ten times a second ------------------------------------------
setInterval(() => {
  if (el("tabs").hidden) return;
  const now = performance.now();
  meter.update(now);

  if (calSamples) {
    if (!meter.artifact) {
      calSamples.alpha.push(meter.alpha);
      calSamples.beta.push(meter.beta);
    }
    const left = Math.max(0, calEndsAt - now);
    el("calbar-fill").style.width = `${100 - (left / (CAL_SECONDS * 1000)) * 100}%`;
    el("cal-note").textContent = `${calSamples.alpha.length} clean windows · in-band signal ${meter.lastSd.toFixed(0)} µV (needs under 150) · alpha ${(meter.alpha * 100).toFixed(0)}% · beta ${(
      meter.beta * 100
    ).toFixed(0)}%`;
    if (left <= 0) {
      // Short on clean windows? Keep listening rather than throwing away what we
      // have — a noisy first pass is a reason to wait longer, not to fail.
      if (calSamples.alpha.length < 10 && !calExtended) {
        calExtended = true;
        calEndsAt = now + 15000;
        el("cal-note").textContent = "Noisy start — listening a bit longer. Sit still, jaw slack, blink normally.";
        return;
      }
      const next = { alpha: baselineFrom(calSamples.alpha), beta: baselineFrom(calSamples.beta) };
      const collected = calSamples.alpha.length;
      calSamples = null;
      if (next.alpha && next.beta) {
        baselines = next;
        saveBaseline(next);
        courts.alpha.reset();
        courts.beta.reset();
        const b = next[band()];
        el("cal-note").textContent =
          `Calibrated on ${collected} windows. Alpha rests at ${(next.alpha.floor * 100).toFixed(0)}% and tops out near ${(next.alpha.ceiling * 100).toFixed(0)}%; ` +
          `beta rests at ${(next.beta.floor * 100).toFixed(0)}% and tops out near ${(next.beta.ceiling * 100).toFixed(0)}%.`;
        void b;
        if (el("sound").checked && view !== "scope") {
          resumeAudio();
          startTone();
        }
      } else {
        // Say what was actually wrong rather than just "failed".
        el("cal-note").textContent =
          `Not enough clean signal: ${collected} usable windows. AF7/AF8 were reading ${meter.lastSd.toFixed(0)} µV in the 5-30 Hz band ` +
          `(needs to stay under 150). Usually that's the reference pad in the middle of your forehead — wipe it and the AF7/AF8 pads with a damp finger, ` +
          `then sit still and try again.`;
        status("calibration failed", "bad");
      }
      showCalibrationState();
    }
    return;
  }

  if (view === "scope" || !baseline()) return;
  const share = meter[band()];
  const lift = liftFrom(share, baseline(), Number(el("sens").value));
  const c = court();
  c.setLift(lift, meter.artifact);
  if (el("sound").checked) setToneLift(lift);

  el("alpha-pct").textContent = `${(share * 100).toFixed(0)}%`;
  el("lift-pct").textContent = meter.artifact ? "held" : `${Math.round(lift * 100)}%`;
  el("baskets").textContent = c.score;
  el("zone-pct").textContent = c.totalMs > 1000 ? `${Math.round((c.zoneMs / c.totalMs) * 100)}%` : "—";
  el("used-chans").textContent = meter.used.length ? meter.used.map((i) => channelNames[i]).join(" + ") : "AF7/AF8 unusable";
}, 100);

// ---- the slower numbers --------------------------------------------------
const GRADE_LABEL = { good: "good", fair: "fair", poor: "poor", waiting: "…" };

setInterval(() => {
  if (el("tabs").hidden) return;

  const rows = [];
  channels.forEach((c, i) => {
    const q = c.measure(mainsHz);
    const name = channelNames[i] || `ch${i + 1}`;
    const dot = el(`e-${name}`);
    if (dot) dot.setAttribute("class", `e ${q.grade}`);
    rows.push(`
      <tr>
        <td class="mono">${name}</td>
        <td>${(EEG_CHARS.find((c2) => c2.name === name) || {}).where || "—"}</td>
        <td><span class="grade ${q.grade}">${GRADE_LABEL[q.grade]}</span></td>
        <td class="mono">${q.sd < 0.05 ? "—" : `${q.sd.toFixed(1)} µV`}</td>
        <td class="mono">${(q.mains * 100).toFixed(0)}%</td>
      </tr>`);
  });
  el("qrows").innerHTML = rows.join("");

  if (running) {
    const secs = Math.floor((Date.now() - startedAt) / 1000);
    el("elapsed").textContent = `${Math.floor(secs / 60)}:${String(secs % 60).padStart(2, "0")}`;
  }
  const pct = seen.total ? (seen.dropped / (seen.total + seen.dropped)) * 100 : 0;
  el("loss").textContent = seen.dropped ? `${seen.dropped} (${pct.toFixed(1)}%)` : "0";
  el("p-loss").className = `pill ${pct > 2 ? "warn" : ""}`;
}, 500);

// ---- browsers that can't do this at all ---------------------------------
if (!bluetoothAvailable()) {
  el("connect").disabled = true;
  el("gate-copy").innerHTML =
    "<b>This browser can't talk to Bluetooth devices.</b> Web Bluetooth exists only in Chrome and Edge on desktop — Safari, Firefox, and every iOS browser are out. The simulator below still works, so you can see what the display does.";
  status("unsupported browser", "bad");
}
showCalibrationState();
