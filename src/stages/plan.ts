import { z } from "zod";
import type { PageScan } from "../adapters/browser/index.js";
import type { Llm } from "../adapters/llm/index.js";
import { PlannerError } from "../core/errors.js";
import { ActionSchema, LangSchema, type Action, type Storyboard, type Viewport } from "../core/schema.js";
import { validateStoryboard, wordCount } from "../core/storyboard.js";

export const PLANNER_SYSTEM = `You write storyboards for short narrated product demo videos recorded in a real browser.
Rules:
- 4 to 7 scenes. Each scene has "say" (8 to 24 words of spoken narration: plain, concrete, present tense, no hype, no exclamation marks) and "do" (0 to 4 browser actions that happen while the line is spoken).
- Narrate what the viewer is looking at. Name real features and real text from the page. Never invent features.
- The first scene starts with {"goto": "<the page url>"}.
- Actions: {"goto": url} | {"scroll_to": selector} | {"scroll": pixels} | {"hover": selector} | {"click": selector} | {"type": {"selector": s, "text": t}} | {"press": key} | {"wait": ms}.
- Use ONLY selectors from the CANDIDATES list, verbatim. Use ONLY same-site links from the LINKS list for goto. Never guess a selector.
- Prefer scroll_to and hover to show sections; use at most 2 clicks in the whole demo; never type into anything that looks like login, payment or personal data; never submit forms.
- Keep the whole demo under 60 seconds of speech.
- "title" is the product name (2 to 5 words). "sentence" is a one-line pitch under 20 words.`;

const PlanOutputSchema = z
  .object({
    title: z.string().trim().min(1).max(120),
    sentence: z.string().trim().min(1).max(300),
    scenes: z
      .array(
        z
          .object({
            say: z.string().trim().min(3).max(400),
            do: z.array(ActionSchema).max(6).default([]),
          })
          .strict(),
      )
      .min(1)
      .max(8),
  })
  .strict();

const actionVariant = (key: string, type: "string" | "integer") => ({
  type: "object",
  required: [key],
  properties: { [key]: { type } },
  additionalProperties: false,
});

/** JSON-schema text for backends that cannot enforce a schema server-side. */
export const PLAN_SCHEMA_HINT = JSON.stringify({
  type: "object",
  additionalProperties: false,
  required: ["title", "sentence", "scenes"],
  properties: {
    title: { type: "string" },
    sentence: { type: "string" },
    scenes: {
      type: "array",
      minItems: 1,
      maxItems: 8,
      items: {
        type: "object",
        additionalProperties: false,
        required: ["say", "do"],
        properties: {
          say: { type: "string" },
          do: {
            type: "array",
            maxItems: 6,
            items: {
              oneOf: [
                actionVariant("goto", "string"),
                actionVariant("scroll_to", "string"),
                actionVariant("scroll", "integer"),
                actionVariant("hover", "string"),
                actionVariant("click", "string"),
                {
                  type: "object",
                  required: ["type"],
                  properties: {
                    type: {
                      type: "object",
                      required: ["selector", "text"],
                      properties: { selector: { type: "string" }, text: { type: "string" } },
                      additionalProperties: false,
                    },
                  },
                  additionalProperties: false,
                },
                actionVariant("press", "string"),
                actionVariant("wait", "integer"),
              ],
            },
          },
        },
      },
    },
  },
});

export interface PlanInput {
  url: string;
  sentence?: string;
  scan: PageScan;
  screenshotJpegBase64?: string;
  lang?: string[];
  viewport?: Viewport;
  maxScenes?: number;
}

export interface PlanResult {
  storyboard: Storyboard;
  warnings: string[];
}

function sameSite(a: URL, b: URL): boolean {
  const strip = (h: string) => h.replace(/^www\./, "");
  return strip(a.hostname) === strip(b.hostname);
}

function parseUrl(value: string, base?: URL): URL | null {
  try {
    return new URL(value, base);
  } catch {
    return null;
  }
}

export function buildPlannerPrompt(input: PlanInput): string {
  const { scan } = input;
  const base = new URL(input.url);
  const links = scan.links
    .filter((l) => {
      const u = parseUrl(l.href);
      return u !== null && sameSite(u, base);
    })
    .slice(0, 40)
    .map((l) => `- "${l.text}" -> ${l.href}`)
    .join("\n");
  const candidates = scan.candidates.map((c) => `- ${c.selector}   (${c.role}${c.text ? `: ${c.text}` : ""})`).join("\n");
  return [
    `PAGE URL: ${input.url}`,
    `PAGE TITLE: ${scan.title}`,
    input.sentence ? `WHAT THE OWNER SAYS IT IS: ${input.sentence}` : "",
    `PAGE TEXT (trimmed):\n${scan.text.slice(0, 6000)}`,
    `LINKS (same site):\n${links || "(none)"}`,
    `CANDIDATES (the only selectors you may use):\n${candidates || "(none)"}`,
    "Write the storyboard now.",
  ]
    .filter(Boolean)
    .join("\n\n");
}

/**
 * Asks the model for scenes, then keeps only actions that point at real selectors and same-site links. Bad actions
 * are dropped with a warning rather than failing the render: a demo with one fewer hover is still a demo.
 */
export async function planStoryboard(llm: Llm, input: PlanInput): Promise<PlanResult> {
  const output = await llm.complete({
    system: PLANNER_SYSTEM,
    user: buildPlannerPrompt(input),
    imageJpegBase64: input.screenshotJpegBase64,
    schema: PlanOutputSchema,
    schemaHint: PLAN_SCHEMA_HINT,
    maxTokens: 6000,
  });
  const warnings: string[] = [];
  const base = new URL(input.url);
  const selectors = new Set(input.scan.candidates.map((c) => c.selector));
  const inputSelectors = new Set(input.scan.candidates.filter((c) => c.role === "input").map((c) => c.selector));
  const linkHrefs = new Set(input.scan.links.map((l) => l.href));

  const scenes = output.scenes.slice(0, input.maxScenes ?? 7).map((scene, i) => {
    const kept: Action[] = [];
    for (const action of scene.do) {
      if ("goto" in action) {
        const target = parseUrl(action.goto, base);
        if (!target) {
          warnings.push(`scene ${i + 1}: dropped goto "${action.goto}" (not a URL)`);
          continue;
        }
        const ok = target.href === base.href || linkHrefs.has(target.href) || (sameSite(target, base) && target.pathname === "/");
        if (!ok) {
          warnings.push(`scene ${i + 1}: dropped goto "${action.goto}" (not a link on the page)`);
          continue;
        }
        kept.push({ goto: target.href });
        continue;
      }
      if ("type" in action) {
        if (!inputSelectors.has(action.type.selector)) {
          warnings.push(`scene ${i + 1}: dropped type into "${action.type.selector}" (not an input candidate)`);
          continue;
        }
        kept.push(action);
        continue;
      }
      const sel = "scroll_to" in action ? action.scroll_to : "hover" in action ? action.hover : "click" in action ? action.click : null;
      if (sel !== null && !selectors.has(sel)) {
        warnings.push(`scene ${i + 1}: dropped action on "${sel}" (not a candidate selector)`);
        continue;
      }
      kept.push(action);
    }
    if (i === 0 && !kept.some((a) => "goto" in a)) kept.unshift({ goto: base.href });
    if (wordCount(scene.say) > 30) warnings.push(`scene ${i + 1}: narration is long (${wordCount(scene.say)} words)`);
    return { say: scene.say, do: kept };
  });

  const clicks = scenes.flatMap((s) => s.do).filter((a) => "click" in a).length;
  if (clicks > 3) warnings.push(`storyboard has ${clicks} clicks; consider fewer`);

  const storyboard = validateStoryboard(
    {
      version: 1,
      title: output.title,
      url: base.href,
      sentence: input.sentence ?? output.sentence,
      lang: input.lang ?? ["en"],
      viewport: input.viewport ?? "1920x1080",
      scenes,
    },
    "planned storyboard",
  );
  return { storyboard, warnings };
}

const TranslationSchema = z.object({ lines: z.array(z.string().trim().min(1)) }).strict();

/** Translates narration lines for a localized render, keeping count and order. */
export async function translateNarration(llm: Llm, lines: string[], lang: string): Promise<string[]> {
  LangSchema.parse(lang);
  const out = await llm.complete({
    system:
      "You translate short spoken narration lines for a product demo. Keep product names, keep the meaning, keep each line short and natural to say aloud.",
    user: `Translate each line into the language with BCP-47 code "${lang}". Return the same number of lines in the same order.\n\n${lines
      .map((l, i) => `${i + 1}. ${l}`)
      .join("\n")}`,
    schema: TranslationSchema,
    schemaHint: JSON.stringify({
      type: "object",
      required: ["lines"],
      properties: { lines: { type: "array", items: { type: "string" } } },
      additionalProperties: false,
    }),
    maxTokens: 4000,
  });
  if (out.lines.length !== lines.length) {
    throw new PlannerError(`translation returned ${out.lines.length} lines for ${lines.length}`);
  }
  return out.lines;
}
