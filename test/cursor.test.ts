import { inflateSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import { CURSOR_TRAVEL_S, cursorAxisExpr, cursorKeyframes } from "../src/render/cursor.js";
import { CURSOR_SIZE, crc32, cursorPng, encodePng } from "../src/render/cursor-png.js";
import type { ActionEvent } from "../src/core/schema.js";

const viewport = { width: 1280, height: 720 };

describe("cursor keyframes", () => {
  it("rests, then glides to each target arriving exactly when the action fired", () => {
    const events: ActionEvent[] = [
      { t: 2000, scene: 0, kind: "hover", ok: true, x: 100, y: 200 },
      { t: 5000, scene: 1, kind: "click", ok: true, x: 300, y: 400 },
      { t: 6000, scene: 1, kind: "scroll", ok: true },
      { t: 7000, scene: 1, kind: "click", ok: false, x: 999, y: 999 },
    ];
    const frames = cursorKeyframes(events, viewport);
    expect(frames[0]).toEqual({ t: 0, x: 704, y: 446 });
    expect(frames).toContainEqual({ t: 2 - CURSOR_TRAVEL_S, x: 704, y: 446 });
    expect(frames).toContainEqual({ t: 2, x: 100, y: 200 });
    expect(frames).toContainEqual({ t: 5, x: 300, y: 400 });
    expect(frames.some((f) => f.x === 999)).toBe(false);
    for (let i = 1; i < frames.length; i++) expect(frames[i]!.t).toBeGreaterThan(frames[i - 1]!.t);
  });

  it("handles a target that arrives immediately after the previous one", () => {
    const frames = cursorKeyframes(
      [
        { t: 1000, scene: 0, kind: "hover", ok: true, x: 10, y: 10 },
        { t: 1010, scene: 0, kind: "click", ok: true, x: 20, y: 20 },
      ],
      viewport,
    );
    const last = frames[frames.length - 1]!;
    expect(last.x).toBe(20);
    for (let i = 1; i < frames.length; i++) expect(frames[i]!.t).toBeGreaterThan(frames[i - 1]!.t);
  });

  it("builds a nested ffmpeg expression that holds the last value", () => {
    const expr = cursorAxisExpr(
      [
        { t: 0, x: 10, y: 0 },
        { t: 1, x: 10, y: 0 },
        { t: 1.5, x: 60, y: 0 },
      ],
      "x",
      -1,
    );
    expect(expr).toBe("if(lt(t,1),9,if(lt(t,1.500),9+(59-(9))*(st(0,clip((t-1)/0.500,0,1))*ld(0)*(3-2*ld(0))),59))");
    expect(cursorAxisExpr([], "x")).toBe("0");
  });
});

describe("cursor sprite", () => {
  it("encodes a valid PNG with the right dimensions and alpha", () => {
    const png = cursorPng();
    expect([...png.subarray(0, 8)]).toEqual([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    expect(png.readUInt32BE(16)).toBe(CURSOR_SIZE.width);
    expect(png.readUInt32BE(20)).toBe(CURSOR_SIZE.height);
    expect(png.subarray(12, 16).toString("ascii")).toBe("IHDR");
    // IEND crc is a well-known constant
    expect(png.readUInt32BE(png.length - 4)).toBe(0xae426082);
    expect(crc32(Buffer.from("IEND"))).toBe(0xae426082);
    // IDAT payload inflates to (stride + 1) * height bytes
    const idatLen = png.readUInt32BE(33);
    expect(png.subarray(37, 41).toString("ascii")).toBe("IDAT");
    const raw = inflateSync(png.subarray(41, 41 + idatLen));
    expect(raw.length).toBe((CURSOR_SIZE.width * 4 + 1) * CURSOR_SIZE.height);
    // the tip pixel is opaque, the far corner is transparent
    expect(raw[1 + 1 * 4 + 3 + (CURSOR_SIZE.width * 4 + 1) * 1]).toBeGreaterThan(200);
    const lastRow = (CURSOR_SIZE.height - 1) * (CURSOR_SIZE.width * 4 + 1);
    expect(raw[lastRow + 1 + (CURSOR_SIZE.width - 1) * 4 + 3]).toBe(0);
  });

  it("encodes arbitrary RGBA", () => {
    const png = encodePng(2, 1, new Uint8Array([255, 0, 0, 255, 0, 255, 0, 128]));
    expect(png.readUInt32BE(16)).toBe(2);
    expect(png.readUInt32BE(20)).toBe(1);
  });
});
