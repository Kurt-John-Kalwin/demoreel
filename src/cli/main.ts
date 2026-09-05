#!/usr/bin/env node
import { readFile, writeFile, access } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { serve } from "@hono/node-server";
import { pickBrowser } from "../adapters/browser/index.js";
import { pickLlm } from "../adapters/llm/index.js";
import { pickNarrator } from "../adapters/tts/index.js";
import { CapacityError, DemoreelError, GuardError, ValidationError, errorMessage } from "../core/errors.js";
import { createLogger } from "../core/log.js";
import { newId, planFromUrl, renderStoryboard, type PipelineDeps } from "../core/pipeline.js";
import { LangSchema, ViewportSchema } from "../core/schema.js";
import { loadStoryboard, saveStoryboard } from "../core/storyboard.js";
import { findFont } from "../render/fonts.js";
import { createServer } from "../server/app.js";
import { postPrComment } from "../action/comment.js";
import { runDoctor } from "./doctor.js";

const HELP = `demoreel: narrated demo videos as a build artifact

  demoreel init <url> [sentence] [--out demoreel.yaml] [--viewport 1920x1080] [--lang en] [--allow-private-pages]
  demoreel render [demoreel.yaml] [--url <preview url>] [--lang xx] [--out out/<id>] [--voice name] [--keep-work] [--offset ms]
  demoreel serve [--port 8787] [--data-dir ./data]
  demoreel doctor [--live]
  demoreel action-comment --repo owner/name --pr 42 --gif out/demo.gif [--share-url u] [--artifact-url u]

Exit codes: 0 ok, 1 error, 2 usage, 3 refused by a guard, 4 at capacity.
Environment: SOLARI_API_KEY (required), ANTHROPIC_API_KEY or the claude CLI (planner), ELEVENLABS_API_KEY or OPENAI_API_KEY (voice), see .env.example.`;

async function loadDotEnv(): Promise<void> {
  const file = join(process.cwd(), ".env");
  try {
    await access(file);
  } catch {
    return;
  }
  const text = await readFile(file, "utf8");
  for (const line of text.split("\n")) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
    if (!m || m[1]! in process.env) continue;
    process.env[m[1]!] = m[2]!.replace(/^["']|["']$/g, "");
  }
}

async function buildDeps(): Promise<PipelineDeps> {
  const log = createLogger("demoreel");
  const browser = await pickBrowser();
  const [narrator, llm, fontFile] = await Promise.all([pickNarrator(), pickLlm(), findFont()]);
  log.info("adapters", { browser: browser.name, narrator: narrator.name, planner: llm?.name ?? "none", font: fontFile ?? "none" });
  return { browser, narrator, llm, fontFile, log };
}

function str(v: unknown): string | undefined {
  return typeof v === "string" && v.length ? v : undefined;
}

async function cmdInit(args: string[]): Promise<number> {
  const { values, positionals } = parseArgs({
    args,
    allowPositionals: true,
    options: {
      out: { type: "string", default: "demoreel.yaml" },
      viewport: { type: "string", default: "1920x1080" },
      lang: { type: "string", default: "en" },
      "allow-private-pages": { type: "boolean", default: false },
    },
  });
  const [url, ...rest] = positionals;
  if (!url) {
    console.error("usage: demoreel init <url> [sentence]");
    return 2;
  }
  const deps = await buildDeps();
  const viewport = ViewportSchema.parse(values.viewport);
  const lang = values.lang!.split(",").map((l) => LangSchema.parse(l.trim()));
  const result = await planFromUrl(
    { url, sentence: rest.join(" ") || undefined, viewport, lang, enforcePageGuard: !values["allow-private-pages"], screenshot: true },
    deps,
  );
  await saveStoryboard(values.out!, result.storyboard);
  for (const w of result.warnings) deps.log.warn(w);
  console.log(`wrote ${values.out} with ${result.storyboard.scenes.length} scenes. Edit it, then: demoreel render ${values.out}`);
  return 0;
}

async function cmdRender(args: string[]): Promise<number> {
  const { values, positionals } = parseArgs({
    args,
    allowPositionals: true,
    options: {
      url: { type: "string" },
      lang: { type: "string" },
      out: { type: "string" },
      voice: { type: "string" },
      "keep-work": { type: "boolean", default: false },
      offset: { type: "string" },
    },
  });
  const file = positionals[0] ?? "demoreel.yaml";
  const storyboard = await loadStoryboard(file);
  // `music:` is written relative to the storyboard, so a storyboard stays portable no matter
  // which directory the render is launched from.
  if (storyboard.music) storyboard.music = resolve(dirname(resolve(file)), storyboard.music);
  const deps = await buildDeps();
  const id = newId();
  const outDir = values.out ?? join("out", id);
  const manifest = await renderStoryboard(
    {
      storyboard,
      outDir,
      id,
      lang: values.lang ? LangSchema.parse(values.lang) : undefined,
      urlOverride: str(values.url),
      voice: str(values.voice),
      keepWork: values["keep-work"],
      videoOffsetMs: values.offset ? Number(values.offset) : undefined,
      cacheDir: join(resolve(outDir), "..", ".narration-cache"),
      onProgress: (stage) => deps.log.info(stage),
    },
    deps,
  );
  for (const w of manifest.warnings) deps.log.warn(w);
  console.log(JSON.stringify({ id: manifest.id, outDir: resolve(outDir), mp4: join(resolve(outDir), manifest.files.mp4), gif: manifest.files.gif ? join(resolve(outDir), manifest.files.gif) : null, durationMs: manifest.durationMs, warnings: manifest.warnings.length }, null, 2));
  return 0;
}

async function cmdServe(args: string[]): Promise<number> {
  const { values } = parseArgs({
    args,
    options: { port: { type: "string" }, "data-dir": { type: "string" } },
  });
  const deps = await buildDeps();
  const dataDir = resolve(values["data-dir"] ?? process.env.DEMOREEL_DATA_DIR ?? "./data");
  const port = Number(values.port ?? process.env.DEMOREEL_PORT ?? 8787);
  const ctx = await createServer(deps, {
    dataDir,
    publicUrl: (process.env.DEMOREEL_PUBLIC_URL ?? `http://localhost:${port}`).replace(/\/$/, ""),
    perIpDaily: Number(process.env.DEMOREEL_PER_IP_DAILY ?? 3),
    dailyBudget: Number(process.env.DEMOREEL_DAILY_BUDGET ?? 200),
    ipSalt: process.env.DEMOREEL_IP_SALT ?? newId(),
    paused: async () => {
      if (process.env.DEMOREEL_PAUSED === "1") return true;
      try {
        await access(join(dataDir, "PAUSED"));
        return true;
      } catch {
        return false;
      }
    },
  });
  const server = serve({ fetch: ctx.app.fetch, port }, (info) => deps.log.info(`listening on http://localhost:${info.port}`, { dataDir }));
  const shutdown = () => {
    deps.log.info("shutting down");
    ctx.queue.stop();
    server.close();
    setTimeout(() => process.exit(0), 500).unref();
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
  await new Promise(() => {});
  return 0;
}

async function cmdDoctor(args: string[]): Promise<number> {
  const { values } = parseArgs({ args, options: { live: { type: "boolean", default: false } } });
  const checks = await runDoctor({ live: values.live });
  for (const c of checks) console.log(`${c.ok ? "ok  " : "FAIL"} ${c.name.padEnd(18)} ${c.detail}`);
  return checks.every((c) => c.ok || c.name === "planner" || c.name === "narrator" || c.name === "font") ? 0 : 1;
}

async function cmdActionComment(args: string[]): Promise<number> {
  const { values } = parseArgs({
    args,
    options: {
      repo: { type: "string" },
      pr: { type: "string" },
      gif: { type: "string" },
      "share-url": { type: "string" },
      "artifact-url": { type: "string" },
      branch: { type: "string", default: "demoreel-assets" },
      title: { type: "string" },
    },
  });
  if (!values.repo || !values.pr || !values.gif) {
    console.error("usage: demoreel action-comment --repo owner/name --pr N --gif path [--share-url u] [--artifact-url u]");
    return 2;
  }
  const result = await postPrComment({
    repo: values.repo,
    pr: Number(values.pr),
    gifPath: values.gif,
    shareUrl: str(values["share-url"]),
    artifactUrl: str(values["artifact-url"]),
    branch: values.branch!,
    title: str(values.title),
  });
  console.log(JSON.stringify(result));
  return 0;
}

async function main(argv: string[]): Promise<number> {
  await loadDotEnv();
  const [command, ...rest] = argv;
  switch (command) {
    case "init":
      return cmdInit(rest);
    case "render":
      return cmdRender(rest);
    case "serve":
      return cmdServe(rest);
    case "doctor":
      return cmdDoctor(rest);
    case "action-comment":
      return cmdActionComment(rest);
    case undefined:
    case "help":
    case "--help":
    case "-h":
      console.log(HELP);
      return command ? 0 : 2;
    default:
      console.error(`unknown command "${command}"\n\n${HELP}`);
      return 2;
  }
}

main(process.argv.slice(2)).then(
  (code) => process.exit(code),
  (err) => {
    if (err instanceof CapacityError) {
      console.error(`at capacity: ${err.message}`);
      process.exit(4);
    }
    if (err instanceof GuardError || err instanceof ValidationError) {
      console.error(`refused: ${err.message}`);
      process.exit(3);
    }
    if (err instanceof DemoreelError) {
      console.error(`${err.code}: ${err.message}`);
      process.exit(1);
    }
    console.error(`error: ${errorMessage(err)}`);
    process.exit(1);
  },
);

export { writeFile };
