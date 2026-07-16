#!/bin/bash
# measure-context.sh — measure the cold-start prompt load of the PM wake set
# and a representative worker read set (remediation plan P1-05).
#
# Usage: scripts/measure-context.sh [--budget-pm TOKENS] [--budget-worker TOKENS] [ROOT]
#
# Tokens are ESTIMATED as bytes/4 (order-of-magnitude gauge, not billing).
# Budgets are RATCHETS: exceeding one exits 1 so doc growth is a deliberate
# decision, not drift. Current budgets: docs/context-budget.md.

set -u

BUDGET_PM=25000
BUDGET_WORKER=10000
ROOT="."
while [ $# -gt 0 ]; do
  case "$1" in
    --budget-pm) BUDGET_PM="${2:-}"; shift 2 ;;
    --budget-worker) BUDGET_WORKER="${2:-}"; shift 2 ;;
    -*) echo "FAIL - args: unknown flag '$1'"; exit 1 ;;
    *) ROOT="$1"; shift ;;
  esac
done

# first_existing <candidate...> -> prints the first file that exists
first_existing() {
  for c in "$@"; do
    [ -f "$ROOT/$c" ] && { echo "$c"; return 0; }
  done
  return 1
}

FAILURES=0
measure_set() { # measure_set <label> <budget> <file...>
  label="$1"; budget="$2"; shift 2
  total=0
  echo "== $label =="
  for f in "$@"; do
    [ -f "$ROOT/$f" ] || { echo "  (missing) $f"; continue; }
    bytes=$(wc -c < "$ROOT/$f" | tr -d ' ')
    tok=$((bytes / 4))
    total=$((total + tok))
    printf '  %7d bytes ~%6d tok  %s\n' "$bytes" "$tok" "$f"
  done
  printf '  TOTAL ~%d tokens (budget %d)\n' "$total" "$budget"
  if [ "$total" -gt "$budget" ]; then
    echo "  FAIL - $label exceeds its context budget — trim or consciously raise the ratchet (docs/context-budget.md)"
    FAILURES=$((FAILURES+1))
  else
    echo "  PASS - $label within budget"
  fi
}

# PM wake set (CLAUDE.md PM Start Protocol; instantiated names first,
# template seeds pre-bootstrap). Ledgers are partial reads in practice —
# counted in full here, which keeps the ratchet conservative.
PM_SET="
CLAUDE.md
$(first_existing profiles/project.md profiles/project.template.md)
$(first_existing profiles/stack.md profiles/stack.template.md)
$(first_existing charter.md charter.template.md)
agents/pm.md
agents/_shared/meta-rules.md
docs/workflow-catalog.md
agents/lessons.md
"

# Representative worker read set (role-wrapper read list; backend as the
# representative role, templates.md counted in full though briefs use one section).
WORKER_SET="
$(first_existing .claude/agents/role-wrapper.template.md)
agents/backend.md
$(first_existing profiles/project.md profiles/project.template.md)
$(first_existing profiles/stack.md profiles/stack.template.md)
agents/templates.md
agents/_shared/meta-rules.md
$(first_existing agents/_shared/verify-discipline.md agents/_shared/verify-discipline.template.md)
agents/lessons.md
"

# shellcheck disable=SC2086
measure_set "PM wake set" "$BUDGET_PM" $PM_SET
echo
# shellcheck disable=SC2086
measure_set "Worker read set (backend)" "$BUDGET_WORKER" $WORKER_SET

if [ "$FAILURES" -gt 0 ]; then
  echo "RESULT: CONTEXT-BUDGET-EXCEEDED ($FAILURES set(s))"
  exit 1
fi
echo "RESULT: CONTEXT-BUDGETS-OK"
exit 0
