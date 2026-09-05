/** One-off: measure absolute page geometry so the launch storyboard can use pixel scrolls with known landings. */
import { SolariProvider } from "../src/adapters/browser/solari.js";

const browser = new SolariProvider({ apiKey: process.env.SOLARI_API_KEY!, baseUrl: process.env.SOLARI_BASE_URL });
const h = await browser.open({ viewport: { width: 1920, height: 1080 }, stealth: true, wallClockMs: 120_000 });
try {
  await h.page.goto("https://topsets.app/");
  await h.page.wait(1500);
  const page = h.page as unknown as { raw?: { evaluate: (s: string) => Promise<unknown> } };
  const targets = ["#import", "#cockpit", "#logging", "#program", "#insights", "#shiplog", "#beta"];
  // scroll to the very bottom first so every lazy/reveal section has painted, then measure from the top.
  await h.page.wheel(60000);
  await h.page.wait(1200);
  await h.page.wheel(-60000);
  await h.page.wait(1200);
  const boxes: Record<string, unknown> = {};
  for (const sel of targets) boxes[sel] = await h.page.boxOf(sel);
  console.log(JSON.stringify({ note: "boxOf is viewport-relative at scrollY=0", boxes }, null, 2));
} finally {
  await h.close();
}
