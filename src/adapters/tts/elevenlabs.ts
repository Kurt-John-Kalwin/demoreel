import { writeFile } from "node:fs/promises";
import { PlannerError } from "../../core/errors.js";
import { probeMedia } from "../../render/ffmpeg.js";
import type { Narrator, SynthesisRequest, SynthesisResult } from "./index.js";

export interface ElevenLabsTtsOptions {
  apiKey: string;
  /** Voice model. Defaults to eleven_multilingual_v2: slower than flash, but this is narration, not a phone call. */
  model?: string;
  /** Voice id, or a voice name from the account, which is looked up once and cached. */
  voice?: string;
  baseUrl?: string;
  /** mp3_44100_192 and the pcm formats need a paid tier; 128 kbps mp3 is available everywhere. */
  outputFormat?: string;
  retries?: number;
  retryDelayMs?: number;
  /**
   * Delivery. Omitted entirely when unset, so the voice's own defaults apply. Lower `stability` lets the read
   * vary line to line, which is what makes narration sound spoken rather than read; `style` adds emphasis at the
   * cost of consistency; `speed` is 0.7-1.2. Set from DEMOREEL_TTS_STABILITY / _SIMILARITY / _STYLE / _SPEED.
   */
  voiceSettings?: VoiceSettings | null;
}

export interface VoiceSettings {
  stability?: number;
  similarity_boost?: number;
  style?: number;
  use_speaker_boost?: boolean;
  speed?: number;
}

/** Reads the delivery knobs off the environment; returns null when none are set, so nothing is sent. */
export function voiceSettingsFromEnv(env: NodeJS.ProcessEnv = process.env): VoiceSettings | null {
  const num = (raw: string | undefined, lo: number, hi: number): number | undefined => {
    const n = Number(raw);
    return raw !== undefined && raw !== "" && Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : undefined;
  };
  const settings: VoiceSettings = {};
  const stability = num(env.DEMOREEL_TTS_STABILITY, 0, 1);
  const similarity = num(env.DEMOREEL_TTS_SIMILARITY, 0, 1);
  const style = num(env.DEMOREEL_TTS_STYLE, 0, 1);
  const speed = num(env.DEMOREEL_TTS_SPEED, 0.7, 1.2);
  if (stability !== undefined) settings.stability = stability;
  if (similarity !== undefined) settings.similarity_boost = similarity;
  if (style !== undefined) settings.style = style;
  if (speed !== undefined) settings.speed = speed;
  if (env.DEMOREEL_TTS_SPEAKER_BOOST !== undefined) settings.use_speaker_boost = env.DEMOREEL_TTS_SPEAKER_BOOST !== "0";
  return Object.keys(settings).length ? settings : null;
}

/** Rachel: the stock voice every account has, so the adapter works before anyone picks a voice. */
const DEFAULT_VOICE = "21m00Tcm4TlvDq8ikWAM";
/** Only the v2.5 models accept language_code; multilingual_v2 rejects the field outright. */
const TAKES_LANGUAGE_CODE = /_(turbo|flash)_v2_5$/;
const VOICE_ID = /^[A-Za-z0-9]{20}$/;

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** Pulls the human-readable half out of ElevenLabs' `{ detail: { status, message } }` error bodies. */
async function describe(res: Response): Promise<string> {
  const body = await res.text().catch(() => "");
  try {
    const detail = (JSON.parse(body) as { detail?: { status?: string; message?: string } | string }).detail;
    if (typeof detail === "string") return detail;
    if (detail?.message) return detail.status ? `${detail.status}: ${detail.message}` : detail.message;
  } catch {
    /* not json; fall through to the raw body */
  }
  return body.slice(0, 200);
}

function retryAfterMs(res: Response): number | null {
  const seconds = Number(res.headers.get("retry-after"));
  return Number.isFinite(seconds) && seconds > 0 ? Math.min(seconds, 20) * 1000 : null;
}

/** ElevenLabs text-to-speech over plain fetch: one request per scene, mp3 out. */
export class ElevenLabsTts implements Narrator {
  readonly name: string;
  private readonly opts: Required<ElevenLabsTtsOptions>;
  private readonly voiceIds = new Map<string, string>();

  constructor(opts: ElevenLabsTtsOptions) {
    this.opts = {
      apiKey: opts.apiKey,
      model: opts.model ?? "eleven_multilingual_v2",
      voice: opts.voice ?? DEFAULT_VOICE,
      baseUrl: opts.baseUrl ?? "https://api.elevenlabs.io/v1",
      outputFormat: opts.outputFormat ?? "mp3_44100_128",
      retries: opts.retries ?? 2,
      retryDelayMs: opts.retryDelayMs ?? 800,
      voiceSettings: opts.voiceSettings ?? null,
    };
    this.name = `elevenlabs:${this.opts.model}`;
  }

  async synthesize(req: SynthesisRequest): Promise<SynthesisResult> {
    const voiceId = await this.resolveVoice(req.voice ?? this.opts.voice);
    const body: Record<string, unknown> = { text: req.text, model_id: this.opts.model };
    // lang is BCP-47 (en, pt-BR); ElevenLabs wants the ISO 639-1 half.
    if (TAKES_LANGUAGE_CODE.test(this.opts.model)) body.language_code = req.lang.slice(0, 2).toLowerCase();
    if (this.opts.voiceSettings) body.voice_settings = this.opts.voiceSettings;
    const res = await this.request(
      `${this.opts.baseUrl}/text-to-speech/${encodeURIComponent(voiceId)}?output_format=${encodeURIComponent(this.opts.outputFormat)}`,
      {
        method: "POST",
        headers: { "xi-api-key": this.opts.apiKey, "content-type": "application/json", accept: "audio/mpeg" },
        body: JSON.stringify(body),
      },
      120_000,
    );
    const file = `${req.outBase}.mp3`;
    await writeFile(file, Buffer.from(await res.arrayBuffer()));
    const info = await probeMedia(file);
    return { file, durationMs: info.durationMs };
  }

  /** Storyboards say `voice: Rachel`; the API wants an id. Names are resolved once per process. */
  private async resolveVoice(voice: string): Promise<string> {
    if (VOICE_ID.test(voice)) return voice;
    const key = voice.trim().toLowerCase();
    const cached = this.voiceIds.get(key);
    if (cached) return cached;
    const res = await this.request(`${this.opts.baseUrl}/voices`, { headers: { "xi-api-key": this.opts.apiKey } }, 30_000);
    const voices = ((await res.json()) as { voices?: Array<{ voice_id?: string; name?: string }> }).voices ?? [];
    const named = (v: { name?: string }) => v.name?.trim().toLowerCase() ?? "";
    // The stock library names carry their own description ("River - Relaxed, Neutral,
    // Informative"), so an exact match on the bare name a storyboard would write never hits.
    // Fall back to the segment before the dash, and only when it is unambiguous: silently
    // picking one of two voices called "Will" would change the narrator without saying so.
    const bare = (v: { name?: string }) => named(v).split(/\s+[-\u2013\u2014]\s+/)[0]!.trim();
    let match = voices.find((v) => named(v) === key);
    if (!match) {
      const candidates = voices.filter((v) => bare(v) === key);
      if (candidates.length > 1) {
        throw new PlannerError(
          `ElevenLabs has more than one voice called "${voice}" (${candidates.map((c) => c.name).join(", ")}). Use the full name or the voice id.`,
        );
      }
      match = candidates[0];
    }
    if (!match?.voice_id) {
      const known = voices
        .map((v) => v.name)
        .filter(Boolean)
        .slice(0, 12)
        .join(", ");
      throw new PlannerError(`ElevenLabs has no voice named "${voice}"${known ? ` (available: ${known})` : ""}`);
    }
    this.voiceIds.set(key, match.voice_id);
    return match.voice_id;
  }

  /** Retries the vendor's own busy signals (429, 5xx, dropped sockets) so one blip does not cost a whole render. */
  private async request(url: string, init: RequestInit, timeoutMs: number): Promise<Response> {
    for (let attempt = 0; ; attempt++) {
      let res: Response;
      try {
        res = await fetch(url, { ...init, signal: AbortSignal.timeout(timeoutMs) });
      } catch (err) {
        if (attempt >= this.opts.retries) throw new PlannerError(`ElevenLabs request failed: ${(err as Error).message}`, err);
        await sleep(this.opts.retryDelayMs * 2 ** attempt);
        continue;
      }
      if (res.ok) return res;
      const retryable = res.status === 429 || res.status >= 500;
      if (!retryable || attempt >= this.opts.retries) {
        throw new PlannerError(`ElevenLabs TTS failed (${res.status}): ${await describe(res)}`);
      }
      await sleep(retryAfterMs(res) ?? this.opts.retryDelayMs * 2 ** attempt);
    }
  }
}
