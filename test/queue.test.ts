import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { DailyBudget, IpLimiter, JobStore, Queue, type Job } from "../src/server/queue.js";
import { log, tempDir } from "./helpers.js";

let tmp: Awaited<ReturnType<typeof tempDir>>;
beforeAll(async () => {
  tmp = await tempDir();
});
afterAll(() => tmp.cleanup());

async function waitFor(cond: () => boolean, ms = 2000): Promise<void> {
  const until = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > until) throw new Error("waitFor timed out");
    await new Promise((r) => setTimeout(r, 5));
  }
}

function job(id: string, status: Job["status"] = "queued"): Job {
  const now = new Date().toISOString();
  return { id, createdAt: now, updatedAt: now, url: "https://x.example/", lang: "en", ipHash: "h", status, warnings: [] };
}

describe("job store", () => {
  it("persists across instances and fails interrupted jobs on load", async () => {
    const file = join(tmp.dir, "jobs.json");
    const a = new JobStore(file);
    await a.load();
    await a.put(job("one", "recording"));
    await a.put(job("two", "done"));
    const b = new JobStore(file);
    await b.load();
    expect(b.get("two")?.status).toBe("done");
    expect(await b.failInterrupted()).toBe(1);
    expect(b.get("one")?.status).toBe("failed");
    expect(b.get("one")?.error?.code).toBe("interrupted");
  });

  it("refuses writes before load", async () => {
    await expect(new JobStore(join(tmp.dir, "x.json")).put(job("z"))).rejects.toThrow(/load/);
  });
});

describe("queue", () => {
  it("runs one job at a time in order and reports positions", async () => {
    const store = new JobStore(join(tmp.dir, "q.json"));
    await store.load();
    const order: string[] = [];
    let release: (() => void) | null = null;
    const queue = new Queue(
      store,
      async (j, update) => {
        order.push(j.id);
        await new Promise<void>((r) => (release = r));
        await update({ status: "done" });
      },
      log,
    );
    for (const id of ["a", "b", "c"]) {
      await store.put(job(id));
      queue.enqueue(store.get(id)!);
    }
    await waitFor(() => order.length === 1);
    expect(order).toEqual(["a"]);
    expect(queue.position("a")).toBe(0);
    expect(queue.position("b")).toBe(1);
    expect(queue.position("c")).toBe(2);
    expect(queue.length).toBe(3);
    release!();
    await waitFor(() => order.length === 2);
    expect(order).toEqual(["a", "b"]);
    expect(store.get("a")?.status).toBe("done");
    release!();
    await waitFor(() => order.length === 3);
    release!();
    await queue.drain();
    expect(store.get("c")?.status).toBe("done");
    expect(order).toEqual(["a", "b", "c"]);
    expect(queue.position("zzz")).toBe(-1);
    expect(queue.length).toBe(0);
  });

  it("marks a job failed when the runner throws", async () => {
    const store = new JobStore(join(tmp.dir, "q2.json"));
    await store.load();
    const queue = new Queue(store, async () => { throw new Error("boom"); }, log);
    await store.put(job("k"));
    queue.enqueue(store.get("k")!);
    await waitFor(() => store.get("k")?.status === "failed");
    expect(store.get("k")?.error?.code).toBe("internal");
    await queue.drain();
  });
});

describe("limits", () => {
  it("caps each ip per day and rolls over at midnight", () => {
    let now = new Date("2026-09-03T23:59:00Z");
    const limiter = new IpLimiter(2, () => now);
    expect(limiter.take("a")).toBe(true);
    expect(limiter.take("a")).toBe(true);
    expect(limiter.take("a")).toBe(false);
    expect(limiter.take("b")).toBe(true);
    expect(limiter.remaining("a")).toBe(0);
    now = new Date("2026-09-04T00:01:00Z");
    expect(limiter.take("a")).toBe(true);
  });

  it("caps the day globally", () => {
    let now = new Date("2026-09-03T12:00:00Z");
    const budget = new DailyBudget(1, () => now);
    expect(budget.take()).toBe(true);
    expect(budget.take()).toBe(false);
    expect(budget.remaining()).toBe(0);
    now = new Date("2026-09-04T12:00:00Z");
    expect(budget.remaining()).toBe(1);
  });
});
