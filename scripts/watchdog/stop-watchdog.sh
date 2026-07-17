#!/usr/bin/env bash
# Stop / SessionEnd hook: kills the background watchdog spawned at SessionStart.

set -e
umask 077

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
# Session IDs are UNTRUSTED input (they land in file paths): safe charset only.
case "$session_id" in
    *[!A-Za-z0-9._-]*) session_id="" ;;
esac
session_id=$(printf '%s' "$session_id" | cut -c1-128)
[ -z "$session_id" ] && session_id="ppid-$PPID"

PID_FILE="$HB_DIR/${session_id}.watchdog-pid"
HB_FILE="$HB_DIR/${session_id}.heartbeat"

# True only for a strictly-numeric PID whose live command is our watchdog loop
# FOR THIS SESSION (the loop's argv carries the session id) — never TERM/KILL a
# PID we merely found in a file (stale files, PID reuse, other sessions).
pid_is_watchdog() {
    [ -n "$1" ] || return 1
    case "$1" in *[!0-9]*) return 1 ;; esac
    # Fixed-string suffix match — session ids may contain '.' which is a regex
    # metachar; never build a regex from untrusted-ish input (F-08).
    _cmd=$(ps -p "$1" -o command= 2>/dev/null) || return 1
    case "$_cmd" in *"watchdog-loop.sh ${session_id}") return 0 ;; *) return 1 ;; esac
}

if [ -f "$PID_FILE" ]; then
    pid=$(cat "$PID_FILE" 2>/dev/null || echo "")
    if pid_is_watchdog "$pid"; then
        kill -TERM "$pid" 2>/dev/null || true
        # Give it a moment, then force.
        sleep 0.5
        if pid_is_watchdog "$pid"; then
            kill -KILL "$pid" 2>/dev/null || true
        fi
    fi
    rm -f "$PID_FILE"
fi

# Removing the heartbeat file is also a stop signal for the loop. Clear the
# alert state too (R-10): a leftover `.alerted-*` marker would keep an
# orphaned loop waiting until max lifetime instead of exiting cleanly.
rm -f "$HB_FILE"
find "$HB_DIR" -maxdepth 1 -name "${session_id}.heartbeat.alerted-*" -delete 2>/dev/null || true
rmdir "$HB_DIR/${session_id}.start-lock" 2>/dev/null || true

exit 0
