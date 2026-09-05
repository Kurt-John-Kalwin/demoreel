// Mine Reddit pain via a stealth Solari cloud browser (plain HTTP is blocked).
import { Solari } from "@solarisdk/browser";
import fs from "node:fs";
const t0 = Date.now(); const log = (...a) => console.log(`[${((Date.now()-t0)/1000).toFixed(0)}s]`, ...a);
const solari = new Solari({ apiKey: process.env.SOLARI_API_KEY });
const kill = setTimeout(() => { console.error("HARD TIMEOUT"); process.exit(9); }, 290_000);
const queries = [ ["SaaS", "demo video stale OR outdated OR re-record"], 
  ["SaaS", "demo video"], ["startups", "demo video"], ["indiehackers", "demo video"], ["SideProject", "demo video"],
  ["iOSProgramming", "app preview video"], ["ProductManagement", "demo video"], ["technicalwriting", "video outdated"],
  ["ExperiencedDevs", "screen recording PR"], ["webdev", "demo video"], ["microsaas", "demo video"],
];
const out = [];
let browser;
try {
  browser = await solari.launch({ stealth: true, proxy: "us" }); log("proxy resolved:", JSON.stringify(browser.proxy));
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const page = await ctx.newPage();
  page.setDefaultNavigationTimeout(25000);
  for (const [sub, q] of queries) {
    const url = `https://old.reddit.com/r/${sub}/search?q=${encodeURIComponent(q)}&restrict_sr=on&sort=relevance&t=all`;
    try {
      await page.goto(url, { waitUntil: "domcontentloaded" });
      const title = await page.title();
      const results = await page.$$eval(".search-result", els => els.slice(0, 6).map(e => ({
        title: e.querySelector(".search-title")?.textContent?.trim() ?? "",
        href: e.querySelector(".search-title")?.getAttribute("href") ?? "",
        score: e.querySelector(".search-score")?.textContent?.trim() ?? "",
        comments: e.querySelector(".search-comments")?.textContent?.trim() ?? "",
        time: e.querySelector("time")?.getAttribute("datetime") ?? "",
      })));
      log(`r/${sub} "${q}": page="${title.slice(0,50)}" results=${results.length}`);
      for (const r of results) { console.log(`   ${r.time.slice(0,10)} | ${r.score} | ${r.comments} | ${r.title.slice(0,110)} | ${r.href}`); }
      // open top 2 posts for body + top comments
      for (const r of results.slice(0, 2)) {
        if (!r.href) continue;
        try {
          await page.goto(r.href.replace("www.reddit.com", "old.reddit.com"), { waitUntil: "domcontentloaded" });
          const body = await page.$$eval(".expando .usertext-body .md, .self .usertext-body .md", els => els[0]?.innerText?.trim().slice(0, 700) ?? "");
          const comments = await page.$$eval(".commentarea .comment > .entry .usertext-body .md", els => els.slice(0, 4).map(e => e.innerText.trim().replace(/\s+/g, " ").slice(0, 320)));
          out.push({ sub, q, ...r, body, comments });
          console.log(`     BODY: ${body.replace(/\s+/g, " ").slice(0, 400)}`);
          comments.forEach(c => console.log(`     - ${c}`));
        } catch (e) { console.log(`     (post fetch failed: ${String(e).slice(0, 80)})`); }
      }
    } catch (e) { log(`r/${sub} "${q}" FAILED: ${String(e).slice(0, 120)}`); }
  }
  for (const site of ["https://demofly.ai", "https://waitlist.buildshot.xyz/?source=HN", "https://www.clueso.io"]) {
    try { await page.goto(site, { waitUntil: "domcontentloaded", timeout: 30000 }); await page.waitForTimeout(2500);
      const txt = await page.evaluate(() => document.body.innerText.replace(/\s+/g, " ").trim());
      console.log(`\n=== SITE ${site} (${txt.length} chars) ===\n${txt.slice(0, 1800)}`);
    } catch (e) { console.log(`SITE ${site} failed: ${String(e).slice(0,100)}`); }
  }
} finally { if (browser) await browser.close(); await solari.close(); clearTimeout(kill); fs.writeFileSync("reddit-pain.json", JSON.stringify(out, null, 1)); log("done", out.length, "posts saved"); }
