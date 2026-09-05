import { access } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import type { ZodType, ZodTypeDef } from "zod";

export interface LlmRequest<T> {
  system: string;
  user: string;
  /** Optional JPEG screenshot the planner may look at; adapters without vision ignore it. */
  imageJpegBase64?: string;
  schema: ZodType<T, ZodTypeDef, unknown>;
  /** JSON schema text shown to adapters that cannot enforce a schema server-side. */
  schemaHint: string;
  maxTokens?: number;
}

/** A structured-completion backend. The planner never depends on a vendor directly. */
export interface Llm {
  readonly name: string;
  complete<T>(req: LlmRequest<T>): Promise<T>;
}

export interface LlmPickOptions {
  env?: NodeJS.ProcessEnv;
  hasClaudeCli?: () => Promise<boolean>;
}

async function exists(p: string): Promise<boolean> {
  try {
    await access(p);
    return true;
  } catch {
    return false;
  }
}

export async function detectClaudeCli(env: NodeJS.ProcessEnv = process.env): Promise<boolean> {
  const dirs = (env.PATH ?? "").split(":").filter(Boolean);
  for (const dir of dirs) if (await exists(join(dir, "claude"))) return true;
  return false;
}

/**
 * Picks the planner backend: the Anthropic SDK when credentials exist (API key, auth token, or an `ant auth login`
 * profile on disk), otherwise the local `claude` CLI, otherwise none. Imports are lazy so tests stay light.
 */
export async function pickLlm(opts: LlmPickOptions = {}): Promise<Llm | null> {
  const env = opts.env ?? process.env;
  const forced = env.DEMOREEL_LLM;
  const hasSdkCreds =
    Boolean(env.ANTHROPIC_API_KEY || env.ANTHROPIC_AUTH_TOKEN) || (await exists(join(homedir(), ".config", "anthropic")));
  if (forced === "anthropic" || (!forced && hasSdkCreds)) {
    const { AnthropicLlm } = await import("./anthropic.js");
    return new AnthropicLlm({ model: env.DEMOREEL_LLM_MODEL });
  }
  const cli = await (opts.hasClaudeCli ?? (() => detectClaudeCli(env)))();
  if (forced === "claude-cli" || (!forced && cli)) {
    if (!cli) return null;
    const { ClaudeCliLlm } = await import("./claude-cli.js");
    return new ClaudeCliLlm({ model: env.DEMOREEL_LLM_MODEL ?? "sonnet" });
  }
  return null;
}

/** Finds the first JSON object in free text; models sometimes wrap output in prose or fences. */
export function extractJsonObject(text: string): string | null {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const candidate = fenced ? fenced[1]! : text;
  const start = candidate.indexOf("{");
  if (start < 0) return null;
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < candidate.length; i++) {
    const ch = candidate[i]!;
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === "\\") escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === "{") depth++;
    else if (ch === "}") {
      depth--;
      if (depth === 0) return candidate.slice(start, i + 1);
    }
  }
  return null;
}
