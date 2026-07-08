#!/usr/bin/env bash
# Heartbeat hook for Claude Code autonomous-loop watchdog.
# Wired as a PostToolUse hook in ~/.claude/settings.json.
# Touches ~/.claude/heartbeats/<session_id>.heartbeat after every tool result,
# proving the session is still making forward progress.
#
# Install: copy to ~/.claude/scripts/heartbeat.sh, chmod +x, then add the
# settings.json snippet from this directory.

set -e

HB_DIR="$HOME/.claude/heartbeats"
mkdir -p "$HB_DIR"

# Hook receives JSON on stdin. Try to extract session_id; fall back to PPID.
session_id=""
if command -v python3 >/dev/null 2>&1; then
    session_id=$(python3 -c "import sys, json
try:
    d = json.load(sys.stdin)
    print(d.get('session_id', ''))
except Exception:
    print('')" 2>/dev/null || true)
fi
[ -z "$session_id" ] && session_id="ppid-$PPID"

touch "$HB_DIR/${session_id}.heartbeat"

# If a prior watchdog moved the file aside as `.alerted-<ts>`, clean those
# up - heartbeat resumed, so the alert state is stale.
find "$HB_DIR" -maxdepth 1 -name "${session_id}.heartbeat.alerted-*" -delete 2>/dev/null || true

exit 0
