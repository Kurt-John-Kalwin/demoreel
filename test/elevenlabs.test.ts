import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { ElevenLabsTts, voiceSettingsFromEnv } from "../src/adapters/tts/elevenlabs.js";
import { pickNarrator } from "../src/adapters/tts/index.js";
import { runFfmpeg } from "../src/render/ffmpeg.js";
import { tempDir } from "./helpers.js";

let tmp: Awaited<ReturnType<typeof tempDir>>;
/** A real second of mp3, so the adapter's ffprobe duration check is exercised rather than stubbed. */
let mp3: Buffer;

beforeAll(async () => {
  tmp = await tempDir();
  const file = join(tmp.dir, "fixture.mp3");
  await runFfmpeg(["-f", "lavfi", "-i", "anullsrc=r=44100:cl=mono", "-t", "1.0", "-c:a", "libmp3lame", "-b:a", "128k", file]);
  mp3 = await readFile(file);
});
afterAll(() => tmp.cleanup());
afterEach(() => vi.unstubAllGlobals());

type Call = { url: string; init: RequestInit };

function stubFetch(handler: (call: Call, n: number) => Response): Call[] {
  const calls: Call[] = [];
  vi.stubGlobal("fetch", async (url: string | URL, init: RequestInit = {}) => {
    const call = { url: String(url), init };
    calls.push(call);
    return handler(call, calls.length);
  });
  return calls;
}

const audio = (): Response => new Response(new Uint8Array(mp3), { status: 200, headers: { "content-type": "audio/mpeg" } });
const fail = (status: number, detail: unknown): Response =>
  new Response(JSON.stringify({ detail }), { status, headers: { "content-type": "application/json" } });

describe("elevenlabs narrator", () => {
  it("posts a scene to the voice endpoint and measures the clip it gets back", async () => {
    const calls = stubFetch(audio);
    const tts = new ElevenLabsTts({ apiKey: "k-123", voice: "21m00Tcm4TlvDq8ikWAM" });
    const res = await tts.synthesize({ text: "Top Sets plans your next set.", lang: "en", outBase: join(tmp.dir, "scene-1") });

    expect(tts.name).toBe("elevenlabs:eleven_multilingual_v2");
    expect(res.file).toBe(join(tmp.dir, "scene-1.mp3"));
    expect(res.durationMs).toBeGreaterThan(900);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe("https://api.elevenlabs.io/v1/text-to-speech/21m00Tcm4TlvDq8ikWAM?output_format=mp3_44100_128");
    expect(calls[0]!.init.method).toBe("POST");
    expect((calls[0]!.init.headers as Record<string, string>)["xi-api-key"]).toBe("k-123");
    expect(JSON.parse(String(calls[0]!.init.body))).toEqual({ text: "Top Sets plans your next set.", model_id: "eleven_multilingual_v2" });
  });

  it("sends language_code only to the models that accept it", async () => {
    const calls = stubFetch(audio);
    await new ElevenLabsTts({ apiKey: "k", model: "eleven_flash_v2_5", voice: "21m00Tcm4TlvDq8ikWAM" }).synthesize({
      text: "Hola.",
      lang: "pt-BR",
      outBase: join(tmp.dir, "flash"),
    });
    await new ElevenLabsTts({ apiKey: "k", voice: "21m00Tcm4TlvDq8ikWAM" }).synthesize({ text: "Hola.", lang: "pt-BR", outBase: join(tmp.dir, "multi") });

    expect(JSON.parse(String(calls[0]!.init.body)).language_code).toBe("pt");
    expect(JSON.parse(String(calls[1]!.init.body))).not.toHaveProperty("language_code");
  });

  it("resolves a voice name to an id once and reuses it", async () => {
    const calls = stubFetch((call) =>
      call.url.endsWith("/voices")
        ? new Response(JSON.stringify({ voices: [{ voice_id: "aQROLc2Cn2y6RVqZ0dsG", name: "Rachel" }] }), { status: 200 })
        : audio(),
    );
    const tts = new ElevenLabsTts({ apiKey: "k", voice: "rachel" });
    await tts.synthesize({ text: "One.", lang: "en", outBase: join(tmp.dir, "n1") });
    await tts.synthesize({ text: "Two.", lang: "en", outBase: join(tmp.dir, "n2") });

    expect(calls.map((c) => c.url.split("/v1/")[1]?.split("?")[0])).toEqual([
      "voices",
      "text-to-speech/aQROLc2Cn2y6RVqZ0dsG",
      "text-to-speech/aQROLc2Cn2y6RVqZ0dsG",
    ]);
  });

  it("names the voices that do exist when the storyboard asks for one that does not", async () => {
    stubFetch(() => new Response(JSON.stringify({ voices: [{ voice_id: "aQROLc2Cn2y6RVqZ0dsG", name: "Rachel" }] }), { status: 200 }));
    const tts = new ElevenLabsTts({ apiKey: "k" });
    await expect(tts.synthesize({ text: "One.", lang: "en", outBase: join(tmp.dir, "n3"), voice: "Samantha" })).rejects.toThrow(
      /no voice named "Samantha".*Rachel/s,
    );
  });

  it("matches a stock library voice by the name before its description", async () => {
    const calls = stubFetch((call) =>
      call.url.endsWith("/voices")
        ? new Response(
            JSON.stringify({
              voices: [
                { voice_id: "aQROLc2Cn2y6RVqZ0dsG", name: "Sarah - Mature, Reassuring, Confident" },
                { voice_id: "SAz9YHcvj6GT2YYXdXww", name: "River - Relaxed, Neutral, Informative" },
              ],
            }),
            { status: 200 },
          )
        : audio(),
    );
    const tts = new ElevenLabsTts({ apiKey: "k", voice: "River" });
    await tts.synthesize({ text: "One.", lang: "en", outBase: join(tmp.dir, "nv1") });
    expect(calls.at(-1)!.url).toContain("text-to-speech/SAz9YHcvj6GT2YYXdXww");
  });

  it("refuses to guess when two voices share a bare name", async () => {
    stubFetch(() =>
      new Response(
        JSON.stringify({
          voices: [
            { voice_id: "aQROLc2Cn2y6RVqZ0dsG", name: "Will - Relaxed Optimist" },
            { voice_id: "SAz9YHcvj6GT2YYXdXww", name: "Will - Fierce Warrior" },
          ],
        }),
        { status: 200 },
      ),
    );
    const tts = new ElevenLabsTts({ apiKey: "k", voice: "Will" });
    await expect(tts.synthesize({ text: "One.", lang: "en", outBase: join(tmp.dir, "nv2") })).rejects.toThrow(
      /more than one voice called "Will"/,
    );
  });

  it("surfaces the vendor's own message on a hard failure", async () => {
    stubFetch(() => fail(401, { status: "quota_exceeded", message: "You have 12 credits remaining." }));
    const tts = new ElevenLabsTts({ apiKey: "k", voice: "21m00Tcm4TlvDq8ikWAM", retries: 2, retryDelayMs: 0 });
    await expect(tts.synthesize({ text: "One.", lang: "en", outBase: join(tmp.dir, "n4") })).rejects.toThrow(
      /\(401\): quota_exceeded: You have 12 credits remaining\./,
    );
  });

  it("retries a busy signal rather than losing the render", async () => {
    const calls = stubFetch((_call, n) => (n === 1 ? fail(429, { message: "Too busy" }) : audio()));
    const tts = new ElevenLabsTts({ apiKey: "k", voice: "21m00Tcm4TlvDq8ikWAM", retryDelayMs: 0 });
    const res = await tts.synthesize({ text: "One.", lang: "en", outBase: join(tmp.dir, "n5") });

    expect(calls).toHaveLength(2);
    expect(res.durationMs).toBeGreaterThan(900);
  });

  it("gives up after the retry budget", async () => {
    const calls = stubFetch(() => fail(500, { message: "internal" }));
    const tts = new ElevenLabsTts({ apiKey: "k", voice: "21m00Tcm4TlvDq8ikWAM", retries: 1, retryDelayMs: 0 });
    await expect(tts.synthesize({ text: "One.", lang: "en", outBase: join(tmp.dir, "n6") })).rejects.toThrow(/\(500\)/);
    expect(calls).toHaveLength(2);
  });
});

describe("voice settings", () => {
  it("sends nothing when no delivery knobs are set", () => {
    expect(voiceSettingsFromEnv({})).toBeNull();
    expect(voiceSettingsFromEnv({ DEMOREEL_TTS_STABILITY: "" })).toBeNull();
    expect(voiceSettingsFromEnv({ DEMOREEL_TTS_STABILITY: "loose" })).toBeNull();
  });

  it("clamps each knob to the range the vendor accepts", () => {
    expect(voiceSettingsFromEnv({ DEMOREEL_TTS_STABILITY: "-1", DEMOREEL_TTS_SPEED: "5" })).toEqual({ stability: 0, speed: 1.2 });
    expect(voiceSettingsFromEnv({ DEMOREEL_TTS_STYLE: "2", DEMOREEL_TTS_SIMILARITY: "0.8" })).toEqual({ style: 1, similarity_boost: 0.8 });
    expect(voiceSettingsFromEnv({ DEMOREEL_TTS_SPEAKER_BOOST: "0" })).toEqual({ use_speaker_boost: false });
  });

  it("puts the settings in the request body when they are given", async () => {
    const calls = stubFetch(audio);
    const tts = new ElevenLabsTts({ apiKey: "k", voice: "21m00Tcm4TlvDq8ikWAM", voiceSettings: { stability: 0.4, speed: 1.05 } });
    await tts.synthesize({ text: "Hello there.", lang: "en", outBase: join(tmp.dir, "settings") });
    expect(JSON.parse(String(calls[0]!.init.body)).voice_settings).toEqual({ stability: 0.4, speed: 1.05 });
  });

  it("carries the environment through the narrator picker", async () => {
    const n = await pickNarrator({ ELEVENLABS_API_KEY: "k", DEMOREEL_TTS_STABILITY: "0.35" }, "linux");
    expect(n.name).toBe("elevenlabs:eleven_multilingual_v2");
    const calls = stubFetch(audio);
    await n.synthesize({ text: "Hello there.", lang: "en", outBase: join(tmp.dir, "picked") });
    expect(JSON.parse(String(calls[0]!.init.body)).voice_settings).toEqual({ stability: 0.35 });
  });
});

describe("narrator selection", () => {
  const linux: NodeJS.Platform = "linux";

  it("prefers ElevenLabs over OpenAI when both keys are set", async () => {
    const n = await pickNarrator({ ELEVENLABS_API_KEY: "e", OPENAI_API_KEY: "o" } as NodeJS.ProcessEnv, linux);
    expect(n.name).toBe("elevenlabs:eleven_multilingual_v2");
  });

  it("accepts the older ELEVEN_API_KEY spelling and the model override", async () => {
    const n = await pickNarrator({ ELEVEN_API_KEY: "e", DEMOREEL_TTS_MODEL: "eleven_turbo_v2_5" } as NodeJS.ProcessEnv, linux);
    expect(n.name).toBe("elevenlabs:eleven_turbo_v2_5");
  });

  it("lets DEMOREEL_TTS pin an adapter against the keys present", async () => {
    const openai = await pickNarrator({ DEMOREEL_TTS: "openai", ELEVENLABS_API_KEY: "e", OPENAI_API_KEY: "o" } as NodeJS.ProcessEnv, linux);
    expect(openai.name).toBe("openai:gpt-4o-mini-tts");
    const say = await pickNarrator({ DEMOREEL_TTS: "say", ELEVENLABS_API_KEY: "e" } as NodeJS.ProcessEnv, linux);
    expect(say.name).toBe("macos-say");
  });

  it("still falls back to silence with no keys and no say", async () => {
    expect((await pickNarrator({} as NodeJS.ProcessEnv, linux)).name).toBe("silent");
  });
});
