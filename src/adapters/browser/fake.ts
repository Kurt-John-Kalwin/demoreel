import { writeColorClip } from "../../render/ffmpeg.js";
import type { Box } from "../../core/schema.js";
import type { BrowserHandle, BrowserProvider, DriverPage, OpenOptions, PageScan } from "./index.js";

export interface FakeSite {
  scan: Omit<PageScan, "url">;
  boxes: Record<string, Box>;
  status?: number;
}

/**
 * Offline stand-in for the cloud browser: answers selector lookups from a table, records every call, and writes a
 * solid-colour clip of the right length so the render stage runs for real in tests.
 */
export class FakeBrowserProvider implements BrowserProvider {
  readonly name = "fake";
  readonly calls: Array<{ method: string; args: unknown[] }> = [];
  constructor(private readonly site: FakeSite, private readonly clock: { now(): number; sleep(ms: number): Promise<void> } = realClock()) {}

  async open(opts: OpenOptions): Promise<BrowserHandle> {
    const startedAt = this.clock.now();
    const calls = this.calls;
    const site = this.site;
    const clock = this.clock;
    let currentUrl = "about:blank";
    const record = (method: string, ...args: unknown[]) => calls.push({ method, args });
    const page: DriverPage = {
      async goto(url) {
        record("goto", url);
        currentUrl = url;
        await clock.sleep(120);
        return { status: site.status ?? 200 };
      },
      async title() {
        return site.scan.title;
      },
      async scan() {
        return { ...site.scan, url: currentUrl };
      },
      async boxOf(selector) {
        record("boxOf", selector);
        return site.boxes[selector] ?? null;
      },
      async scrollIntoView(selector) {
        record("scrollIntoView", selector);
        await clock.sleep(80);
      },
      async wheel(deltaY) {
        record("wheel", deltaY);
        await clock.sleep(60);
      },
      async moveMouse(x, y) {
        record("moveMouse", x, y);
      },
      async click(x, y) {
        record("click", x, y);
        await clock.sleep(40);
      },
      async type(selector, text) {
        record("type", selector, text);
        await clock.sleep(20 * text.length);
      },
      async press(key) {
        record("press", key);
      },
      async wait(ms) {
        await clock.sleep(ms);
      },
      async screenshotJpeg() {
        return Buffer.from("");
      },
    };
    return {
      page,
      elapsedMs: () => clock.now() - startedAt,
      async saveVideo(file) {
        const ms = Math.max(1000, clock.now() - startedAt);
        const target = file.replace(/\.webm$/, ".mp4");
        await writeColorClip(target, { width: opts.viewport.width, height: opts.viewport.height, ms });
        return target;
      },
      async replay() {
        return null;
      },
      async close() {
        record("close");
      },
    };
  }
}

export function realClock() {
  return { now: () => Date.now(), sleep: (ms: number) => new Promise<void>((r) => setTimeout(r, ms)) };
}

/** Deterministic clock for tests: sleeping advances time instantly. */
export function fakeClock(start = 0) {
  let now = start;
  return {
    now: () => now,
    sleep: async (ms: number) => {
      now += ms;
    },
  };
}
