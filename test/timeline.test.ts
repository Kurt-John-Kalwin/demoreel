import { describe, expect, it } from "vitest";
import { LEAD_IN_MS, MAX_SCENE_MS, MIN_SCENE_MS, SCENE_PAD_MS, TAIL_MS, buildTimeline, estimateActionMs, resolveTailMs } from "../src/core/timeline.js";
import type { Scene } from "../src/core/schema.js";

describe("timeline", () => {
  const scenes: Scene[] = [
    { say: "first line here", do: [{ goto: "https://a.b/" }] },
    { say: "second line here", do: [] },
    { say: "third line here", do: [{ type: { selector: "#q", text: "hello world" } }] },
  ];

  it("gives each scene its narration plus a pause, clamped to the minimum", () => {
    const tl = buildTimeline(scenes, [
      { sceneIndex: 0, durationMs: 3000 },
      { sceneIndex: 1, durationMs: 1000 },
      { sceneIndex: 2, durationMs: 4000 },
    ]);
    expect(tl.scenes[0]).toEqual({ index: 0, startMs: LEAD_IN_MS, endMs: LEAD_IN_MS + 3000 + SCENE_PAD_MS, narrationMs: 3000 });
    expect(tl.scenes[1]!.endMs - tl.scenes[1]!.startMs).toBe(MIN_SCENE_MS);
    expect(tl.scenes[2]!.startMs).toBe(tl.scenes[1]!.endMs);
    expect(tl.totalMs).toBe(tl.scenes[2]!.endMs + TAIL_MS);
  });

  it("never exceeds the maximum scene length", () => {
    const tl = buildTimeline(scenes, [{ sceneIndex: 0, durationMs: 90_000 }]);
    expect(tl.scenes[0]!.endMs - tl.scenes[0]!.startMs).toBe(MAX_SCENE_MS);
  });

  it("lets long action sequences win over short narration", () => {
    const typing: Scene = { say: "short line", do: [{ type: { selector: "#q", text: "a".repeat(60) } }] };
    const tl = buildTimeline([typing], [{ sceneIndex: 0, durationMs: 500 }]);
    expect(tl.scenes[0]!.endMs - tl.scenes[0]!.startMs).toBe(Math.max(MIN_SCENE_MS, estimateActionMs(typing.do[0]!)));
  });

  it("treats a missing clip as silence", () => {
    const tl = buildTimeline(scenes, []);
    expect(tl.scenes.every((s) => s.narrationMs === 0)).toBe(true);
  });
});

describe("resolveTailMs", () => {
  it("defaults to the constant and clamps the override", () => {
    expect(resolveTailMs({})).toBe(TAIL_MS);
    expect(resolveTailMs({ DEMOREEL_TAIL_MS: "not a number" })).toBe(TAIL_MS);
    expect(resolveTailMs({ DEMOREEL_TAIL_MS: "3000" })).toBe(3000);
    expect(resolveTailMs({ DEMOREEL_TAIL_MS: "10" })).toBe(500);
    expect(resolveTailMs({ DEMOREEL_TAIL_MS: "999999" })).toBe(6000);
  });
});
