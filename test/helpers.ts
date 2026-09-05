import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { FakeSite } from "../src/adapters/browser/fake.js";
import { silentLogger } from "../src/core/log.js";
import { validateStoryboard, type Storyboard } from "../src/index.js";

export const log = silentLogger;

export function sampleStoryboard(overrides: Partial<Storyboard> = {}): Storyboard {
  return validateStoryboard({
    version: 1,
    title: "Top Sets",
    url: "https://topsets.app/",
    sentence: "A hypertrophy tracker that plans your next set for you.",
    viewport: "1280x720",
    scenes: [
      { say: "Top Sets is a hypertrophy tracker that plans your next set for you.", do: [{ goto: "https://topsets.app/" }] },
      { say: "Every row in the log is alive and judges each set.", do: [{ scroll_to: "#living-list" }, { hover: "#living-list" }] },
      { say: "The program builder is real buttons.", do: [{ click: "a:has-text(\"Builder\")" }, { click: "#missing" }] },
    ],
    ...overrides,
  });
}

export const sampleSite: FakeSite = {
  scan: {
    title: "Top Sets: the set list that thinks between sets",
    text: "Top Sets is a hypertrophy tracker. Log a set in two taps. The living list. The builder. Coaches.",
    links: [
      { text: "Builder", href: "https://topsets.app/#builder" },
      { text: "Coaches", href: "https://topsets.app/coaches" },
      { text: "Twitter", href: "https://x.com/topsets" },
    ],
    candidates: [
      { selector: "#living-list", role: "section", text: "the living list" },
      { selector: "a:has-text(\"Builder\")", role: "link", text: "Builder" },
      { selector: "input[name=\"email\"]", role: "input", text: "Email" },
      { selector: "h1:has-text(\"A set list\")", role: "heading", text: "A set list that thinks" },
    ],
    passwordFields: 0,
  },
  boxes: {
    "#living-list": { x: 100, y: 200, w: 600, h: 300 },
    "a:has-text(\"Builder\")": { x: 900, y: 40, w: 80, h: 30 },
    "input[name=\"email\"]": { x: 300, y: 500, w: 240, h: 40 },
  },
};

export async function tempDir(prefix = "demoreel-test-"): Promise<{ dir: string; cleanup: () => Promise<void> }> {
  const dir = await mkdtemp(join(tmpdir(), prefix));
  // Backstop for anything still writing here: node retries rm on ENOTEMPTY/EBUSY/EPERM.
  // Tests that queue background work should still await it -- this only covers the last gasp.
  return { dir, cleanup: () => rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }) };
}
