import { access } from "node:fs/promises";

const CANDIDATES = [
  "/System/Library/Fonts/Supplemental/Arial.ttf",
  "/System/Library/Fonts/Supplemental/Helvetica.ttf",
  "/Library/Fonts/Arial.ttf",
  "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf",
  "/usr/share/fonts/truetype/liberation/LiberationSans-Regular.ttf",
  "/usr/share/fonts/truetype/freefont/FreeSans.ttf",
  "/usr/share/fonts/TTF/DejaVuSans.ttf",
];

/** First readable TrueType font for drawtext; DEMOREEL_FONT overrides. Null means captions and cards are skipped. */
export async function findFont(env: NodeJS.ProcessEnv = process.env): Promise<string | null> {
  const list = env.DEMOREEL_FONT ? [env.DEMOREEL_FONT, ...CANDIDATES] : CANDIDATES;
  for (const p of list) {
    try {
      await access(p);
      return p;
    } catch {
      /* try next */
    }
  }
  return null;
}
