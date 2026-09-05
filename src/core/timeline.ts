import type { Action, Scene, SceneTiming } from "./schema.js";

/** Black lead-in at the start of every recording; the title card is drawn over it. */
export const LEAD_IN_MS = 1200;
/** Held after the last scene so the outro card has room. */
export const TAIL_MS = 1500;
/**
 * How long to hold the outro card. A PR clip wants it short; a clip whose last card carries a punchline wants
 * it long enough to read and screenshot. DEMOREEL_TAIL_MS overrides, clamped to 0.5-6 s.
 */
export function resolveTailMs(env: NodeJS.ProcessEnv = process.env): number {
  const raw = Number(env.DEMOREEL_TAIL_MS);
  if (!Number.isFinite(raw)) return TAIL_MS;
  return Math.min(6000, Math.max(500, Math.round(raw)));
}
/** Breathing room after a narration clip ends before the next scene starts. */
export const SCENE_PAD_MS = 350;
export const MIN_SCENE_MS = 2500;
export const MAX_SCENE_MS = 20000;

export interface NarrationClip {
  sceneIndex: number;
  durationMs: number;
  file?: string;
}

/** Rough on-screen time an action needs; used only to keep a scene from ending before its actions do. */
export function estimateActionMs(action: Action): number {
  if ("goto" in action) return 1500;
  if ("scroll_to" in action) return 1200;
  if ("scroll" in action) return 800;
  if ("hover" in action) return 700;
  if ("click" in action) return 900;
  if ("type" in action) return 300 + 70 * action.type.text.length;
  if ("press" in action) return 300;
  return action.wait;
}

export function estimateSceneActionsMs(scene: Scene): number {
  return scene.do.reduce((sum, a) => sum + estimateActionMs(a), 0);
}

export interface Timeline {
  scenes: SceneTiming[];
  totalMs: number;
}

/**
 * Planned timing: each scene lasts as long as its narration (plus a pause) or its actions, whichever is longer,
 * clamped to sane bounds. The driver uses these as dwell targets; actual starts are recorded and win at render time.
 */
export function buildTimeline(scenes: Scene[], clips: NarrationClip[]): Timeline {
  const byScene = new Map(clips.map((c) => [c.sceneIndex, c.durationMs]));
  let cursor = LEAD_IN_MS;
  const out: SceneTiming[] = scenes.map((scene, index) => {
    const narrationMs = byScene.get(index) ?? 0;
    const wanted = Math.max(narrationMs + SCENE_PAD_MS, estimateSceneActionsMs(scene));
    const durationMs = Math.min(MAX_SCENE_MS, Math.max(MIN_SCENE_MS, wanted));
    const timing = { index, startMs: cursor, endMs: cursor + durationMs, narrationMs };
    cursor += durationMs;
    return timing;
  });
  return { scenes: out, totalMs: cursor + TAIL_MS };
}
