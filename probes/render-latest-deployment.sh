#!/usr/bin/env bash
# The Action's `target` and `render` steps, run on this machine instead of a GitHub runner.
# Takes the URL from the latest SUCCESSFUL github-pages deployment, exactly as action.yml does:
#   URL="${{ github.event.deployment_status.environment_url || github.event.deployment_status.target_url }}"
set -euo pipefail
cd "$(dirname "$0")/.."
REPO=Kurt-John-Kalwin/demoreel
OUT="${1:-out/deploy-$(date +%H%M%S)}"

DEP=$(gh api "repos/$REPO/deployments?environment=github-pages&per_page=1" --jq '.[0].id')
read -r STATE URL < <(gh api "repos/$REPO/deployments/$DEP/statuses?per_page=1" \
  --jq '.[0] | "\(.state) \(.environment_url // .target_url)"')
echo "deployment $DEP  state=$STATE  url=$URL"
[ "$STATE" = "success" ] || { echo "latest deployment is not a success; nothing to film"; exit 1; }

set -a; . ./.env; set +a
export DEMOREEL_TTS=elevenlabs
npx tsx src/cli/main.ts render demoreel.yaml --url "$URL" --out "$OUT"
