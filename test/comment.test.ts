import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { COMMENT_MARKER, commentBody, postPrComment, type GhClient } from "../src/action/comment.js";
import { tempDir } from "./helpers.js";

let tmp: Awaited<ReturnType<typeof tempDir>>;
beforeAll(async () => {
  tmp = await tempDir();
});
afterAll(() => tmp.cleanup());

function fakeGh(state: { branchExists: boolean; comments: Array<{ id: number; body: string }> }) {
  const calls: Array<{ method: string; path: string; body?: unknown }> = [];
  const gh: GhClient = {
    async api(method, path, body) {
      calls.push({ method, path, body });
      if (method === "GET" && path.endsWith("/git/ref/heads/demoreel-assets")) {
        if (!state.branchExists) throw new Error("404");
        return { object: { sha: "abc" } };
      }
      if (method === "GET" && /\/repos\/[^/]+\/[^/]+$/.test(path)) return { default_branch: "main" };
      if (method === "GET" && path.endsWith("/git/ref/heads/main")) return { object: { sha: "mainsha" } };
      if (method === "POST" && path.endsWith("/git/refs")) {
        state.branchExists = true;
        return {};
      }
      if (method === "PUT") return { content: {} };
      if (method === "GET" && path.includes("/comments")) return state.comments;
      if (method === "POST" && path.includes("/comments")) return { id: 77 };
      if (method === "PATCH") return { id: 5 };
      throw new Error(`unexpected ${method} ${path}`);
    },
  };
  return { gh, calls };
}

describe("pr comment", () => {
  it("creates the assets branch, uploads the gif and posts a marked comment", async () => {
    const gif = join(tmp.dir, "demo.gif");
    await writeFile(gif, Buffer.from("GIF89a"));
    const { gh, calls } = fakeGh({ branchExists: false, comments: [] });
    const result = await postPrComment({ repo: "o/r", pr: 12, gifPath: gif, branch: "demoreel-assets", shareUrl: "https://d.example/v/1" }, gh);
    expect(result).toMatchObject({ commentId: 77, updated: false });
    expect(result.gifUrl).toMatch(/^https:\/\/raw\.githubusercontent\.com\/o\/r\/demoreel-assets\/pr-12\/\d+\.gif$/);
    expect(calls.some((c) => c.method === "POST" && c.path === "/repos/o/r/git/refs")).toBe(true);
    const put = calls.find((c) => c.method === "PUT")!;
    expect(put.path).toMatch(/^\/repos\/o\/r\/contents\/pr-12\//);
    expect((put.body as { content: string; branch: string }).content).toBe(Buffer.from("GIF89a").toString("base64"));
    const post = calls.find((c) => c.method === "POST" && c.path.includes("/comments"))!;
    expect((post.body as { body: string }).body).toContain(COMMENT_MARKER);
    expect((post.body as { body: string }).body).toContain("https://d.example/v/1");
  });

  it("updates its own earlier comment instead of adding another", async () => {
    const gif = join(tmp.dir, "demo2.gif");
    await writeFile(gif, Buffer.from("GIF89a"));
    const { gh, calls } = fakeGh({ branchExists: true, comments: [{ id: 5, body: `${COMMENT_MARKER}\nold` }, { id: 6, body: "unrelated" }] });
    const result = await postPrComment({ repo: "o/r", pr: 3, gifPath: gif, branch: "demoreel-assets" }, gh);
    expect(result).toMatchObject({ commentId: 5, updated: true });
    expect(calls.some((c) => c.method === "PATCH" && c.path.endsWith("/comments/5"))).toBe(true);
    expect(calls.some((c) => c.method === "POST" && c.path.endsWith("/git/refs"))).toBe(false);
  });

  it("refuses gifs GitHub would not render", async () => {
    const gif = join(tmp.dir, "big.gif");
    await writeFile(gif, Buffer.alloc(9 * 1024 * 1024));
    const { gh } = fakeGh({ branchExists: true, comments: [] });
    await expect(postPrComment({ repo: "o/r", pr: 1, gifPath: gif, branch: "b" }, gh)).rejects.toThrow(/8 MB/);
  });

  it("writes a body with the gif and links", () => {
    const body = commentBody({ title: "preview", gifUrl: "https://g/x.gif", artifactUrl: "https://a" });
    expect(body.split("\n")[0]).toBe(COMMENT_MARKER);
    expect(body).toContain("![demo](https://g/x.gif)");
    expect(body).toContain("[download the mp4 from the workflow run](https://a)");
  });
});
