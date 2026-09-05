import type { BrowserProvider, PageScan } from "../adapters/browser/index.js";
import type { Logger } from "../core/log.js";
import { classifyPage, type PageKind } from "../guards/page.js";

export interface ScanOptions {
  url: URL;
  browser: BrowserProvider;
  viewport: { width: number; height: number };
  log: Logger;
  screenshot?: boolean;
}

export interface ScanResult {
  scan: PageScan;
  screenshotJpegBase64?: string;
  classification: { kind: PageKind; reason: string };
  browserSeconds: number;
}

/** Opens the page once without recording and collects what the planner and the guards need. */
export async function scanPage(opts: ScanOptions): Promise<ScanResult> {
  const handle = await opts.browser.open({ viewport: opts.viewport, stealth: true, wallClockMs: 60_000 });
  try {
    const nav = await handle.page.goto(opts.url.toString());
    await handle.page.wait(700);
    const scan = await handle.page.scan();
    if (nav.status !== undefined) scan.httpStatus = nav.status;
    const screenshotJpegBase64 = opts.screenshot ? (await handle.page.screenshotJpeg()).toString("base64") : undefined;
    const classification = classifyPage({
      url: scan.url,
      title: scan.title,
      passwordFields: scan.passwordFields,
      textSample: scan.text.slice(0, 800),
      httpStatus: nav.status,
    });
    opts.log.info("scanned", {
      title: scan.title,
      links: scan.links.length,
      candidates: scan.candidates.length,
      kind: classification.kind,
    });
    return { scan, screenshotJpegBase64, classification, browserSeconds: handle.elapsedMs() / 1000 };
  } finally {
    await handle.close();
  }
}
