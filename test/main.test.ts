// Pure logic from the main and sync processes.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import Path from "node:path";
import type Clip from "../src/shared/hueTypes";
import { normalizeBridgeId } from "../src/shared/bridgeId";
import { decodeSettings, encodeSettings } from "../src/shared/settingsCodec";
import { smoothingToRates, ratesToSmoothing } from "../src/shared/color/process";
import { SseParser } from "../src/main/hue/sse";
import ResourceStore, { deepMerge } from "../src/main/hue/ResourceStore";
import { selectAreas, selectRooms, selectSceneGroups, preferredArea } from "../src/main/hue/selectors";
import { LinkButtonNotPressed, defaultDeviceType, pairUntilPressed, parsePairingResponse } from "../src/main/hue/pairing";
import { parseGsrCaptureOptions, parseHyprctl, parseWfRecorderList, parseXrandrMonitors } from "../src/sync/capture/monitors";
import { FrameReader, layoutFor, parseStreamInfo } from "../src/sync/capture/FrameReader";

const fixture = (name: string) => fs.readFileSync(Path.join(__dirname, "../../test/fixtures", name), "utf8");

//#region Bridge id
test("bridge ids normalise to the 12-character form", () => {
  assert.equal(normalizeBridgeId("C42996FFFECA8B7A"), "c42996ca8b7a");
  assert.equal(normalizeBridgeId("c42996ca8b7a"), "c42996ca8b7a");
  assert.equal(normalizeBridgeId("001788FFFE27ADBF"), "00178827adbf");
});
//#endregion

//#region Settings
test("v1 settings decode unchanged and round-trip with unknown keys", () => {
  const raw = JSON.parse(fixture("settings-v1.json"));
  const decoded = decodeSettings(raw);
  assert.equal(decoded.settings.bridgeHost, raw.bridge_host);
  assert.equal(decoded.settings.sync.brightness, raw.sync.brightness);
  assert.equal(decoded.settings.sync.saturation, raw.sync.saturation);
  assert.equal(decoded.settings.sync.captureBackend, "auto");
  const encoded = encodeSettings(decoded) as { sync: Record<string, unknown> };
  // v1's restore token survives, so going back to v1 keeps the remembered screen.
  assert.ok("screencast_restore_token" in encoded.sync);
  assert.deepEqual(decodeSettings(encoded).settings, decoded.settings);
});

test("bad settings fall back and clamp", () => {
  const { settings } = decodeSettings({ close_to_tray: "yes", sync: { brightness: 9, target_fps: -1, capture_backend: "magic" } });
  assert.equal(settings.closeToTray, true);
  assert.equal(settings.sync.brightness, 1.5);
  assert.equal(settings.sync.targetFps, 1);
  assert.equal(settings.sync.captureBackend, "auto");
  assert.equal(decodeSettings("not json").settings.sync.gridWidth, 64);
});

test("smoothing slider maps to attack/decay and back", () => {
  assert.deepEqual(smoothingToRates(0.3), { attack: 0.7, decay: 0.175 });
  assert.equal(smoothingToRates(0.99).attack, 0.05);
  assert.ok(Math.abs(ratesToSmoothing(0.7) - 0.3) < 1e-9);
});
//#endregion

//#region SSE
test("SSE parser handles every chunk boundary", () => {
  const stream = ": hi\r\nid: 1\r\ndata: [{\"a\":1}]\r\n\r\nevent: x\ndata: line1\ndata: line2\n\n";
  const expected = [
    { id: "1", event: "message", data: "[{\"a\":1}]" },
    { id: "1", event: "x", data: "line1\nline2" },
  ];
  for (let cut = 0; cut <= stream.length; cut++) {
    const parser = new SseParser();
    const events = [...parser.push(stream.slice(0, cut)), ...parser.push(stream.slice(cut))];
    assert.deepEqual(events, expected, `cut at ${cut}`);
  }
});

test("SSE parser handles UTF-8 split across chunks", () => {
  const bytes = Buffer.from("data: Stue ☀\n\n");
  const parser = new SseParser();
  const events = [...parser.push(bytes.subarray(0, 12)), ...parser.push(bytes.subarray(12))];
  assert.equal(events[0].data, "Stue ☀");
});
//#endregion

//#region Store
test("store merges objects deeply, replaces arrays and honours null", () => {
  assert.deepEqual(deepMerge({ a: { b: 1, c: 2 }, l: [1, 2] }, { a: { b: 3 }, l: [9] }), { a: { b: 3, c: 2 }, l: [9] });
  const store = new ResourceStore();
  store.reset([{ id: "e", type: "entertainment_configuration", status: "active", active_streamer: { rid: "x", rtype: "auth" } }]);
  store.apply([{ type: "update", data: [{ id: "e", type: "entertainment_configuration", status: "inactive", active_streamer: null }] }]);
  const area = store.get<Clip.EntertainmentConfiguration>("e")!;
  assert.equal(area.status, "inactive");
  assert.equal(area.active_streamer, null);
  store.apply([{ type: "delete", data: [{ id: "e", type: "entertainment_configuration" }] }]);
  assert.equal(store.size, 0);
});
//#endregion

//#region Selectors
function demoStore(): ResourceStore {
  const store = new ResourceStore();
  store.reset([
    { id: "room1", type: "room", metadata: { name: "office" }, children: [{ rid: "dev1", rtype: "device" }], services: [{ rid: "gl1", rtype: "grouped_light" }] },
    { id: "room0", type: "room", metadata: { name: "Empty" }, children: [] },
    { id: "dev1", type: "device", services: [{ rid: "l1", rtype: "light" }, { rid: "zc1", rtype: "zigbee_connectivity" }] },
    { id: "dev2", type: "device", services: [{ rid: "l2", rtype: "light" }] },
    { id: "zc1", type: "zigbee_connectivity", owner: { rid: "dev1", rtype: "device" }, status: "connectivity_issue" },
    { id: "l1", type: "light", owner: { rid: "dev1", rtype: "device" }, metadata: { name: "Desk" }, on: { on: true }, dimming: { brightness: 40.4 }, color: { xy: { x: 0.6, y: 0.3 }, gamut_type: "C" } },
    { id: "l2", type: "light", owner: { rid: "dev2", rtype: "device" }, metadata: { name: "Plug" }, on: { on: false } },
    { id: "s1", type: "scene", metadata: { name: "Relax" }, group: { rid: "room1", rtype: "room" }, actions: [{ target: { rid: "l1", rtype: "light" }, action: { color_temperature: { mirek: 400 }, dimming: { brightness: 50 } } }], status: { active: "static" } },
    { id: "e1", type: "entertainment_configuration", metadata: { name: "Office" }, configuration_type: "screen", status: "inactive", channels: [{ channel_id: 1, position: { x: 1, y: -1, z: 0 } }, { channel_id: 0, position: { x: -1, y: null, z: 0 } }] },
  ]);
  return store;
}

test("rooms group lights, hide empty rooms and collect the rest", () => {
  const rooms = selectRooms(demoStore());
  assert.deepEqual(rooms.map((r) => r.name), ["office", "Other lights"]);
  const desk = rooms[0].lights[0];
  assert.equal(desk.brightness, 40);
  assert.equal(desk.reachable, false);
  assert.equal(rooms[0].groupedLightId, "gl1");
  assert.equal(rooms[1].lights[0].brightness, null);
});

test("scene active state and palette come from live data", () => {
  const store = demoStore();
  assert.equal(selectSceneGroups(store)[0].scenes[0].active, true);
  store.apply([{ type: "update", data: [{ id: "s1", type: "scene", status: { active: "inactive" } }] }]);
  const scene = selectSceneGroups(store)[0].scenes[0];
  assert.equal(scene.active, false);
  assert.equal(scene.palette.length, 1);
});

test("areas sort channels and fill missing positions", () => {
  const areas = selectAreas(demoStore());
  assert.deepEqual(areas[0].channels.map((c) => c.id), [0, 1]);
  assert.equal(areas[0].channels[0].y, 0);
  assert.equal(preferredArea(areas)?.id, "e1");
});
//#endregion

//#region Pairing
test("pairing response parsing", () => {
  assert.deepEqual(parsePairingResponse([{ success: { username: "u", clientkey: "K" } }]), { appKey: "u", clientKey: "K" });
  assert.throws(() => parsePairingResponse([{ error: { type: 101 } }]), LinkButtonNotPressed);
  assert.throws(() => parsePairingResponse([{ success: { username: "u" } }]), /1\.22/);
  for (const bad of [[], {}, [null], ["x"], [{}]]) assert.throws(() => parsePairingResponse(bad));
});

test("device type respects the bridge's length limits", () => {
  const [app, device] = defaultDeviceType("averyveryverylongapplicationname").split("#");
  assert.ok(app.length <= 20 && device.length <= 19);
});

test("pairing loop retries on 101, then succeeds", async () => {
  let calls = 0;
  const result = await pairUntilPressed({
    host: "h", intervalMs: 1, timeoutMs: 1000,
    attempt: async () => {
      if (++calls < 3) throw new LinkButtonNotPressed();
      return { credentials: { appKey: "a", clientKey: "b" }, fingerprint: null };
    },
  }, new AbortController().signal);
  assert.equal(calls, 3);
  assert.equal(result.credentials.appKey, "a");
});

test("pairing loop discards a success that arrives after the deadline", async () => {
  let clock = 0;
  await assert.rejects(pairUntilPressed({
    host: "h", intervalMs: 1, timeoutMs: 100, now: () => clock,
    attempt: async () => {
      clock = 500; // The attempt took longer than the whole budget
      return { credentials: { appKey: "a", clientKey: "b" }, fingerprint: null };
    },
  }, new AbortController().signal), /Timed out/);
});

test("pairing loop stops on abort", async () => {
  const abort = new AbortController();
  const run = pairUntilPressed({
    host: "h", intervalMs: 50, timeoutMs: 10000,
    attempt: async () => {
      throw new LinkButtonNotPressed();
    },
  }, abort.signal);
  abort.abort(new Error("cancelled"));
  await assert.rejects(run, /cancelled/);
});
//#endregion

//#region Capture parsing
test("monitor listings parse", () => {
  const hypr = parseHyprctl(fixture("hyprctl-monitors.json"));
  assert.deepEqual(hypr.map((m) => m.id), ["DP-1", "DP-2", "DP-3"]);
  // DP-2 is rotated, so its visible size swaps.
  assert.deepEqual([hypr[1].width, hypr[1].height], [1080, 1920]);

  const wf = parseWfRecorderList("1. Name: DP-1 Description: BNQ ZOWIE XL LCD X (DP-1)\n2. Name: DP-2 Description: Acer (DP-2)\n");
  assert.deepEqual(wf.map((m) => [m.id, m.name]), [["DP-1", "BNQ ZOWIE XL LCD X (DP-1)"], ["DP-2", "Acer (DP-2)"]]);

  const gsr = parseGsrCaptureOptions("DP-1|1920x1080\nDP-2|1080x1920\nregion\nportal\n");
  assert.deepEqual(gsr.map((m) => [m.id, m.width, m.height]), [["DP-1", 1920, 1080], ["DP-2", 1080, 1920]]);

  const x = parseXrandrMonitors("Monitors: 2\n 0: +*DP-1 1920/527x1080/296+0+0  DP-1\n 1: +HDMI-1 2560/597x1440/336+1920+0  HDMI-1\n");
  assert.deepEqual(x.map((m) => [m.id, m.width, m.height, m.x, m.focused]), [["DP-1", 1920, 1080, 0, true], ["HDMI-1", 2560, 1440, 1920, false]]);
});

test("ffmpeg banner gives the output pixel format", () => {
  const banner = "Input #0, ...\n  Stream #0:0: Video: rawvideo (RGB[24]), rgb24, 1920x1080\nOutput #0, rawvideo, to '/dev/stdout':\n  Stream #0:0: Video: rawvideo (BGR[0] / 0x524742), bgr0(pc), 64x36 [SAR 1:1 DAR 16:9], q=2-31\n";
  assert.deepEqual(parseStreamInfo(banner), { format: "bgr0", width: 64, height: 36 });
  assert.equal(parseStreamInfo("Input #0 only"), null);
  assert.deepEqual(layoutFor("rgb24"), { format: "rgb24", bytesPerPixel: 3, r: 0, g: 1, b: 2 });
});

test("frame reader reassembles frames split anywhere", () => {
  const frames: number[][] = [];
  const reader = new FrameReader(2, 1, (frame) => frames.push([...frame]), layoutFor("bgr0"));
  const data = Buffer.from([1, 2, 3, 0, 4, 5, 6, 0, 7, 8, 9, 0, 10, 11, 12, 0]);
  reader.pushStdout(data.subarray(0, 3));
  reader.pushStdout(data.subarray(3, 11));
  reader.pushStdout(data.subarray(11));
  assert.deepEqual(frames, [[1, 2, 3, 0, 4, 5, 6, 0], [7, 8, 9, 0, 10, 11, 12, 0]]);
});

test("frame reader waits for the banner before interpreting data", () => {
  const sizes: number[] = [];
  const reader = new FrameReader(2, 1, (frame) => sizes.push(frame.length));
  reader.pushStdout(Buffer.alloc(6));
  assert.deepEqual(sizes, []);
  reader.pushStderr("Output #0, rawvideo:\n  Stream #0:0: Video: rawvideo, rgb24, 2x1\n");
  assert.deepEqual(sizes, [6]);
  reader.dispose();
});
//#endregion
