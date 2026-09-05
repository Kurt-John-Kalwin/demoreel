import { describe, expect, it } from "vitest";
import { ValidationError } from "../src/core/errors.js";
import { ActionSchema, StoryboardSchema, formatIssues, viewportSize } from "../src/core/schema.js";
import { parseStoryboard, storyboardToYaml } from "../src/core/storyboard.js";

const minimal = `
version: 1
title: Example
url: https://example.com
scenes:
  - say: This is the example home page.
    do:
      - goto: https://example.com
`;

describe("storyboard schema", () => {
  it("applies defaults for lang and viewport", () => {
    const sb = parseStoryboard(minimal);
    expect(sb.lang).toEqual(["en"]);
    expect(sb.viewport).toBe("1920x1080");
    expect(viewportSize(sb.viewport)).toEqual({ width: 1920, height: 1080 });
  });

  it("round-trips through yaml", () => {
    const sb = parseStoryboard(minimal);
    expect(parseStoryboard(storyboardToYaml(sb))).toEqual(sb);
  });

  it("rejects unknown keys so typos cannot pass silently", () => {
    expect(() => parseStoryboard(minimal.replace("say:", "sey:"))).toThrow(ValidationError);
    const bad = StoryboardSchema.safeParse({ version: 1, title: "x", url: "https://a.b", scenes: [{ say: "two words", do: [], extra: 1 }] });
    expect(bad.success).toBe(false);
  });

  it("rejects an action with two keys or an unknown key", () => {
    expect(ActionSchema.safeParse({ goto: "https://a.b", wait: 10 }).success).toBe(false);
    expect(ActionSchema.safeParse({ tap: "#x" }).success).toBe(false);
    expect(ActionSchema.safeParse({ type: { selector: "#x", text: "hi" } }).success).toBe(true);
  });

  it("requires at least two words of narration and at most twelve scenes", () => {
    expect(StoryboardSchema.safeParse({ version: 1, title: "x", url: "https://a.b", scenes: [{ say: "Hello" }] }).success).toBe(false);
    const many = Array.from({ length: 13 }, () => ({ say: "two words" }));
    expect(StoryboardSchema.safeParse({ version: 1, title: "x", url: "https://a.b", scenes: many }).success).toBe(false);
  });

  it("formats issues with paths", () => {
    const res = StoryboardSchema.safeParse({ version: 1, title: "", url: "nope", scenes: [] });
    expect(res.success).toBe(false);
    if (!res.success) {
      const lines = formatIssues(res.error);
      expect(lines.some((l) => l.startsWith("title:"))).toBe(true);
      expect(lines.some((l) => l.startsWith("url:"))).toBe(true);
    }
  });

  it("explains yaml syntax errors", () => {
    expect(() => parseStoryboard("version: 1\n  bad: [")).toThrow(/not valid YAML/);
  });
});
