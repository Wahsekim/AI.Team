#!/usr/bin/env bash
# SessionStart hook: spawns the background watchdog loop for this Claude session.
# Wired in ~/.claude/settings.json under hooks.SessionStart.
#
# Idempotent: if a watchdog for this session_id is already running, no-op.

set -e

HB_DIR="$HOME/.claude/heartbeats"
mkdir -p "$HB_DIR"

# Parse session_id from JSON stdin (Claude Code hook protocol).
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

# Initial heartbeat so the watchdog has a baseline.
touch "$HB_FILE"

# Already running for this session?
if [ -f "$PID_FILE" ]; then
    existing_pid=$(cat "$PID_FILE" 2>/dev/null || echo "")
    if [ -n "$existing_pid" ] && kill -0 "$existing_pid" 2>/dev/null; then
        # Watchdog already alive for this session - done.
        exit 0
    fi
    # Stale PID file - clean up and respawn.
    rm -f "$PID_FILE"
fi

# Spawn watchdog loop in disowned background. Prefer the installed Claude scripts
# location; fall back to this repository directory for local testing.
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
LOOP_SCRIPT="$HOME/.claude/scripts/watchdog-loop.sh"
if [ ! -x "$LOOP_SCRIPT" ]; then
    LOOP_SCRIPT="$SCRIPT_DIR/watchdog-loop.sh"
fi

if [ -x "$LOOP_SCRIPT" ]; then
    nohup bash "$LOOP_SCRIPT" "$session_id" \
        >> "$HOME/.claude/watchdog.stdout.log" \
        2>> "$HOME/.claude/watchdog.stderr.log" &
    echo $! > "$PID_FILE"
    disown
fi

exit 0
