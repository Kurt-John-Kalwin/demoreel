# Demoreel TODOS

Status: BUILT 3 Sep 2026 (UTC). Pipeline, CLI, public door and Action exist; 93 offline tests pass; two live renders verified (topsets.app, docs.getsolari.com). Decisions taken during the build (override any of them):

1. Build order: everything shares one pipeline; the public door and the Action both exist. The door is verified locally; the Action has not run on a real PR yet.
2. TTS: adapter interface with ElevenLabs (preferred when ELEVENLABS_API_KEY is set), OpenAI, and macOS `say` (used for the verified renders). ElevenLabs added 4 Sep 2026: unit-tested against a stubbed transport, never yet called against the real API. Kokoro-in-sandbox not built yet.
3. Worker host: the server is one Node process (`demoreel serve`) that runs anywhere with Node 20; no Dockerfile or Fly config yet, not deployed.
4. Name: `demoreel` kept; npm name still unclaimed, GitHub repo not created, no git history yet.

Day 0 gates: sync offset measured at 63-66 ms (pass); narration sync within 7 ms per scene (pass); the topsets.app clip exists at out/topsets/demo.mp4 and needs Kurt's listen test with sound (the macOS voice is placeholder quality; OpenAI or ElevenLabs before posting).

Next: run `demoreel doctor` with a real ELEVENLABS_API_KEY and re-render the topsets.app clip for the listen test; git init + first commit; create the GitHub repo; publish to npm; deploy `serve` (Fly.io or any VM); run the Action on a real PR of Tonnage/web or connexa; swap the voice; render the launch video of Demoreel with Demoreel.

Open research gaps: Reddit and X were unreachable this session (Reddit blocks even stealth + residential egress; X is login-walled; WebSearch budget exhausted). Re-run the pain sweep when limits reset. `expo start --web` for Top Sets untested.

Known platform facts to design around: Playwright `video.path()` throws remotely, use `saveAs()`; sandbox `base` has Node 18 while @solarisdk/browser needs >=20 (cookbook PR #34); rrweb replay endpoint had a multi-hour outage on 2 Sep (rushes); `cpu: 2` still gives 1 vCPU.
