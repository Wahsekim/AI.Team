#!/usr/bin/env bash
# Stop / SessionEnd hook: kills the background watchdog spawned at SessionStart.

set -e

HB_DIR="$HOME/.claude/heartbeats"
[ ! -d "$HB_DIR" ] && exit 0

# Parse session_id from JSON stdin.
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

PID_FILE="$HB_DIR/${session_id}.watchdog-pid"
HB_FILE="$HB_DIR/${session_id}.heartbeat"

if [ -f "$PID_FILE" ]; then
    pid=$(cat "$PID_FILE" 2>/dev/null || echo "")
    if [ -n "$pid" ] && kill -0 "$pid" 2>/dev/null; then
        kill -TERM "$pid" 2>/dev/null || true
        # Give it a moment, then force.
        sleep 0.5
        kill -KILL "$pid" 2>/dev/null || true
    fi
    rm -f "$PID_FILE"
fi

# Removing the heartbeat file is also a stop signal for the loop.
rm -f "$HB_FILE"

exit 0
