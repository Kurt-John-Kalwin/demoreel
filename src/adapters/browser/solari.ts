import { Solari, SolariError, type BrowserSession } from "@solarisdk/browser";
import type { BrowserContext, Page } from "patchright-core";
import type { Box } from "../../core/schema.js";
import { CapacityError, DriveError } from "../../core/errors.js";
import type { BrowserHandle, BrowserProvider, DriverPage, OpenOptions, PageScan } from "./index.js";

export interface SolariProviderOptions {
  apiKey: string;
  baseUrl?: string;
}

export const NAV_TIMEOUT_MS = 30_000;
/** Longest a smooth scroll is allowed to animate before the page reports back anyway. */
const SCROLL_SETTLE_MS = 2500;
export const ACTION_TIMEOUT_MS = 8_000;

/**
 * Extra request headers for the recording context, as a JSON object in DEMOREEL_EXTRA_HEADERS.
 *
 * A cloud browser cannot be handed a cookie or a click, so a preview that is gated on a header
 * — an ngrok free tunnel's browser interstitial, a Vercel protection bypass, a staging edge that
 * wants a shared token — is otherwise unrecordable. Malformed JSON is ignored rather than fatal:
 * losing the whole render to a typo in an env var is a worse failure than a missing header, which
 * announces itself immediately as the wrong page on screen.
 */
export function extraHeadersFromEnv(env: NodeJS.ProcessEnv = process.env): Record<string, string> | undefined {
  const raw = env.DEMOREEL_EXTRA_HEADERS;
  if (!raw || !raw.trim()) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return undefined;
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return undefined;
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(parsed)) {
    if (typeof value === "string" && key.trim()) out[key.trim()] = value;
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

/** Runs the page in a Solari cloud browser; footage comes from Playwright's server-side recorder. */
export class SolariProvider implements BrowserProvider {
  readonly name = "solari";
  private readonly opts: SolariProviderOptions;
  constructor(opts: SolariProviderOptions) {
    if (!opts.apiKey) throw new DriveError("SOLARI_API_KEY is not set");
    this.opts = opts;
  }

  async open(opts: OpenOptions): Promise<BrowserHandle> {
    // maxAttempts 1: the 0.1.3 client retries POST /sessions unconditionally, which can leak a second billed session.
    const solari = new Solari({ apiKey: this.opts.apiKey, baseUrl: this.opts.baseUrl, maxAttempts: 1, timeoutMs: 45_000 });
    let session: BrowserSession;
    try {
      const launch: Parameters<Solari["launch"]>[0] = { stealth: opts.stealth ?? true };
      if (opts.proxy) launch.proxy = opts.proxy;
      session = await solari.launch(launch);
    } catch (err) {
      await solari.close().catch(() => {});
      if (err instanceof SolariError && (err.status === 429 || err.code === "ConcurrencyLimitExceeded")) throw new CapacityError();
      if (err instanceof SolariError && err.status === 402) throw new DriveError("the Solari plan does not allow this feature", err);
      throw new DriveError(`could not launch a Solari browser: ${(err as Error).message}`, err, true);
    }
    let context: BrowserContext;
    let page: Page;
    try {
      const extraHTTPHeaders = extraHeadersFromEnv();
      context = await session.newContext({
        viewport: opts.viewport,
        deviceScaleFactor: 1,
        ...(extraHTTPHeaders ? { extraHTTPHeaders } : {}),
        ...(opts.recordDir ? { recordVideo: { dir: opts.recordDir, size: opts.viewport } } : {}),
      });
      page = await context.newPage();
      page.setDefaultNavigationTimeout(NAV_TIMEOUT_MS);
      page.setDefaultTimeout(ACTION_TIMEOUT_MS);
    } catch (err) {
      await session.close().catch(() => {});
      await solari.close().catch(() => {});
      throw new DriveError(`could not open a recording context: ${(err as Error).message}`, err, true);
    }
    const startedAt = Date.now();
    const driverPage = new PlaywrightDriverPage(page, opts.viewport);
    let closed = false;
    return {
      page: driverPage,
      elapsedMs: () => Date.now() - startedAt,
      async saveVideo(file: string) {
        const video = page.video();
        if (!video) throw new DriveError("this session was opened without recording");
        await page.close();
        await video.saveAs(file);
        return file;
      },
      async replay() {
        return null;
      },
      async close() {
        if (closed) return;
        closed = true;
        await context.close().catch(() => {});
        await session.close().catch(() => {});
        await solari.close().catch(() => {});
      },
    };
  }
}

export class PlaywrightDriverPage implements DriverPage {
  constructor(
    private readonly page: Page,
    private readonly viewport: { width: number; height: number },
  ) {}

  async goto(url: string): Promise<{ status?: number }> {
    const res = await this.page.goto(url, { waitUntil: "domcontentloaded" });
    await this.page.waitForLoadState("load", { timeout: 10_000 }).catch(() => {});
    return { status: res?.status() };
  }

  title(): Promise<string> {
    return this.page.title();
  }

  async scan(): Promise<PageScan> {
    const data = (await this.page.evaluate(PAGE_SCAN_SCRIPT)) as Omit<PageScan, "url">;
    return { ...data, url: this.page.url() };
  }

  async boxOf(selector: string): Promise<Box | null> {
    const loc = this.page.locator(selector).first();
    try {
      await loc.waitFor({ state: "visible", timeout: ACTION_TIMEOUT_MS });
    } catch {
      return null;
    }
    const box = await loc.boundingBox();
    if (!box) return null;
    return { x: box.x, y: box.y, w: box.width, h: box.height };
  }

  /** Scrolls with wheel events so the motion is visible in the footage, then settles. */
  async scrollIntoView(selector: string): Promise<void> {
    const loc = this.page.locator(selector).first();
    await loc.waitFor({ state: "attached", timeout: ACTION_TIMEOUT_MS });
    let box = await loc.boundingBox();
    if (!box) {
      await loc.scrollIntoViewIfNeeded({ timeout: ACTION_TIMEOUT_MS });
      return;
    }
    // Put the element a third of the way down rather than dead centre: headings read better with the section
    // body under them, and a centred h2 leaves the section's own heading half off the top of frame.
    const target = box.y - this.viewport.height / 3;
    if (Math.abs(target) > 24) await this.wheel(Math.round(target));
    box = await loc.boundingBox();
    if (box && (box.y < 0 || box.y > this.viewport.height)) await loc.scrollIntoViewIfNeeded({ timeout: ACTION_TIMEOUT_MS });
    await this.page.waitForTimeout(250);
  }

  /**
   * One round trip. The previous implementation sent twelve `mouse.wheel` events with a 45 ms sleep between each,
   * which is 24 CDP round trips to a cloud browser: measured at 11.2 s for a single 1600 px scroll, and the 45 ms
   * sleeps were never the cost. The page animates its own scroll instead and reports back once it settles, so the
   * motion is still visible in the footage but the wall clock is one RTT plus the animation.
   */
  async wheel(deltaY: number): Promise<void> {
    const delta = Math.round(deltaY);
    if (delta === 0) return;
    // A plain string: `evaluate(fn)` under tsx leaks esbuild's keepNames helper into the page (`__name is not defined`).
    await this.page.evaluate(`new Promise((resolve) => {
      window.scrollBy({ top: ${delta}, left: 0, behavior: "smooth" });
      let last = null;
      let still = 0;
      const started = Date.now();
      const iv = setInterval(() => {
        const y = window.scrollY;
        if (last !== null && Math.abs(y - last) < 1) { still += 1; } else { still = 0; }
        last = y;
        if (still >= 3 || Date.now() - started > ${SCROLL_SETTLE_MS}) { clearInterval(iv); resolve(y); }
      }, 50);
    })`);
  }

  async moveMouse(x: number, y: number): Promise<void> {
    await this.page.mouse.move(x, y, { steps: 12 });
  }

  async click(x: number, y: number): Promise<void> {
    await this.page.mouse.click(x, y);
  }

  async type(selector: string, text: string): Promise<void> {
    const loc = this.page.locator(selector).first();
    await loc.click({ timeout: ACTION_TIMEOUT_MS });
    await loc.pressSequentially(text, { delay: 55 });
  }

  async press(key: string): Promise<void> {
    await this.page.keyboard.press(key);
  }

  wait(ms: number): Promise<void> {
    return this.page.waitForTimeout(ms);
  }

  async screenshotJpeg(): Promise<Buffer> {
    return this.page.screenshot({ type: "jpeg", quality: 70 });
  }
}

/**
 * Runs inside the page as a plain expression (a string, so no transpiler helpers leak into the page).
 * Collects text, same-page links and stable selectors for the planner. Keep it self-contained ES2020.
 */
export const PAGE_SCAN_SCRIPT = `(() => {
  const clean = (s) => (s || "").replace(/\\s+/g, " ").trim();
  const visible = (el) => {
    const r = el.getBoundingClientRect();
    const st = getComputedStyle(el);
    return r.width > 4 && r.height > 4 && st.visibility !== "hidden" && st.display !== "none";
  };
  const cssEscape = (s) => (window.CSS && CSS.escape ? CSS.escape(s) : s.replace(/[^a-zA-Z0-9_-]/g, "\\\\$&"));
  const quote = (s) => s.replace(/"/g, "'");
  const text = clean(document.body && document.body.innerText).slice(0, 6000);
  const links = [];
  const candidates = [];
  const seenSel = new Set();
  const seenLink = new Set();
  const textCounts = new Map();
  const all = Array.from(document.querySelectorAll("a[href], button, [role=button], input, textarea, select, h1, h2, h3, section[id], [id]"));
  for (const el of all) {
    const t = clean(el.textContent).slice(0, 80);
    if (t) textCounts.set(t, (textCounts.get(t) || 0) + 1);
  }
  const push = (selector, role, t) => {
    if (seenSel.has(selector) || candidates.length >= 60) return;
    seenSel.add(selector);
    candidates.push({ selector, role, text: t });
  };
  for (const el of all) {
    if (!visible(el)) continue;
    const t = clean(el.textContent).slice(0, 80);
    const id = el.getAttribute("id");
    const tag = el.tagName.toLowerCase();
    if (tag === "a") {
      const href = el.href;
      if (t && href && links.length < 40 && !seenLink.has(t)) {
        seenLink.add(t);
        links.push({ text: t, href });
      }
      if (id) push("#" + cssEscape(id), "link", t);
      else if (t && t.length <= 40 && textCounts.get(t) === 1) push('a:has-text("' + quote(t) + '")', "link", t);
      continue;
    }
    if (tag === "button" || el.getAttribute("role") === "button") {
      if (id) push("#" + cssEscape(id), "button", t);
      else if (t && t.length <= 40 && textCounts.get(t) === 1) push('button:has-text("' + quote(t) + '")', "button", t);
      continue;
    }
    if (tag === "input" || tag === "textarea" || tag === "select") {
      const type = (el.getAttribute("type") || "text").toLowerCase();
      if (["hidden", "submit", "password", "file"].includes(type)) continue;
      const name = el.getAttribute("name");
      const placeholder = el.getAttribute("placeholder");
      const label = clean(placeholder || el.getAttribute("aria-label") || name || "");
      if (id) push("#" + cssEscape(id), "input", label);
      else if (name) push(tag + '[name="' + name + '"]', "input", label);
      else if (placeholder) push(tag + '[placeholder="' + quote(placeholder) + '"]', "input", label);
      continue;
    }
    if (/^h[1-3]$/.test(tag)) {
      if (id) push("#" + cssEscape(id), "heading", t);
      else if (t && textCounts.get(t) === 1) push(tag + ':has-text("' + quote(t.slice(0, 60)) + '")', "heading", t);
      continue;
    }
    if (id && (tag === "section" || el.getBoundingClientRect().height > 120)) push("#" + cssEscape(id), "section", t.slice(0, 40));
  }
  const passwordFields = document.querySelectorAll('input[type="password"]').length;
  return { title: clean(document.title), text, links, candidates, passwordFields };
})()`;
