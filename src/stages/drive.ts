import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import type { BrowserHandle, BrowserProvider } from "../adapters/browser/index.js";
import { DriveError } from "../core/errors.js";
import type { Logger } from "../core/log.js";
import { viewportSize, type Action, type ActionEvent, type ActionKind, type Box, type Storyboard } from "../core/schema.js";
import { LEAD_IN_MS, resolveTailMs, type Timeline } from "../core/timeline.js";

/** A black page for the lead-in; the title card is drawn over these frames. */
export const BLACK_PAGE = "data:text/html,%3Chtml%20style%3D%22background%3A%23000%22%3E%3Cbody%3E%3C%2Fbody%3E%3C%2Fhtml%3E";

export interface DriveOptions {
  storyboard: Storyboard;
  timeline: Timeline;
  browser: BrowserProvider;
  workDir: string;
  log: Logger;
  /** render the same storyboard against another deployment (a preview URL) */
  urlOverride?: string;
  /** hard stop for the recording session */
  wallClockMs?: number;
}

export interface DriveResult {
  footage: string;
  events: ActionEvent[];
  sceneStarts: number[];
  recordingMs: number;
  browserSeconds: number;
  warnings: string[];
}

/** Rewrites a storyboard URL onto the override origin so a PR preview plays the production storyboard. */
export function rebaseUrl(target: string, storyboardUrl: string, override?: string): string {
  if (!override) return new URL(target, storyboardUrl).href;
  const t = new URL(target, storyboardUrl);
  const original = new URL(storyboardUrl);
  const over = new URL(override);
  if (t.origin !== original.origin) return t.href;
  return new URL(t.pathname + t.search + t.hash, over.origin).href;
}

function kindOf(action: Action): ActionKind {
  if ("goto" in action) return "goto";
  if ("scroll_to" in action) return "scroll_to";
  if ("scroll" in action) return "scroll";
  if ("hover" in action) return "hover";
  if ("click" in action) return "click";
  if ("type" in action) return "type";
  if ("press" in action) return "press";
  return "wait";
}

/**
 * Plays the storyboard inside a recording browser. Every action is timestamped against the recording clock; a
 * failed action is logged and skipped so a missing selector costs one hover, not the whole video.
 */
export async function drive(opts: DriveOptions): Promise<DriveResult> {
  const { storyboard, timeline, log } = opts;
  const viewport = viewportSize(storyboard.viewport);
  const recordDir = join(opts.workDir, "footage");
  await mkdir(recordDir, { recursive: true });
  const wallClockMs = opts.wallClockMs ?? 240_000;
  const handle = await opts.browser.open({ viewport, recordDir, stealth: true, wallClockMs });
  const events: ActionEvent[] = [];
  const sceneStarts: number[] = [];
  const warnings: string[] = [];
  const t = () => handle.elapsedMs();
  try {
    const { page } = handle;
    await page.goto(BLACK_PAGE).catch(() => undefined);
    events.push({ t: t(), scene: -1, kind: "lead-in", ok: true });
    const leadRemaining = LEAD_IN_MS - t();
    if (leadRemaining > 0) await page.wait(leadRemaining);

    for (const [i, scene] of storyboard.scenes.entries()) {
      const timing = timeline.scenes[i];
      if (!timing) break;
      // A scene that opens with navigation loads the page first, so narration starts on a painted page.
      let actions = scene.do;
      const first = actions[0];
      if (first && "goto" in first) {
        const nav = await runAction(handle, first, i, storyboard.url, opts.urlOverride);
        events.push(nav);
        if (!nav.ok) {
          warnings.push(`scene ${i + 1}: goto on "${nav.selector}" failed (${nav.error})`);
          log.warn("navigation failed", { scene: i + 1, error: nav.error });
        }
        actions = actions.slice(1);
      }
      const start = t();
      sceneStarts.push(start);
      events.push({ t: start, scene: i, kind: "scene-start", ok: true });
      for (const action of actions) {
        if (t() > wallClockMs) break;
        const event = await runAction(handle, action, i, storyboard.url, opts.urlOverride);
        events.push(event);
        if (!event.ok) {
          warnings.push(`scene ${i + 1}: ${event.kind}${event.selector ? ` on "${event.selector}"` : ""} failed (${event.error})`);
          log.warn("action failed", { scene: i + 1, kind: event.kind, error: event.error });
        }
      }
      const plannedLength = timing.endMs - timing.startMs;
      const remaining = start + plannedLength - t();
      if (remaining > 0) await page.wait(remaining);
      if (t() > wallClockMs) {
        warnings.push(`recording stopped after scene ${i + 1}: wall clock budget of ${wallClockMs} ms reached`);
        break;
      }
    }
    events.push({ t: t(), scene: -1, kind: "tail", ok: true });
    await page.wait(resolveTailMs());
    const recordingMs = t();
    const footage = await handle.saveVideo(join(opts.workDir, "footage.webm"));
    return { footage, events, sceneStarts, recordingMs, browserSeconds: t() / 1000, warnings };
  } catch (err) {
    if (err instanceof DriveError) throw err;
    throw new DriveError(`recording failed: ${(err as Error).message}`, err);
  } finally {
    await handle.close();
  }
}

async function runAction(handle: BrowserHandle, action: Action, scene: number, storyboardUrl: string, override?: string): Promise<ActionEvent> {
  const { page } = handle;
  const at = () => handle.elapsedMs();
  const center = (box: Box) => ({ x: Math.round(box.x + box.w / 2), y: Math.round(box.y + box.h / 2) });
  const kind = kindOf(action);
  try {
    if ("goto" in action) {
      const url = rebaseUrl(action.goto, storyboardUrl, override);
      const res = await page.goto(url);
      await page.wait(500);
      if (res.status !== undefined && res.status >= 400) {
        return { t: at(), scene, kind, ok: false, selector: url, error: `HTTP ${res.status} for ${url}` };
      }
      return { t: at(), scene, kind, ok: true, selector: url };
    }
    if ("scroll_to" in action) {
      await page.scrollIntoView(action.scroll_to);
      const box = await page.boxOf(action.scroll_to);
      return { t: at(), scene, kind, ok: true, selector: action.scroll_to, ...(box ? { box } : {}) };
    }
    if ("scroll" in action) {
      await page.wheel(action.scroll);
      return { t: at(), scene, kind, ok: true };
    }
    if ("hover" in action || "click" in action) {
      const selector = "hover" in action ? action.hover : action.click;
      const box = await page.boxOf(selector);
      if (!box) return { t: at(), scene, kind, ok: false, selector, error: "selector not visible" };
      const { x, y } = center(box);
      await page.moveMouse(x, y);
      if ("click" in action) {
        await page.wait(180);
        const clickedAt = at();
        await page.click(x, y);
        await page.wait(400);
        return { t: clickedAt, scene, kind, ok: true, selector, x, y, box };
      }
      const hoveredAt = at();
      await page.wait(250);
      return { t: hoveredAt, scene, kind, ok: true, selector, x, y, box };
    }
    if ("type" in action) {
      const box = await page.boxOf(action.type.selector);
      const pos = box ? center(box) : null;
      if (pos) await page.moveMouse(pos.x, pos.y);
      const started = at();
      await page.type(action.type.selector, action.type.text);
      return { t: started, scene, kind, ok: true, selector: action.type.selector, ...(pos ?? {}), ...(box ? { box } : {}) };
    }
    if ("press" in action) {
      await page.press(action.press);
      return { t: at(), scene, kind, ok: true, selector: action.press };
    }
    await page.wait(action.wait);
    return { t: at(), scene, kind, ok: true };
  } catch (err) {
    return { t: at(), scene, kind, ok: false, error: (err as Error).message.split("\n")[0]?.slice(0, 160) ?? "unknown" };
  }
}
