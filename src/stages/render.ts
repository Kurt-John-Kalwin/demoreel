import { mkdir, writeFile, access } from "node:fs/promises";
import { join, resolve } from "node:path";
import { RenderError } from "../core/errors.js";
import type { Logger } from "../core/log.js";
import { viewportSize, type ActionEvent, type SceneTiming, type Storyboard } from "../core/schema.js";
import { LEAD_IN_MS, resolveTailMs } from "../core/timeline.js";
import { cursorPng } from "../render/cursor-png.js";
import { probeMedia, runFfmpeg } from "../render/ffmpeg.js";
import { buildFilterGraph, captionCues, toVtt } from "../render/filters.js";
import type { NarrationClipResult } from "./narrate.js";

export interface RenderOptions {
  storyboard: Storyboard;
  footage: string;
  events: ActionEvent[];
  sceneStarts: number[];
  recordingMs: number;
  clips: NarrationClipResult[];
  workDir: string;
  outDir: string;
  fontFile: string | null;
  log: Logger;
  videoOffsetMs?: number;
  gif?: boolean;
}

export interface RenderResult {
  mp4: string;
  gif?: string;
  poster?: string;
  vtt: string;
  timeline: SceneTiming[];
  durationMs: number;
  warnings: string[];
}

const sec = (ms: number) => (ms / 1000).toFixed(3);

/** Actual scene timing from the recorded starts; the planned timeline only guided the driver. */
export function actualTimeline(sceneStarts: number[], clips: NarrationClipResult[], recordingMs: number): SceneTiming[] {
  const byScene = new Map(clips.map((c) => [c.sceneIndex, c.durationMs]));
  return sceneStarts.map((startMs, index) => ({
    index,
    startMs,
    endMs: sceneStarts[index + 1] ?? Math.max(startMs + 500, recordingMs - resolveTailMs()),
    narrationMs: byScene.get(index) ?? 0,
  }));
}

/**
 * Default distance the bed sits under the narration before ducking.
 * Measured against this project's own films: at -12 dB the ducked bed lands ~14 dB under the
 * speech, which is the usual place for a bed you notice only when the voice stops. -18 is barely
 * there, -8 starts competing.
 */
const MUSIC_DB = -12;

/**
 * The music bed for this render, or null.
 *
 * `DEMOREEL_MUSIC` / `DEMOREEL_MUSIC_DB` win over the storyboard, so a level can be tried
 * without editing the file — which matters because the only way to judge a bed is to hear it.
 * A bed that is named but missing is a warning, never a failed render: a film with no music is
 * still a film.
 */
async function resolveMusic(
  storyboard: Storyboard,
  warnings: string[],
): Promise<{ file: string; gainDb: number } | null> {
  const named = process.env.DEMOREEL_MUSIC ?? storyboard.music;
  if (!named) return null;
  const file = resolve(named);
  try {
    await access(file);
  } catch {
    warnings.push(`music bed not found at ${file}; rendered without it`);
    return null;
  }
  const fromEnv = process.env.DEMOREEL_MUSIC_DB ? Number(process.env.DEMOREEL_MUSIC_DB) : undefined;
  const gainDb = Number.isFinite(fromEnv) ? (fromEnv as number) : storyboard.musicDb ?? MUSIC_DB;
  return { file, gainDb };
}

export async function render(opts: RenderOptions): Promise<RenderResult> {
  const { storyboard, log } = opts;
  const warnings: string[] = [];
  await mkdir(opts.outDir, { recursive: true });
  await mkdir(opts.workDir, { recursive: true });
  const viewport = viewportSize(storyboard.viewport);
  const footageInfo = await probeMedia(opts.footage);
  if (footageInfo.durationMs < 1000) throw new RenderError(`footage is only ${footageInfo.durationMs} ms long`);
  const totalMs = footageInfo.durationMs;
  const timeline = actualTimeline(opts.sceneStarts, opts.clips, opts.recordingMs);
  const leadInMs = opts.sceneStarts[0] ?? LEAD_IN_MS;
  if (!opts.fontFile) warnings.push("no TrueType font found; rendered without captions and title cards (set DEMOREEL_FONT)");

  const cursorFile = join(opts.workDir, "cursor.png");
  await writeFile(cursorFile, cursorPng());

  const music = await resolveMusic(storyboard, warnings);
  if (music) log.info("music bed", { file: music.file, gainDb: music.gainDb });

  const clips = [...opts.clips]
    .sort((a, b) => a.sceneIndex - b.sceneIndex)
    .filter((c) => opts.sceneStarts[c.sceneIndex] !== undefined);
  const graph = buildFilterGraph({
    storyboard,
    timeline,
    events: opts.events,
    viewport,
    narration: clips.map((c) => ({ sceneIndex: c.sceneIndex, startMs: opts.sceneStarts[c.sceneIndex]! })),
    audioInputOffset: 2,
    cursorInputIndex: 1,
    fontFile: opts.fontFile,
    totalMs,
    leadInMs,
    tailMs: resolveTailMs(),
    videoOffsetMs: opts.videoOffsetMs ?? 0,
    ...(music ? { music: { inputIndex: 2 + clips.length, gainDb: music.gainDb } } : {}),
  });

  const mp4 = join(opts.outDir, "demo.mp4");
  const args = ["-i", opts.footage, "-i", cursorFile];
  for (const c of clips) args.push("-i", c.file);
  // -stream_loop so a bed shorter than the film repeats instead of falling silent.
  if (music) args.push("-stream_loop", "-1", "-i", music.file);
  args.push("-filter_complex", graph.filterComplex, "-map", graph.videoLabel);
  if (graph.audioLabel) args.push("-map", graph.audioLabel, "-c:a", "aac", "-b:a", "128k");
  args.push(
    "-c:v", "libx264", "-preset", "veryfast", "-crf", "20", "-pix_fmt", "yuv420p", "-r", "25",
    "-movflags", "+faststart", "-t", sec(totalMs), mp4,
  );
  log.info("rendering", { scenes: timeline.length, clips: clips.length, totalMs });
  await runFfmpeg(args, { cwd: opts.workDir, timeoutMs: 15 * 60_000 });

  const vtt = join(opts.outDir, "captions.vtt");
  await writeFile(vtt, toVtt(captionCues(storyboard, timeline)), "utf8");

  const result: RenderResult = { mp4, vtt, timeline, durationMs: totalMs, warnings };
  const poster = join(opts.outDir, "poster.jpg");
  try {
    const posterAt = Math.min(leadInMs + 1200, Math.max(totalMs - 500, 0));
    await runFfmpeg(["-ss", sec(posterAt), "-i", mp4, "-frames:v", "1", "-q:v", "3", poster], { timeoutMs: 60_000 });
    result.poster = poster;
  } catch (err) {
    warnings.push(`poster failed: ${(err as Error).message}`);
  }
  if (opts.gif !== false) {
    const gif = join(opts.outDir, "demo.gif");
    try {
      await runFfmpeg(
        [
          "-ss", sec(leadInMs), "-t", "8", "-i", mp4,
          "-vf", "fps=12,scale=960:-2:flags=lanczos,split[a][b];[a]palettegen=max_colors=128[p];[b][p]paletteuse=dither=bayer:bayer_scale=3",
          "-loop", "0", gif,
        ],
        { timeoutMs: 5 * 60_000 },
      );
      result.gif = gif;
    } catch (err) {
      warnings.push(`gif failed: ${(err as Error).message}`);
    }
  }
  return result;
}
