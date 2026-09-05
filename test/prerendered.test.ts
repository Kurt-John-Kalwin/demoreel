import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PrerenderedTts } from "../src/adapters/tts/prerendered.js";
import { pickNarrator } from "../src/adapters/tts/index.js";
import { runFfmpeg } from "../src/render/ffmpeg.js";
import { tempDir } from "./helpers.js";

let tmp: Awaited<ReturnType<typeof tempDir>>;
let clip: string;
let manifest: string;

beforeAll(async () => {
  tmp = await tempDir();
  await mkdir(join(tmp.dir, "vo"), { recursive: true });
  clip = join(tmp.dir, "vo", "01.mp3");
  // A real encode, so the ffprobe duration path is exercised rather than stubbed.
  await runFfmpeg(["-f", "lavfi", "-i", "sine=frequency=440:duration=2", "-c:a", "libmp3lame", clip]);
  manifest = join(tmp.dir, "vo", "voiceover.json");
  await writeFile(manifest, JSON.stringify({ voice: "River", clips: { "A line that was voiced elsewhere.": "01.mp3" } }));
});
afterAll(() => tmp.cleanup());

describe("prerendered narrator", () => {
  it("copies the clip into the render cache and measures it", async () => {
    const tts = new PrerenderedTts({ manifestPath: manifest });
    const res = await tts.synthesize({
      text: "A line that was voiced elsewhere.",
      lang: "en",
      outBase: join(tmp.dir, "out1"),
    });
    expect(res.file).toBe(join(tmp.dir, "out1.mp3"));
    expect(res.durationMs).toBeGreaterThan(1500);
    expect(res.durationMs).toBeLessThan(2600);
  });

  it("matches on the line, ignoring surrounding whitespace", async () => {
    const tts = new PrerenderedTts({ manifestPath: manifest });
    const res = await tts.synthesize({
      text: "  A line that was voiced elsewhere.  ",
      lang: "en",
      outBase: join(tmp.dir, "out2"),
    });
    expect(res.durationMs).toBeGreaterThan(1500);
  });

  it("refuses a line it has no take for rather than rendering it silent", async () => {
    const tts = new PrerenderedTts({ manifestPath: manifest });
    await expect(
      tts.synthesize({ text: "A line nobody recorded.", lang: "en", outBase: join(tmp.dir, "out3") }),
    ).rejects.toThrow(/no clip for: "A line nobody recorded\."/);
  });

  it("names the manifest when it is missing or malformed", async () => {
    const missing = new PrerenderedTts({ manifestPath: join(tmp.dir, "nope.json") });
    await expect(missing.synthesize({ text: "x", lang: "en", outBase: join(tmp.dir, "o") })).rejects.toThrow(
      /no voiceover manifest at/,
    );
    const bad = join(tmp.dir, "vo", "bad.json");
    await writeFile(bad, "{ not json");
    await expect(
      new PrerenderedTts({ manifestPath: bad }).synthesize({ text: "x", lang: "en", outBase: join(tmp.dir, "o") }),
    ).rejects.toThrow(/is not valid JSON/);
    const noClips = join(tmp.dir, "vo", "noclips.json");
    await writeFile(noClips, JSON.stringify({ voice: "River" }));
    await expect(
      new PrerenderedTts({ manifestPath: noClips }).synthesize({ text: "x", lang: "en", outBase: join(tmp.dir, "o") }),
    ).rejects.toThrow(/has no "clips" object/);
  });

  it("reports a manifest entry whose file is gone", async () => {
    const dangling = join(tmp.dir, "vo", "dangling.json");
    await writeFile(dangling, JSON.stringify({ clips: { hello: "does-not-exist.mp3" } }));
    await expect(
      new PrerenderedTts({ manifestPath: dangling }).synthesize({ text: "hello", lang: "en", outBase: join(tmp.dir, "o") }),
    ).rejects.toThrow(/voiceover clip is missing/);
  });

  it("is chosen ahead of every vendor when DEMOREEL_VOICEOVER is set", async () => {
    const picked = await pickNarrator({ DEMOREEL_VOICEOVER: manifest, ELEVENLABS_API_KEY: "k", OPENAI_API_KEY: "k" }, "darwin");
    expect(picked.name).toBe("prerendered");
  });

  it("leaves the vendor order alone when it is not set", async () => {
    const picked = await pickNarrator({ ELEVENLABS_API_KEY: "k" }, "darwin");
    expect(picked.name).toContain("elevenlabs");
  });
});
