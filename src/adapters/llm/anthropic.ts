import Anthropic from "@anthropic-ai/sdk";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import type { ZodObject, ZodRawShape } from "zod";
import { PlannerError } from "../../core/errors.js";
import type { Llm, LlmRequest } from "./index.js";

export interface AnthropicLlmOptions {
  model?: string;
  client?: Anthropic;
}

/** Structured planning through the official SDK with server-side schema enforcement. */
export class AnthropicLlm implements Llm {
  readonly name: string;
  private readonly client: Anthropic;
  private readonly model: string;

  constructor(opts: AnthropicLlmOptions = {}) {
    this.model = opts.model ?? "claude-opus-5";
    this.name = `anthropic:${this.model}`;
    this.client = opts.client ?? new Anthropic();
  }

  async complete<T>(req: LlmRequest<T>): Promise<T> {
    const content: Anthropic.ContentBlockParam[] = [];
    if (req.imageJpegBase64) {
      content.push({ type: "image", source: { type: "base64", media_type: "image/jpeg", data: req.imageJpegBase64 } });
    }
    content.push({ type: "text", text: req.user });
    try {
      const response = await this.client.messages.parse({
        model: this.model,
        max_tokens: req.maxTokens ?? 8000,
        system: req.system,
        messages: [{ role: "user", content }],
        output_config: { format: zodOutputFormat(req.schema as unknown as ZodObject<ZodRawShape>), effort: "medium" },
      });
      if (response.stop_reason === "refusal") throw new PlannerError("the model declined to plan this page");
      const parsed = response.parsed_output as T | null | undefined;
      if (parsed === null || parsed === undefined) throw new PlannerError("the model returned no parseable storyboard");
      return parsed;
    } catch (err) {
      if (err instanceof PlannerError) throw err;
      if (err instanceof Anthropic.AuthenticationError) throw new PlannerError("Anthropic credentials were rejected", err);
      if (err instanceof Anthropic.RateLimitError) throw new PlannerError("Anthropic rate limit hit; retry shortly", err);
      if (err instanceof Anthropic.APIError) throw new PlannerError(`Anthropic API error ${err.status}: ${err.message}`, err);
      throw new PlannerError(`planner failed: ${(err as Error).message}`, err);
    }
  }
}
