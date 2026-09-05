import { writeSilence } from "../../render/ffmpeg.js";
import { estimateSpeechMs, type Narrator, type SynthesisRequest, type SynthesisResult } from "./index.js";

/** Silence sized to speaking pace. Keeps every stage runnable without a voice vendor; tests and dry runs use it. */
export class SilentTts implements Narrator {
  readonly name = "silent";
  async synthesize(req: SynthesisRequest): Promise<SynthesisResult> {
    const durationMs = estimateSpeechMs(req.text);
    const file = `${req.outBase}.wav`;
    await writeSilence(file, durationMs);
    return { file, durationMs };
  }
}
