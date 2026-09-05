import { stat } from "node:fs/promises";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { FakeBrowserProvider, fakeClock } from "../src/adapters/browser/fake.js";
import { LEAD_IN_MS, TAIL_MS, buildTimeline } from "../src/core/timeline.js";
import { drive, rebaseUrl } from "../src/stages/drive.js";
import { log, sampleSite, sampleStoryboard, tempDir } from "./helpers.js";

let tmp: Awaited<ReturnType<typeof tempDir>>;
beforeAll(async () => {
  tmp = await tempDir();
});
afterAll(() => tmp.cleanup());

describe("rebaseUrl", () => {
  it("moves same-origin targets onto the preview origin and leaves others alone", () => {
    expect(rebaseUrl("https://topsets.app/coaches?x=1", "https://topsets.app/", "https://pr-12.vercel.app")).toBe("https://pr-12.vercel.app/coaches?x=1");
    expect(rebaseUrl("/pricing", "https://topsets.app/", "https://pr-12.vercel.app/")).toBe("https://pr-12.vercel.app/pricing");
    expect(rebaseUrl("https://docs.other.com/", "https://topsets.app/", "https://pr-12.vercel.app")).toBe("https://docs.other.com/");
    expect(rebaseUrl("/pricing", "https://topsets.app/")).toBe("https://topsets.app/pricing");
  });
});

describe("drive", () => {
  it("plays every scene, logs failures without aborting, and records real footage", async () => {
    const storyboard = sampleStoryboard();
    const clock = fakeClock();
    const browser = new FakeBrowserProvider(sampleSite, clock);
    const timeline = buildTimeline(storyboard.scenes, [
      { sceneIndex: 0, durationMs: 3000 },
      { sceneIndex: 1, durationMs: 2000 },
      { sceneIndex: 2, durationMs: 2000 },
    ]);
    const result = await drive({ storyboard, timeline, browser, workDir: tmp.dir, log });
    expect(result.sceneStarts).toHaveLength(3);
    expect(result.sceneStarts[0]).toBeGreaterThanOrEqual(LEAD_IN_MS);
    for (let i = 1; i < 3; i++) {
      const planned = timeline.scenes[i - 1]!.endMs - timeline.scenes[i - 1]!.startMs;
      expect(result.sceneStarts[i]! - result.sceneStarts[i - 1]!).toBeGreaterThanOrEqual(planned);
    }
    const failed = result.events.filter((e) => !e.ok);
    expect(failed).toHaveLength(1);
    expect(failed[0]).toMatchObject({ kind: "click", selector: "#missing", error: "selector not visible" });
    expect(result.warnings).toHaveLength(1);
    const click = result.events.find((e) => e.kind === "click" && e.ok);
    expect(click).toMatchObject({ x: 940, y: 55, box: sampleSite.boxes["a:has-text(\"Builder\")"] });
    expect(result.recordingMs).toBeGreaterThanOrEqual(timeline.totalMs - TAIL_MS);
    expect((await stat(result.footage)).size).toBeGreaterThan(1000);
    const methods = browser.calls.map((c) => c.method);
    expect(methods).toContain("scrollIntoView");
    expect(methods[methods.length - 1]).toBe("close");
  });

  it("stops recording when the wall clock budget is spent", async () => {
    const storyboard = sampleStoryboard();
    const browser = new FakeBrowserProvider(sampleSite, fakeClock());
    const timeline = buildTimeline(storyboard.scenes, []);
    const result = await drive({ storyboard, timeline, browser, workDir: `${tmp.dir}/short`, log, wallClockMs: 3000 });
    expect(result.sceneStarts.length).toBeLessThan(3);
    expect(result.warnings.some((w) => w.includes("wall clock"))).toBe(true);
  });
});
