import { writeFile } from "node:fs/promises";
import { PlannerError } from "../../core/errors.js";
import { probeMedia } from "../../render/ffmpeg.js";
import type { Narrator, SynthesisRequest, SynthesisResult } from "./index.js";

export interface OpenAiTtsOptions {
  apiKey: string;
  model?: string;
  voice?: string;
  baseUrl?: string;
}

/** OpenAI speech endpoint over plain fetch: one request per scene, mp3 out. */
export class OpenAiTts implements Narrator {
  readonly name: string;
  private readonly opts: Required<OpenAiTtsOptions>;

  constructor(opts: OpenAiTtsOptions) {
    this.opts = {
      apiKey: opts.apiKey,
      model: opts.model ?? "gpt-4o-mini-tts",
      voice: opts.voice ?? "alloy",
      baseUrl: opts.baseUrl ?? "https://api.openai.com/v1",
    };
    this.name = `openai:${this.opts.model}`;
  }

  async synthesize(req: SynthesisRequest): Promise<SynthesisResult> {
    const res = await fetch(`${this.opts.baseUrl}/audio/speech`, {
      method: "POST",
      headers: { authorization: `Bearer ${this.opts.apiKey}`, "content-type": "application/json" },
      body: JSON.stringify({ model: this.opts.model, voice: req.voice ?? this.opts.voice, input: req.text, response_format: "mp3" }),
      signal: AbortSignal.timeout(60_000),
    });
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      throw new PlannerError(`OpenAI TTS failed (${res.status}): ${body.slice(0, 200)}`);
    }
    const file = `${req.outBase}.mp3`;
    await writeFile(file, Buffer.from(await res.arrayBuffer()));
    const info = await probeMedia(file);
    return { file, durationMs: info.durationMs };
  }
}
