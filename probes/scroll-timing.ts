import { SolariProvider } from "../src/adapters/browser/solari.js";
const t0 = () => Number(process.hrtime.bigint() / 1000000n);
const browser = new SolariProvider({ apiKey: process.env.SOLARI_API_KEY!, baseUrl: process.env.SOLARI_BASE_URL });
const h = await browser.open({ viewport: { width: 1920, height: 1080 }, stealth: true, wallClockMs: 120_000 });
try {
  let s = t0(); await h.page.goto("https://topsets.app/"); console.log("goto".padEnd(28), t0() - s, "ms");
  await h.page.wait(1200);
  for (const px of [1600, -900, 10000, 4000]) {
    s = t0(); await h.page.wheel(px); console.log(`wheel ${px}`.padEnd(28), t0() - s, "ms");
  }
  for (const sel of ["#cockpit", "#beta"]) {
    s = t0(); await h.page.scrollIntoView(sel); console.log(`scrollIntoView ${sel}`.padEnd(28), t0() - s, "ms");
    const b = await h.page.boxOf(sel);
    console.log("   landed at viewport y =", b ? Math.round(b.y) : "?");
  }
  s = t0(); await h.page.boxOf('h2:has-text("Sign up for the waitlist.")'); console.log("boxOf".padEnd(28), t0() - s, "ms");
} finally { await h.close(); }
