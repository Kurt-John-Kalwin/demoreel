import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ElevenLabsTts } from "../../src/adapters/tts/elevenlabs.js";
import { estimateSpeechMs } from "../../src/adapters/tts/index.js";
import { tempDir } from "../helpers.js";

/** Spends a line of the account's character quota. Run with LIVE=1 and ELEVENLABS_API_KEY. */
const key = process.env.ELEVENLABS_API_KEY ?? process.env.ELEVEN_API_KEY;
const live = process.env.LIVE === "1" && Boolean(key);

let tmp: Awaited<ReturnType<typeof tempDir>>;
beforeAll(async () => {
  tmp = await tempDir();
});
afterAll(() => tmp.cleanup());

describe.skipIf(!live)("live ElevenLabs narration", () => {
  it("voices a line into an mp3 of roughly spoken length", async () => {
    const text = "Demoreel turns a URL and one sentence into a narrated demo video.";
    const tts = new ElevenLabsTts({ apiKey: key!, model: process.env.DEMOREEL_TTS_MODEL, voice: process.env.DEMOREEL_TTS_VOICE });
    const res = await tts.synthesize({ text, lang: "en", outBase: join(tmp.dir, "live") });
    const expected = estimateSpeechMs(text);
    expect(res.file.endsWith(".mp3")).toBe(true);
    expect(res.durationMs).toBeGreaterThan(expected * 0.4);
    expect(res.durationMs).toBeLessThan(expected * 2.5);
  });
});
