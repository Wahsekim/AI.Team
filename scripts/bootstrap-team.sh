#!/bin/bash
# bootstrap-team.sh — lean, idempotent template instantiation for an AI.Team
# deployment. Mechanical half of bootstrap only: the PM interview
# (ask:first_start placeholders, staffing, wrappers) still follows
# docs/bootstrap-*.md afterwards.
#
# Usage: scripts/bootstrap-team.sh [--project-name NAME] [--product-repo PATH]
#                                  [--ui] [--dry-run] [ROOT]   (default ROOT: .)
#
# Guarantees (reassessment N-07 — machine-readable failure semantics):
#  - copies each .template.md seed to its operational name ONLY if missing —
#    re-running never overwrites instantiated or human-edited files;
#  - substitutions ({{PROJECT_NAME...}}, {{PRODUCT_REPO_PATH...}}) are applied
#    only to files created by THIS run, plus the documented CLAUDE.md
#    start-phrase localization (token replacement — idempotent);
#  - FAIL-FAST: a missing value after a flag, a missing MANDATORY seed, or any
#    copy/substitution error prints 'RESULT: BOOTSTRAP-FAILED' and exits 1 —
#    never a green exit over a broken instantiation;
#  - --dry-run prints the plan and writes nothing;
#  - verdicts: BOOTSTRAP-FAILED (exit 1) | DRY-RUN | INSTANTIATED-PENDING-INTERVIEW
#    (files in place, ask:first_start placeholders remain — the normal outcome) |
#    BOOTSTRAPPED (nothing pending);
#  - never writes secrets; ends with the compat + deployment gates
#    (informational here — they go green only after the interview + wrappers).
#
# Dependencies: bash, coreutils, grep, perl (for substitutions).

set -uo pipefail

failboot() { echo "FAIL - $1"; echo "RESULT: BOOTSTRAP-FAILED"; exit 1; }

PROJECT_NAME=""
PRODUCT_REPO=""
UI=0
DRY=0
ROOT="."
while [ $# -gt 0 ]; do
  case "$1" in
    --project-name|--product-repo)
      [ $# -ge 2 ] || failboot "args: $1 requires a value"
      case "$1" in
        --project-name) PROJECT_NAME="$2" ;;
        --product-repo) PRODUCT_REPO="$2" ;;
      esac
      shift 2 ;;
    --ui) UI=1; shift ;;
    --dry-run) DRY=1; shift ;;
    -*) failboot "args: unknown flag '$1'" ;;
    *) ROOT="$1"; shift ;;
  esac
done

[ -d "$ROOT" ] || failboot "root: '$ROOT' is not a directory"
if [ -n "$PROJECT_NAME$PRODUCT_REPO" ] && ! command -v perl >/dev/null 2>&1; then
  failboot "deps: perl is required for --project-name/--product-repo substitutions"
fi
if [ -n "$PRODUCT_REPO" ]; then
  # Normalize to an absolute path (the path may not exist yet — bootstrap of a
  # blank project creates it later; normalize what we can).
  case "$PRODUCT_REPO" in
    /*) : ;;
    *) PRODUCT_REPO="$(cd "$ROOT" && pwd)/$PRODUCT_REPO" ;;
  esac
fi

# Mandatory seeds: a kit missing any of these cannot produce a deployable
# instance — that is a broken checkout, not a skippable step.
MANDATORY_PAIRS="
charter.template.md:charter.md
profiles/project.template.md:profiles/project.md
profiles/stack.template.md:profiles/stack.md
agents/roster.template.md:agents/roster.md
agents/_shared/verify-discipline.template.md:agents/_shared/verify-discipline.md
"
OPTIONAL_PAIRS=""
[ "$UI" = 1 ] && OPTIONAL_PAIRS="agents/_shared/browser-access.template.md:agents/_shared/browser-access.md"

for pair in $MANDATORY_PAIRS; do
  seed="${pair%%:*}"
  target="${pair##*:}"
  [ -f "$ROOT/$seed" ] || [ -f "$ROOT/$target" ] || failboot "seed: mandatory seed $seed missing and $target not instantiated — broken kit checkout"
done

CREATED=""
substitute() { # substitute <file> — fill flag-provided placeholders in place
  f="$1"
  if [ -n "$PROJECT_NAME" ]; then
    PN="$PROJECT_NAME" perl -0pi -e 's/\{\{PROJECT_NAME[^}]*\}\}/$ENV{PN}/g' "$f" \
      || failboot "substitute: PROJECT_NAME substitution failed in $f"
  fi
  if [ -n "$PRODUCT_REPO" ]; then
    PR="$PRODUCT_REPO" perl -0pi -e 's/\{\{PRODUCT_REPO_PATH[^}]*\}\}/$ENV{PR}/g' "$f" \
      || failboot "substitute: PRODUCT_REPO_PATH substitution failed in $f"
  fi
}

for pair in $MANDATORY_PAIRS $OPTIONAL_PAIRS; do
  seed="${pair%%:*}"
  target="${pair##*:}"
  if [ ! -f "$ROOT/$seed" ]; then
    # Mandatory seeds were pre-checked; only optional seeds can land here.
    echo "SKIP - $target: seed $seed not found (optional)"
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
  cp "$ROOT/$seed" "$ROOT/$target" || failboot "copy: $seed -> $target failed"
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
    PN="$PROJECT_NAME" perl -0pi -e 's/\{\{PROJECT_NAME[^}]*\}\}/$ENV{PN}/g' "$ROOT/CLAUDE.md" \
      || failboot "substitute: CLAUDE.md localization failed"
    echo "DONE - CLAUDE.md: start phrase localized to '$PROJECT_NAME'"
  fi
fi

if [ "$DRY" = 1 ]; then
  echo "RESULT: DRY-RUN — nothing written."
  exit 0
fi

# Remaining interview work (drives the verdict).
PENDING=0
for pair in $MANDATORY_PAIRS $OPTIONAL_PAIRS; do
  target="${pair##*:}"
  [ -f "$ROOT/$target" ] || continue
  N=$(grep -c 'ask:first_start' "$ROOT/$target" 2>/dev/null || true)
  if [ "${N:-0}" -gt 0 ]; then
    echo "TODO - $target: $N ask:first_start placeholder(s) need the PM interview"
    PENDING=$((PENDING + N))
  fi
done

# Gates (informational at this stage — they go green only after the interview
# and wrapper instantiation; bootstrap Done checklists require them to pass
# CLEAN before first dispatch).
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
if [ -x "$SCRIPT_DIR/check-claude-compat.sh" ]; then
  "$SCRIPT_DIR/check-claude-compat.sh" "$ROOT" | tail -1 || true
fi
if [ -x "$SCRIPT_DIR/validate-team.sh" ]; then
  "$SCRIPT_DIR/validate-team.sh" --mode deployment "$ROOT" | tail -1 || true
fi
if [ "$PENDING" -gt 0 ]; then
  echo "RESULT: INSTANTIATED-PENDING-INTERVIEW${CREATED:+ — created:$CREATED} — $PENDING ask:first_start placeholder(s) remain. Next: PM interview (docs/bootstrap-*.md), staffing (docs/staffing.md), wrappers, then validate-team.sh --mode deployment must exit 0."
else
  echo "RESULT: BOOTSTRAPPED${CREATED:+ — created:$CREATED}. Next: staffing (docs/staffing.md), wrappers, then validate-team.sh --mode deployment must exit 0."
fi
exit 0
