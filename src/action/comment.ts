import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import { DemoreelError } from "../core/errors.js";

export const COMMENT_MARKER = "<!-- demoreel -->";
export const MAX_GIF_BYTES = 8 * 1024 * 1024;

export interface CommentInput {
  repo: string;
  pr: number;
  gifPath: string;
  shareUrl?: string;
  artifactUrl?: string;
  branch: string;
  title?: string;
}

export interface GhClient {
  api(method: "GET" | "POST" | "PATCH" | "PUT", path: string, body?: unknown): Promise<unknown>;
}

/** Thin wrapper over the `gh` CLI, which runners already authenticate with GITHUB_TOKEN. */
export const ghCli: GhClient = {
  api(method, path, body) {
    const args = ["api", "-X", method, path];
    if (body !== undefined) args.push("--input", "-");
    return new Promise((resolvePromise, reject) => {
      const child = spawn("gh", args, { stdio: ["pipe", "pipe", "pipe"] });
      const out: Buffer[] = [];
      const err: Buffer[] = [];
      child.stdout.on("data", (d: Buffer) => out.push(d));
      child.stderr.on("data", (d: Buffer) => err.push(d));
      child.on("error", (e) => reject(new DemoreelError(`gh could not start: ${e.message}`, { code: "github" })));
      child.on("close", (code) => {
        const stdout = Buffer.concat(out).toString("utf8");
        if (code !== 0) {
          reject(new DemoreelError(`gh ${method} ${path} failed: ${Buffer.concat(err).toString("utf8").trim().slice(0, 300)}`, { code: "github" }));
          return;
        }
        try {
          resolvePromise(stdout.trim() ? JSON.parse(stdout) : null);
        } catch (e) {
          reject(new DemoreelError(`gh ${method} ${path} returned non-JSON output`, { code: "github", cause: e }));
        }
      });
      if (body !== undefined) child.stdin.end(JSON.stringify(body));
      else child.stdin.end();
    });
  },
};

export function commentBody(input: { title: string; gifUrl: string; shareUrl?: string; artifactUrl?: string; sourceUrl?: string }): string {
  const lines = [
    COMMENT_MARKER,
    `**Demo video for this PR** (${input.title})`,
    "",
    `![demo](${input.gifUrl})`,
    "",
  ];
  const links: string[] = [];
  if (input.shareUrl) links.push(`[watch with narration](${input.shareUrl})`);
  if (input.artifactUrl) links.push(`[download the mp4 from the workflow run](${input.artifactUrl})`);
  if (links.length) lines.push(links.join(" · "));
  lines.push("", "_Rendered by [Demoreel](https://github.com/Kurt-John-Kalwin/demoreel) from this PR's preview URL._");
  return lines.join("\n");
}

/**
 * Hosts the gif on an assets branch of the same repo (GitHub cannot take uploads through the API) and posts or
 * updates one comment per PR, found by its marker.
 */
export async function postPrComment(input: CommentInput, gh: GhClient = ghCli): Promise<{ commentId: number; gifUrl: string; updated: boolean }> {
  const gif = await readFile(input.gifPath);
  if (gif.length > MAX_GIF_BYTES) throw new DemoreelError(`gif is ${gif.length} bytes; GitHub renders images up to about 8 MB`, { code: "gif-too-large" });
  await ensureBranch(input.repo, input.branch, gh);
  const path = `pr-${input.pr}/${Date.now()}.gif`;
  await gh.api("PUT", `/repos/${input.repo}/contents/${path}`, {
    message: `demoreel: demo for #${input.pr}`,
    content: gif.toString("base64"),
    branch: input.branch,
  });
  const gifUrl = `https://raw.githubusercontent.com/${input.repo}/${input.branch}/${path}`;
  const body = commentBody({ title: input.title ?? "preview", gifUrl, shareUrl: input.shareUrl, artifactUrl: input.artifactUrl });
  const existing = (await gh.api("GET", `/repos/${input.repo}/issues/${input.pr}/comments?per_page=100`)) as Array<{ id: number; body?: string }> | null;
  const mine = existing?.find((c) => c.body?.includes(COMMENT_MARKER));
  if (mine) {
    await gh.api("PATCH", `/repos/${input.repo}/issues/comments/${mine.id}`, { body });
    return { commentId: mine.id, gifUrl, updated: true };
  }
  const created = (await gh.api("POST", `/repos/${input.repo}/issues/${input.pr}/comments`, { body })) as { id: number };
  return { commentId: created.id, gifUrl, updated: false };
}

async function ensureBranch(repo: string, branch: string, gh: GhClient): Promise<void> {
  try {
    await gh.api("GET", `/repos/${repo}/git/ref/heads/${branch}`);
    return;
  } catch {
    /* create it below */
  }
  const info = (await gh.api("GET", `/repos/${repo}`)) as { default_branch: string };
  const head = (await gh.api("GET", `/repos/${repo}/git/ref/heads/${info.default_branch}`)) as { object: { sha: string } };
  await gh.api("POST", `/repos/${repo}/git/refs`, { ref: `refs/heads/${branch}`, sha: head.object.sha });
}
