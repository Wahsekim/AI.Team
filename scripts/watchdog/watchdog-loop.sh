#!/usr/bin/env bash
# Background watchdog loop, one per Claude session.
# Spawned by start-watchdog.sh on SessionStart; killed by stop-watchdog.sh on Stop/SessionEnd.
#
# Usage: watchdog-loop.sh <session_id>
#
# Loop:
#   sleep WATCHDOG_INTERVAL (default 30s)
#   compute heartbeat age
#   if age > WATCHDOG_THRESHOLD (default 600s = 10min): alert + log + bail
#
# Self-terminates if:
#   - heartbeat file disappears (stop hook ran cleanly)
#   - max lifetime reached (default 12h - defense against orphaned loops)

set -e
umask 077

# Session IDs are UNTRUSTED input (they land in file paths, JSONL log lines and
# the notification text): safe charset only, else fall back to 'unknown'.
session_id="${1:-unknown}"
case "$session_id" in
    *[!A-Za-z0-9._-]*) session_id="unknown" ;;
esac
session_id=$(printf '%s' "$session_id" | cut -c1-128)
[ -z "$session_id" ] && session_id="unknown"

INTERVAL_SECONDS=${WATCHDOG_INTERVAL:-30}
THRESHOLD_SECONDS=${WATCHDOG_THRESHOLD:-600}
MAX_LIFETIME_SECONDS=${WATCHDOG_MAX_LIFETIME:-43200}  # 12 hours

HB_DIR="$HOME/.claude/heartbeats"
HB_FILE="$HB_DIR/${session_id}.heartbeat"
PID_FILE="$HB_DIR/${session_id}.watchdog-pid"
LOG="$HOME/.claude/hang-log.jsonl"

started_at=$(date +%s)

while true; do
    now=$(date +%s)

    # Self-terminate if max lifetime reached.
    if [ $((now - started_at)) -gt "$MAX_LIFETIME_SECONDS" ]; then
        printf '{"ts":"%s","session_id":"%s","event":"watchdog_max_lifetime"}\n' \
            "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$session_id" >> "$LOG"
        rm -f "$PID_FILE"
        exit 0
    fi

    # Self-terminate ONLY on clean shutdown: heartbeat gone AND no alert state.
    # After a stale alert the heartbeat is set aside as `.alerted-<ts>` — that is
    # a WAITING state, not a stop signal: keep looping (bounded by max lifetime)
    # so monitoring resumes when the next tool result recreates the heartbeat
    # (N-08: the old behavior exited here and never monitored again).
    if [ ! -f "$HB_FILE" ]; then
        if ls "$HB_DIR/${session_id}.heartbeat.alerted-"* >/dev/null 2>&1; then
            sleep "$INTERVAL_SECONDS"
            continue
        fi
        # Heartbeat was removed with no alert pending - session ended cleanly.
        rm -f "$PID_FILE"
        exit 0
    fi

    # Compute heartbeat age.
    if mtime=$(stat -f %m "$HB_FILE" 2>/dev/null); then :; else mtime=$(stat -c %Y "$HB_FILE"); fi
    age=$((now - mtime))

    if [ "$age" -gt "$THRESHOLD_SECONDS" ]; then
        ts=$(date -u +%Y-%m-%dT%H:%M:%SZ)
        printf '{"ts":"%s","session_id":"%s","age_seconds":%d,"threshold":%d,"event":"heartbeat_stale"}\n' \
            "$ts" "$session_id" "$age" "$THRESHOLD_SECONDS" >> "$LOG"

        if command -v osascript >/dev/null 2>&1; then
            osascript -e "display notification \"Session ${session_id} hung for ${age}s - check Claude Code\" with title \"Claude Code watchdog\" sound name \"Funk\"" 2>/dev/null || true
        fi

        # Move heartbeat aside so we don't re-alert on the next iteration.
        # If session resumes, the heartbeat hook recreates the file.
        mv "$HB_FILE" "${HB_FILE}.alerted-${now}" 2>/dev/null || true
    fi

    sleep "$INTERVAL_SECONDS"
done
