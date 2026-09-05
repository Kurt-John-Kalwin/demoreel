/** One-off: scroll topsets.app to each landing-page section and screenshot it, to pick the strongest shots. */
import { SolariProvider } from "../src/adapters/browser/solari.js";
import { writeFileSync } from "node:fs";

const OUT = process.env.PROBE_OUT ?? "/private/tmp/claude-501/-Users-kurtkalwin-Solrais/24497da1-da1e-41b1-9e10-002d1f083ba7/scratchpad";
const SECTIONS = ["#import", "#cockpit", "#logging", "#program", "#insights", "#nutrition", "#milestones", "#shiplog", "#promise", "#beta"];

const browser = new SolariProvider({ apiKey: process.env.SOLARI_API_KEY!, baseUrl: process.env.SOLARI_BASE_URL });
const h = await browser.open({ viewport: { width: 1920, height: 1080 }, stealth: true, wallClockMs: 180_000 });
try {
  await h.page.goto("https://topsets.app/");
  await h.page.wait(1200);
  writeFileSync(`${OUT}/frame-00-hero.jpg`, await h.page.screenshotJpeg());
  for (const [i, sel] of SECTIONS.entries()) {
    await h.page.scrollIntoView(sel);
    await h.page.wait(900);
    const box = await h.page.boxOf(sel);
    writeFileSync(`${OUT}/frame-${String(i + 1).padStart(2, "0")}-${sel.slice(1)}.jpg`, await h.page.screenshotJpeg());
    console.error(sel, box ? `box ${Math.round(box.x)},${Math.round(box.y)} ${Math.round(box.w)}x${Math.round(box.h)}` : "NOT VISIBLE");
  }
} finally {
  await h.close();
}
console.error("frames written");
