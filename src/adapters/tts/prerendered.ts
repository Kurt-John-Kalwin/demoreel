import { copyFile, readFile } from "node:fs/promises";
import { dirname, isAbsolute, resolve } from "node:path";
import { PlannerError } from "../../core/errors.js";
import { probeMedia } from "../../render/ffmpeg.js";
import type { Narrator, SynthesisRequest, SynthesisResult } from "./index.js";

/**
 * Narration that was voiced somewhere else — a studio read, a vendor this machine has no key
 * for, a take the director picked by ear out of several. The manifest maps each scene's exact
 * `say` line to an audio file:
 *
 *   { "voice": "River", "clips": { "This sandbox booted in…": "01.mp3" } }
 *
 * Keyed by the line rather than by scene number on purpose: reordering scenes must not silently
 * put the wrong words under the wrong picture, and a line whose text was edited after the read
 * should fail loudly rather than play the stale take.
 */
export interface PrerenderedOptions {
  manifestPath: string;
}

interface Manifest {
  voice?: string;
  clips: Record<string, string>;
}

export class PrerenderedTts implements Narrator {
  readonly name: string;
  private readonly manifestPath: string;
  private manifest: Manifest | null = null;

  constructor(opts: PrerenderedOptions) {
    this.manifestPath = opts.manifestPath;
    this.name = "prerendered";
  }

  private async load(): Promise<Manifest> {
    if (this.manifest) return this.manifest;
    let raw: string;
    try {
      raw = await readFile(this.manifestPath, "utf8");
    } catch {
      throw new PlannerError(`no voiceover manifest at ${this.manifestPath} (set DEMOREEL_VOICEOVER)`);
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch (err) {
      throw new PlannerError(`voiceover manifest ${this.manifestPath} is not valid JSON: ${(err as Error).message}`);
    }
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      throw new PlannerError(`voiceover manifest ${this.manifestPath} must be a JSON object`);
    }
    const clips = (parsed as { clips?: unknown }).clips;
    if (typeof clips !== "object" || clips === null || Array.isArray(clips)) {
      throw new PlannerError(`voiceover manifest ${this.manifestPath} has no "clips" object`);
    }
    const voice = (parsed as { voice?: unknown }).voice;
    this.manifest = {
      clips: Object.fromEntries(
        Object.entries(clips as Record<string, unknown>).filter((e): e is [string, string] => typeof e[1] === "string"),
      ),
      ...(typeof voice === "string" ? { voice } : {}),
    };
    return this.manifest;
  }

  async synthesize(req: SynthesisRequest): Promise<SynthesisResult> {
    const manifest = await this.load();
    const key = req.text.trim();
    const named = manifest.clips[key];
    if (!named) {
      throw new PlannerError(
        `the voiceover manifest has no clip for: "${key.slice(0, 70)}${key.length > 70 ? "…" : ""}". ` +
          `Re-record that line, or match the storyboard to the manifest exactly.`,
      );
    }
    const source = isAbsolute(named) ? named : resolve(dirname(this.manifestPath), named);
    // Copied into the render's own cache so a later run is not hostage to the manifest's
    // directory still existing, and so the cache key covers it like any other narrator's clip.
    const file = `${req.outBase}.mp3`;
    try {
      await copyFile(source, file);
    } catch {
      throw new PlannerError(`voiceover clip is missing: ${source}`);
    }
    const info = await probeMedia(file);
    if (info.durationMs <= 0) throw new PlannerError(`voiceover clip has no audio: ${source}`);
    return { file, durationMs: info.durationMs };
  }
}
