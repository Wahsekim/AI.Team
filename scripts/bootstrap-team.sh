#!/bin/bash
# bootstrap-team.sh — lean, idempotent template instantiation for an AI.Team
# deployment. Mechanical half of bootstrap only: the PM interview
# (ask:first_start placeholders, staffing, wrappers) still follows
# docs/bootstrap-*.md afterwards.
#
# Usage: scripts/bootstrap-team.sh [--project-name NAME] [--product-repo PATH]
#                                  [--ui] [--dry-run] [ROOT]   (default ROOT: .)
#
# Guarantees:
#  - copies each .template.md seed to its operational name ONLY if missing —
#    re-running never overwrites instantiated or human-edited files;
#  - substitutions ({{PROJECT_NAME...}}, {{PRODUCT_REPO_PATH...}}) are applied
#    only to files created by THIS run, plus the documented CLAUDE.md
#    start-phrase localization (token replacement — idempotent);
#  - --dry-run prints the plan and writes nothing;
#  - never writes secrets; finishes by running the compat + validation gates
#    (informational — remaining ask:first_start placeholders are expected
#    until the PM interview completes).

set -u

PROJECT_NAME=""
PRODUCT_REPO=""
UI=0
DRY=0
ROOT="."
while [ $# -gt 0 ]; do
  case "$1" in
    --project-name) PROJECT_NAME="${2:-}"; shift 2 ;;
    --product-repo) PRODUCT_REPO="${2:-}"; shift 2 ;;
    --ui) UI=1; shift ;;
    --dry-run) DRY=1; shift ;;
    -*) echo "FAIL - args: unknown flag '$1'"; exit 1 ;;
    *) ROOT="$1"; shift ;;
  esac
done

if [ ! -d "$ROOT" ]; then
  echo "FAIL - root: '$ROOT' is not a directory"
  exit 1
fi
if [ -n "$PRODUCT_REPO" ]; then
  # Normalize to an absolute path (the path may not exist yet — bootstrap of a
  # blank project creates it later; normalize what we can).
  case "$PRODUCT_REPO" in
    /*) : ;;
    *) PRODUCT_REPO="$(cd "$ROOT" && pwd)/$PRODUCT_REPO" ;;
  esac
fi

PAIRS="
charter.template.md:charter.md
profiles/project.template.md:profiles/project.md
profiles/stack.template.md:profiles/stack.md
agents/roster.template.md:agents/roster.md
agents/_shared/verify-discipline.template.md:agents/_shared/verify-discipline.md
"
[ "$UI" = 1 ] && PAIRS="$PAIRS
agents/_shared/browser-access.template.md:agents/_shared/browser-access.md"

CREATED=""
substitute() { # substitute <file> — fill flag-provided placeholders in place
  f="$1"
  if [ -n "$PROJECT_NAME" ]; then
    PN="$PROJECT_NAME" perl -0pi -e 's/\{\{PROJECT_NAME[^}]*\}\}/$ENV{PN}/g' "$f"
  fi
  if [ -n "$PRODUCT_REPO" ]; then
    PR="$PRODUCT_REPO" perl -0pi -e 's/\{\{PRODUCT_REPO_PATH[^}]*\}\}/$ENV{PR}/g' "$f"
  fi
}

for pair in $PAIRS; do
  seed="${pair%%:*}"
  target="${pair##*:}"
  if [ ! -f "$ROOT/$seed" ]; then
    echo "SKIP - $target: seed $seed not found"
    continue
  fi
  if [ -f "$ROOT/$target" ]; then
    echo "SKIP - $target: already instantiated (never overwritten)"
    continue
  fi
  if [ "$DRY" = 1 ]; then
    echo "PLAN - $target: would instantiate from $seed"
    continue
  fi
  cp "$ROOT/$seed" "$ROOT/$target"
  substitute "$ROOT/$target"
  CREATED="$CREATED $target"
  echo "DONE - $target: instantiated from $seed"
done

# Documented CLAUDE.md localization: replace the start-phrase PROJECT_NAME
# token only (idempotent — second run finds no token to replace).
if [ -n "$PROJECT_NAME" ] && [ -f "$ROOT/CLAUDE.md" ] && grep -q '{{PROJECT_NAME' "$ROOT/CLAUDE.md"; then
  if [ "$DRY" = 1 ]; then
    echo "PLAN - CLAUDE.md: would localize {{PROJECT_NAME}} start phrase"
  else
    PN="$PROJECT_NAME" perl -0pi -e 's/\{\{PROJECT_NAME[^}]*\}\}/$ENV{PN}/g' "$ROOT/CLAUDE.md"
    echo "DONE - CLAUDE.md: start phrase localized to '$PROJECT_NAME'"
  fi
fi

if [ "$DRY" = 1 ]; then
  echo "RESULT: DRY-RUN — nothing written."
  exit 0
fi

# Remaining interview work (informational).
for pair in $PAIRS; do
  target="${pair##*:}"
  [ -f "$ROOT/$target" ] || continue
  N=$(grep -c 'ask:first_start' "$ROOT/$target" 2>/dev/null || true)
  [ "${N:-0}" -gt 0 ] && echo "TODO - $target: $N ask:first_start placeholder(s) need the PM interview"
done

# Gates (informational here — placeholders are expected until the interview
# and wrapper instantiation finish; bootstrap Done checklists require them to
# pass CLEAN before first dispatch).
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
if [ -x "$SCRIPT_DIR/check-claude-compat.sh" ]; then
  "$SCRIPT_DIR/check-claude-compat.sh" "$ROOT" | tail -1
fi
if [ -x "$SCRIPT_DIR/validate-team.sh" ]; then
  "$SCRIPT_DIR/validate-team.sh" --mode deployment "$ROOT" | tail -1
fi
echo "RESULT: BOOTSTRAPPED${CREATED:+ —$CREATED}. Next: PM interview (docs/bootstrap-*.md), staffing (docs/staffing.md), wrappers, then validate-team.sh --mode deployment must exit 0."
exit 0
