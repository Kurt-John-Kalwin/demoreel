import type { SceneTiming, Storyboard, ActionEvent } from "../core/schema.js";
import { cursorAxisExpr, cursorKeyframes, type CursorKeyframe } from "./cursor.js";
import { CURSOR_SIZE } from "./cursor-png.js";

/** drawtext text escaping: backslash, colon, quote, percent and newline are special inside filter args. */
export function escapeDrawtext(text: string): string {
  return text
    .replace(/\\/g, "\\\\")
    .replace(/'/g, "\u2019")
    .replace(/:/g, "\\:")
    .replace(/%/g, "%%")
    .replace(/,/g, "\\,")
    .replace(/\[/g, "\\[")
    .replace(/\]/g, "\\]")
    .replace(/;/g, "\\;");
}

/** Greedy word wrap for caption lines. */
export function wrapText(text: string, maxChars: number): string[] {
  const words = text.trim().split(/\s+/);
  const lines: string[] = [];
  let line = "";
  for (const w of words) {
    if (!line) line = w;
    else if (line.length + 1 + w.length <= maxChars) line += " " + w;
    else {
      lines.push(line);
      line = w;
    }
  }
  if (line) lines.push(line);
  return lines;
}

export interface CaptionCue {
  startMs: number;
  endMs: number;
  text: string;
}

export function captionCues(storyboard: Storyboard, timeline: SceneTiming[]): CaptionCue[] {
  return timeline.map((t) => ({
    startMs: t.startMs,
    endMs: Math.max(t.startMs + 800, t.startMs + t.narrationMs + 300),
    text: storyboard.scenes[t.index]?.say ?? "",
  }));
}

function vttTime(ms: number): string {
  const h = Math.floor(ms / 3_600_000);
  const m = Math.floor((ms % 3_600_000) / 60_000);
  const s = Math.floor((ms % 60_000) / 1000);
  const f = ms % 1000;
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}.${String(f).padStart(3, "0")}`;
}

export function toVtt(cues: CaptionCue[]): string {
  const body = cues.map((c, i) => `${i + 1}\n${vttTime(c.startMs)} --> ${vttTime(c.endMs)}\n${c.text}\n`).join("\n");
  return `WEBVTT\n\n${body}`;
}

export interface GraphInput {
  storyboard: Storyboard;
  timeline: SceneTiming[];
  events: ActionEvent[];
  viewport: { width: number; height: number };
  /** narration clips in scene order; index into ffmpeg inputs starts at `audioInputOffset` */
  narration: Array<{ sceneIndex: number; startMs: number }>;
  audioInputOffset: number;
  fontFile: string | null;
  totalMs: number;
  leadInMs: number;
  tailMs: number;
  /** ms to add to every overlay/caption time to line footage up with the action clock */
  videoOffsetMs?: number;
  cursorInputIndex: number;
  /** Optional music bed. Omitted entirely when there is none, so the no-music graph is unchanged. */
  music?: { inputIndex: number; gainDb: number } | null;
}

const sec = (ms: number) => (ms / 1000).toFixed(3);

function fontArg(fontFile: string): string {
  return `fontfile='${fontFile.replace(/\\/g, "\\\\").replace(/'/g, "\\'").replace(/:/g, "\\:")}'`;
}

/**
 * Builds the -filter_complex graph: click highlights, title and outro cards, captions, cursor overlay, and the
 * narration mix placed at each scene's actual start. Pure, so it is unit-tested against golden strings.
 */
export function buildFilterGraph(input: GraphInput): { filterComplex: string; videoLabel: string; audioLabel: string | null } {
  const { storyboard, timeline, events, viewport, fontFile } = input;
  const offset = input.videoOffsetMs ?? 0;
  const parts: string[] = [];
  const vchain: string[] = [];

  // Click highlights: a thin box around the target for half a second.
  for (const ev of events) {
    if (ev.kind !== "click" || !ev.box || !ev.ok) continue;
    const t0 = sec(ev.t + offset - 120);
    const t1 = sec(ev.t + offset + 550);
    const pad = 6;
    vchain.push(
      `drawbox=x=${Math.round(ev.box.x - pad)}:y=${Math.round(ev.box.y - pad)}:w=${Math.round(ev.box.w + pad * 2)}:h=${Math.round(
        ev.box.h + pad * 2,
      )}:color=0xC8382D@0.9:t=4:enable='between(t,${t0},${t1})'`,
    );
  }

  if (fontFile) {
    const font = fontArg(fontFile);
    const titleSize = Math.round(viewport.width / 24);
    const subSize = Math.round(viewport.width / 52);
    // Title card over the lead-in. The lead-in covers the hoisted `goto`, so by the time the card is still up the
    // page underneath has usually painted; without a fill the white title sits on a live page and is unreadable.
    // Mirrors the outro's dim so both cards look like the same card.
    vchain.push(`drawbox=x=0:y=0:w=iw:h=ih:color=0x0E1418@0.88:t=fill:enable='between(t,0,${sec(input.leadInMs + offset)})'`);
    vchain.push(
      `drawtext=${font}:text='${escapeDrawtext(storyboard.title)}':fontsize=${titleSize}:fontcolor=white:x=(w-text_w)/2:y=(h-text_h)/2-${Math.round(
        subSize * 0.9,
      )}:enable='between(t,0,${sec(input.leadInMs + offset)})'`,
    );
    if (storyboard.sentence) {
      vchain.push(
        `drawtext=${font}:text='${escapeDrawtext(storyboard.sentence)}':fontsize=${subSize}:fontcolor=0xC8CCD0:x=(w-text_w)/2:y=(h-text_h)/2+${Math.round(
          subSize * 1.1,
        )}:enable='between(t,0,${sec(input.leadInMs + offset)})'`,
      );
    }
    // Outro: dim the last frames, then the host name on top.
    const outroStart = sec(input.totalMs - input.tailMs + offset);
    vchain.push(`drawbox=x=0:y=0:w=iw:h=ih:color=0x0E1418@0.88:t=fill:enable='gte(t,${outroStart})'`);
    const outroLine = storyboard.outro ?? hostOf(storyboard.url);
    const outroShift = storyboard.outroNote ? Math.round(subSize * 0.9) : 0;
    vchain.push(
      `drawtext=${font}:text='${escapeDrawtext(outroLine)}':fontsize=${titleSize}:fontcolor=white:x=(w-text_w)/2:y=(h-text_h)/2-${outroShift}:enable='gte(t,${outroStart})'`,
    );
    if (storyboard.outroNote) {
      vchain.push(
        `drawtext=${font}:text='${escapeDrawtext(storyboard.outroNote)}':fontsize=${subSize}:fontcolor=0xC8CCD0:x=(w-text_w)/2:y=(h-text_h)/2+${Math.round(
          subSize * 1.1,
        )}:enable='gte(t,${outroStart})'`,
      );
    }
    // Captions: one drawtext per scene, wrapped, on a dark band.
    const capSize = Math.round(viewport.width / 44);
    const maxChars = viewport.width >= 1600 ? 64 : viewport.width >= 1000 ? 46 : 26;
    for (const cue of captionCues(storyboard, timeline)) {
      const lines = wrapText(cue.text, maxChars).map(escapeDrawtext).join("\n");
      vchain.push(
        `drawtext=${font}:text='${lines.replace(/\n/g, "\\\n")}':fontsize=${capSize}:fontcolor=white:line_spacing=6:box=1:boxcolor=0x0E1418@0.78:boxborderw=${Math.round(
          capSize * 0.55,
        )}:x=(w-text_w)/2:y=h-text_h-${Math.round(viewport.height * 0.07)}:enable='between(t,${sec(cue.startMs + offset)},${sec(cue.endMs + offset)})'`,
      );
    }
  }

  const base = vchain.length ? `[0:v]${vchain.join(",")}[vbase]` : `[0:v]null[vbase]`;
  parts.push(base);

  // Cursor overlay with eased motion; hotspot is the sprite's top-left.
  const frames: CursorKeyframe[] = cursorKeyframes(events, viewport).map((f) => ({ ...f, t: f.t + offset / 1000 }));
  const x = cursorAxisExpr(frames, "x", -1);
  const y = cursorAxisExpr(frames, "y", -1);
  // The cursor is part of the demo, not of the title or outro cards.
  const cursorWindow = `between(t,${sec(input.leadInMs + offset)},${sec(input.totalMs - input.tailMs + offset)})`;
  parts.push(`[vbase][${input.cursorInputIndex}:v]overlay=x='${x}':y='${y}':eval=frame:format=auto:enable='${cursorWindow}'[vout]`);
  void CURSOR_SIZE;

  let audioLabel: string | null = null;
  if (input.narration.length) {
    const labels: string[] = [];
    input.narration.forEach((n, i) => {
      const idx = input.audioInputOffset + i;
      const delay = Math.max(0, Math.round(n.startMs));
      parts.push(`[${idx}:a]aformat=sample_rates=48000:channel_layouts=stereo,adelay=${delay}|${delay}[a${i}]`);
      labels.push(`[a${i}]`);
    });
    if (labels.length === 1) {
      parts.push(`${labels[0]}apad=whole_dur=${sec(input.totalMs)}[aout]`);
    } else {
      parts.push(`${labels.join("")}amix=inputs=${labels.length}:normalize=0:dropout_transition=0,apad=whole_dur=${sec(input.totalMs)}[aout]`);
    }
    audioLabel = "[aout]";
  }

  // Music bed. Ducked by the narration rather than merely set quiet: a fixed level that sits
  // politely under a loud line is still muddy under a soft one, and the narration is the point.
  if (input.music) {
    const total = sec(input.totalMs);
    const outAt = sec(Math.max(0, input.totalMs - 3000));
    parts.push(
      `[${input.music.inputIndex}:a]aformat=sample_rates=48000:channel_layouts=stereo,` +
        `atrim=0:${total},volume=${input.music.gainDb}dB,` +
        `afade=t=in:st=0:d=2,afade=t=out:st=${outAt}:d=3[mbed]`,
    );
    if (audioLabel) {
      parts.push(`${audioLabel}asplit=2[mspeech][mkey]`);
      parts.push(`[mbed][mkey]sidechaincompress=threshold=0.03:ratio=8:attack=25:release=450[mduck]`);
      parts.push(`[mspeech][mduck]amix=inputs=2:normalize=0:dropout_transition=0[amixed]`);
    } else {
      parts.push(`[mbed]apad=whole_dur=${total}[amixed]`);
    }
    audioLabel = "[amixed]";
  }

  return { filterComplex: parts.join(";"), videoLabel: "[vout]", audioLabel };
}

export function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}
