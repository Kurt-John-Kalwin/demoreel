import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { parse } from "yaml";
import { StoryboardSchema } from "../src/core/schema.js";
import { probeMedia } from "../src/render/ffmpeg.js";
const sb = StoryboardSchema.parse(parse(readFileSync("launch.yaml", "utf8")));
for (const [i, sc] of sb.scenes.entries()) {
  const key = createHash("sha1").update(["elevenlabs:eleven_multilingual_v2", sb.voice ?? "", "en", sc.say].join(" ")).digest("hex").slice(0, 20);
  const f = `out/.narration-cache/${key}.mp3`;
  const d = existsSync(f) ? (await probeMedia(f)).durationMs : null;
  console.log(`s${String(i + 1).padStart(2)} ${key} ${existsSync(f) ? "HIT " + d + "ms" : "MISS"}`);
}
