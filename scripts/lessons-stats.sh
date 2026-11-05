#!/bin/bash
# lessons-stats.sh — lesson citation counts from lifecycle `- Lessons:` lines
# (teamai port P03, docs/teamai-port-plan-2026-10-14.md).
#
# Usage: scripts/lessons-stats.sh [ROOT]   (default: .)
#
# Pure bash + awk. Reads agents/lessons.md (index lines only) and every
# lifecycle file (active + agents/archive/lifecycle-*.md, so counts survive
# rotation). Prints one line per lesson plus WARN advisories for the Coach
# thresholds in agents/coach.md -> Lessons Regime. Counts are printed, NEVER
# written into the index. WARN never fails; exit 1 only on args/missing files.

set -u

ROOT="."
while [ $# -gt 0 ]; do
  case "$1" in
    -*) echo "FAIL - args: unknown flag '$1'"; exit 1 ;;
    *) ROOT="$1"; shift ;;
  esac
done

INDEX="$ROOT/agents/lessons.md"
ACTIVE="$ROOT/agents/lifecycle.md"
[ -f "$INDEX" ] || { echo "FAIL - files: $INDEX missing"; exit 1; }
[ -f "$ACTIVE" ] || { echo "FAIL - files: $ACTIVE missing"; exit 1; }

STALE_WINDOW=30
PROMOTE_MIN=2
FOLD_MIN=5
FOLD_ROLES=2

# Archives first, active last: "last" citation follows file order then entry order.
FILES=""
for f in "$ROOT"/agents/archive/lifecycle-*.md; do [ -f "$f" ] && FILES="$FILES $f"; done
FILES="$FILES $ACTIVE"

# shellcheck disable=SC2086
awk -v index_file="$INDEX" -v active_file="$ACTIVE" \
    -v stale_window="$STALE_WINDOW" -v promote_min="$PROMOTE_MIN" \
    -v fold_min="$FOLD_MIN" -v fold_roles="$FOLD_ROLES" '
BEGIN {
  n = 0
  while ((getline line < index_file) > 0) {
    if (match(line, /^- L[0-9][0-9][0-9]?[0-9]? - [A-Za-z0-9<>_-]+ - /)) {
      split(line, parts, " - ")
      id = parts[1]; sub(/^- /, "", id)
      order[++n] = id; status[id] = parts[2]
    }
  }
  close(index_file)
}
/^## \[[0-9]+\]/ {
  entry = $2; sub(/^\[/, "", entry); sub(/\]$/, "", entry)
  role = ""
  if (match($0, /\([^)]*\)/)) role = substr($0, RSTART + 1, RLENGTH - 2)
  if (FILENAME == active_file) active_entries[++active_n] = entry
  next
}
/^- Lessons:/ {
  rest = $0; sub(/^- Lessons:[ \t]*/, "", rest)
  while (match(rest, /L[0-9][0-9][0-9]?[0-9]?/)) {
    id = substr(rest, RSTART, RLENGTH)
    rest = substr(rest, RSTART + RLENGTH)
    key = id SUBSEP entry
    if (!(key in cited_in)) {
      cited_in[key] = 1
      cited[id]++
      last[id] = entry
      rkey = id SUBSEP role
      if (!(rkey in role_seen)) { role_seen[rkey] = 1; roles[id]++ }
    }
    if (!(id in status)) unknown[id] = entry
  }
}
END {
  if (n == 0) print "INFO - index: no lessons in index"
  for (i = 1; i <= n; i++) {
    id = order[i]
    c = cited[id] + 0; r = roles[id] + 0
    printf "%s %s cited=%d roles=%d last=%s\n", id, status[id], c, r, (id in last ? "[" last[id] "]" : "none")
  }
  for (i = 1; i <= n; i++) {
    id = order[i]; c = cited[id] + 0; r = roles[id] + 0
    if (status[id] == "candidate" && c >= promote_min)
      printf "WARN - promote: %s candidate cited=%d (>=%d distinct entries) -> Coach: codify to active\n", id, c, promote_min
    if (c >= fold_min && r >= fold_roles)
      printf "WARN - fold: %s cited=%d roles=%d -> Coach: fold proposal (coach.md Lessons Regime)\n", id, c, r
    if (status[id] == "active" && active_n >= stale_window) {
      hit = 0
      for (j = active_n - stale_window + 1; j <= active_n; j++) if ((id SUBSEP active_entries[j]) in cited_in) hit = 1
      if (!hit) printf "WARN - stale: %s active uncited in last %d dispatches -> obsolete candidate (Coach judges; new lessons may trip this)\n", id, stale_window
    }
  }
  for (id in unknown) printf "WARN - unknown: %s cited in [%s] but not in the index\n", id, unknown[id]
  print "LESSONS-STATS-OK"
}' $FILES
