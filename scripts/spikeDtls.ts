// DTLS go/no-go spike: can node-dtls-client, running on Electron's BoringSSL,
// hold a Hue Entertainment stream as well as v1's OpenSSL crate did?
//
// Usage (credentials JSON holds {"app_key","client_key"}):
//   ELECTRON_RUN_AS_NODE=1 electron scripts/spikeDtls.ts <host> <areaId> <creds.json> [cycles] [seconds]
import fs from "node:fs";
import https from "node:https";
import { dtls } from "node-dtls-client";

const [host, areaId, credsPath, cyclesArg = "5", secondsArg = "5"] = process.argv.slice(2);
if (!host || !areaId || !credsPath) {
  console.error("Usage: spikeDtls.ts <host> <areaId> <creds.json> [cycles] [seconds]");
  process.exit(2);
}
const creds = JSON.parse(fs.readFileSync(credsPath, "utf8")) as { app_key: string; client_key: string };
const cycles = parseInt(cyclesArg);
const seconds = parseFloat(secondsArg);
const FPS = 60;

function clip(method: string, path: string, body?: unknown): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const req = https.request({
      host, path, method, rejectUnauthorized: false,
      headers: { "hue-application-key": creds.app_key, "content-type": "application/json" },
    }, (res) => {
      let data = "";
      res.on("data", (c) => data += c);
      res.on("end", () => resolve(JSON.parse(data || "null")));
    });
    req.on("error", reject);
    req.end(body === undefined ? undefined : JSON.stringify(body));
  });
}

function connect(): Promise<{ socket: dtls.Socket; ms: number }> {
  const started = performance.now();
  return new Promise((resolve, reject) => {
    const socket = dtls.createSocket({
      type: "udp4", address: host, port: 2100,
      psk: { [creds.app_key]: Buffer.from(creds.client_key, "hex") },
      ciphers: ["TLS_PSK_WITH_AES_128_GCM_SHA256"],
      timeout: 10000,
    });
    socket.once("connected", () => resolve({ socket, ms: performance.now() - started }));
    socket.once("error", reject);
  });
}

function frame(seq: number, channels: number[], hue: number): Buffer {
  const buf = Buffer.alloc(52 + 7 * channels.length);
  buf.write("HueStream", 0, "ascii");
  buf[9] = 2; buf[11] = seq & 0xff;
  buf.write(areaId, 16, "ascii");
  channels.forEach((id, i) => {
    // Simple hue sweep, offset per channel so the lamps differ.
    const h = (hue + i / channels.length) % 1;
    const rgb = [0, 1 / 3, 2 / 3].map((o) => Math.max(0, Math.cos((h - o) * Math.PI * 2)));
    const at = 52 + 7 * i;
    buf[at] = id;
    rgb.forEach((c, j) => buf.writeUInt16BE(Math.round(c * 65535), at + 1 + j * 2));
  });
  return buf;
}

async function cycle(n: number, channels: number[]): Promise<void> {
  await clip("PUT", `/clip/v2/resource/entertainment_configuration/${areaId}`, { action: "start" });
  let attempt = 0;
  let conn: { socket: dtls.Socket; ms: number } | null = null;
  while (!conn) {
    try {
      conn = await connect();
    } catch (error) {
      if (++attempt >= 2) throw error;
      await new Promise((r) => setTimeout(r, 300));
    }
  }
  const { socket, ms } = conn;
  let sendErrors = 0;
  const intervals: number[] = [];
  const start = performance.now();
  const interval = 1000 / FPS;
  let sent = 0;
  let last = start;
  await new Promise<void>((resolve) => {
    const tick = () => {
      const now = performance.now();
      if (sent > 0) intervals.push(now - last);
      last = now;
      socket.send(frame(sent, channels, (now - start) / 3000), (err) => { if (err) sendErrors++; });
      sent++;
      if (now - start >= seconds * 1000) return resolve();
      setTimeout(tick, Math.max(0, start + sent * interval - performance.now()));
    };
    tick();
  });
  socket.close();
  await clip("PUT", `/clip/v2/resource/entertainment_configuration/${areaId}`, { action: "stop" });
  intervals.sort((a, b) => a - b);
  const p99 = intervals[Math.floor(intervals.length * 0.99)];
  const fps = sent / ((performance.now() - start) / 1000);
  console.log(`cycle ${n}: handshake ${ms.toFixed(0)}ms (attempts ${attempt + 1}), sent ${sent}, ${fps.toFixed(1)} fps, p99 ${p99.toFixed(1)}ms, send errors ${sendErrors}`);
}

const area = await clip("GET", `/clip/v2/resource/entertainment_configuration/${areaId}`) as { data: { channels: { channel_id: number }[] }[] };
const channels = area.data[0].channels.map((c) => c.channel_id);
console.log(`runtime: node ${process.versions.node}, electron ${process.versions.electron ?? "-"}; channels ${channels.join(",")}`);
for (let i = 1; i <= cycles; i++) {
  await cycle(i, channels);
}
const after = await clip("GET", `/clip/v2/resource/entertainment_configuration/${areaId}`) as { data: { status: string }[] };
console.log(`area status after: ${after.data[0].status}`);
