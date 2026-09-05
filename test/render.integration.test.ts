import { readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { FakeBrowserProvider, fakeClock } from "../src/adapters/browser/fake.js";
import { SilentTts } from "../src/adapters/tts/silent.js";
import { renderStoryboard } from "../src/core/pipeline.js";
import { ManifestSchema } from "../src/core/schema.js";
import { probeMedia } from "../src/render/ffmpeg.js";
import { findFont } from "../src/render/fonts.js";
import { log, sampleSite, sampleStoryboard, tempDir } from "./helpers.js";

let tmp: Awaited<ReturnType<typeof tempDir>>;
beforeAll(async () => {
  tmp = await tempDir();
});
afterAll(() => tmp.cleanup());

describe("end to end with fakes", () => {
  it("renders an mp4, gif, captions and manifest from a storyboard", async () => {
    const storyboard = sampleStoryboard();
    const browser = new FakeBrowserProvider(sampleSite, fakeClock());
    const outDir = join(tmp.dir, "out");
    const stages: string[] = [];
    const manifest = await renderStoryboard(
      { storyboard, outDir, id: "test01", cacheDir: join(tmp.dir, "cache"), onProgress: (s) => stages.push(s) },
      { browser, narrator: new SilentTts(), llm: null, fontFile: await findFont(), log },
    );
    expect(stages).toEqual(["narrating", "recording", "rendering", "publishing"]);
    expect(manifest.id).toBe("test01");
    expect(manifest.files.mp4).toBe("demo.mp4");
    expect(manifest.timeline).toHaveLength(3);
    const mp4 = await probeMedia(join(outDir, "demo.mp4"));
    expect(mp4.width).toBe(1280);
    expect(mp4.height).toBe(720);
    expect(mp4.hasAudio).toBe(true);
    expect(Math.abs(mp4.durationMs - manifest.durationMs)).toBeLessThan(400);
    expect(manifest.durationMs).toBeGreaterThan(8000);
    expect((await stat(join(outDir, "demo.gif"))).size).toBeGreaterThan(1000);
    expect((await stat(join(outDir, "poster.jpg"))).size).toBeGreaterThan(1000);
    const vtt = await readFile(join(outDir, "captions.vtt"), "utf8");
    expect(vtt.startsWith("WEBVTT")).toBe(true);
    expect(vtt).toContain(storyboard.scenes[1]!.say);
    const stored = ManifestSchema.parse(JSON.parse(await readFile(join(outDir, "manifest.json"), "utf8")));
    expect(stored.warnings.some((w) => w.includes("#missing"))).toBe(true);
    expect(stored.cost.ttsCharacters).toBeGreaterThan(0);
    expect(stored.adapters).toEqual({ browser: "fake", narrator: "silent", llm: undefined });
    await expect(stat(join(outDir, "work"))).rejects.toThrow();
  });
});
