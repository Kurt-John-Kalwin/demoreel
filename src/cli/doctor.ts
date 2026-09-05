import { execFile } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { pickLlm } from "../adapters/llm/index.js";
import { pickNarrator } from "../adapters/tts/index.js";
import { ffmpegPath, ffprobePath, probeMedia } from "../render/ffmpeg.js";
import { findFont } from "../render/fonts.js";

const execFileAsync = promisify(execFile);

export interface Check {
  name: string;
  ok: boolean;
  detail: string;
}

/** Everything a render needs, checked up front so failures happen in seconds, not after a two-minute recording. */
export async function runDoctor(opts: { live?: boolean; env?: NodeJS.ProcessEnv } = {}): Promise<Check[]> {
  const env = opts.env ?? process.env;
  const checks: Check[] = [];
  const major = Number(process.versions.node.split(".")[0]);
  checks.push({ name: "node", ok: major >= 20, detail: `v${process.versions.node}${major >= 20 ? "" : " (need 20+)"}` });

  for (const [name, bin] of [
    ["ffmpeg", ffmpegPath],
    ["ffprobe", ffprobePath],
  ] as const) {
    try {
      const { stdout } = await execFileAsync(bin(), ["-version"], { timeout: 15_000 });
      checks.push({ name, ok: true, detail: stdout.split("\n")[0]?.slice(0, 60) ?? "ok" });
    } catch (err) {
      checks.push({ name, ok: false, detail: (err as Error).message });
    }
  }

  const font = await findFont(env);
  checks.push({ name: "font", ok: Boolean(font), detail: font ?? "none found; captions and cards will be skipped (set DEMOREEL_FONT)" });

  checks.push({ name: "solari key", ok: Boolean(env.SOLARI_API_KEY), detail: env.SOLARI_API_KEY ? "SOLARI_API_KEY set" : "SOLARI_API_KEY missing" });

  try {
    const llm = await pickLlm({ env });
    checks.push({ name: "planner", ok: Boolean(llm), detail: llm ? llm.name : "none: set ANTHROPIC_API_KEY or install the claude CLI (render still works with a hand-written storyboard)" });
  } catch (err) {
    checks.push({ name: "planner", ok: false, detail: (err as Error).message });
  }

  const narrator = await pickNarrator(env);
  checks.push({ name: "narrator", ok: narrator.name !== "silent", detail: narrator.name === "silent" ? "silent (set ELEVENLABS_API_KEY or OPENAI_API_KEY, or run on macOS for `say`)" : narrator.name });

  if (opts.live && env.SOLARI_API_KEY) {
    const dir = await mkdtemp(join(tmpdir(), "demoreel-doctor-"));
    try {
      const { SolariProvider } = await import("../adapters/browser/solari.js");
      const provider = new SolariProvider({ apiKey: env.SOLARI_API_KEY, baseUrl: env.SOLARI_BASE_URL });
      const started = Date.now();
      const handle = await provider.open({ viewport: { width: 1280, height: 720 }, recordDir: dir, stealth: true });
      await handle.page.goto("https://example.com");
      await handle.page.wait(1500);
      const file = await handle.saveVideo(join(dir, "probe.webm"));
      await handle.close();
      const info = await probeMedia(file);
      checks.push({ name: "solari recording", ok: info.durationMs > 500, detail: `${info.width}x${info.height} ${info.fps ?? "?"} fps, ${info.durationMs} ms, ${Date.now() - started} ms end to end` });
    } catch (err) {
      checks.push({ name: "solari recording", ok: false, detail: (err as Error).message });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }
  return checks;
}
