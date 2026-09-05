/** Puts externally-generated narration into demoreel's cache under the key the pipeline will look for. */
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parse } from "yaml";
import { StoryboardSchema } from "../src/core/schema.js";
import { probeMedia } from "../src/render/ffmpeg.js";

const SP = "/private/tmp/claude-501/-Users-kurtkalwin-Solrais/24497da1-da1e-41b1-9e10-002d1f083ba7/scratchpad";
const CACHE = "out/.narration-cache";
const NARRATOR = "elevenlabs:eleven_multilingual_v2";

const sb = StoryboardSchema.parse(parse(readFileSync("launch.yaml", "utf8")));
const urls = new Map<number, string>();
for (const line of readFileSync(`${SP}/${process.env.CLIPS ?? "clips.tsv"}`, "utf8").split("\n")) {
  if (!line.trim()) continue;
  const [n, u] = line.split("\t");
  urls.set(Number(n), u!.trim());
}
mkdirSync(CACHE, { recursive: true });
let total = 0;
for (const [i, scene] of sb.scenes.entries()) {
  const url = urls.get(i + 1);
  if (!url) { continue; }
  const key = createHash("sha1").update([NARRATOR, sb.voice ?? "", "en", scene.say].join(" ")).digest("hex").slice(0, 20);
  const res = await fetch(url);
  if (!res.ok) throw new Error(`scene ${i + 1}: HTTP ${res.status}`);
  const file = join(CACHE, `${key}.mp3`);
  const buf = Buffer.from(await res.arrayBuffer());
  writeFileSync(file, buf);
  const info = await probeMedia(file);
  total += info.durationMs;
  console.log(`scene ${String(i + 1).padStart(2)}  ${key}  ${String(buf.length).padStart(7)} bytes  ${(info.durationMs / 1000).toFixed(2)}s  ${scene.say.slice(0, 40)}`);
}
console.log(`\ntotal narration: ${(total / 1000).toFixed(1)}s`);
