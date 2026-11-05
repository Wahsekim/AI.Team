#!/bin/bash
# now-utc.sh — the only sanctioned source of ledger timestamps (review
# 2026-09-25, recommendation 11): hand-typed local times labelled 'Z' corrupted
# two ledgers. Prints host-generated UTC, never a hand-derived value.
#
# Usage: scripts/now-utc.sh            -> 2026-09-25T14:03:07Z   (lifecycle/messages timestamps)
#        scripts/now-utc.sh --date     -> 2026-09-25             (engine args.date / messages/<date>.md)
set -u
case "${1:-}" in
  '') date -u +%Y-%m-%dT%H:%M:%SZ ;;
  --date) date -u +%Y-%m-%d ;;
  *) echo "usage: scripts/now-utc.sh [--date]" >&2; exit 1 ;;
esac
