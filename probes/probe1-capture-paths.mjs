// Live capture probe against Solari: (1) Playwright recordVideo over the remote Playwright server,
// (2) CDP Page.startScreencast frame rate, (3) rrweb replay download. Budget: ~1 browser-minute.
import { Solari } from "@solarisdk/browser";
import { chromium } from "patchright-core";
import fs from "node:fs";
import path from "node:path";

const t0 = Date.now();
const ms = () => `${((Date.now() - t0) / 1000).toFixed(1)}s`;
const log = (...a) => console.log(`[${ms()}]`, ...a);
const out = { videoDir: path.resolve("videos"), shots: path.resolve("shots") };
fs.mkdirSync(out.videoDir, { recursive: true }); fs.mkdirSync(out.shots, { recursive: true });

const solari = new Solari({ apiKey: process.env.SOLARI_API_KEY });
const killTimer = setTimeout(() => { console.error("HARD TIMEOUT"); process.exit(9); }, 150_000);
let browser;
try {
  browser = await solari.launch({ recording: true });
  log("launched session", browser.id, "expiresAt", browser.expiresAt, "version", browser.version());
  log("wsEndpoint", browser.wsEndpoint.replace(/token=[^&]+/, "token=***"));
  log("cdpEndpoint", browser.cdpEndpoint.replace(/token=[^&]+/, "token=***"));

  // (1) Playwright recordVideo through the remote server
  let ctx, page, videoPath = null, videoErr = null;
  try {
    ctx = await browser.newContext({ recordVideo: { dir: out.videoDir, size: { width: 1280, height: 720 } }, viewport: { width: 1280, height: 720 }, deviceScaleFactor: 1 });
    page = await ctx.newPage();
    log("context+page with recordVideo ok");
  } catch (e) { videoErr = String(e); log("recordVideo context FAILED:", videoErr); ctx = browser.contexts()[0]; page = await ctx.newPage(); }
  const g0 = Date.now();
  await page.goto("https://docs.getsolari.com", { waitUntil: "domcontentloaded", timeout: 30000 });
  log("goto docs.getsolari.com in", Date.now() - g0, "ms; title:", await page.title());
  const shot0 = Date.now();
  const buf = await page.screenshot({ type: "jpeg", quality: 80 });
  log("screenshot", buf.length, "bytes in", Date.now() - shot0, "ms");
  // burst of 10 screenshots to measure achievable fps via polling
  const b0 = Date.now(); let n = 0;
  while (Date.now() - b0 < 3000) { await page.screenshot({ type: "jpeg", quality: 70 }); n++; }
  log(`screenshot polling: ${n} frames in 3s => ${(n / 3).toFixed(1)} fps`);
  await page.mouse.move(400, 300); await page.mouse.wheel(0, 600); await page.waitForTimeout(800);
  await page.mouse.wheel(0, -600); await page.waitForTimeout(500);

  // (2) CDP screencast frame rate on the same page
  try {
    const cdp = await ctx.newCDPSession(page);
    let frames = 0, bytes = 0;
    cdp.on("Page.screencastFrame", async (ev) => { frames++; bytes += ev.data.length; try { await cdp.send("Page.screencastFrameAck", { sessionId: ev.sessionId }); } catch {} });
    await cdp.send("Page.startScreencast", { format: "jpeg", quality: 70, maxWidth: 1280, maxHeight: 720, everyNthFrame: 1 });
    const s0 = Date.now();
    for (let i = 0; i < 6; i++) { await page.mouse.wheel(0, i % 2 ? -300 : 300); await page.waitForTimeout(500); }
    await cdp.send("Page.stopScreencast");
    log(`CDP screencast: ${frames} frames, ${(bytes / 1024).toFixed(0)} KB base64 in ${Date.now() - s0} ms => ${(frames / ((Date.now() - s0) / 1000)).toFixed(1)} fps (only changed frames are sent)`);
  } catch (e) { log("CDP screencast FAILED:", String(e)); }

  // (2b) raw connectOverCDP as a second client on the same session
  try {
    const c0 = Date.now();
    const b2 = await chromium.connectOverCDP(browser.cdpEndpoint, { timeout: 15000 });
    log("connectOverCDP second client ok in", Date.now() - c0, "ms; contexts:", b2.contexts().length, "pages:", b2.contexts().flatMap(c => c.pages()).length);
    await b2.close();
  } catch (e) { log("connectOverCDP FAILED:", String(e)); }

  // close context to flush video
  if (page.video) { try { const v = page.video(); if (v) videoPath = await v.path(); } catch (e) { log("video().path() err", String(e)); } }
  await ctx.close();
  log("context closed; recordVideo error:", videoErr ?? "none");
  for (const f of fs.readdirSync(out.videoDir)) { const st = fs.statSync(path.join(out.videoDir, f)); log("VIDEO FILE", f, st.size, "bytes"); }
} finally {
  const id = browser?.id;
  if (browser) { await browser.close(); log("browser closed"); }
  // (3) rrweb replay
  if (id) {
    for (let i = 1; i <= 10; i++) {
      await new Promise(r => setTimeout(r, 3000));
      try {
        const ru = await solari.sessions.getReplayUrl(id);
        const blob = await solari.sessions.downloadReplay(id);
        const text = Buffer.from(blob).toString("utf8");
        const lines = text.split("\n").filter(Boolean);
        const types = {}; for (const l of lines) { try { const e = JSON.parse(l); types[e.type] = (types[e.type] || 0) + 1; } catch {} }
        log(`REPLAY ok attempt ${i}: ${blob.length} bytes, ${lines.length} rrweb events, types=${JSON.stringify(types)}, encoding=${ru.contentEncoding}, expiresIn=${ru.expiresInSeconds}s`);
        log("first event:", lines[0].slice(0, 160));
        fs.writeFileSync("replay.ndjson", text);
        break;
      } catch (e) { log(`replay attempt ${i}: ${String(e).slice(0, 120)}`); }
    }
  }
  await solari.close();
  clearTimeout(killTimer);
  log("done");
}
