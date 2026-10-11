// Checks the TypeScript port against outputs dumped from the v1 (numpy) code at
// tag v1-final. See test/fixtures/golden-v1.json.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import Path from "node:path";
import { ColorProcessor, SRGB_TO_LINEAR, toU16 } from "../src/shared/color/process";
import { ScreenMapper } from "../src/shared/stream/ScreenMapper";
import { buildFrame, rgbChannels } from "../src/shared/stream/protocol";
import { gamutFor, mirekToRgb, rgbToXy, xyToRgb } from "../src/shared/color/convert";

interface Golden {
  grid: [number, number];
  frames: string[];
  channels: [number, number, number, number][];
  lut: number[];
  pipeline: {
    flip: boolean;
    settings: { brightness: number; saturation: number; attack: number; decay: number };
    mappings: [number, number, number, number][];
    frames: { sampled: number[][]; u16: number[][] }[];
  }[];
  convert: {
    rgb_to_xy: [string, number[], number[]][];
    xy_to_rgb: [string, number[], number, number[]][];
    mirek: [number, number[]][];
  };
  protocol: { area: string; seq: number; values: [number, [number, number, number]][]; hex: string };
}

const golden: Golden = JSON.parse(fs.readFileSync(Path.join(__dirname, "../../test/fixtures/golden-v1.json"), "utf8"));

function near(actual: number, expected: number, tolerance: number, what: string): void {
  assert.ok(Math.abs(actual - expected) <= tolerance, `${what}: ${actual} vs ${expected}`);
}

test("sRGB LUT matches v1", () => {
  golden.lut.forEach((v, i) => near(SRGB_TO_LINEAR[i], v, 1e-5, `lut[${i}]`));
});

test("mapper and processor pipeline matches v1", () => {
  const [w, h] = golden.grid;
  const channels = golden.channels.map(([channelId, x, y, z]) => ({ channelId, x, y, z }));
  const frames = golden.frames.map((b64) => {
    const bytes = Buffer.from(b64, "base64");
    const linear = new Float32Array(bytes.length);
    for (let i = 0; i < bytes.length; i++) linear[i] = SRGB_TO_LINEAR[bytes[i]];
    return linear;
  });

  for (const c of golden.pipeline) {
    const mapper = new ScreenMapper(channels, w, h, { screenAtPositiveY: c.flip });
    mapper.mappings.forEach((m, i) => {
      const [id, u, v, a] = c.mappings[i];
      assert.equal(m.channelId, id);
      near(m.u, u, 1e-9, "u");
      near(m.v, v, 1e-9, "v");
      near(m.affinity, a, 1e-9, "affinity");
    });

    const processor = new ColorProcessor(channels.length, { ...c.settings, blackPoint: 0.004 });
    const u16 = new Uint16Array(channels.length * 3);
    c.frames.forEach((expected, f) => {
      const sampled = mapper.sample(frames[f]);
      expected.sampled.forEach((rgb, i) => rgb.forEach((v, k) => near(sampled[i * 3 + k], v, 1e-5, `flip=${c.flip} frame ${f} sampled[${i}][${k}]`)));
      toU16(processor.process(sampled), u16);
      expected.u16.forEach((rgb, i) => rgb.forEach((v, k) => near(u16[i * 3 + k], v, 2, `flip=${c.flip} frame ${f} u16[${i}][${k}]`)));
    });
  }
});

test("colour conversion matches v1", () => {
  for (const [g, rgb, xy] of golden.convert.rgb_to_xy) {
    const out = rgbToXy(rgb, gamutFor(g));
    near(out[0], xy[0], 1e-9, `rgbToXy ${g} ${rgb} x`);
    near(out[1], xy[1], 1e-9, `rgbToXy ${g} ${rgb} y`);
  }
  for (const [g, xy, bri, rgb] of golden.convert.xy_to_rgb) {
    xyToRgb(xy, bri, gamutFor(g)).forEach((c, k) => near(c, rgb[k], 1e-9, `xyToRgb ${g} ${xy}[${k}]`));
  }
  for (const [mirek, rgb] of golden.convert.mirek) {
    mirekToRgb(mirek).forEach((c, k) => near(c, rgb[k], 1e-9, `mirek ${mirek}[${k}]`));
  }
});

test("protocol frame bytes match v1", () => {
  const p = golden.protocol;
  assert.equal(buildFrame(p.area, rgbChannels(p.values), p.seq).toString("hex"), p.hex);
});
