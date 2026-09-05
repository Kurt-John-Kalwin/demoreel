import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { Logger } from "../core/log.js";
import type { Manifest, Storyboard } from "../core/schema.js";

export type JobStatus =
  | "queued"
  | "planning"
  | "narrating"
  | "recording"
  | "rendering"
  | "publishing"
  | "done"
  | "failed"
  | "refused";

export const TERMINAL: ReadonlySet<JobStatus> = new Set<JobStatus>(["done", "failed", "refused"]);

export interface Job {
  id: string;
  createdAt: string;
  updatedAt: string;
  url: string;
  sentence?: string;
  lang: string;
  ipHash: string;
  status: JobStatus;
  error?: { code: string; message: string };
  storyboard?: Storyboard;
  manifest?: Manifest;
  warnings: string[];
}

const MAX_JOBS_KEPT = 2000;

/** JSON-file job store with atomic writes. Single process, single writer; enough for one always-on worker. */
export class JobStore {
  private jobs = new Map<string, Job>();
  private loaded = false;
  private writing: Promise<void> = Promise.resolve();

  constructor(private readonly file: string) {}

  async load(): Promise<void> {
    try {
      const raw = JSON.parse(await readFile(this.file, "utf8")) as { jobs?: Job[] };
      for (const job of raw.jobs ?? []) this.jobs.set(job.id, job);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
    }
    this.loaded = true;
  }

  get(id: string): Job | undefined {
    return this.jobs.get(id);
  }

  list(): Job[] {
    return [...this.jobs.values()].sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
  }

  /** Resolves once every write queued so far has reached disk. */
  async settled(): Promise<void> {
    await this.writing;
  }

  async put(job: Job): Promise<void> {
    if (!this.loaded) throw new Error("JobStore.load() must run before put()");
    this.jobs.set(job.id, { ...job, updatedAt: new Date().toISOString() });
    if (this.jobs.size > MAX_JOBS_KEPT) {
      for (const old of this.list().slice(MAX_JOBS_KEPT)) this.jobs.delete(old.id);
    }
    this.writing = this.writing.then(() => this.flush());
    await this.writing;
  }

  /** Jobs left mid-flight by a previous process are failed, never resumed: a half-recorded session cannot continue. */
  async failInterrupted(): Promise<number> {
    let n = 0;
    for (const job of this.jobs.values()) {
      if (!TERMINAL.has(job.status)) {
        job.status = "failed";
        job.error = { code: "interrupted", message: "the server restarted while this job was running" };
        n++;
      }
    }
    if (n) await this.flush();
    return n;
  }

  private async flush(): Promise<void> {
    await mkdir(dirname(this.file), { recursive: true });
    const tmp = `${this.file}.${process.pid}.tmp`;
    await writeFile(tmp, JSON.stringify({ jobs: [...this.jobs.values()] }), "utf8");
    await rename(tmp, this.file);
  }
}

export type JobRunner = (job: Job, update: (patch: Partial<Job>) => Promise<void>) => Promise<void>;

/** Single-flight FIFO: one render at a time keeps browser concurrency and spend predictable. */
export class Queue {
  private pending: string[] = [];
  private running: string | null = null;
  private stopped = false;
  private idleWaiters: Array<() => void> = [];

  constructor(
    private readonly store: JobStore,
    private readonly runner: JobRunner,
    private readonly log: Logger,
  ) {}

  enqueue(job: Job): void {
    this.pending.push(job.id);
    this.start();
  }

  /** 0 = running now, 1 = next, ... ; -1 when not waiting. */
  position(id: string): number {
    if (this.running === id) return 0;
    const idx = this.pending.indexOf(id);
    return idx < 0 ? -1 : idx + 1;
  }

  get length(): number {
    return this.pending.length + (this.running ? 1 : 0);
  }

  stop(): void {
    this.stopped = true;
    this.wake();
  }

  /** True once nothing is running and nothing more will start: a stopped queue never drains its backlog. */
  private get idle(): boolean {
    return !this.running && (this.stopped || this.pending.length === 0);
  }

  /** Resolves when the queue goes idle. Lets a shutdown -- or a test tearing down its data dir -- wait for in-flight writes. */
  async drain(): Promise<void> {
    while (!this.idle) await new Promise<void>((resolve) => this.idleWaiters.push(resolve));
  }

  /** Kick the pump, then release drain() waiters if that left us idle. */
  private start(): void {
    void this.pump().catch((err) => this.log.error("queue pump failed", { error: (err as Error).message }));
    this.wake();
  }

  private wake(): void {
    if (!this.idle) return;
    const waiters = this.idleWaiters;
    this.idleWaiters = [];
    for (const resolve of waiters) resolve();
  }

  private async pump(): Promise<void> {
    if (this.running || this.stopped) return;
    const id = this.pending.shift();
    if (!id) return;
    const job = this.store.get(id);
    if (!job) return this.start();
    this.running = id;
    const update = async (patch: Partial<Job>) => {
      const current = this.store.get(id);
      if (current) await this.store.put({ ...current, ...patch });
    };
    try {
      await this.runner(job, update);
    } catch (err) {
      this.log.error("job runner threw", { id, error: (err as Error).message });
      try {
        await update({ status: "failed", error: { code: "internal", message: "unexpected failure" } });
      } catch (storeErr) {
        this.log.error("could not record the failure", { id, error: (storeErr as Error).message });
      }
    } finally {
      this.running = null;
      this.start();
    }
  }
}

function dayKey(now: Date): string {
  return now.toISOString().slice(0, 10);
}

/** Per-IP daily allowance, reset at UTC midnight. Keys are hashes, never raw addresses. */
export class IpLimiter {
  private day = "";
  private counts = new Map<string, number>();
  constructor(private readonly perDay: number, private readonly clock: () => Date = () => new Date()) {}

  private roll(): void {
    const key = dayKey(this.clock());
    if (key !== this.day) {
      this.day = key;
      this.counts.clear();
    }
  }

  remaining(ipHash: string): number {
    this.roll();
    return Math.max(0, this.perDay - (this.counts.get(ipHash) ?? 0));
  }

  take(ipHash: string): boolean {
    this.roll();
    const used = this.counts.get(ipHash) ?? 0;
    if (used >= this.perDay) return false;
    this.counts.set(ipHash, used + 1);
    return true;
  }
}

/** Global daily render allowance; the hard stop against a viral afternoon burning the month. */
export class DailyBudget {
  private day = "";
  private used = 0;
  constructor(private readonly limit: number, private readonly clock: () => Date = () => new Date()) {}

  private roll(): void {
    const key = dayKey(this.clock());
    if (key !== this.day) {
      this.day = key;
      this.used = 0;
    }
  }

  remaining(): number {
    this.roll();
    return Math.max(0, this.limit - this.used);
  }

  take(): boolean {
    this.roll();
    if (this.used >= this.limit) return false;
    this.used++;
    return true;
  }
}
