import { readFileSync } from "node:fs";
import { parse } from "yaml";
import { StoryboardSchema } from "../src/core/schema.js";
import { buildTimeline, LEAD_IN_MS, resolveTailMs } from "../src/core/timeline.js";

const sb = StoryboardSchema.parse(parse(readFileSync("launch.yaml", "utf8")));
const wc = (s: string) => s.trim().split(/\s+/).length;
const words = sb.scenes.reduce((n, s) => n + wc(s.say), 0);
console.log("VALID -", sb.scenes.length, "scenes,", words, "words");
console.log("outro:", JSON.stringify(sb.outro), "| note:", JSON.stringify(sb.outroNote));

for (const wps of [2.4, 2.6, 2.8]) {
  const clips = sb.scenes.map((s, i) => ({ sceneIndex: i, durationMs: Math.round((wc(s.say) / wps) * 1000) }));
  const tl = buildTimeline(sb.scenes, clips);
  const total = LEAD_IN_MS + 3000 /* hoisted goto */ + tl.totalMs + resolveTailMs({ DEMOREEL_TAIL_MS: "3000" });
  console.log(`  at ${wps} words/s: scenes ${(tl.totalMs / 1000).toFixed(1)}s -> video ${(total / 1000).toFixed(1)}s`);
}
