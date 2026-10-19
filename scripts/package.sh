#!/usr/bin/env bash
# Build a Discordio test zip without the Decky CLI or Docker.
#
# This build does not bundle GStreamer, so Go Live uses the system's GStreamer
# (check with `discordio-test.sh report`). The GitHub Actions build uses the
# Decky CLI and bundles it.
#
# Usage: scripts/package.sh            -> out/Discordio.zip

set -euo pipefail
cd "$(dirname "$0")/.."

NAME="Discordio"
STAGE="out/stage/$NAME"

pnpm install --frozen-lockfile
pnpm run build

rm -rf out/stage "out/$NAME.zip"
mkdir -p "$STAGE/dist"
cp dist/index.js "$STAGE/dist/"
cp main.py plugin.json package.json README.md LICENSE LICENSE-Deckcord "$STAGE/"
# Decky expects the contents of defaults/ at the plugin root.
cp -r defaults/. "$STAGE/"
find "$STAGE" -name '__pycache__' -prune -exec rm -rf {} +

(cd out/stage && zip -qr "../$NAME.zip" "$NAME")
rm -rf out/stage
echo "Built out/$NAME.zip"
