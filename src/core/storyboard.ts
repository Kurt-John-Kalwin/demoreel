import { readFile, writeFile } from "node:fs/promises";
import YAML from "yaml";
import { formatIssues, StoryboardSchema, type Storyboard, type StoryboardInput } from "./schema.js";
import { ValidationError } from "./errors.js";

export function parseStoryboard(text: string, source = "storyboard"): Storyboard {
  let raw: unknown;
  try {
    raw = YAML.parse(text);
  } catch (err) {
    throw new ValidationError(`${source}: not valid YAML or JSON (${(err as Error).message})`);
  }
  return validateStoryboard(raw, source);
}

export function validateStoryboard(raw: unknown, source = "storyboard"): Storyboard {
  const result = StoryboardSchema.safeParse(raw);
  if (!result.success) {
    throw new ValidationError(`${source} is invalid:\n  ${formatIssues(result.error).join("\n  ")}`);
  }
  return result.data;
}

export async function loadStoryboard(path: string): Promise<Storyboard> {
  const text = await readFile(path, "utf8");
  return parseStoryboard(text, path);
}

export function storyboardToYaml(sb: StoryboardInput | Storyboard): string {
  return YAML.stringify(sb, { lineWidth: 100 });
}

export async function saveStoryboard(path: string, sb: StoryboardInput | Storyboard): Promise<void> {
  await writeFile(path, storyboardToYaml(sb), "utf8");
}

export function wordCount(text: string): number {
  return text.trim().split(/\s+/).filter(Boolean).length;
}
