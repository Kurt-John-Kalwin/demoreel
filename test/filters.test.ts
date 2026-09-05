import { describe, expect, it } from "vitest";
import { buildFilterGraph, captionCues, escapeDrawtext, hostOf, toVtt, wrapText } from "../src/render/filters.js";
import { sampleStoryboard } from "./helpers.js";
import type { ActionEvent, SceneTiming } from "../src/core/schema.js";

describe("drawtext escaping and wrapping", () => {
  it("escapes the characters ffmpeg treats specially", () => {
    expect(escapeDrawtext("a:b,c%d [e] 'f' \\g;h")).toBe("a\\:b\\,c%%d \\[e\\] ’f’ \\\\g\\;h");
  });
  it("wraps greedily by characters", () => {
    expect(wrapText("one two three four five", 9)).toEqual(["one two", "three", "four five"]);
    expect(wrapText("single", 40)).toEqual(["single"]);
  });
  it("formats WebVTT cues", () => {
    expect(toVtt([{ startMs: 1200, endMs: 4650, text: "Hello there" }])).toBe("WEBVTT\n\n1\n00:00:01.200 --> 00:00:04.650\nHello there\n");
  });
  it("extracts a host for the outro", () => {
    expect(hostOf("https://topsets.app/x?y=1")).toBe("topsets.app");
    expect(hostOf("not a url")).toBe("not a url");
  });
});

describe("filter graph", () => {
  const storyboard = sampleStoryboard();
  const timeline: SceneTiming[] = [
    { index: 0, startMs: 1200, endMs: 5000, narrationMs: 3000 },
    { index: 1, startMs: 5000, endMs: 9000, narrationMs: 2500 },
  ];
  const events: ActionEvent[] = [
    { t: 6000, scene: 1, kind: "click", ok: true, x: 200, y: 300, box: { x: 150, y: 280, w: 100, h: 40 } },
    { t: 6500, scene: 1, kind: "click", ok: false, box: { x: 0, y: 0, w: 10, h: 10 } },
  ];
  const base = {
    storyboard,
    timeline,
    events,
    viewport: { width: 1280, height: 720 },
    narration: [
      { sceneIndex: 0, startMs: 1200 },
      { sceneIndex: 1, startMs: 5000 },
    ],
    audioInputOffset: 2,
    cursorInputIndex: 1,
    totalMs: 10_500,
    leadInMs: 1200,
    tailMs: 1500,
  };

  it("dims the lead-in under the title card the same way it dims the outro", () => {
    const fc = buildFilterGraph({ ...base, fontFile: "/tmp/Font.ttf" }).filterComplex;
    expect(fc).toContain("drawbox=x=0:y=0:w=iw:h=ih:color=0x0E1418@0.88:t=fill:enable='between(t,0,1.200)'");
    expect(fc).toContain("drawbox=x=0:y=0:w=iw:h=ih:color=0x0E1418@0.88:t=fill:enable='gte(t,9.000)'");
  });

  it("uses the storyboard's outro card, with a note line, instead of the host", () => {
    const g = buildFilterGraph({
      ...base,
      storyboard: sampleStoryboard({ outro: "Nobody recorded this.", outroNote: "demoreel render" }),
      fontFile: "/tmp/Font.ttf",
    });
    expect(g.filterComplex).toContain("text='Nobody recorded this.'");
    expect(g.filterComplex).toContain("text='demoreel render'");
    expect(g.filterComplex).not.toContain("text='topsets.app'");
  });

  it("keeps the outro line centred when there is no note", () => {
    const g = buildFilterGraph({ ...base, storyboard: sampleStoryboard({ outro: "Fin." }), fontFile: "/tmp/Font.ttf" });
    expect(g.filterComplex).toContain("text='Fin.':fontsize=53:fontcolor=white:x=(w-text_w)/2:y=(h-text_h)/2-0:");
  });

  it("draws highlights, cards, captions, cursor and mixes narration at scene starts", () => {
    const g = buildFilterGraph({ ...base, fontFile: "/tmp/Font.ttf" });
    expect(g.videoLabel).toBe("[vout]");
    expect(g.audioLabel).toBe("[aout]");
    const fc = g.filterComplex;
    expect(fc).toContain("drawbox=x=144:y=274:w=112:h=52:color=0xC8382D@0.9:t=4:enable='between(t,5.880,6.550)'");
    expect(fc).not.toContain("drawbox=x=-6"); // the failed click draws nothing
    expect(fc).toContain("fontfile='/tmp/Font.ttf'");
    expect(fc).toContain("text='Top Sets'");
    expect(fc).toContain("enable='between(t,0,1.200)'");
    expect(fc).toContain("text='topsets.app'");
    expect(fc).toContain("enable='gte(t,9.000)'");
    expect(fc).toContain("boxcolor=0x0E1418@0.78");
    expect(fc).toContain("[vbase][1:v]overlay=x='");
    expect(fc).toContain("eval=frame:format=auto:enable='between(t,1.200,9.000)'[vout]");
    expect(fc).toContain("[2:a]aformat=sample_rates=48000:channel_layouts=stereo,adelay=1200|1200[a0]");
    expect(fc).toContain("[3:a]aformat=sample_rates=48000:channel_layouts=stereo,adelay=5000|5000[a1]");
    expect(fc).toContain("[a0][a1]amix=inputs=2:normalize=0:dropout_transition=0,apad=whole_dur=10.500[aout]");
  });

  it("shifts every timed element by the video offset", () => {
    const g = buildFilterGraph({ ...base, fontFile: "/tmp/Font.ttf", videoOffsetMs: 200 });
    expect(g.filterComplex).toContain("between(t,6.080,6.750)");
    expect(g.filterComplex).toContain("between(t,0,1.400)");
  });

  it("degrades without a font and without narration", () => {
    const g = buildFilterGraph({ ...base, fontFile: null, narration: [] });
    expect(g.filterComplex).not.toContain("drawtext");
    expect(g.audioLabel).toBeNull();
    expect(g.filterComplex.startsWith("[0:v]drawbox")).toBe(true);
  });

  it("pads a single narration clip to the full length", () => {
    const g = buildFilterGraph({ ...base, fontFile: null, narration: [{ sceneIndex: 0, startMs: 1200 }] });
    expect(g.filterComplex).toContain("[a0]apad=whole_dur=10.500[aout]");
  });

  it("builds caption cues from the timeline", () => {
    const cues = captionCues(storyboard, timeline);
    expect(cues[0]).toEqual({ startMs: 1200, endMs: 4500, text: storyboard.scenes[0]!.say });
  });
});
