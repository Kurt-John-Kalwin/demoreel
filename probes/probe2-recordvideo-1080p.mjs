// Probe 2: Playwright recordVideo via remote server + saveAs; 1080p; measure with ffprobe.
import { Solari } from "@solarisdk/browser";
import fs from "node:fs"; import path from "node:path"; import { execFileSync } from "node:child_process";
import ffprobe from "ffprobe-static";
const t0 = Date.now(); const log = (...a) => console.log(`[${((Date.now()-t0)/1000).toFixed(1)}s]`, ...a);
const dir = path.resolve("videos2"); fs.mkdirSync(dir, { recursive: true });
const solari = new Solari({ apiKey: process.env.SOLARI_API_KEY });
const kill = setTimeout(() => { console.error("HARD TIMEOUT"); process.exit(9); }, 150_000);
let browser;
try {
  browser = await solari.launch();
  log("launched", browser.id.split(":").pop());
  const ctx = await browser.newContext({ recordVideo: { dir, size: { width: 1920, height: 1080 } }, viewport: { width: 1920, height: 1080 }, deviceScaleFactor: 1 });
  const page = await ctx.newPage();
  const g0 = Date.now();
  await page.goto("https://github.com/solari-sdk/solari-cookbook", { waitUntil: "domcontentloaded", timeout: 30000 });
  log("goto github in", Date.now()-g0, "ms");
  // 8 seconds of visible activity: hover, scroll, click into README anchor
  for (let i = 0; i < 8; i++) { await page.mouse.move(300 + i*120, 400 + (i%2)*80, { steps: 10 }); await page.mouse.wheel(0, i < 4 ? 400 : -400); await page.waitForTimeout(600); }
  const ss0 = Date.now(); await page.screenshot({ type: "png" }); log("1080p png screenshot", Date.now()-ss0, "ms");
  const video = page.video();
  await page.close();
  const s0 = Date.now(); const outPath = path.join(dir, "demo.webm"); await video.saveAs(outPath); log("saveAs took", Date.now()-s0, "ms");
  await ctx.close();
  const st = fs.statSync(outPath); log("VIDEO", outPath, st.size, "bytes");
  const info = execFileSync(ffprobe.path, ["-v","error","-select_streams","v:0","-show_entries","stream=codec_name,width,height,r_frame_rate,avg_frame_rate,nb_frames:format=duration,size","-of","json", outPath]).toString();
  log("ffprobe:", info.replace(/\s+/g," "));
} finally { if (browser) await browser.close(); await solari.close(); clearTimeout(kill); log("done"); }
