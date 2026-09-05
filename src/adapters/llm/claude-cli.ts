import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { PlannerError } from "../../core/errors.js";
import { extractJsonObject, type Llm, type LlmRequest } from "./index.js";

const execFileAsync = promisify(execFile);

export interface ClaudeCliOptions {
  model?: string;
  binary?: string;
  timeoutMs?: number;
}

/**
 * Planner backend on top of the local `claude` CLI in print mode. Uses the developer's own subscription; MCP servers
 * are disabled so the request carries only our prompt. One repair round when the JSON does not validate.
 */
export class ClaudeCliLlm implements Llm {
  readonly name: string;
  private readonly model: string;
  private readonly binary: string;
  private readonly timeoutMs: number;

  constructor(opts: ClaudeCliOptions = {}) {
    this.model = opts.model ?? "sonnet";
    this.binary = opts.binary ?? "claude";
    this.timeoutMs = opts.timeoutMs ?? 180_000;
    this.name = `claude-cli:${this.model}`;
  }

  async complete<T>(req: LlmRequest<T>): Promise<T> {
    const first = await this.ask(req.system, `${req.user}\n\nRespond with ONLY a JSON object matching this JSON schema, no prose:\n${req.schemaHint}`);
    const attempt = this.parse(first, req);
    if (attempt.ok) return attempt.value;
    const repaired = await this.ask(
      req.system,
      `Your previous answer did not validate:\n${attempt.error}\n\nPrevious answer:\n${first.slice(0, 6000)}\n\nReturn ONLY a corrected JSON object matching this schema:\n${req.schemaHint}`,
    );
    const second = this.parse(repaired, req);
    if (second.ok) return second.value;
    throw new PlannerError(`claude CLI returned invalid JSON twice: ${second.error}`);
  }

  private parse<T>(text: string, req: LlmRequest<T>): { ok: true; value: T } | { ok: false; error: string } {
    const json = extractJsonObject(text);
    if (!json) return { ok: false, error: "no JSON object found in the reply" };
    let raw: unknown;
    try {
      raw = JSON.parse(json);
    } catch (err) {
      return { ok: false, error: `JSON.parse failed: ${(err as Error).message}` };
    }
    const result = req.schema.safeParse(raw);
    if (!result.success) return { ok: false, error: result.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ") };
    return { ok: true, value: result.data };
  }

  private async ask(system: string, user: string): Promise<string> {
    const dir = await mkdtemp(join(tmpdir(), "demoreel-claude-"));
    try {
      const mcpConfig = join(dir, "mcp.json");
      await writeFile(mcpConfig, JSON.stringify({ mcpServers: {} }));
      const args = [
        "-p",
        user,
        "--output-format",
        "json",
        "--model",
        this.model,
        "--system-prompt",
        system,
        "--strict-mcp-config",
        "--mcp-config",
        mcpConfig,
        "--tools",
        "",
      ];
      const { stdout } = await execFileAsync(this.binary, args, {
        cwd: dir,
        timeout: this.timeoutMs,
        maxBuffer: 8 * 1024 * 1024,
        env: { ...process.env, CLAUDECODE: "" },
      });
      const envelope = JSON.parse(stdout) as { result?: string; is_error?: boolean; subtype?: string };
      if (envelope.is_error) throw new PlannerError(`claude CLI reported an error (${envelope.subtype ?? "unknown"})`);
      if (typeof envelope.result !== "string") throw new PlannerError("claude CLI returned no result text");
      return envelope.result;
    } catch (err) {
      if (err instanceof PlannerError) throw err;
      const e = err as { stderr?: string; message?: string };
      throw new PlannerError(`claude CLI failed: ${(e.stderr || e.message || "").split("\n").slice(-3).join(" ").trim()}`, err);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }
}
