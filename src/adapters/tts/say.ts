import { execFile } from "node:child_process";
import { writeFile, unlink } from "node:fs/promises";
import { promisify } from "node:util";
import { RenderError } from "../../core/errors.js";
import { probeMedia } from "../../render/ffmpeg.js";
import type { Narrator, SynthesisRequest, SynthesisResult } from "./index.js";

const execFileAsync = promisify(execFile);

/** macOS system voices via `say`. Free, offline, good enough to hear pacing; swap for a cloud voice to ship. */
export class SayTts implements Narrator {
  readonly name = "macos-say";
  private readonly voice: string | undefined;
  constructor(opts: { voice?: string } = {}) {
    this.voice = opts.voice;
  }

  async synthesize(req: SynthesisRequest): Promise<SynthesisResult> {
    const file = `${req.outBase}.aiff`;
    const textFile = `${req.outBase}.txt`;
    await writeFile(textFile, req.text, "utf8");
    const args = ["-o", file, "--data-format=BEI16@22050", "-f", textFile];
    const voice = req.voice ?? this.voice;
    if (voice) args.unshift("-v", voice);
    try {
      await execFileAsync("say", args, { timeout: 120_000 });
    } catch (err) {
      throw new RenderError(`macOS say failed: ${(err as Error).message}`, err);
    } finally {
      await unlink(textFile).catch(() => {});
    }
    const info = await probeMedia(file);
    return { file, durationMs: info.durationMs };
  }
}
