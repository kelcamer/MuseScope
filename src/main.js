// ---------------------------------------------------------------------------
// Muse Scope — connect a Muse S over Web Bluetooth, watch the four EEG
// channels, and check each electrode is actually making contact.
//
// No framework on purpose: 4 channels × 256 Hz is a stream, not application
// state, so samples go straight into ring buffers and the canvas redraws on
// requestAnimationFrame. Only the numbers around the edges touch the DOM, twice
// a second.
// ---------------------------------------------------------------------------

import { MuseClient, bluetoothAvailable, CHANNELS, EEG_CHARS, SAMPLES_PER_PACKET } from "./muse.js";
import { ChannelState } from "./signal.js";
import { Scope } from "./scope.js";
import "./styles.css";

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
    </section>

    <section class="panel panel--scope" id="live" hidden>
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
            <tr><th>Electrode</th><th>Where</th><th>Contact</th><th>Amplitude</th><th>Mains</th></tr>
          </thead>
          <tbody id="qrows"></tbody>
        </table>
      </div>

      <p class="note">
        Contact grades are computed here, not read from the headband — Muse's own fit indicator lives in the native SDK and isn't exposed over
        Bluetooth. A <b>poor</b> grade means the electrode is railing, flat, or picking up more mains hum than brain: wet the contact points
        slightly, push hair out of the way, and reseat the band. Filtering affects only what you see; every number in this table comes from raw
        microvolts.
      </p>
      <p class="note">
        Something to try once all four are green: close your eyes and stay still for ten seconds. Alpha rhythm around 10 Hz should swell — the
        traces get visibly rounder and bigger. Open your eyes and it collapses. That's the oldest result in EEG, on your own head.
      </p>
    </section>
  </main>

  <footer>
    <p class="note">
      Unofficial. InteraXon publishes no Bluetooth spec; this follows the community protocol that <code>muse-js</code> established, so a firmware
      update could break it. Chrome or Edge on desktop only — Safari and Firefox don't implement Web Bluetooth, and neither does any iOS browser.
      Nothing leaves this page: no upload, no storage, no account.
    </p>
  </footer>
`;

const el = (id) => document.getElementById(id);
const channels = CHANNELS.map(() => new ChannelState());
const scope = new Scope(el("scope"));

const seen = { expected: CHANNELS.map(() => null), dropped: 0, total: 0 };
let mainsHz = 60;
let startedAt = 0;
let running = false;
let demo = null;

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
  el("live").hidden = !on;
}

// ---- sample intake -------------------------------------------------------
function onSamples(channelIndex, samples, seq) {
  const state = channels[channelIndex];
  for (let i = 0; i < SAMPLES_PER_PACKET; i++) state.push(samples[i]);

  // Packet counters run +1 per notification per channel. A jump means the
  // radio lost packets — worth showing, because it silently costs you data.
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

const client = new MuseClient({
  onSamples,
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
  } catch (err) {
    const msg = String(err && err.message ? err.message : err);
    if (/cancel/i.test(msg)) {
      el("gate-note").textContent = "No device picked.";
    } else if (/globally disabled|bluetooth adapter|not available/i.test(msg)) {
      el("gate-note").textContent =
        "Chrome can't reach Bluetooth. On macOS, allow it in System Settings → Privacy & Security → Bluetooth, then restart Chrome.";
    } else {
      el("gate-note").textContent = msg;
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

el("scale").addEventListener("change", (e) => scope.setScale(Number(e.target.value)));
el("notch").addEventListener("change", (e) => setNotch(e.target.checked));
el("mains").addEventListener("change", (e) => {
  mainsHz = Number(e.target.value);
  setNotch(el("notch").checked);
});

// ---- a synthetic headband, so the display can be checked without hardware ---
function stopDemo() {
  if (demo) clearInterval(demo);
  demo = null;
}

el("demo").addEventListener("click", () => {
  stopDemo();
  showLive(true);
  startedAt = Date.now();
  running = true;
  status("simulated — no headband", "warn");
  el("device").textContent = "simulator";
  el("battery").textContent = "—";
  el("pause").disabled = true;

  let t = 0;
  const buf = new Float32Array(SAMPLES_PER_PACKET);
  // one packet per channel every ~47ms, the real cadence at 256 Hz / 12 samples
  demo = setInterval(() => {
    for (let c = 0; c < CHANNELS.length; c++) {
      for (let i = 0; i < SAMPLES_PER_PACKET; i++) {
        const s = (t + i) / 256;
        const alpha = 18 * Math.sin(2 * Math.PI * 10.2 * s) * (0.5 + 0.5 * Math.sin(2 * Math.PI * 0.15 * s));
        const theta = 9 * Math.sin(2 * Math.PI * 5.5 * s + c);
        const noise = (Math.random() - 0.5) * 12;
        // the last electrode is deliberately bad, so the contact check has
        // something to catch: heavy mains pickup
        const hum = (c === 3 ? 55 : 4) * Math.sin(2 * Math.PI * mainsHz * s);
        buf[i] = alpha + theta + noise + hum + 40 * Math.sin(2 * Math.PI * 0.05 * s);
      }
      onSamples(c, buf, (t / SAMPLES_PER_PACKET) & 0xffff);
    }
    t += SAMPLES_PER_PACKET;
  }, (SAMPLES_PER_PACKET / 256) * 1000);
});

// ---- render loops --------------------------------------------------------
const GRADE_LABEL = { good: "good", fair: "fair", poor: "poor", waiting: "…" };

function frame() {
  requestAnimationFrame(frame);
  if (el("live").hidden) return;
  scope.draw(channels, channels.map((c) => c.quality.grade));
}
requestAnimationFrame(frame);

// numbers update twice a second — fast enough to be live, slow enough to read
setInterval(() => {
  if (el("live").hidden) return;

  const rows = [];
  channels.forEach((c, i) => {
    const q = c.measure(mainsHz);
    const dot = el(`e-${CHANNELS[i]}`);
    if (dot) dot.setAttribute("class", `e ${q.grade}`);
    rows.push(`
      <tr>
        <td class="mono">${CHANNELS[i]}</td>
        <td>${EEG_CHARS[i].where}</td>
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
