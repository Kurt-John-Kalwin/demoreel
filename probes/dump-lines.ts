import { readFileSync } from "node:fs";
import { parse } from "yaml";
import { StoryboardSchema } from "../src/core/schema.js";
const sb = StoryboardSchema.parse(parse(readFileSync("launch.yaml", "utf8")));
sb.scenes.forEach((s, i) => console.log(JSON.stringify({ i: i + 1, say: s.say })));
