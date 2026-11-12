#!/bin/bash
# measure-context.sh — measure the cold-start prompt load of the PM wake set
# and a representative worker read set (remediation plan P1-05).
#
# Usage: scripts/measure-context.sh [--budget-pm TOKENS] [--budget-worker TOKENS] [ROOT]
#
# Tokens are ESTIMATED as bytes/4 (order-of-magnitude gauge, not billing).
# Budgets are RATCHETS: exceeding one exits 1 so doc growth is a deliberate
# decision, not drift. Current budgets: docs/context-budget.md.
#
# Two-root instances (decisions/0009-kit-instance-separation.md): a path is
# read in ROOT if it exists there, otherwise under ROOT/kit, and is printed with
# the root it came from. A required file found in neither root fails the run
# with CONTEXT-MEASUREMENT-INCOMPLETE: a partial count is not a measurement.

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

TWO_ROOT=0
{ [ -f "$ROOT/kit.lock" ] || [ -f "$ROOT/kit/charter.template.md" ]; } && TWO_ROOT=1

# located <path> -> the path under ROOT that holds it (instance first, then kit/); the path itself if nowhere
located() {
  if [ ! -f "$ROOT/$1" ] && [ "$TWO_ROOT" = 1 ] && [ -f "$ROOT/kit/$1" ]; then echo "kit/$1"; else echo "$1"; fi
}
# first_existing <candidate...> -> the first candidate found in either root; the first candidate if none is
first_existing() {
  for c in "$@"; do
    l=$(located "$c")
    [ -f "$ROOT/$l" ] && { echo "$l"; return 0; }
  done
  echo "$1"
}

FAILURES=0
MISSING=0
measure_set() { # measure_set <label> <budget> <file...>
  label="$1"; budget="$2"; shift 2
  total=0
  echo "== $label =="
  for f in "$@"; do
    f=$(located "$f")
    [ -f "$ROOT/$f" ] || { echo "  FAIL - required file not found: $f"; MISSING=$((MISSING+1)); continue; }
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
# An instance primer sends the reader on to the kit primer, so both are read.
KIT_PRIMER=""
[ "$TWO_ROOT" = 1 ] && KIT_PRIMER="kit/CLAUDE.md"
PM_SET="
CLAUDE.md
$KIT_PRIMER
$(first_existing profiles/project.md profiles/project.template.md)
$(first_existing profiles/stack.md profiles/stack.template.md)
$(first_existing charter.md charter.template.md)
agents/pm.md
agents/_shared/meta-rules.md
docs/workflow-catalog.md
$(first_existing agents/lessons.md agents/lessons.template.md)
"

# Worker read sets: EVERY live wrapper in .claude/agents/ (deployment) with the
# role file it points at — the complete active-role read closure, not a
# template/backend proxy (review 2026-09-25, I-1). A fresh kit measures the
# seed + backend.md. templates.md is counted in full though briefs use one section.
live_wrappers() {
  found=0
  for w in "$ROOT"/.claude/agents/*.md; do
    [ -f "$w" ] || continue
    case "$w" in *.template.md|*/README.md|*INLINE_BASE_AGENT_MODE.md) continue ;; esac
    echo "${w#"$ROOT"/}"; found=1
  done
  [ "$found" = 1 ] || first_existing agents/_seeds/role-wrapper.template.md
}
role_file_of() { # role_file_of <wrapper> -> the agents/<role>.md the wrapper body reads, else backend.md
  rf=$(grep -oE 'agents/[a-z][a-z0-9_-]*\.md' "$ROOT/$1" 2>/dev/null | grep -v '_shared/\|_seeds/\|templates\.md\|lessons\.md\|roster\.md\|pm\.md\|lifecycle\.md' | head -1)
  if [ -n "$rf" ] && [ -f "$ROOT/$(located "$rf")" ]; then located "$rf"; else located "agents/backend.md"; fi
}
SHARED_SET="
$(first_existing profiles/project.md profiles/project.template.md)
$(first_existing profiles/stack.md profiles/stack.template.md)
agents/templates.md
agents/_shared/meta-rules.md
$(first_existing agents/_shared/verify-discipline.md agents/_shared/verify-discipline.template.md)
$(first_existing agents/lessons.md agents/lessons.template.md)
"

# shellcheck disable=SC2086
measure_set "PM wake set" "$BUDGET_PM" $PM_SET
for WRAPPER in $(live_wrappers); do
  ROLE_FILE=$(role_file_of "$WRAPPER")
  echo
  # shellcheck disable=SC2086
  measure_set "Worker read set ($WRAPPER + $ROLE_FILE)" "$BUDGET_WORKER" "$WRAPPER" "$ROLE_FILE" $SHARED_SET
done

if [ "$MISSING" -gt 0 ]; then
  echo "RESULT: CONTEXT-MEASUREMENT-INCOMPLETE ($MISSING required file(s) not found; totals above are partial)"
  exit 1
fi
if [ "$FAILURES" -gt 0 ]; then
  echo "RESULT: CONTEXT-BUDGET-EXCEEDED ($FAILURES set(s))"
  exit 1
fi
echo "RESULT: CONTEXT-BUDGETS-OK"
exit 0
