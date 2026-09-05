/** One-off: scan topsets.app on Solari and dump selectors for authoring the launch storyboard. */
import { SolariProvider } from "../src/adapters/browser/solari.js";
import { scanPage } from "../src/stages/scan.js";
import { writeFileSync } from "node:fs";

const OUT = process.env.PROBE_OUT ?? "/private/tmp/claude-501/-Users-kurtkalwin-Solrais/24497da1-da1e-41b1-9e10-002d1f083ba7/scratchpad";
const noop = (m: string, d?: unknown) => console.error(m, d ?? "");
const log = { info: noop, warn: noop, error: noop, child: () => log } as any;

const browser = new SolariProvider({ apiKey: process.env.SOLARI_API_KEY!, baseUrl: process.env.SOLARI_BASE_URL });
const r = await scanPage({
  url: new URL(process.env.PROBE_URL ?? "https://topsets.app/"),
  browser,
  viewport: { width: 1920, height: 1080 },
  log,
  screenshot: true,
});
writeFileSync(`${OUT}/scan.json`, JSON.stringify(
  { title: r.scan.title, url: r.scan.url, httpStatus: r.scan.httpStatus, links: r.scan.links, candidates: r.scan.candidates, text: r.scan.text.slice(0, 4000), kind: r.classification }, null, 2));
if (r.screenshotJpegBase64) writeFileSync(`${OUT}/topsets.jpg`, Buffer.from(r.screenshotJpegBase64, "base64"));
console.error("done, browserSeconds", r.browserSeconds.toFixed(1));
