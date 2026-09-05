import { execFile } from "node:child_process";
import { createRequire } from "node:module";
import { promisify } from "node:util";
import { RenderError } from "../core/errors.js";

const execFileAsync = promisify(execFile);
const require = createRequire(import.meta.url);

function staticPath(pkg: "ffmpeg-static" | "ffprobe-static"): string {
  const mod: unknown = require(pkg);
  if (typeof mod === "string") return mod;
  if (mod && typeof mod === "object" && "path" in mod && typeof (mod as { path: unknown }).path === "string") {
    return (mod as { path: string }).path;
  }
  throw new RenderError(`${pkg} did not resolve to a binary path`);
}

export function ffmpegPath(): string {
  return process.env.FFMPEG_PATH ?? staticPath("ffmpeg-static");
}

export function ffprobePath(): string {
  return process.env.FFPROBE_PATH ?? staticPath("ffprobe-static");
}

export interface RunOptions {
  cwd?: string;
  timeoutMs?: number;
}

export async function runFfmpeg(args: string[], opts: RunOptions = {}): Promise<void> {
  try {
    await execFileAsync(ffmpegPath(), ["-hide_banner", "-loglevel", "error", "-y", ...args], {
      cwd: opts.cwd,
      timeout: opts.timeoutMs ?? 10 * 60_000,
      maxBuffer: 16 * 1024 * 1024,
    });
  } catch (err) {
    const e = err as { stderr?: string; message?: string; killed?: boolean };
    const tail = (e.stderr ?? e.message ?? "").split("\n").filter(Boolean).slice(-6).join("\n");
    throw new RenderError(`ffmpeg failed${e.killed ? " (timeout)" : ""}: ${tail}`, err);
  }
}

export interface MediaInfo {
  durationMs: number;
  width?: number;
  height?: number;
  fps?: number;
  hasAudio: boolean;
}

export async function probeMedia(file: string): Promise<MediaInfo> {
  let stdout: string;
  try {
    ({ stdout } = await execFileAsync(
      ffprobePath(),
      ["-v", "error", "-print_format", "json", "-show_format", "-show_streams", file],
      { timeout: 60_000, maxBuffer: 4 * 1024 * 1024 },
    ));
  } catch (err) {
    throw new RenderError(`ffprobe failed for ${file}`, err);
  }
  const data = JSON.parse(stdout) as {
    format?: { duration?: string };
    streams?: Array<{ codec_type?: string; width?: number; height?: number; r_frame_rate?: string; duration?: string }>;
  };
  const video = data.streams?.find((s) => s.codec_type === "video");
  const audio = data.streams?.find((s) => s.codec_type === "audio");
  const durationSec = Number(data.format?.duration ?? video?.duration ?? audio?.duration ?? 0);
  let fps: number | undefined;
  if (video?.r_frame_rate) {
    const [n, d] = video.r_frame_rate.split("/").map(Number);
    if (n && d) fps = n / d;
  }
  return {
    durationMs: Math.round(durationSec * 1000),
    width: video?.width,
    height: video?.height,
    fps,
    hasAudio: Boolean(audio),
  };
}

/** Writes `ms` of silence as a wav; used by the silent narrator and by tests. */
export async function writeSilence(file: string, ms: number): Promise<void> {
  await runFfmpeg(["-f", "lavfi", "-i", "anullsrc=r=24000:cl=mono", "-t", (ms / 1000).toFixed(3), "-c:a", "pcm_s16le", file]);
}

/**
 * Writes a solid-colour test clip (mp4, x264 ultrafast); used by the fake browser so the render stage can be
 * exercised offline. libvpx in the bundled ffmpeg is far too slow for this, so the fake never writes webm.
 */
export async function writeColorClip(file: string, opts: { width: number; height: number; ms: number; color?: string; fps?: number }): Promise<void> {
  const fps = opts.fps ?? 25;
  await runFfmpeg([
    "-f", "lavfi", "-i", `color=c=${opts.color ?? "0x334455"}:s=${opts.width}x${opts.height}:r=${fps}:d=${(opts.ms / 1000).toFixed(3)}`,
    "-c:v", "libx264", "-preset", "ultrafast", "-pix_fmt", "yuv420p", file,
  ]);
}
