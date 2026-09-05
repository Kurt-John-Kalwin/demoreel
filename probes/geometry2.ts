import { SolariProvider } from "../src/adapters/browser/solari.js";
const browser = new SolariProvider({ apiKey: process.env.SOLARI_API_KEY!, baseUrl: process.env.SOLARI_BASE_URL });
const h = await browser.open({ viewport: { width: 1920, height: 1080 }, stealth: true, wallClockMs: 120_000 });
try {
  await h.page.goto("https://topsets.app/"); await h.page.wait(1500);
  await h.page.wheel(60000); await h.page.wait(1500); await h.page.wheel(-60000); await h.page.wait(1500);
  for (const sel of ['#import','h2:has-text("Bring five years with you.")','#cockpit','h2:has-text("Open the app already knowing where you stand.")','#beta','h2:has-text("Sign up for the waitlist.")']) {
    const b = await h.page.boxOf(sel);
    console.log(sel.padEnd(56), b ? `y=${Math.round(b.y)} h=${Math.round(b.h)}` : "NOT FOUND");
  }
} finally { await h.close(); }
