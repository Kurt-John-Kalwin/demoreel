import type { Job } from "./queue.js";

export function escapeHtml(value: unknown): string {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

const CSS = `
:root{--paper:#F1F3F5;--paper2:#E6EAEE;--ink:#16212B;--muted:#5B6B78;--line:#D3DAE0;--rec:#C8382D;--band:#0E1418;--bandtext:#F7F7F2}
@media(prefers-color-scheme:dark){:root{--paper:#0F151A;--paper2:#161E25;--ink:#E8ECEF;--muted:#93A1AC;--line:#27333C;--rec:#E5564B;--band:#05080A}}
*{box-sizing:border-box}body{margin:0;background:var(--paper);color:var(--ink);font:17px/1.5 "Source Sans 3","Segoe UI",Helvetica,Arial,sans-serif}
main{max-width:76ch;margin:0 auto;padding:40px 22px 80px}h1,h2{font-family:"Bricolage Grotesque","Avenir Next","Helvetica Neue",Arial,sans-serif;letter-spacing:-.01em;margin:0}
h1{font-size:2.4rem;line-height:1.05}h2{font-size:1.3rem;margin-top:28px}p{margin:0;max-width:66ch}a{color:inherit}
.rec{display:inline-flex;align-items:center;gap:8px;font:600 .74rem/1 "IBM Plex Mono",Menlo,monospace;letter-spacing:.1em;text-transform:uppercase;color:var(--rec)}
.rec:before{content:"";width:9px;height:9px;border-radius:50%;background:var(--rec)}
form{display:flex;flex-direction:column;gap:10px;margin-top:22px}input{font:inherit;padding:12px 14px;border:1px solid var(--line);background:var(--paper2);color:var(--ink);width:100%}
button{font:600 1rem/1 inherit;padding:14px 18px;background:var(--rec);color:#fff;border:0;cursor:pointer}button:focus-visible,input:focus-visible,a:focus-visible{outline:2px solid var(--rec);outline-offset:3px}
.facts{display:grid;grid-template-columns:repeat(auto-fit,minmax(140px,1fr));gap:1px;background:var(--line);border:1px solid var(--line);margin-top:26px}
.facts div{background:var(--paper2);padding:12px 14px}.facts b{display:block;font-size:1.3rem}.facts span{font-size:.82rem;color:var(--muted)}
video{width:100%;background:#000;border:1px solid var(--line)}.small{font-size:.86rem;color:var(--muted)}
.scenes{display:flex;flex-direction:column;gap:10px;margin-top:12px}.scene{border:1px solid var(--line);background:var(--paper2);padding:10px 12px}
.scene .say{display:inline-block;background:var(--band);color:var(--bandtext);padding:4px 8px;font-size:.92rem}.scene code{font:.76rem "IBM Plex Mono",Menlo,monospace;color:var(--muted);margin-right:8px}
.grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(200px,1fr));gap:12px;margin-top:12px}.grid a{display:block;border:1px solid var(--line);background:var(--paper2);text-decoration:none;font-size:.86rem}
.grid img{display:block;width:100%;aspect-ratio:16/9;object-fit:cover}.grid span{display:block;padding:8px 10px;color:var(--muted);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.err{border-left:3px solid var(--rec);padding:8px 14px;background:var(--paper2)}.ok{color:#2E7D5B}ul{padding-left:1.2em}
`;

function layout(title: string, body: string, extraHead = ""): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escapeHtml(
    title,
  )}</title><link rel="preconnect" href="https://fonts.googleapis.com"><link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Bricolage+Grotesque:wght@700&family=Source+Sans+3:wght@400;600&family=IBM+Plex+Mono:wght@500&display=swap"><style>${CSS}</style>${extraHead}</head><body><main>${body}</main></body></html>`;
}

export interface LandingData {
  rendered: number;
  queued: number;
  paused: boolean;
  recent: Array<{ id: string; title: string; poster?: string }>;
  perIp: number;
  publicUrl: string;
}

export function landingPage(d: LandingData): string {
  const recent = d.recent.length
    ? `<h2>Recent renders</h2><div class="grid">${d.recent
        .map(
          (r) =>
            `<a href="/v/${escapeHtml(r.id)}">${r.poster ? `<img src="/files/${escapeHtml(r.id)}/${escapeHtml(r.poster)}" alt="">` : ""}<span>${escapeHtml(
              r.title,
            )}</span></a>`,
        )
        .join("")}</div>`
    : "";
  const form = d.paused
    ? `<p class="err">Rendering is paused right now. The recent renders below still play.</p>`
    : `<form method="post" action="/api/jobs"><input name="url" type="url" required placeholder="https://your-product.com" autocomplete="off"><input name="sentence" maxlength="300" placeholder="One sentence about it (optional)"><button type="submit">Make the demo video</button><p class="small">Public pages only. About two minutes. Up to ${d.perIp} videos per day per person.</p></form>`;
  return layout(
    "Demoreel",
    `<span class="rec">Demoreel</span><h1>Paste a URL. Get a narrated demo video.</h1><p>A cloud browser walks the page, a narrator explains it, and a 1080p video with captions comes back. Keep the storyboard in your repo and it re-renders on every deploy.</p>${form}<div class="facts"><div><b>${d.rendered}</b><span>videos rendered</span></div><div><b>${d.queued}</b><span>in the queue</span></div><div><b>1080p</b><span>25 fps, captions, cursor</span></div></div>${recent}<p class="small" style="margin-top:32px">Open source. <a href="https://github.com/Kurt-John-Kalwin/demoreel">GitHub</a>. Built on <a href="https://getsolari.com">Solari</a> cloud browsers.</p>`,
  );
}

const STAGE_TEXT: Record<Job["status"], string> = {
  queued: "Waiting for a browser",
  planning: "Reading the page and writing the storyboard",
  narrating: "Voicing the narration",
  recording: "Recording in a cloud browser",
  rendering: "Compositing the video",
  publishing: "Publishing",
  done: "Done",
  failed: "Failed",
  refused: "Refused",
};

export function statusPage(job: Job, position: number): string {
  const poll = `<script>(function(){function tick(){fetch("/api/jobs/${escapeHtml(job.id)}").then(r=>r.json()).then(j=>{if(j.status==="done"){location.href="/v/${escapeHtml(
    job.id,
  )}";return}if(j.status==="failed"||j.status==="refused"){location.reload();return}document.getElementById("stage").textContent=j.stage+(j.position>0?" (position "+j.position+")":"");setTimeout(tick,2500)}).catch(()=>setTimeout(tick,4000))}setTimeout(tick,2500)})()</script>`;
  let body = `<span class="rec">Rendering</span><h1>${escapeHtml(job.url)}</h1><p id="stage">${escapeHtml(STAGE_TEXT[job.status])}${
    position > 0 ? ` (position ${position})` : ""
  }</p><p class="small">This page updates itself. Renders take about two minutes.</p>`;
  if (job.status === "failed" || job.status === "refused") {
    body = `<span class="rec">${escapeHtml(job.status)}</span><h1>${escapeHtml(job.url)}</h1><p class="err">${escapeHtml(job.error?.message ?? "Something went wrong.")}</p><p class="small" style="margin-top:16px"><a href="/">Try another page</a></p>`;
    return layout("Demoreel", body);
  }
  return layout("Demoreel", body, poll);
}

export function sharePage(job: Job, publicUrl: string): string {
  const m = job.manifest;
  if (!m) return layout("Demoreel", `<p class="err">This render has no video yet.</p>`);
  const f = (name: string) => `/files/${escapeHtml(job.id)}/${escapeHtml(name)}`;
  const scenes = m.storyboard.scenes
    .map(
      (s, i) =>
        `<div class="scene"><span class="say">${escapeHtml(s.say)}</span><div style="margin-top:6px">${s.do
          .map((a) => `<code>${escapeHtml(Object.entries(a).map(([k, v]) => `${k} ${typeof v === "object" ? JSON.stringify(v) : v}`).join(" "))}</code>`)
          .join("")}${m.timeline[i] ? `<code>${(m.timeline[i]!.startMs / 1000).toFixed(1)}s</code>` : ""}</div></div>`,
    )
    .join("");
  const warnings = m.warnings.length ? `<h2>Notes</h2><ul class="small">${m.warnings.map((w) => `<li>${escapeHtml(w)}</li>`).join("")}</ul>` : "";
  const og = m.files.poster ? `<meta property="og:image" content="${escapeHtml(publicUrl)}${f(m.files.poster)}">` : "";
  return layout(
    `${m.storyboard.title} demo`,
    `<span class="rec">Demo video</span><h1>${escapeHtml(m.storyboard.title)}</h1><p>${escapeHtml(m.storyboard.sentence ?? "")}</p><div style="margin-top:18px"><video controls preload="metadata" playsinline ${
      m.files.poster ? `poster="${f(m.files.poster)}"` : ""
    }><source src="${f(m.files.mp4)}" type="video/mp4"><track kind="captions" src="${f(m.files.vtt)}" srclang="${escapeHtml(m.lang)}" label="Captions" default></video></div><p class="small" style="margin-top:10px">${(
      m.durationMs / 1000
    ).toFixed(0)} s · source <a href="${escapeHtml(m.sourceUrl)}" rel="nofollow noopener">${escapeHtml(m.sourceUrl)}</a> · rendered ${escapeHtml(
      m.createdAt.slice(0, 16).replace("T", " "),
    )} UTC · <a href="${f(m.files.mp4)}" download>mp4</a>${m.files.gif ? ` · <a href="${f(m.files.gif)}" download>gif</a>` : ""} · <a href="${f(
      m.files.storyboard,
    )}" download>storyboard.yaml</a></p><h2>Storyboard</h2><p class="small">Put this file in your repo as <code>demoreel.yaml</code> and the GitHub Action re-renders it on every deploy.</p><div class="scenes">${scenes}</div>${warnings}<p class="small" style="margin-top:32px">Made with <a href="/">Demoreel</a>. Site owner and want this removed? Email <a href="mailto:kurtkalwin@gmail.com?subject=Demoreel%20takedown%20${escapeHtml(job.id)}">the maintainer</a> with this link.</p>`,
    `<meta property="og:title" content="${escapeHtml(m.storyboard.title)} demo">${og}<meta property="og:type" content="video.other">`,
  );
}
