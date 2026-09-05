import { randomBytes } from "node:crypto";
import { mkdir, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import type { BrowserProvider } from "../adapters/browser/index.js";
import type { Llm } from "../adapters/llm/index.js";
import type { Narrator } from "../adapters/tts/index.js";
import type { PageKind } from "../guards/page.js";
import { robotsAllows, type Fetcher } from "../guards/robots.js";
import { assertPublicHost, normalizeTargetUrl, type Resolver } from "../guards/url.js";
import { drive } from "../stages/drive.js";
import { narrate } from "../stages/narrate.js";
import { planStoryboard } from "../stages/plan.js";
import { publish } from "../stages/publish.js";
import { render } from "../stages/render.js";
import { scanPage, type ScanResult } from "../stages/scan.js";
import { GuardError, PlannerError } from "./errors.js";
import type { Logger } from "./log.js";
import { viewportSize, type Manifest, type Storyboard, type Viewport } from "./schema.js";
import { buildTimeline } from "./timeline.js";

export interface PipelineDeps {
  browser: BrowserProvider;
  narrator: Narrator;
  llm?: Llm | null;
  fontFile: string | null;
  log: Logger;
  /** injectable for tests */
  resolver?: Resolver;
  robotsFetcher?: Fetcher;
}

export type Stage = "narrating" | "recording" | "rendering" | "publishing";

export interface RenderInput {
  storyboard: Storyboard;
  outDir: string;
  id?: string;
  lang?: string;
  urlOverride?: string;
  voice?: string;
  videoOffsetMs?: number;
  cacheDir?: string;
  keepWork?: boolean;
  wallClockMs?: number;
  onProgress?: (stage: Stage) => void;
}

export function newId(): string {
  return randomBytes(6).toString("base64url");
}

/** narrate -> drive -> render -> publish. One call, one manifest, every warning kept. */
export async function renderStoryboard(input: RenderInput, deps: PipelineDeps): Promise<Manifest> {
  const id = input.id ?? newId();
  const lang = input.lang ?? input.storyboard.lang[0] ?? "en";
  const outDir = resolve(input.outDir);
  const workDir = join(outDir, "work");
  await mkdir(workDir, { recursive: true });
  const log = deps.log.child(id);
  const warnings: string[] = [];
  const startedAt = Date.now();

  input.onProgress?.("narrating");
  const narration = await narrate({
    storyboard: input.storyboard,
    lang,
    narrator: deps.narrator,
    cacheDir: input.cacheDir ?? join(outDir, "..", ".narration-cache"),
    log,
    voice: input.voice,
    llm: deps.llm,
  });
  warnings.push(...narration.warnings);
  const timeline = buildTimeline(
    input.storyboard.scenes,
    narration.clips.map((c) => ({ sceneIndex: c.sceneIndex, durationMs: c.durationMs })),
  );
  log.info("narrated", { scenes: narration.clips.length, plannedMs: timeline.totalMs });

  input.onProgress?.("recording");
  const driven = await drive({
    storyboard: input.storyboard,
    timeline,
    browser: deps.browser,
    workDir,
    log,
    urlOverride: input.urlOverride,
    wallClockMs: input.wallClockMs,
  });
  warnings.push(...driven.warnings);

  input.onProgress?.("rendering");
  const rendered = await render({
    storyboard: input.storyboard,
    footage: driven.footage,
    events: driven.events,
    sceneStarts: driven.sceneStarts,
    recordingMs: driven.recordingMs,
    clips: narration.clips,
    workDir,
    outDir,
    fontFile: deps.fontFile,
    log,
    videoOffsetMs: input.videoOffsetMs ?? Number(process.env.DEMOREEL_VIDEO_OFFSET_MS ?? 0),
  });
  warnings.push(...rendered.warnings);

  input.onProgress?.("publishing");
  const manifest = await publish({
    id,
    outDir,
    storyboard: input.storyboard,
    lang,
    sourceUrl: input.urlOverride ?? input.storyboard.url,
    render: rendered,
    events: driven.events,
    timeline: rendered.timeline,
    cost: {
      browserSeconds: Math.round(driven.browserSeconds),
      ttsCharacters: narration.characters,
      llmCalls: narration.llmCalls,
    },
    warnings,
    adapters: { browser: deps.browser.name, narrator: deps.narrator.name, llm: deps.llm?.name },
  });
  if (!input.keepWork) await rm(workDir, { recursive: true, force: true });
  log.info("done", { ms: Date.now() - startedAt, durationMs: manifest.durationMs, warnings: warnings.length });
  return manifest;
}

export interface PlanInputFromUrl {
  url: string;
  sentence?: string;
  viewport?: Viewport;
  lang?: string[];
  /** refuse login, checkout and account pages (the public door does; owners rendering their own site need not) */
  enforcePageGuard?: boolean;
  screenshot?: boolean;
}

export interface PlanFromUrlResult {
  storyboard: Storyboard;
  scan: ScanResult;
  warnings: string[];
  llmCalls: number;
  pageKind: PageKind;
}

/** Guards, scan, plan. Throws GuardError for anything the public door must refuse. */
export async function planFromUrl(input: PlanInputFromUrl, deps: PipelineDeps): Promise<PlanFromUrlResult> {
  if (!deps.llm) throw new PlannerError("no planner is configured: set ANTHROPIC_API_KEY or install the claude CLI");
  const url = normalizeTargetUrl(input.url);
  await assertPublicHost(url.hostname, deps.resolver);
  const robots = await robotsAllows(url, deps.robotsFetcher);
  if (!robots.allowed) throw new GuardError(`This site asks bots to stay away (${robots.reason}).`, "robots");
  const viewport: Viewport = input.viewport ?? "1920x1080";
  const scan = await scanPage({
    url,
    browser: deps.browser,
    viewport: viewportSize(viewport),
    log: deps.log,
    screenshot: input.screenshot ?? false,
  });
  if (input.enforcePageGuard !== false && scan.classification.kind !== "ok") {
    throw new GuardError(`This page cannot be demoed: ${scan.classification.reason}.`, `page-${scan.classification.kind}`);
  }
  const planned = await planStoryboard(deps.llm, {
    url: scan.scan.url || url.href,
    sentence: input.sentence,
    scan: scan.scan,
    screenshotJpegBase64: scan.screenshotJpegBase64,
    lang: input.lang,
    viewport,
  });
  return { storyboard: planned.storyboard, scan, warnings: planned.warnings, llmCalls: 1, pageKind: scan.classification.kind };
}
