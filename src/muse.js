// ---------------------------------------------------------------------------
// Muse BLE client (Web Bluetooth).
//
// The Muse protocol is NOT documented by InteraXon — their official SDK is
// native iOS/Android only. Everything here follows the community
// reverse-engineering that `muse-js` (Uri Shaked, MIT) established and that has
// been stable across Muse 2016 / 2 / S firmware for years. A vendor firmware
// update could in principle change it; if this file ever stops working, that's
// the first thing to suspect.
//
// Requires Chrome or Edge (Web Bluetooth), served over HTTPS, and a user
// gesture — a page cannot open the device chooser on its own.
// ---------------------------------------------------------------------------

export const MUSE_SERVICE = "0000fe8d-0000-1000-8000-00805f9b34fb";

const CHAR = {
  control: "273e0001-4c4d-454d-96be-f03bab8a9e01",
  telemetry: "273e000b-4c4d-454d-96be-f03bab8a9e01",
};

// The four scalp electrodes, in the order they're drawn. TP9/TP10 sit behind
// the ears, AF7/AF8 on the forehead. (A fifth channel, 273e0007, is the AUX
// port — unused on a bare headband, so it isn't subscribed.)
export const EEG_CHARS = [
  { name: "TP9", uuid: "273e0003-4c4d-454d-96be-f03bab8a9e01", where: "left ear" },
  { name: "AF7", uuid: "273e0004-4c4d-454d-96be-f03bab8a9e01", where: "left forehead" },
  { name: "AF8", uuid: "273e0005-4c4d-454d-96be-f03bab8a9e01", where: "right forehead" },
  { name: "TP10", uuid: "273e0006-4c4d-454d-96be-f03bab8a9e01", where: "right ear" },
];

export const CHANNELS = EEG_CHARS.map((c) => c.name);
export const SAMPLE_RATE = 256; // Hz, per channel
export const SAMPLES_PER_PACKET = 12;

// 12-bit unsigned ADC counts → microvolts. 0x800 is mid-rail (0 µV).
const SCALE_UV = 0.48828125;
const MID = 0x800;

// Preset chosen at stream start. p21 = EEG only, which is all this app reads.
// p50 additionally turns on the PPG (heart) channels on Muse 2 / Muse S — flip
// this and subscribe to 273e000f/10/11 when someone wants heart rate.
const PRESET = "p21";

// Commands go out as [length, ...ascii, '\n'] where length counts the ascii
// plus the newline. "d" (start) becomes [0x02, 0x64, 0x0a].
function encodeCommand(cmd) {
  const body = new TextEncoder().encode(`${cmd}\n`);
  const out = new Uint8Array(body.length + 1);
  out[0] = body.length;
  out.set(body, 1);
  return out;
}

/**
 * Decode one 20-byte EEG notification: a 16-bit packet counter followed by 12
 * samples packed as 12-bit big-endian values (2 + 18 = 20 bytes).
 *
 * Because the samples start on a byte boundary, each one is either aligned to a
 * byte or offset by half of one — so there are only two cases, not eight.
 */
export function decodeEeg(view, out) {
  const seq = view.getUint16(0);
  let bit = 16;
  for (let i = 0; i < SAMPLES_PER_PACKET; i++) {
    const byte = bit >> 3;
    const raw =
      (bit & 7) === 0
        ? (view.getUint8(byte) << 4) | (view.getUint8(byte + 1) >> 4)
        : ((view.getUint8(byte) & 0x0f) << 8) | view.getUint8(byte + 1);
    out[i] = (raw - MID) * SCALE_UV;
    bit += 12;
  }
  return seq;
}

// Telemetry notification: packet counter, battery, fuel-gauge voltage, temp.
function decodeTelemetry(view) {
  return {
    battery: view.getUint16(2) / 512, // percent
    voltage: view.getUint16(4) * 2.2, // mV
    tempC: view.getUint16(8),
  };
}

export function bluetoothAvailable() {
  return typeof navigator !== "undefined" && !!navigator.bluetooth;
}

export class MuseClient {
  // onSamples(channelIndex, Float32Array(12), seq) is called ~21×/s per channel.
  constructor({ onSamples, onTelemetry, onStatus, onDeviceInfo, onDisconnect } = {}) {
    this.onSamples = onSamples || (() => {});
    this.onTelemetry = onTelemetry || (() => {});
    this.onStatus = onStatus || (() => {});
    this.onDeviceInfo = onDeviceInfo || (() => {});
    this.onDisconnect = onDisconnect || (() => {});
    this.device = null;
    this.gatt = null;
    this.control = null;
    this.streaming = false;
    this._scratch = new Float32Array(SAMPLES_PER_PACKET);
    this._infoBuffer = "";
    this._onGattDisconnect = () => {
      this.streaming = false;
      this.onDisconnect();
    };
  }

  async connect() {
    if (!bluetoothAvailable()) throw new Error("This browser has no Web Bluetooth. Use Chrome or Edge on desktop.");
    this.onStatus("waiting for you to pick the headband…");
    this.device = await navigator.bluetooth.requestDevice({
      filters: [{ services: [MUSE_SERVICE] }],
      optionalServices: [MUSE_SERVICE],
    });
    this.device.addEventListener("gattserverdisconnected", this._onGattDisconnect);

    this.onStatus("connecting…");
    this.gatt = await this.device.gatt.connect();
    const service = await this.gatt.getPrimaryService(MUSE_SERVICE);

    this.control = await service.getCharacteristic(CHAR.control);
    await this.control.startNotifications();
    this.control.addEventListener("characteristicvaluechanged", (e) => this._readControl(e.target.value));

    for (let i = 0; i < EEG_CHARS.length; i++) {
      const ch = await service.getCharacteristic(EEG_CHARS[i].uuid);
      await ch.startNotifications();
      ch.addEventListener("characteristicvaluechanged", (e) => {
        const seq = decodeEeg(e.target.value, this._scratch);
        this.onSamples(i, this._scratch, seq);
      });
    }

    try {
      const tel = await service.getCharacteristic(CHAR.telemetry);
      await tel.startNotifications();
      tel.addEventListener("characteristicvaluechanged", (e) => this.onTelemetry(decodeTelemetry(e.target.value)));
    } catch {
      /* telemetry is a nice-to-have; a headband that won't give it still streams EEG */
    }

    this.onStatus("connected");
    return this.device.name || "Muse";
  }

  // The control characteristic answers 'v1' and 's' with JSON split across
  // several notifications, each prefixed by its own length byte. Reassemble by
  // counting braces rather than assuming one message per packet.
  _readControl(view) {
    let text = "";
    for (let i = 1; i < view.byteLength; i++) text += String.fromCharCode(view.getUint8(i));
    this._infoBuffer += text.replace(/\n/g, "");
    const start = this._infoBuffer.indexOf("{");
    if (start < 0) {
      this._infoBuffer = "";
      return;
    }
    let depth = 0;
    for (let i = start; i < this._infoBuffer.length; i++) {
      if (this._infoBuffer[i] === "{") depth++;
      else if (this._infoBuffer[i] === "}") depth--;
      if (depth === 0) {
        const chunk = this._infoBuffer.slice(start, i + 1);
        this._infoBuffer = this._infoBuffer.slice(i + 1);
        try {
          this.onDeviceInfo(JSON.parse(chunk));
        } catch {
          /* a partial or unexpected payload — drop it, this is only decoration */
        }
        return;
      }
    }
    if (this._infoBuffer.length > 2048) this._infoBuffer = ""; // never grow without bound
  }

  async _send(cmd) {
    if (!this.control) return;
    await this.control.writeValue(encodeCommand(cmd));
  }

  async start() {
    await this._send("h"); // halt first — the headband may already be streaming
    await this._send(PRESET);
    await this._send("s"); // ask for status, so onDeviceInfo can report firmware
    await this._send("d"); // and go
    this.streaming = true;
    this.onStatus("streaming");
  }

  async stop() {
    await this._send("h");
    this.streaming = false;
    this.onStatus("paused");
  }

  async deviceInfo() {
    await this._send("v1");
  }

  disconnect() {
    if (this.device) this.device.removeEventListener("gattserverdisconnected", this._onGattDisconnect);
    if (this.gatt && this.gatt.connected) this.gatt.disconnect();
    this.streaming = false;
    this.device = null;
    this.gatt = null;
    this.control = null;
    this.onStatus("disconnected");
  }
}
