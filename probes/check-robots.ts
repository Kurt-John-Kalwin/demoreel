import { robotsAllows } from "../src/guards/robots.js";
for (const u of process.argv.slice(2)) {
  const r = await robotsAllows(new URL(u));
  console.log(`${r.allowed ? "ALLOW " : "REFUSE"} ${u}${r.allowed ? "" : "  <- " + r.reason}`);
}
