# 🧠 Muse Scope

Connect a Muse S headband from the browser and watch the raw four-channel EEG,
with a per-electrode contact check so you know whether what you're looking at is
brain or hum.

No install, no native app, no account. Chrome talks to the headband directly over
Bluetooth Low Energy.

**Live:** https://kelcamer.github.io/MuseScope/

## What it shows

| | |
|---|---|
| **Four traces** | TP9 and TP10 (behind the ears), AF7 and AF8 (forehead), 256 Hz each, over a rolling 4-second window |
| **Contact grade** | good / fair / poor per electrode, drawn on a head diagram and broken out in a table |
| **Amplitude** | signal standard deviation in µV, per electrode |
| **Mains** | how much of each channel's power sits at 50/60 Hz — the best single tell for a bad contact |
| **Dropped packets** | counted from the headband's own packet counters, so you can see the radio struggling |
| **Battery** | from the telemetry channel |

There's also a **Simulate a signal** button that feeds the display synthetic EEG
(with one deliberately bad electrode), so the whole thing can be checked with no
hardware present.

## Requirements

- **Chrome or Edge on desktop.** Web Bluetooth doesn't exist in Safari or
  Firefox, or in any iOS browser.
- **HTTPS**, which the live link above satisfies.
- **A click to pair.** A page cannot open the Bluetooth chooser by itself, so
  every session starts with the Connect button.
- **The headband awake** — press its button once so it advertises.
- On macOS, Chrome needs Bluetooth permission: System Settings → Privacy &
  Security → Bluetooth.

Keep the tab visible during a long session. Background tabs get throttled, which
shows up as dropped packets.

## This is unofficial

InteraXon publishes no Bluetooth specification. The official SDK is native
iOS/Android. Everything in `src/muse.js` follows the community reverse
engineering that [`muse-js`](https://github.com/urish/muse-js) (MIT) established
and that has been stable across Muse 2016 / 2 / S firmware for years — but a
vendor firmware update could break it, and that's the first thing to suspect if
it ever stops connecting.

## About the contact grades

Muse's own headband-status indicator is only exposed through the native SDK, so
these grades are computed here from the raw signal:

1. **Railing** — a dry electrode that isn't touching skin swings to the ADC
   limits.
2. **Mains pickup** — poor contact impedance turns the lead into an antenna, so
   50/60 Hz power as a share of total power is the most trustworthy indicator.
3. **Flatline or wild drift** — near-zero variance means nothing is connected;
   enormous variance means movement, sweat, or hair in the way.

The thresholds are judgement calls checked against synthesized signals, not
against a clinical reference. Treat them as a fit aid, not a measurement.

Display filtering (a ~0.4 Hz high-pass, plus an optional 60 Hz notch) affects
only the traces. Every number in the table is computed from raw microvolts.

## Try this

With all four electrodes green: close your eyes, hold still for ten seconds.
Alpha rhythm near 10 Hz should swell and the traces get visibly rounder. Open
your eyes and it collapses. Oldest result in EEG, on your own head.

Note the electrode positions, though — frontal and temporal, nothing occipital.
The Muse cannot look at visual cortex.

## Run it

```bash
npm install
npm run build      # outputs to dist/
```

Push to `main` and GitHub Actions deploys to Pages. There is no dev-server
script on purpose: Web Bluetooth needs a secure context, and the live page is
the place to check it.

## Layout

```
src/
├── main.js      # DOM, controls, connect flow, the simulator
├── muse.js      # BLE service/characteristic UUIDs, commands, packet decoding
├── signal.js    # ring buffers, display filters, Goertzel, contact grading
├── scope.js     # canvas renderer, four lanes, min/max per pixel column
└── styles.css
```

Not a medical device. It draws a signal; it doesn't diagnose anything.
