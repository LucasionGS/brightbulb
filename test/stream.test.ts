// Behaviours pinned by v1's test suite, ported to node:test.
import { test } from "node:test";
import assert from "node:assert/strict";
import { buildFrame, HueStreamFrame, MAX_CHANNELS, rgbChannels } from "../src/shared/stream/protocol";
import { ScreenMapper } from "../src/shared/stream/ScreenMapper";
import { ColorProcessor, SRGB_TO_LINEAR, toSrgb, toU16 } from "../src/shared/color/process";
import { clampToGamut, GAMUT_B, rgbToXy, xyToRgb } from "../src/shared/color/convert";

const AREA = "769f2d58-23ed-442e-9579-4921bc53310d";

//#region Protocol
test("header layout", () => {
  const frame = buildFrame(AREA, [[3, 1, 2, 3]], 7);
  assert.equal(frame.length, 52 + 7);
  assert.equal(frame.subarray(0, 9).toString("ascii"), "HueStream");
  assert.deepEqual([...frame.subarray(9, 16)], [2, 0, 7, 0, 0, 0, 0]);
  assert.equal(frame.subarray(16, 52).toString("ascii"), AREA);
  assert.deepEqual([...frame.subarray(52)], [3, 0, 1, 0, 2, 0, 3]);
});

test("sequence wraps at one byte", () => {
  assert.equal(buildFrame(AREA, [], 256 + 5)[11], 5);
});

test("rejects too many channels and malformed ids", () => {
  const channels = Array.from({ length: MAX_CHANNELS + 1 }, (_, i) => [i, 0, 0, 0] as [number, number, number, number]);
  assert.throws(() => buildFrame(AREA, channels));
  assert.throws(() => buildFrame("short", []));
});

test("values clamp instead of wrapping", () => {
  const frame = new HueStreamFrame(AREA, [0]);
  frame.write(0, [70000, -5, NaN]);
  assert.deepEqual([...frame.buffer.subarray(53)], [0xff, 0xff, 0, 0, 0, 0]);
  assert.deepEqual(rgbChannels([[1, [2, -1, NaN]]]), [[1, 65535, 0, 0]]);
});
//#endregion

//#region Mapper
function solidFrame(w: number, h: number, paint: (u: number, v: number) => [number, number, number]): Float32Array {
  const frame = new Float32Array(w * h * 3);
  for (let j = 0; j < h; j++) {
    for (let i = 0; i < w; i++) {
      frame.set(paint((i + 0.5) / w, (j + 0.5) / h), (j * w + i) * 3);
    }
  }
  return frame;
}

test("left and right channels follow their own side", () => {
  const mapper = new ScreenMapper([
    { channelId: 0, x: -1, y: -1, z: 0 },
    { channelId: 1, x: 1, y: -1, z: 0 },
  ], 32, 18);
  const out = mapper.sample(solidFrame(32, 18, (u) => (u < 0.5 ? [1, 0, 0] : [0, 0, 1])));
  assert.ok(out[0] > out[2], "left is red");
  assert.ok(out[5] > out[3], "right is blue");
});

test("top channels read the top of the screen", () => {
  const mapper = new ScreenMapper([{ channelId: 0, x: 0, y: -1, z: 1 }], 32, 18);
  const out = mapper.sample(solidFrame(32, 18, (_u, v) => (v < 0.5 ? [0, 1, 0] : [0, 0, 0])));
  assert.ok(out[1] > 0.6);
});

test("rear channels drift to the average, and the flip swaps that", () => {
  const frame = solidFrame(32, 18, (u) => (u < 0.5 ? [1, 1, 1] : [0, 0, 0]));
  const front = new ScreenMapper([{ channelId: 0, x: -1, y: -1, z: 0 }], 32, 18).sample(frame)[0];
  const rear = new ScreenMapper([{ channelId: 0, x: -1, y: 1, z: 0 }], 32, 18).sample(frame)[0];
  const flipped = new ScreenMapper([{ channelId: 0, x: -1, y: 1, z: 0 }], 32, 18, { screenAtPositiveY: true }).sample(frame)[0];
  assert.ok(front > rear);
  assert.ok(Math.abs(flipped - front) < 1e-6);
});

test("empty areas sample to nothing", () => {
  assert.equal(new ScreenMapper([], 8, 8).sample(new Float32Array(8 * 8 * 3)).length, 0);
});
//#endregion

//#region Processor
test("LUT round-trips through toSrgb", () => {
  for (let i = 0; i < 256; i++) {
    assert.ok(Math.abs(toSrgb(SRGB_TO_LINEAR[i]) - i / 255) < 1e-4);
  }
});

test("first frame passes through, then attack is faster than decay", () => {
  const p = new ColorProcessor(1, { saturation: 1, brightness: 1, attack: 0.6, decay: 0.15 });
  assert.ok(Math.abs(p.process([0.5, 0.5, 0.5])[0] - toSrgb(0.5)) < 1e-6);
  const up = new ColorProcessor(1, { saturation: 1, attack: 0.6, decay: 0.15 });
  up.process([0, 0, 0]);
  const rise = up.process([1, 1, 1])[0];
  const down = new ColorProcessor(1, { saturation: 1, attack: 0.6, decay: 0.15 });
  down.process([1, 1, 1]);
  const fall = 1 - down.process([0, 0, 0])[0];
  assert.ok(rise > fall);
});

test("grey stays grey under saturation; dim colours hit the black point", () => {
  const p = new ColorProcessor(2, { saturation: 2.5 });
  const out = p.process([0.3, 0.3, 0.3, 0.002, 0.001, 0]);
  assert.ok(Math.abs(out[0] - out[1]) < 1e-6 && Math.abs(out[1] - out[2]) < 1e-6);
  assert.deepEqual([...out.subarray(3)], [0, 0, 0]);
});

test("u16 output stays in range and scrubs NaN", () => {
  assert.deepEqual([...toU16([NaN, -1, 2, 0.5], new Uint16Array(4))], [0, 0, 65535, 32768]);
});
//#endregion

//#region Colour conversion
test("white lands near D65", () => {
  const [x, y] = rgbToXy([1, 1, 1]);
  assert.ok(Math.abs(x - 0.3127) < 0.01 && Math.abs(y - 0.329) < 0.01);
});

test("out-of-gamut points are clamped onto the triangle", () => {
  const [x, y] = clampToGamut([0.1, 0.9], GAMUT_B);
  assert.deepEqual(clampToGamut([x, y], GAMUT_B), [x, y]);
});

test("black does not divide by zero", () => {
  assert.ok(xyToRgb([0.3, 0], 0).every((c) => Number.isFinite(c)));
  assert.deepEqual(rgbToXy([0, 0, 0]), [0.692, 0.308]);
});
//#endregion
