# Changelog

## 0.1.0 (unreleased)

First working pipeline.

- `demoreel init <url>`: a stealth Solari cloud browser scans the page, a planner writes `demoreel.yaml` using only selectors that exist on the page.
- `demoreel render`: narration is voiced first, the storyboard is played in a recording cloud browser (Playwright's server-side recorder, 25 fps), and ffmpeg composites a synthesized cursor, click highlights, title and outro cards and captions. Outputs mp4, gif, poster, WebVTT captions, the storyboard, the action log and a manifest.
- `demoreel serve`: the public door. Paste a URL, get a share page. Guards: public hosts only, robots.txt, login and checkout pages refused, per-IP and daily caps, a pause switch, single-flight queue.
- GitHub Action: renders the repo's storyboard against a preview URL and posts a gif on the pull request (hosted on an assets branch of the same repo).
- Adapters: planner via the Anthropic SDK or the local `claude` CLI; voices via OpenAI or macOS `say`, silence as the fallback; browser via Solari with an offline fake for tests.
- Storyboards can set `outro` and `outroNote` for the last card; without them it stays the host of `url`.
- `DEMOREEL_TAIL_MS` holds the outro card for 0.5-6 s, so a card carrying a line worth reading gets read.
- ElevenLabs delivery is tunable: `DEMOREEL_TTS_STABILITY`, `_SIMILARITY`, `_STYLE`, `_SPEED`, `_SPEAKER_BOOST`. Nothing is sent unless set.
