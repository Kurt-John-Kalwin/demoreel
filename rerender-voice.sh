#!/usr/bin/env bash
# Re-renders the releasedeck launch video with the real ElevenLabs voice.
#
# Run this once the ELEVENLABS_API_KEY's credit limit is raised (the script needs ~837
# credits; the key was capped at 10). Nothing but the narration changes: the storyboard,
# the page and the cuts are already locked.
set -euo pipefail
cd "$(dirname "$0")"

SB="/private/tmp/claude-501/-Users-kurtkalwin-Solrais/5899895d-a142-4cb8-b92f-c6a65d756f98/scratchpad/demoreel.yaml"
OUT="/private/tmp/claude-501/-Users-kurtkalwin-Solrais/5899895d-a142-4cb8-b92f-c6a65d756f98/scratchpad/out-final"

[ -f "$SB" ] || { echo "storyboard missing: $SB"; exit 1; }

echo "voice check…"
npx tsx src/cli/main.ts doctor | grep -E "narrator|solari" || true

echo
echo "rendering with ElevenLabs (Roger — Laid-Back, Casual, Resonant)…"
DEMOREEL_TTS=elevenlabs npx tsx src/cli/main.ts render "$SB" --out "$OUT"

echo
echo "done → $OUT/demo.mp4"
echo "listen before posting."
