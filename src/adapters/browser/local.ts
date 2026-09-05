import { chromium, type Browser, type BrowserContext, type Page } from "patchright-core";
import { DriveError } from "../../core/errors.js";
import { PlaywrightDriverPage, NAV_TIMEOUT_MS, ACTION_TIMEOUT_MS } from "./solari.js";
import type { BrowserHandle, BrowserProvider, OpenOptions } from "./index.js";

/**
 * Records the page in a Chromium on this machine.
 *
 * The cloud provider is the right one for a public URL: it is a clean, stealthy, consistent
 * machine. But a demo of a *local* app cannot be filmed from the cloud without publishing that
 * app to the internet first, and standing up a tunnel to show a dev server to a camera is a
 * poor trade. This provider films `http://localhost:...` directly.
 *
 * It is the same Playwright underneath, so `PlaywrightDriverPage` — every selector, scroll and
 * click rule the cloud path uses — is reused unchanged, and the footage lands in the same
 * WebM the renderer already expects. What is lost is stealth and a consistent machine: the
 * page sees a local, un-proxied Chromium, so use the cloud for anything bot-sensitive.
 */
export class LocalProvider implements BrowserProvider {
  readonly name = "local";

  async open(opts: OpenOptions): Promise<BrowserHandle> {
    let browser: Browser;
    try {
      browser = await chromium.launch({ headless: true });
    } catch (err) {
      throw new DriveError(
        `could not launch a local Chromium: ${(err as Error).message}. Install one with "npx patchright install chromium".`,
        err,
      );
    }
    let context: BrowserContext;
    let page: Page;
    try {
      context = await browser.newContext({
        viewport: opts.viewport,
        deviceScaleFactor: 1,
        ...(opts.recordDir ? { recordVideo: { dir: opts.recordDir, size: opts.viewport } } : {}),
      });
      page = await context.newPage();
      page.setDefaultNavigationTimeout(NAV_TIMEOUT_MS);
      page.setDefaultTimeout(ACTION_TIMEOUT_MS);
    } catch (err) {
      await browser.close().catch(() => {});
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
        // The video is only finalized once the page closes, exactly as on the cloud path.
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
        await browser.close().catch(() => {});
      },
    };
  }
}
