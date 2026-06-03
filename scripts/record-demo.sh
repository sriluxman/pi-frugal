#!/usr/bin/env bash
# record-demo.sh — drives an interactive pi session inside a tmux pane while
# asciinema records the whole thing. Used to produce docs/demo.gif for the
# pi.dev gallery preview.
#
# Not part of the installable package's runtime — purely a release-asset tool.

set -eu

REPO_DIR="$(cd "$(dirname "$0")/.." && pwd)"
CAST_OUT="${REPO_DIR}/docs/demo.cast"
SESSION="pifrugal_demo_$$"
DEMO_CWD="/tmp/pi-frugal-demo-cwd"

# Clean working dir so pi opens in a tidy place.
rm -rf "${DEMO_CWD}"
mkdir -p "${DEMO_CWD}"
# Drop a few decoy files so "list files" has interesting output
echo "stub" > "${DEMO_CWD}/notes.md"
echo "x" > "${DEMO_CWD}/.config"
mkdir "${DEMO_CWD}/src" && echo "fn main(){}" > "${DEMO_CWD}/src/main.rs"

# Background driver — types into the tmux session with realistic pacing.
# Sleeps are tuned for typical Anthropic latency over github-copilot.
drive() {
  local s="$1"
  sleep 4.0                                                # let pi finish booting + render footer

  # ── Scene 1: cheap retrieval → Haiku (keyword "list")
  tmux send-keys -t "$s" "list the files in the current directory" Enter
  sleep 14

  # ── Scene 2: design/brainstorm → Sonnet (keyword "brainstorm")
  tmux send-keys -t "$s" "brainstorm three caching strategies for a public REST API, one short sentence each" Enter
  sleep 22

  # ── Scene 3: ,opus comma-override → Opus (inline override demonstration)
  tmux send-keys -t "$s" ",opus in one short paragraph, what makes an LRU cache thread-safe" Enter
  sleep 26

  # ── Scene 4: hero frame — the routing decision table
  tmux send-keys -t "$s" "/route show" Enter
  sleep 5

  # Quit cleanly
  tmux send-keys -t "$s" "/exit" Enter
  sleep 1
  tmux send-keys -t "$s" "" C-d
  sleep 1
}

cleanup() {
  tmux kill-session -t "$SESSION" 2>/dev/null || true
  # restore any disabled local skills/extensions
  for f in "$HOME/.pi/agent/skills/atlassian.md.demo-disabled" \
           "$HOME/.pi/agent/extensions/tier-router.ts.demo-disabled" \
           "$HOME/.pi/agent/extensions/aicredits-footer.ts.demo-disabled"; do
    [ -f "$f" ] && mv "$f" "${f%.demo-disabled}"
  done
}
trap cleanup EXIT

# Disable any locally-installed copies so the only loaded versions are
# pi-frugal's (via -e). Otherwise pi prints a [Skill conflicts] warning
# right where our hero frame should be.
for f in "$HOME/.pi/agent/skills/atlassian.md" \
         "$HOME/.pi/agent/extensions/tier-router.ts" \
         "$HOME/.pi/agent/extensions/aicredits-footer.ts"; do
  [ -f "$f" ] && mv "$f" "${f}.demo-disabled"
done

# Start pi inside a detached tmux session at fixed geometry (good aspect for a gallery tile).
# -e loads the local pi-frugal package without needing it installed.
# --no-session keeps the demo from polluting session history.
tmux new-session -d -s "$SESSION" -x 110 -y 30 \
  "cd '${DEMO_CWD}' && pi --no-session -e '${REPO_DIR}'"

# Spawn driver in background, then record the tmux session in foreground.
drive "$SESSION" &
DRIVER_PID=$!

# asciinema records the tmux attach as its child process.
asciinema rec --overwrite --idle-time-limit 2 \
  --title "pi-frugal — tiered routing + AiCredits footer" \
  --command "tmux attach -t $SESSION" \
  "${CAST_OUT}"

wait "$DRIVER_PID" 2>/dev/null || true
echo
echo "✓ recorded → ${CAST_OUT}"
echo "  next: bash $(dirname "$0")/convert-demo.sh"
