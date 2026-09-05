import { readFileSync } from "node:fs";
import { parse } from "yaml";
import { StoryboardSchema } from "../src/core/schema.js";
const file = process.argv[2] ?? "demoreel.yaml";
const sb = StoryboardSchema.parse(parse(readFileSync(file, "utf8")));
const w = sb.scenes.reduce((n, s) => n + s.say.trim().split(/\s+/).length, 0);
console.log(`${file} VALID — ${sb.scenes.length} scenes, ${w} words, ~${(w / 3.5).toFixed(0)}s narration`);
console.log("outro:", JSON.stringify(sb.outro), "|", JSON.stringify(sb.outroNote));
