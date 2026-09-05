# Demoreel

Narrated demo videos as a build artifact.

Paste a URL and one sentence. A stealth [Solari](https://getsolari.com) cloud browser walks the page, a planner writes the storyboard, a voice reads it, and a 1080p video with a synthesized cursor, click highlights and captions comes back. Keep `demoreel.yaml` in your repo and the GitHub Action re-renders it from every preview deployment, so the video never goes stale and every pull request gets a clip.

```
demoreel init https://topsets.app "A hypertrophy tracker that plans your next set for you."
demoreel render demoreel.yaml
```

## Status

Verified on 3 Sep 2026 (UTC) against live Solari, with the tests green (82 offline tests, 3 s).

| Piece | State | Evidence |
|---|---|---|
| Storyboard format and validation | works | strict schema, YAML or JSON, one key per action |
| Planner (`init`) | works | topsets.app: 7 scenes in 26 s, every selector from the scan, zero dropped actions |
| Narration first, then recording | works | narration begins within 7 ms of every scene start (silencedetect vs the action log) |
| Recording on Solari | works | Playwright `recordVideo` at 1080p25 through Solari's remote Playwright server; clock offset measured at 63 to 66 ms |
| Render (cursor, highlights, cards, captions, mix) | works | topsets.app: 83 s mp4 with aac narration, gif, poster, WebVTT, in 118 s end to end |
| Public door (`serve`) | works locally | paste to share page in 112 s for docs.getsolari.com; guards refuse bad and private URLs; not deployed yet |
| GitHub Action | written, unit-tested, not yet run on a real PR | gif hosted on a `demoreel-assets` branch, one comment per PR |
| Voices | ElevenLabs, OpenAI or macOS `say` | ElevenLabs and OpenAI are unit-tested against stubbed transports; the verified renders used `say` |
| Localized renders (`lang:`) | works when a planner is configured | lines are translated, then voiced |

## How it works

```
init:    guards -> scan (cloud browser, no recording) -> plan (LLM, selectors from the scan only) -> demoreel.yaml
render:  narrate (TTS per scene, cached) -> drive (recording cloud browser, action log) -> render (ffmpeg) -> publish (manifest)
```

The driver dwells on each scene for `max(narration + 350 ms, actions)`, records the real start time of every scene, and the renderer places each narration clip at that real start. The cursor is drawn from the action log with eased motion; clicks get a highlight box. Nothing is guessed from pixels.

## Storyboard

```yaml
version: 1
title: Top Sets
url: https://topsets.app/
sentence: A hypertrophy tracker that plans your next set for you.
lang: [en]            # add es, hi, de for localized renders
viewport: 1920x1080   # or 1280x720, 390x844
voice: Rachel         # optional; an ElevenLabs voice id or name, an OpenAI voice, or a macOS `say` voice
outro: Nobody recorded this.          # optional; the last card. Defaults to the host of `url`
outroNote: it re-renders every deploy # optional; the small grey line under it
scenes:
  - say: Top Sets is a hypertrophy tracker that plans your next set for you.
    do:
      - goto: https://topsets.app/
  - say: Every row in the log is alive. It remembers your last lift and judges each set.
    do:
      - scroll_to: "#living-list"
      - hover: "#living-list"
  - say: The program builder is real buttons. Pick a lift, a scheme, and the loads.
    do:
      - click: 'a:has-text("Builder")'
```

Actions: `goto`, `scroll_to`, `scroll`, `hover`, `click`, `type: {selector, text}`, `press`, `wait`. Selectors are Playwright selectors. A failed action is logged in the manifest and skipped; the video still renders.

## Commands

| Command | What it does |
|---|---|
| `demoreel init <url> [sentence]` | scan, plan, write `demoreel.yaml` |
| `demoreel render [file] [--url preview] [--lang xx] [--out dir]` | render; `--url` replays the storyboard on another deployment of the same site |
| `demoreel serve` | the public door on port 8787 (`DEMOREEL_*` variables in `.env.example`) |
| `demoreel doctor [--live]` | checks ffmpeg, font, keys, adapters; `--live` records two seconds on Solari |

`DEMOREEL_TAIL_MS` (500-6000, default 1500) holds the outro card longer, which a clip whose last card carries a
line worth reading wants and a pull-request clip does not.
| `demoreel action-comment` | used by the Action to post the gif on a PR |

## Voices

`ELEVENLABS_API_KEY` picks the ElevenLabs adapter, `OPENAI_API_KEY` the OpenAI one, and with neither key macOS
`say` is used, falling back to silence sized to speaking pace. ElevenLabs goes first when both keys are set: that
key was set for voice, while an OpenAI key is often present for something else. `DEMOREEL_TTS` pins one adapter
(`elevenlabs`, `openai`, `say`); `DEMOREEL_TTS_MODEL` and `DEMOREEL_TTS_VOICE` override the model and the voice.

ElevenLabs defaults to `eleven_multilingual_v2` and the stock Rachel voice, returns 128 kbps mp3, and retries the
vendor's 429s and 5xxs twice before failing the render. `DEMOREEL_TTS_STABILITY`, `DEMOREEL_TTS_SIMILARITY`,
`DEMOREEL_TTS_STYLE`, `DEMOREEL_TTS_SPEED` and `DEMOREEL_TTS_SPEAKER_BOOST` set the delivery; none of them are sent
unless set, so the voice's own defaults apply. Lower stability lets the read vary line to line, which is the
difference between narration that sounds spoken and narration that sounds read. The voice may be an id or a name on the account, which is
looked up once. Only the v2.5 models (`eleven_turbo_v2_5`, `eleven_flash_v2_5`) are sent the `language_code` for a
localized render; `eleven_multilingual_v2` detects the language from the text and rejects the field. Clips are
cached by content hash and by narrator name, so re-rendering an unchanged storyboard costs nothing, and switching
adapters re-voices every scene.

## GitHub Action

```yaml
on:
  deployment_status:
jobs:
  demo:
    if: github.event.deployment_status.state == 'success'
    runs-on: ubuntu-latest
    permissions: { contents: write, pull-requests: write }
    steps:
      - uses: actions/checkout@v4
      - uses: Kurt-John-Kalwin/demoreel/action@main
        with:
          solari-api-key: ${{ secrets.SOLARI_API_KEY }}
          elevenlabs-api-key: ${{ secrets.ELEVENLABS_API_KEY }}
```

On a Vercel deployment event the preview URL is taken from the event; pass `url:` and `pr:` explicitly for other hosts.

## Guards on the public door

Public http(s) hosts only (every resolved address must be public), robots.txt honored, login, checkout and account pages refused, one render at a time, a per-IP daily cap, a daily budget with a hard stop, a `PAUSED` file or `DEMOREEL_PAUSED=1` to pause, a 240 s recording budget per render. Every share page shows the source URL and a takedown address.

## Costs

About two minutes of a Solari browser ($0.10/h) is under a cent. The planner and the voice dominate: roughly $0.03 to $0.05 per 45 s video on OpenAI voices, more on ElevenLabs (per character against a plan's credits; a 45 s script is around 700 characters), or a cent on the macOS `say` path.

## Development

```
npm install
npm test            # offline: fakes for the browser, silent narration, real ffmpeg
npm run typecheck
LIVE=1 npm run test:live   # one real Solari render, about a cent
```

Tests never touch the network. The fake browser answers selector lookups from a table and writes real footage so the ffmpeg stage runs for real.

## Out of scope

App Store preview videos (a native app cannot be captured by a cloud browser), avatars, a timeline editor, accounts.

Built for the Pinetree Research challenge on Solari. MIT.
