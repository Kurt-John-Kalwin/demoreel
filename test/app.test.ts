import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { FakeBrowserProvider, fakeClock } from "../src/adapters/browser/fake.js";
import { SilentTts } from "../src/adapters/tts/silent.js";
import type { PipelineDeps } from "../src/core/pipeline.js";
import { ManifestSchema } from "../src/core/schema.js";
import { clientIp, createServer, hashIp, type ServerConfig, type ServerContext } from "../src/server/app.js";
import { log, sampleSite, sampleStoryboard, tempDir } from "./helpers.js";

let tmp: Awaited<ReturnType<typeof tempDir>>;
const servers: ServerContext[] = [];
beforeAll(async () => {
  tmp = await tempDir();
});
// Queued jobs keep writing into their data dir after the test that posted them returns.
// Let every queue finish before the temp dir goes away, or rm races the runner's writes.
afterAll(async () => {
  for (const { queue, store } of servers) {
    await queue.drain();
    queue.stop();
    await store.settled();
  }
  await tmp.cleanup();
});

function deps(): PipelineDeps {
  return {
    browser: new FakeBrowserProvider(sampleSite, fakeClock()),
    narrator: new SilentTts(),
    llm: null,
    fontFile: null,
    log,
    resolver: async (host) => (host.startsWith("private") ? ["10.0.0.1"] : ["93.184.216.34"]),
  };
}

async function makeServer(overrides: Partial<ServerConfig> = {}, dataDir = join(tmp.dir, `data-${Math.random().toString(36).slice(2)}`)) {
  let paused = false;
  const config: ServerConfig = {
    dataDir,
    publicUrl: "http://test.local",
    perIpDaily: 2,
    dailyBudget: 10,
    paused: async () => paused,
    ipSalt: "salt",
    ...overrides,
  };
  const ctx = await createServer(deps(), config, async (job, update) => {
    const outDir = join(dataDir, "renders", job.id);
    await mkdir(outDir, { recursive: true });
    await writeFile(join(outDir, "demo.mp4"), "not really video");
    const manifest = ManifestSchema.parse({
      id: job.id,
      createdAt: new Date().toISOString(),
      sourceUrl: job.url,
      lang: job.lang,
      storyboard: sampleStoryboard(),
      timeline: [],
      durationMs: 12_000,
      files: { mp4: "demo.mp4", vtt: "captions.vtt", storyboard: "storyboard.yaml", actions: "actions.json" },
      cost: {},
      warnings: [],
      adapters: { browser: "fake", narrator: "silent" },
    });
    await update({ status: "done", manifest });
  });
  servers.push(ctx);
  return { ...ctx, setPaused: (p: boolean) => (paused = p) };
}

const post = (app: { request: (input: string, init?: RequestInit) => Promise<Response> }, body: unknown, ip = "1.2.3.4") =>
  app.request("/api/jobs", { method: "POST", headers: { "content-type": "application/json", "x-forwarded-for": ip }, body: JSON.stringify(body) });

describe("public door", () => {
  it("validates, guards, queues, and serves the share page", async () => {
    const { app, queue } = await makeServer();
    expect((await app.request("/healthz")).status).toBe(200);
    expect((await post(app, { url: "not a url" })).status).toBe(400);
    expect((await post(app, { url: "https://private.example/" })).status).toBe(403);
    expect((await post(app, { url: "https://ok.example/", lang: "nope" })).status).toBe(400);
    const res = await post(app, { url: "ok.example/page", sentence: "x".repeat(400) });
    expect(res.status).toBe(202);
    const created = (await res.json()) as { id: string; statusUrl: string };
    expect(created.statusUrl).toBe(`http://test.local/j/${created.id}`);
    await queue.drain();
    const status = (await (await app.request(`/api/jobs/${created.id}`)).json()) as { status: string; videoUrl?: string; files?: Record<string, string> };
    expect(status.status).toBe("done");
    expect(status.videoUrl).toBe(`http://test.local/v/${created.id}`);
    expect(status.files?.mp4).toBe(`http://test.local/files/${created.id}/demo.mp4`);
    const share = await app.request(`/v/${created.id}`);
    expect(share.status).toBe(200);
    expect(await share.text()).toContain("Top Sets");
    const file = await app.request(`/files/${created.id}/demo.mp4`);
    expect(file.status).toBe(200);
    expect(file.headers.get("content-type")).toBe("video/mp4");
    expect((await app.request(`/files/${created.id}/../../jobs.json`)).status).toBe(404);
    expect((await app.request(`/files/${created.id}/evil.sh`)).status).toBe(404);
    expect((await app.request(`/j/${created.id}`)).status).toBe(302);
    expect((await app.request("/v/nope")).status).toBe(404);
  });

  it("enforces the per-ip cap, the daily budget and the pause switch", async () => {
    const { app, setPaused } = await makeServer({ perIpDaily: 1, dailyBudget: 2 });
    expect((await post(app, { url: "https://ok.example/" }, "9.9.9.9")).status).toBe(202);
    const second = await post(app, { url: "https://ok.example/" }, "9.9.9.9");
    expect(second.status).toBe(429);
    expect(((await second.json()) as { error: { message: string } }).error.message).toMatch(/today/);
    expect((await post(app, { url: "https://ok.example/" }, "8.8.8.8")).status).toBe(202);
    expect((await post(app, { url: "https://ok.example/" }, "7.7.7.7")).status).toBe(429);
    setPaused(true);
    expect((await post(app, { url: "https://ok.example/" }, "6.6.6.6")).status).toBe(429);
    const landing = await app.request("/");
    expect(await landing.text()).toContain("paused");
  });

  it("redirects browser form posts to the status page", async () => {
    const { app } = await makeServer();
    const res = await app.request("/api/jobs", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded", "x-forwarded-for": "5.5.5.5" },
      body: "url=https%3A%2F%2Fok.example%2F&sentence=hi",
    });
    expect(res.status).toBe(303);
    expect(res.headers.get("location")).toMatch(/^\/j\//);
  });

  it("hashes ips with the salt and reads forwarded headers", () => {
    expect(hashIp("1.2.3.4", "a")).not.toBe(hashIp("1.2.3.4", "b"));
    expect(hashIp("1.2.3.4", "a")).toHaveLength(24);
    expect(clientIp(new Headers({ "x-forwarded-for": "9.9.9.9, 10.0.0.1" }))).toBe("9.9.9.9");
    expect(clientIp(new Headers())).toBe("unknown");
  });
});
