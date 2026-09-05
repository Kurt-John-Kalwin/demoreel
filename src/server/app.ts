import { createHash } from "node:crypto";
import { access, mkdir } from "node:fs/promises";
import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { join, resolve } from "node:path";
import { Hono } from "hono";
import { CapacityError, DemoreelError, GuardError, ValidationError, errorMessage } from "../core/errors.js";
import type { Logger } from "../core/log.js";
import { newId, planFromUrl, renderStoryboard, type PipelineDeps } from "../core/pipeline.js";
import { LangSchema } from "../core/schema.js";
import { assertPublicHost, normalizeTargetUrl } from "../guards/url.js";
import { DailyBudget, IpLimiter, JobStore, Queue, TERMINAL, type Job, type JobRunner } from "./queue.js";
import { landingPage, sharePage, statusPage } from "./views.js";

export interface ServerConfig {
  dataDir: string;
  publicUrl: string;
  perIpDaily: number;
  dailyBudget: number;
  /** env flag or a `PAUSED` file in the data dir stops new jobs without stopping the site */
  paused: () => Promise<boolean>;
  ipSalt: string;
  maxSentence?: number;
}

export interface ServerContext {
  app: Hono;
  store: JobStore;
  queue: Queue;
  config: ServerConfig;
}

const FILE_TYPES: Record<string, string> = {
  "demo.mp4": "video/mp4",
  "demo.gif": "image/gif",
  "poster.jpg": "image/jpeg",
  "captions.vtt": "text/vtt; charset=utf-8",
  "storyboard.yaml": "text/yaml; charset=utf-8",
  "actions.json": "application/json",
  "manifest.json": "application/json",
  "replay.ndjson": "application/x-ndjson",
};

export function hashIp(ip: string, salt: string): string {
  return createHash("sha256").update(`${salt}:${ip}`).digest("hex").slice(0, 24);
}

/** The public-door worker: guards, plan, render, publish, with the job row updated at every stage. */
export function createJobRunner(deps: PipelineDeps, config: ServerConfig): JobRunner {
  return async (job, update) => {
    const outDir = join(config.dataDir, "renders", job.id);
    try {
      await update({ status: "planning" });
      const planned = await planFromUrl(
        { url: job.url, sentence: job.sentence, lang: [job.lang], enforcePageGuard: true, screenshot: true },
        deps,
      );
      await update({ storyboard: planned.storyboard, warnings: planned.warnings });
      const manifest = await renderStoryboard(
        {
          storyboard: planned.storyboard,
          outDir,
          id: job.id,
          lang: job.lang,
          cacheDir: join(config.dataDir, "narration-cache"),
          onProgress: (stage) => void update({ status: stage }),
        },
        deps,
      );
      await update({ status: "done", manifest, warnings: [...planned.warnings, ...manifest.warnings] });
    } catch (err) {
      const refused = err instanceof GuardError || err instanceof ValidationError;
      const code = err instanceof DemoreelError ? err.code : "internal";
      const message = refused || err instanceof DemoreelError ? errorMessage(err) : "The render failed. Try again in a few minutes.";
      deps.log.warn("job ended", { id: job.id, status: refused ? "refused" : "failed", code, error: errorMessage(err) });
      await update({ status: refused ? "refused" : "failed", error: { code, message } });
    }
  };
}

export async function createServer(deps: PipelineDeps, config: ServerConfig, runner: JobRunner = createJobRunner(deps, config)): Promise<ServerContext> {
  await mkdir(join(config.dataDir, "renders"), { recursive: true });
  const store = new JobStore(join(config.dataDir, "jobs.json"));
  await store.load();
  const interrupted = await store.failInterrupted();
  if (interrupted) deps.log.warn("failed interrupted jobs from a previous run", { count: interrupted });
  const queue = new Queue(store, runner, deps.log.child("queue"));
  const limiter = new IpLimiter(config.perIpDaily);
  const budget = new DailyBudget(config.dailyBudget);
  const app = new Hono();

  app.onError((err, c) => {
    if (err instanceof DemoreelError) {
      const wantsHtml = (c.req.header("accept") ?? "").includes("text/html");
      if (wantsHtml) return c.html(errorHtml(err.message), err.httpStatus as 400);
      return c.json({ error: { code: err.code, message: err.message } }, err.httpStatus as 400);
    }
    deps.log.error("unhandled", { error: errorMessage(err), path: c.req.path });
    return c.json({ error: { code: "internal", message: "Something went wrong." } }, 500);
  });

  const stats = () => {
    const jobs = store.list();
    return {
      rendered: jobs.filter((j) => j.status === "done").length,
      failed: jobs.filter((j) => j.status === "failed").length,
      queued: queue.length,
      budgetRemaining: budget.remaining(),
    };
  };

  app.get("/healthz", (c) => c.json({ ok: true, ...stats() }));
  app.get("/api/stats", async (c) => c.json({ ...stats(), paused: await config.paused() }));

  app.get("/", async (c) => {
    const s = stats();
    const recent = store
      .list()
      .filter((j) => j.status === "done" && j.manifest)
      .slice(0, 6)
      .map((j) => ({ id: j.id, title: j.manifest!.storyboard.title, poster: j.manifest!.files.poster }));
    return c.html(landingPage({ rendered: s.rendered, queued: s.queued, paused: await config.paused(), recent, perIp: config.perIpDaily, publicUrl: config.publicUrl }));
  });

  app.post("/api/jobs", async (c) => {
    const contentType = c.req.header("content-type") ?? "";
    const body = contentType.includes("application/json")
      ? ((await c.req.json().catch(() => ({}))) as Record<string, unknown>)
      : ((await c.req.parseBody()) as Record<string, unknown>);
    const isForm = !contentType.includes("application/json");
    if (await config.paused()) throw new CapacityError("Rendering is paused right now. Try again later.");
    const url = normalizeTargetUrl(String(body.url ?? ""));
    const sentence = String(body.sentence ?? "").trim().slice(0, config.maxSentence ?? 300) || undefined;
    const langRaw = String(body.lang ?? "en").trim() || "en";
    const langParsed = LangSchema.safeParse(langRaw);
    if (!langParsed.success) throw new ValidationError("lang must be a BCP-47 code like en or pt-BR");
    await assertPublicHost(url.hostname, deps.resolver);
    const ipHash = hashIp(clientIp(c.req.raw.headers), config.ipSalt);
    // Check both allowances before consuming either, so a refused request never burns a budget unit.
    if (limiter.remaining(ipHash) <= 0) throw new CapacityError(`You have used today's ${config.perIpDaily} renders. Come back tomorrow.`);
    if (budget.remaining() <= 0) throw new CapacityError("Today's render budget is used up. Come back tomorrow.");
    budget.take();
    limiter.take(ipHash);
    const job: Job = {
      id: newId(),
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      url: url.href,
      sentence,
      lang: langParsed.data,
      ipHash,
      status: "queued",
      warnings: [],
    };
    await store.put(job);
    queue.enqueue(job);
    deps.log.info("job queued", { id: job.id, url: job.url, position: queue.position(job.id) });
    if (isForm) return c.redirect(`/j/${job.id}`, 303);
    return c.json({ id: job.id, status: job.status, position: queue.position(job.id), statusUrl: `${config.publicUrl}/j/${job.id}` }, 202);
  });

  app.get("/api/jobs/:id", (c) => {
    const job = store.get(c.req.param("id"));
    if (!job) return c.json({ error: { code: "not-found", message: "No such job." } }, 404);
    return c.json(publicJob(job, queue.position(job.id), config.publicUrl));
  });

  app.get("/j/:id", (c) => {
    const job = store.get(c.req.param("id"));
    if (!job) return c.html(errorHtml("No such job."), 404);
    if (job.status === "done") return c.redirect(`/v/${job.id}`, 302);
    return c.html(statusPage(job, queue.position(job.id)));
  });

  app.get("/v/:id", (c) => {
    const job = store.get(c.req.param("id"));
    if (!job || job.status !== "done") return c.html(errorHtml("No such video."), 404);
    return c.html(sharePage(job, config.publicUrl));
  });

  app.get("/files/:id/:name", async (c) => {
    const id = c.req.param("id");
    const name = c.req.param("name");
    const type = FILE_TYPES[name];
    const job = store.get(id);
    if (!type || !job || !TERMINAL.has(job.status)) return c.text("Not found", 404);
    const file = resolve(join(config.dataDir, "renders", id, name));
    if (!file.startsWith(resolve(join(config.dataDir, "renders", id)))) return c.text("Not found", 404);
    try {
      await access(file);
    } catch {
      return c.text("Not found", 404);
    }
    const size = (await stat(file)).size;
    const stream = createReadStream(file);
    const web = new ReadableStream<Uint8Array>({
      start(controller) {
        stream.on("data", (chunk) => controller.enqueue(chunk as Uint8Array));
        stream.on("end", () => controller.close());
        stream.on("error", (e) => controller.error(e));
      },
      cancel() {
        stream.destroy();
      },
    });
    return new Response(web, { headers: { "content-type": type, "content-length": String(size), "cache-control": "public, max-age=31536000, immutable" } });
  });

  return { app, store, queue, config };
}

function publicJob(job: Job, position: number, publicUrl: string) {
  return {
    id: job.id,
    status: job.status,
    stage: stageText(job.status),
    position,
    url: job.url,
    error: job.error,
    warnings: job.warnings,
    videoUrl: job.status === "done" ? `${publicUrl}/v/${job.id}` : undefined,
    files: job.manifest ? Object.fromEntries(Object.entries(job.manifest.files).filter(([, v]) => v).map(([k, v]) => [k, `${publicUrl}/files/${job.id}/${v}`])) : undefined,
  };
}

function stageText(status: Job["status"]): string {
  return {
    queued: "Waiting for a browser",
    planning: "Reading the page and writing the storyboard",
    narrating: "Voicing the narration",
    recording: "Recording in a cloud browser",
    rendering: "Compositing the video",
    publishing: "Publishing",
    done: "Done",
    failed: "Failed",
    refused: "Refused",
  }[status];
}

export function clientIp(headers: Headers): string {
  const fwd = headers.get("x-forwarded-for");
  if (fwd) return fwd.split(",")[0]!.trim();
  return headers.get("x-real-ip") ?? "unknown";
}

function errorHtml(message: string): string {
  return `<!doctype html><meta charset="utf-8"><title>Demoreel</title><body style="font-family:system-ui;padding:40px;max-width:60ch"><h1>Demoreel</h1><p style="border-left:3px solid #C8382D;padding:8px 14px">${message.replace(/</g, "&lt;")}</p><p><a href="/">Back</a></p>`;
}
