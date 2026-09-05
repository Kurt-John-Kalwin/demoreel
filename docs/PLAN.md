# Demoreel implementation plan

> Progress note, 3 Sep 2026 (UTC): Days 0 to 3 are built and verified live (pipeline, CLI, public door), Day 4's Action is written and unit-tested but has not run on a real PR, Day 5 has one of the backlog videos rendered (topsets.app). See README.md for the evidence table and TODOS.md for what is left.

Companion to `DESIGN.md` (the why) and `RESEARCH-2026-09-03.md` (the evidence). This is the build order. Times are for one person working with Claude Code; each day ends with something that runs.

## 1. Product in one screen

```
                 +------------------+        +--------------------+
  URL + sentence |  public web app  |        |  demoreel.yaml in  |  preview URL
  ------------->  |  (Vercel)        |        |  a repo + Action   | <-----------
                 +--------+---------+        +----------+---------+
                          |  job                          | npx demoreel render
                          v                               v
                 +------------------------------------------------+
                 |  pipeline (packages/core)                      |
                 |  plan -> narrate -> drive -> render -> publish |
                 |  LLM     TTS        Solari    ffmpeg    R2     |
                 +------------------------+-----------------------+
                                          v
                        mp4 + webm + gif + vtt + storyboard.json
                        share page /v/{id}  |  PR comment (gif + link)
```

Output contract for every render: `demo.mp4` (1080p H.264), `demo.webm`, `demo.gif` (720p, 8 s, under 8 MB), `captions.vtt`, `storyboard.json`, `actions.json`, and optionally `replay.ndjson` (Solari rrweb tape, kept as provenance).

## 2. Storyboard format (`demoreel.yaml`)

```yaml
version: 1
title: Top Sets
url: https://topsets.app
sentence: A hypertrophy tracker that plans your next set for you.
voice: default           # provider voice id; "kokoro:af_heart" for the free path
lang: [en]               # add es, hi, de ... for localized renders
viewport: 1920x1080      # or 390x844 for a phone-shaped demo
scenes:
  - say: Top Sets is a hypertrophy tracker that plans your next set for you.
    do:
      - goto: /
      - wait: 800
  - say: Every row in the log is alive. It remembers your last lift and judges each set.
    do:
      - scroll_to: "#living-list"
      - hover: ".live-row"
  - say: The program builder is real buttons. Pick a lift, a scheme, and the loads.
    do:
      - click: "text=Builder"
      - type: { selector: "input[name=lift]", text: Squat }
```

Rules: `say` is 8-25 words; `do` is a list of `goto | scroll_to | hover | click | type | press | wait | screenshot`; selectors are Playwright selectors; each scene's on-screen time is `max(narration_ms + 300, actions_ms)`. The planner emits this format; humans edit it; the CLI validates it with a zod schema and refuses to render anything else.

## 3. Packages

```
demoreel/
  packages/core/        pure pipeline: schema, timeline, planner prompt, adapters (llm, tts, browser, storage) as interfaces
  packages/render/      ffmpeg filter-graph builder: cursor overlay, zoom, captions, cards, audio mux
  packages/cli/         demoreel init | plan | render | preview | publish
  packages/action/      composite GitHub Action: detect preview URL, render, upload artifact, comment
  apps/web/             Next.js: landing, paste form, queue position, share page, counter
  apps/worker/          one Node process: queue + SQLite + pipeline + R2 upload
  probes/               the three live probe scripts from 3 Sep (keep; they are the smoke tests)
  docs/                 this plan, the design, the research
```

Stack: TypeScript, bun for scripts and tests (vitest), `@solarisdk/browser` pinned, `patchright-core` (comes with the SDK), `ffmpeg-static` and `ffprobe-static`, zod, an LLM SDK behind an adapter, a TTS adapter (OpenAI TTS or ElevenLabs; Kokoro-in-sandbox as the free adapter), Cloudflare R2 via the S3 API, SQLite (`better-sqlite3` or bun:sqlite).

## 4. Build order with gates

### Day 0: gates (half a day)
- [ ] Create the repo `Kurt-John-Kalwin/demoreel`, monorepo scaffold, CI running vitest, MIT licence, README with an honest status table (empty rows are fine).
- [ ] Claim `demoreel` on npm with a placeholder (or decide not to). Check the domain you want.
- [ ] **Sync gate**: extend `probes/probe2.mjs` to log `Date.now()` at context creation and at each action, then measure the offset to video frame 0 with ffprobe. Pass: under 150 ms and no drift over 60 s. Fail: add a visual sync marker (flash a colored div for one frame at t0 and detect it with ffmpeg `blackdetect`-style filters).
- [ ] **Listen gate**: voice the topsets.app storyboard with three voices from the chosen TTS and one Kokoro render; pick the default. Record the per-clip durations; this is the pacing input.
- [ ] **Assignment**: mux the hand-written topsets.app demo (footage + cursor overlay + narration) and watch it with sound. Ship the clip to X. Nothing below starts until this is a yes.

### Day 1: drive + render from a hand-written storyboard
- [ ] `core/schema.ts`: zod schema for the storyboard and for `actions.json`.
- [ ] `core/timeline.ts`: pure function from (storyboard, narration durations) to a scene timeline with absolute start and end times. Unit-tested with fixtures.
- [ ] `core/drive.ts`: Solari stealth session, `recordVideo` at the requested viewport, execute actions with Playwright, log each action with timestamp, coordinates and target bbox, dwell per the timeline, `saveAs` the footage, close. Fake-browser adapter for tests.
- [ ] `render/cursor.ts`: cursor path from `actions.json` (eased moves, click ripple) expressed as ffmpeg overlay expressions or a rendered PNG sequence; test the expression builder against golden strings.
- [ ] `render/mux.ts`: footage + cursor + narration + captions (ASS) + intro/outro cards -> mp4, webm, gif, vtt.
- [ ] `demoreel render demoreel.yaml --out ./out` works end to end on topsets.app.

### Day 2: plan + narrate
- [ ] `core/plan.ts`: prompt with page text, nav links and a screenshot -> storyboard JSON; strict schema validation with one repair retry; refuses login/checkout/account pages by heuristics; respects robots.txt.
- [ ] Planner fixtures: 20 public pages saved as text + screenshot; snapshot tests on the storyboards; a scoring rubric (scene count, word counts, selectors resolvable against the saved DOM).
- [ ] `core/narrate.ts`: TTS adapter interface, OpenAI or ElevenLabs implementation, Kokoro implementation that runs inside a Solari sandbox from a baked template (ffmpeg + Node 20 + kokoro), caching by text hash.
- [ ] `demoreel init https://example.com "one sentence"` writes `demoreel.yaml`; `demoreel plan` re-plans; `lang: [es]` renders a Spanish variant by translating `say` lines.

### Day 3: public door
- [ ] `apps/worker`: queue with single-flight rendering, SQLite jobs table, cost accountant (browser seconds, LLM tokens, TTS characters), daily budget with hard kill, per-IP cap, SSRF guard (public IPs only, no redirects to private ranges), robots.txt check, 90 s video cap, R2 upload.
- [ ] `apps/web`: landing with the paste form, queue position via SSE or polling, share page `/v/{id}` with video, storyboard, source URL, timestamp, downloads, and a takedown email; live counter; honest "at capacity" and "paused" states.
- [ ] Deploy: Vercel for web, Fly.io for the worker; a synthetic canary every 15 minutes renders a tiny known page and flips the site to "paused" on failure.

### Day 4: the Action and PR clips
- [ ] `packages/action`: inputs `url` (or auto-detect the Vercel preview URL from the deployment status event), `storyboard` (default `demoreel.yaml`), `lang`; runs the CLI; uploads mp4 as a workflow artifact; posts or updates one PR comment with the GIF (hosted on R2 or committed to the artifact URL) and the share link. Idempotent comment update per PR.
- [ ] Before/after mode: `--against https://production.url` renders the same storyboard on both and the comment shows two GIFs side by side.
- [ ] Dogfood on Tonnage/web (topsets.app) and connexa; both are Next.js and connexa already deploys to Vercel.

### Day 5: your own backlog, then the launch asset
- [ ] Render: topsets.app landing video (replace the ghost-cursor stand-in on the landing page with the real video), connexa, releasedeck's README page, clonecheck's README page.
- [ ] Render the Demoreel launch video with Demoreel: paste the Demoreel share page URL into Demoreel.
- [ ] Cookbook example PR `browser-narrated-demo-ts`: complete, runnable, renders a demo of docs.getsolari.com with a fixed storyboard, no LLM key needed.
- [ ] README: live URL first, the honest status table filled in, cost table, the two doors, the storyboard format, the guards.

### Day 6: launch and watch
- [ ] X post with the self-made video, tagging @harrychow_ and @getsolari; Discord; Show HN with the paste link.
- [ ] Watch the counter and the failure log; fix what strangers break; 24 h follow-up post with real numbers.

### Day 7: second-week features, only if the counter moved
- [ ] Localized variants exposed on the share page; phone viewport presets; zoom on click targets behind a flag; a Solari profile option for logged-in demo accounts (site owners only, never the public door).

## 5. Guards (build on Day 3, not later)

| Risk | Guard |
|---|---|
| SSRF, private targets | resolve DNS first, refuse non-public IPs, refuse redirects into private ranges, http(s) only |
| Bot-hostile or disallowed pages | robots.txt check per target; refuse pages whose title or forms look like login, checkout, account |
| Cost runaway | daily credit budget, per-render cap on browser seconds and TTS characters, single-flight queue, kill switch env flag, canary pauses the site |
| Abuse of the public door | per-IP 3 renders per day, 90 s cap, no custom scripts from the public form (planner only), takedown email on every share page |
| Solari failures | 429 is not retryable: degrade to "at capacity"; retry only 502/503/504; every session gets `timeoutMs` and a SIGTERM reaper; never depend on the rrweb replay for output |
| Secrets in footage | never type real credentials; the public door has no auth; the Action reads secrets from the runner only |

## 6. Cost model (from today's probes and public prices)

| Item | Per 45 s video |
|---|---|
| Solari stealth browser, about 2 minutes | $0.003 |
| Residential proxy, if needed, about 3 MB | $0.003 |
| LLM planning, about 10k tokens in, 1k out | $0.01-0.03 |
| TTS, about 900 characters | $0.014 (API) or $0 (Kokoro in a sandbox, about 1 minute of sandbox time = $0.001) |
| Worker CPU, ffmpeg 1080p, about 40 s | included in the $5-10/mo machine |
| Total | about $0.03-0.05, or about $0.02 on the free-TTS path |

$20 of Starter credits plus a $10 machine funds roughly 500 public renders a month.

## 7. Tests

- Offline by default: fake LLM (fixture storyboards), fake TTS (silent clips with known durations), fake browser (records actions, emits a synthetic footage file), real ffmpeg. `bun test` must pass with no network.
- One live smoke per package behind `LIVE=1`: `probes/probe2.mjs` (capture), a one-scene render against docs.getsolari.com, the Action against a fixture repo.
- Golden files for the ffmpeg filter graph and the ASS captions; a duration check on every rendered mp4 with ffprobe.

## 8. What is deliberately out

App Store preview videos (native app, not reachable from a cloud browser; say so in the README and point at the Top Sets script for the manual path). Talking-head or avatar videos. A timeline editor. Accounts and billing. Desktop capture. Interactive HTML demos. Multi-region.

## 9. Before the first commit

Confirm the four DECISION items in `DESIGN.md`: build order (public door first), TTS provider, worker host, and the name.
