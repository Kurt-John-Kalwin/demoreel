import type { ActionEvent } from "../core/schema.js";

export interface CursorKeyframe {
  /** seconds from the start of the footage */
  t: number;
  x: number;
  y: number;
}

/** How long the cursor takes to glide to a target. */
export const CURSOR_TRAVEL_S = 0.55;

/**
 * Turns the action log into cursor keyframes: the cursor rests, then glides to each hover, click or type target,
 * arriving exactly when the action fired. Events without coordinates do not move it.
 */
export function cursorKeyframes(events: ActionEvent[], viewport: { width: number; height: number }): CursorKeyframe[] {
  const rest = { x: Math.round(viewport.width * 0.55), y: Math.round(viewport.height * 0.62) };
  const frames: CursorKeyframe[] = [{ t: 0, x: rest.x, y: rest.y }];
  const targets = events
    .filter((e) => e.x !== undefined && e.y !== undefined && e.ok)
    .sort((a, b) => a.t - b.t);
  for (const ev of targets) {
    const arrive = ev.t / 1000;
    const prev = frames[frames.length - 1]!;
    if (arrive <= prev.t + 0.05) {
      frames.push({ t: prev.t + 0.05, x: ev.x!, y: ev.y! });
      continue;
    }
    const depart = Math.max(prev.t, arrive - CURSOR_TRAVEL_S);
    if (depart > prev.t) frames.push({ t: depart, x: prev.x, y: prev.y });
    frames.push({ t: arrive, x: ev.x!, y: ev.y! });
  }
  return frames;
}

const num = (n: number) => (Number.isInteger(n) ? String(n) : n.toFixed(3));

/**
 * ffmpeg overlay expression for one axis: piecewise smoothstep between keyframes, holding the last value.
 * Uses st/ld so the eased progress is computed once per frame.
 */
export function cursorAxisExpr(frames: CursorKeyframe[], axis: "x" | "y", offset = 0): string {
  if (frames.length === 0) return "0";
  const v = (f: CursorKeyframe) => num((axis === "x" ? f.x : f.y) + offset);
  let expr = v(frames[frames.length - 1]!);
  for (let i = frames.length - 2; i >= 0; i--) {
    const a = frames[i]!;
    const b = frames[i + 1]!;
    const d = Math.max(b.t - a.t, 0.001);
    const from = v(a);
    const to = v(b);
    const seg =
      from === to
        ? from
        : `${from}+(${to}-(${from}))*(st(0,clip((t-${num(a.t)})/${num(d)},0,1))*ld(0)*(3-2*ld(0)))`;
    expr = `if(lt(t,${num(b.t)}),${seg},${expr})`;
  }
  return expr;
}
