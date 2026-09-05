import { stat } from "node:fs/promises";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { SilentTts } from "../src/adapters/tts/silent.js";
import { estimateSpeechMs, type Narrator } from "../src/adapters/tts/index.js";
import { narrate } from "../src/stages/narrate.js";
import { log, sampleStoryboard, tempDir } from "./helpers.js";

let tmp: Awaited<ReturnType<typeof tempDir>>;
beforeAll(async () => {
  tmp = await tempDir();
});
afterAll(() => tmp.cleanup());

describe("narration", () => {
  it("sizes silence to speaking pace", async () => {
    const tts = new SilentTts();
    const res = await tts.synthesize({ text: "one two three four five six seven eight nine ten", lang: "en", outBase: `${tmp.dir}/a` });
    expect((await stat(res.file)).size).toBeGreaterThan(1000);
    expect(res.durationMs).toBe(estimateSpeechMs("one two three four five six seven eight nine ten"));
    expect(estimateSpeechMs("hi")).toBe(1200);
  });

  it("caches clips by content so re-renders do not pay twice", async () => {
    let calls = 0;
    const counting: Narrator = {
      name: "counting",
      async synthesize(req) {
        calls++;
        return new SilentTts().synthesize(req);
      },
    };
    const storyboard = sampleStoryboard();
    const first = await narrate({ storyboard, lang: "en", narrator: counting, cacheDir: `${tmp.dir}/cache`, log });
    const second = await narrate({ storyboard, lang: "en", narrator: counting, cacheDir: `${tmp.dir}/cache`, log });
    expect(calls).toBe(storyboard.scenes.length);
    expect(second.clips.map((c) => c.durationMs)).toEqual(first.clips.map((c) => c.durationMs));
    expect(second.characters).toBe(0);
    expect(first.characters).toBeGreaterThan(0);
  });

  it("warns when a translation is requested without a planner", async () => {
    const res = await narrate({ storyboard: sampleStoryboard(), lang: "es", narrator: new SilentTts(), cacheDir: `${tmp.dir}/cache-es`, log });
    expect(res.warnings[0]).toMatch(/translate/);
    expect(res.clips).toHaveLength(3);
  });
});
