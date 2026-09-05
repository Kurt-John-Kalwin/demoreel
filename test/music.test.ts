import { describe, expect, it } from "vitest";
import { buildFilterGraph } from "../src/render/filters.js";
import { sampleStoryboard } from "./helpers.js";
import type { SceneTiming } from "../src/core/schema.js";

const timeline: SceneTiming[] = [
  { index: 0, startMs: 1200, endMs: 5000, narrationMs: 3000 },
  { index: 1, startMs: 5000, endMs: 9000, narrationMs: 2500 },
];

const base = {
  storyboard: sampleStoryboard(),
  timeline,
  events: [],
  viewport: { width: 1280, height: 720 },
  narration: [
    { sceneIndex: 0, startMs: 1200 },
    { sceneIndex: 1, startMs: 5000 },
  ],
  audioInputOffset: 2,
  cursorInputIndex: 1,
  fontFile: null,
  totalMs: 12_000,
  leadInMs: 1200,
  tailMs: 3000,
};

describe("music bed", () => {
  it("leaves the graph alone when there is no music", () => {
    const g = buildFilterGraph(base);
    expect(g.filterComplex).not.toContain("mbed");
    expect(g.filterComplex).not.toContain("sidechaincompress");
    expect(g.audioLabel).toBe("[aout]");
  });

  it("ducks the bed under the narration rather than only setting it quiet", () => {
    const g = buildFilterGraph({ ...base, music: { inputIndex: 4, gainDb: -18 } });
    expect(g.filterComplex).toContain("[4:a]");
    expect(g.filterComplex).toContain("volume=-18dB");
    // the narration is the sidechain key, so the bed dips while anyone is speaking
    expect(g.filterComplex).toContain("[aout]asplit=2[mspeech][mkey]");
    expect(g.filterComplex).toContain("[mbed][mkey]sidechaincompress=");
    expect(g.filterComplex).toContain("[mspeech][mduck]amix=inputs=2:normalize=0");
    expect(g.audioLabel).toBe("[amixed]");
  });

  it("trims and fades the bed to the length of the film", () => {
    const g = buildFilterGraph({ ...base, music: { inputIndex: 4, gainDb: -20 } });
    expect(g.filterComplex).toContain("atrim=0:12.000");
    expect(g.filterComplex).toContain("afade=t=in:st=0:d=2");
    // out over the last 3 s, which is the outro card
    expect(g.filterComplex).toContain("afade=t=out:st=9.000:d=3");
  });

  it("still produces audio when a film has music but no narration", () => {
    const g = buildFilterGraph({ ...base, narration: [], music: { inputIndex: 2, gainDb: -18 } });
    expect(g.filterComplex).toContain("[mbed]apad=whole_dur=12.000[amixed]");
    expect(g.filterComplex).not.toContain("sidechaincompress");
    expect(g.audioLabel).toBe("[amixed]");
  });
});
