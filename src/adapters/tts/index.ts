import { access } from "node:fs/promises";
import { join } from "node:path";

export interface SynthesisRequest {
  text: string;
  lang: string;
  voice?: string;
  /** absolute path without extension; the adapter appends its own */
  outBase: string;
}

export interface SynthesisResult {
  file: string;
  durationMs: number;
}

/** Text to speech behind one interface so the pipeline never knows which vendor voiced a scene. */
export interface Narrator {
  readonly name: string;
  synthesize(req: SynthesisRequest): Promise<SynthesisResult>;
}

async function onPath(binary: string, env: NodeJS.ProcessEnv): Promise<boolean> {
  for (const dir of (env.PATH ?? "").split(":").filter(Boolean)) {
    try {
      await access(join(dir, binary));
      return true;
    } catch {
      /* next */
    }
  }
  return false;
}

/**
 * A prerendered voiceover if one is supplied, then ElevenLabs or OpenAI when a key exists, macOS `say` when
 * available, otherwise silence with a spoken-pace duration.
 * ElevenLabs goes first: an ELEVENLABS_API_KEY was set for voice, while an OPENAI_API_KEY is often there for
 * something else entirely. Set DEMOREEL_TTS to pin one adapter.
 */
export async function pickNarrator(env: NodeJS.ProcessEnv = process.env, platform: NodeJS.Platform = process.platform): Promise<Narrator> {
  const forced = env.DEMOREEL_TTS;
  // A voiceover recorded elsewhere wins over every vendor: it was chosen deliberately, and
  // silently synthesising over the top of it would be the wrong kind of helpful.
  if (forced === "prerendered" || (!forced && env.DEMOREEL_VOICEOVER)) {
    const { PrerenderedTts } = await import("./prerendered.js");
    return new PrerenderedTts({ manifestPath: env.DEMOREEL_VOICEOVER ?? "" });
  }
  const elevenKey = env.ELEVENLABS_API_KEY ?? env.ELEVEN_API_KEY;
  if (forced === "elevenlabs" || (!forced && elevenKey)) {
    const { ElevenLabsTts, voiceSettingsFromEnv } = await import("./elevenlabs.js");
    return new ElevenLabsTts({
      apiKey: elevenKey ?? "",
      model: env.DEMOREEL_TTS_MODEL,
      voice: env.DEMOREEL_TTS_VOICE,
      voiceSettings: voiceSettingsFromEnv(env),
    });
  }
  if (forced === "openai" || (!forced && env.OPENAI_API_KEY)) {
    const { OpenAiTts } = await import("./openai.js");
    return new OpenAiTts({ apiKey: env.OPENAI_API_KEY ?? "", model: env.DEMOREEL_TTS_MODEL, voice: env.DEMOREEL_TTS_VOICE });
  }
  if (forced === "say" || (!forced && platform === "darwin" && (await onPath("say", env)))) {
    const { SayTts } = await import("./say.js");
    return new SayTts({ voice: env.DEMOREEL_TTS_VOICE });
  }
  const { SilentTts } = await import("./silent.js");
  return new SilentTts();
}

/** Spoken-English pace used to size silent narration and sanity-check clips. */
export function estimateSpeechMs(text: string): number {
  const words = text.trim().split(/\s+/).filter(Boolean).length;
  return Math.max(1200, Math.round((words / 2.6) * 1000) + 300);
}
