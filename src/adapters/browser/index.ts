import { ValidationError } from "../../core/errors.js";
import type { Box } from "../../core/schema.js";

export interface OpenOptions {
  viewport: { width: number; height: number };
  /** directory for the recorded footage; omit to run without recording */
  recordDir?: string;
  stealth?: boolean;
  proxy?: string;
  /** rolling budget for the whole session; the driver aborts past it */
  wallClockMs?: number;
}

export interface LinkInfo {
  text: string;
  href: string;
}

export interface CandidateInfo {
  /** Playwright selector that resolves to exactly this element */
  selector: string;
  role: "link" | "button" | "input" | "heading" | "section";
  text: string;
}

export interface PageScan {
  title: string;
  url: string;
  text: string;
  links: LinkInfo[];
  candidates: CandidateInfo[];
  passwordFields: number;
  httpStatus?: number;
}

/** The subset of a page the driver needs. Narrow so a fake can stand in for a cloud browser in tests. */
export interface DriverPage {
  goto(url: string): Promise<{ status?: number }>;
  title(): Promise<string>;
  scan(): Promise<PageScan>;
  /** bounding box of the first match in viewport coordinates, or null */
  boxOf(selector: string): Promise<Box | null>;
  scrollIntoView(selector: string): Promise<void>;
  wheel(deltaY: number): Promise<void>;
  moveMouse(x: number, y: number): Promise<void>;
  click(x: number, y: number): Promise<void>;
  type(selector: string, text: string): Promise<void>;
  press(key: string): Promise<void>;
  wait(ms: number): Promise<void>;
  screenshotJpeg(): Promise<Buffer>;
}

export interface BrowserHandle {
  readonly page: DriverPage;
  /** ms since the page (and its recording) was created */
  elapsedMs(): number;
  /** stops recording and writes the footage; resolves to the file path */
  saveVideo(file: string): Promise<string>;
  /** the vendor's own session replay, when one exists */
  replay(): Promise<Uint8Array | null>;
  close(): Promise<void>;
}

export interface BrowserProvider {
  readonly name: string;
  open(opts: OpenOptions): Promise<BrowserHandle>;
}

/**
 * The provider a render should use. Solari by default — a clean, stealthy, consistent machine —
 * and a local Chromium when DEMOREEL_BROWSER=local, which is what a demo of an app running on
 * this machine needs: filming localhost otherwise means publishing a dev server to the internet
 * just to point a camera at it.
 */
export async function pickBrowser(env: NodeJS.ProcessEnv = process.env): Promise<BrowserProvider> {
  if (env.DEMOREEL_BROWSER === "local") {
    const { LocalProvider } = await import("./local.js");
    return new LocalProvider();
  }
  const apiKey = env.SOLARI_API_KEY;
  if (!apiKey) {
    throw new ValidationError(
      "SOLARI_API_KEY is not set (get one at https://console.getsolari.com), or set DEMOREEL_BROWSER=local to film with a Chromium on this machine",
    );
  }
  const { SolariProvider } = await import("./solari.js");
  return new SolariProvider({ apiKey, ...(env.SOLARI_BASE_URL ? { baseUrl: env.SOLARI_BASE_URL } : {}) });
}
