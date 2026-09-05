import { writeFile } from "node:fs/promises";
import { basename, join } from "node:path";
import { ManifestSchema, type ActionEvent, type Cost, type Manifest, type SceneTiming, type Storyboard } from "../core/schema.js";
import { storyboardToYaml } from "../core/storyboard.js";
import type { RenderResult } from "./render.js";

export interface PublishOptions {
  id: string;
  outDir: string;
  storyboard: Storyboard;
  lang: string;
  sourceUrl: string;
  render: RenderResult;
  events: ActionEvent[];
  timeline: SceneTiming[];
  cost: Cost;
  warnings: string[];
  adapters: Manifest["adapters"];
  replay?: Uint8Array | null;
}

/** Writes the sidecar files and the manifest that the share page and the Action read. File paths are basenames. */
export async function publish(opts: PublishOptions): Promise<Manifest> {
  const storyboardFile = join(opts.outDir, "storyboard.yaml");
  await writeFile(storyboardFile, storyboardToYaml(opts.storyboard), "utf8");
  const actionsFile = join(opts.outDir, "actions.json");
  await writeFile(actionsFile, JSON.stringify(opts.events, null, 1), "utf8");
  let replay: string | undefined;
  if (opts.replay && opts.replay.length) {
    replay = "replay.ndjson";
    await writeFile(join(opts.outDir, replay), opts.replay);
  }
  const manifest = ManifestSchema.parse({
    id: opts.id,
    createdAt: new Date().toISOString(),
    sourceUrl: opts.sourceUrl,
    lang: opts.lang,
    storyboard: opts.storyboard,
    timeline: opts.timeline,
    durationMs: opts.render.durationMs,
    files: {
      mp4: basename(opts.render.mp4),
      gif: opts.render.gif ? basename(opts.render.gif) : undefined,
      poster: opts.render.poster ? basename(opts.render.poster) : undefined,
      vtt: basename(opts.render.vtt),
      storyboard: basename(storyboardFile),
      actions: basename(actionsFile),
      replay,
    },
    cost: opts.cost,
    warnings: opts.warnings,
    adapters: opts.adapters,
  });
  await writeFile(join(opts.outDir, "manifest.json"), JSON.stringify(manifest, null, 2), "utf8");
  return manifest;
}
