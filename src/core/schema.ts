import { z } from "zod";

/** Viewports the recorder supports. Phone size is portrait for social clips. */
export const ViewportSchema = z.enum(["1920x1080", "1280x720", "390x844"]);
export type Viewport = z.infer<typeof ViewportSchema>;

export function viewportSize(v: Viewport): { width: number; height: number } {
  const [w, h] = v.split("x").map(Number) as [number, number];
  return { width: w, height: h };
}

const selector = z.string().trim().min(1).max(300);

/** One browser action. Exactly one key per action, so a typo cannot silently become a no-op. */
export const ActionSchema = z.union([
  z.object({ goto: z.string().trim().min(1).max(2000) }).strict(),
  z.object({ scroll_to: selector }).strict(),
  z.object({ scroll: z.number().int().min(-10000).max(10000) }).strict(),
  z.object({ hover: selector }).strict(),
  z.object({ click: selector }).strict(),
  z.object({ type: z.object({ selector, text: z.string().min(1).max(200) }).strict() }).strict(),
  z.object({ press: z.string().trim().min(1).max(40) }).strict(),
  z.object({ wait: z.number().int().min(0).max(10000) }).strict(),
]);
export type Action = z.infer<typeof ActionSchema>;

export const SceneSchema = z
  .object({
    say: z
      .string()
      .trim()
      .min(3)
      .max(400)
      .refine((s) => s.split(/\s+/).length >= 2, "narration needs at least two words"),
    do: z.array(ActionSchema).max(12).default([]),
  })
  .strict();
export type Scene = z.infer<typeof SceneSchema>;

export const LangSchema = z.string().regex(/^[a-z]{2}(-[A-Z]{2})?$/, "use a BCP-47 code like en or pt-BR");

export const StoryboardSchema = z
  .object({
    version: z.literal(1),
    title: z.string().trim().min(1).max(120),
    url: z.string().url(),
    sentence: z.string().trim().max(300).optional(),
    /** Final card. Defaults to the host of `url` when unset, which is what a plain product demo wants. */
    outro: z.string().trim().min(1).max(80).optional(),
    /** Small grey line under the outro, the way `sentence` sits under `title`. */
    outroNote: z.string().trim().min(1).max(100).optional(),
    voice: z.string().trim().max(60).optional(),
    /** Music bed under the narration: a path relative to this file, or absolute. */
    music: z.string().trim().min(1).max(400).optional(),
    /** How far under the narration the bed sits, in dB. Ducking takes it further during speech. */
    musicDb: z.number().min(-60).max(0).optional(),
    lang: z.array(LangSchema).min(1).max(10).default(["en"]),
    viewport: ViewportSchema.default("1920x1080"),
    scenes: z.array(SceneSchema).min(1).max(12),
  })
  .strict();
export type Storyboard = z.infer<typeof StoryboardSchema>;
/** What a storyboard looks like before defaults are applied (what humans write). */
export type StoryboardInput = z.input<typeof StoryboardSchema>;

export const BoxSchema = z.object({ x: z.number(), y: z.number(), w: z.number(), h: z.number() });
export type Box = z.infer<typeof BoxSchema>;

export const ActionKindSchema = z.enum([
  "lead-in",
  "scene-start",
  "goto",
  "scroll_to",
  "scroll",
  "hover",
  "click",
  "type",
  "press",
  "wait",
  "tail",
]);
export type ActionKind = z.infer<typeof ActionKindSchema>;

/** One entry of the action log the driver writes while recording. `t` is ms since recording start. */
export const ActionEventSchema = z.object({
  t: z.number().nonnegative(),
  scene: z.number().int().min(-1),
  kind: ActionKindSchema,
  ok: z.boolean(),
  x: z.number().optional(),
  y: z.number().optional(),
  box: BoxSchema.optional(),
  selector: z.string().optional(),
  error: z.string().optional(),
});
export type ActionEvent = z.infer<typeof ActionEventSchema>;

export const SceneTimingSchema = z.object({
  index: z.number().int().min(0),
  startMs: z.number().nonnegative(),
  endMs: z.number().nonnegative(),
  narrationMs: z.number().nonnegative(),
});
export type SceneTiming = z.infer<typeof SceneTimingSchema>;

export const CostSchema = z.object({
  browserSeconds: z.number().nonnegative().default(0),
  ttsCharacters: z.number().nonnegative().default(0),
  llmCalls: z.number().nonnegative().default(0),
});
export type Cost = z.infer<typeof CostSchema>;

export const ManifestSchema = z.object({
  id: z.string(),
  createdAt: z.string(),
  sourceUrl: z.string(),
  lang: LangSchema,
  storyboard: StoryboardSchema,
  timeline: z.array(SceneTimingSchema),
  durationMs: z.number().nonnegative(),
  files: z.object({
    mp4: z.string(),
    gif: z.string().optional(),
    poster: z.string().optional(),
    vtt: z.string(),
    storyboard: z.string(),
    actions: z.string(),
    replay: z.string().optional(),
  }),
  cost: CostSchema,
  warnings: z.array(z.string()),
  adapters: z.object({ browser: z.string(), narrator: z.string(), llm: z.string().optional() }),
});
export type Manifest = z.infer<typeof ManifestSchema>;

/** Turn a ZodError into lines a human can act on. */
export function formatIssues(error: z.ZodError): string[] {
  return error.issues.map((i) => `${i.path.length ? i.path.join(".") : "(root)"}: ${i.message}`);
}
