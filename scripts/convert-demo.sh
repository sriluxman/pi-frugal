#!/usr/bin/env bash
# convert-demo.sh — turns docs/demo.cast into docs/demo.gif via agg.
# Tuned for github gallery: dark theme reads well on both light/dark.
set -eu

REPO_DIR="$(cd "$(dirname "$0")/.." && pwd)"
CAST="${REPO_DIR}/docs/demo.cast"
GIF="${REPO_DIR}/docs/demo.gif"

[ -f "$CAST" ] || { echo "✗ no cast at $CAST — run record-demo.sh first"; exit 1; }

agg "$CAST" "$GIF" \
  --theme monokai \
  --font-size 14 \
  --speed 1.4 \
  --fps-cap 24 \
  --idle-time-limit 1

echo
echo "✓ wrote $GIF ($(du -h "$GIF" | cut -f1))"
