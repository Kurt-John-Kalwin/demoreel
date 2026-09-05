import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { SolariProvider } from "../../src/adapters/browser/solari.js";
import { SilentTts } from "../../src/adapters/tts/silent.js";
import { renderStoryboard } from "../../src/core/pipeline.js";
import { validateStoryboard } from "../../src/core/storyboard.js";
import { probeMedia } from "../../src/render/ffmpeg.js";
import { findFont } from "../../src/render/fonts.js";
import { log, tempDir } from "../helpers.js";

/** Costs about a cent. Run with LIVE=1 and SOLARI_API_KEY. */
const live = process.env.LIVE === "1" && Boolean(process.env.SOLARI_API_KEY);

let tmp: Awaited<ReturnType<typeof tempDir>>;
beforeAll(async () => {
  tmp = await tempDir();
});
afterAll(() => tmp.cleanup());

describe.skipIf(!live)("live Solari render", () => {
  it("records docs.getsolari.com and renders a video", async () => {
    const storyboard = validateStoryboard({
      version: 1,
      title: "Solari Docs",
      url: "https://docs.getsolari.com/",
      viewport: "1280x720",
      scenes: [
        { say: "Solari documentation, opened in a cloud browser.", do: [{ goto: "https://docs.getsolari.com/" }] },
        { say: "Scrolling through the quickstart.", do: [{ scroll: 600 }] },
      ],
    });
    const browser = new SolariProvider({ apiKey: process.env.SOLARI_API_KEY!, baseUrl: process.env.SOLARI_BASE_URL });
    const manifest = await renderStoryboard(
      { storyboard, outDir: join(tmp.dir, "out"), cacheDir: join(tmp.dir, "cache") },
      { browser, narrator: new SilentTts(), llm: null, fontFile: await findFont(), log },
    );
    const info = await probeMedia(join(tmp.dir, "out", manifest.files.mp4));
    expect(info.width).toBe(1280);
    expect(info.durationMs).toBeGreaterThan(5000);
    expect(manifest.adapters.browser).toBe("solari");
  }, 240_000);
});
