import type { Llm, LlmRequest } from "./index.js";

/** Test double: returns canned objects in order, validated through the request's schema like a real backend. */
export class FixtureLlm implements Llm {
  readonly name = "fixture";
  readonly calls: Array<{ system: string; user: string }> = [];
  private readonly answers: unknown[];
  constructor(answers: unknown[]) {
    this.answers = [...answers];
  }
  async complete<T>(req: LlmRequest<T>): Promise<T> {
    this.calls.push({ system: req.system, user: req.user });
    const next = this.answers.shift();
    if (next === undefined) throw new Error("FixtureLlm has no more answers");
    return req.schema.parse(next);
  }
}
