#!/bin/bash
# migrate-to-instance.sh — move a legacy single-root deployment into a two-root
# instance (decisions/0009-kit-instance-separation.md).
#
# Usage: kit/scripts/migrate-to-instance.sh [--dry-run] [--project-name NAME] OLD NEW
#   OLD  the legacy deployment: a kit clone that was bootstrapped in place
#   NEW  the new instance root, already holding the kit checkout at NEW/kit
#
# Copies project state from OLD to NEW, then runs the two-root bootstrap:
#   - files Git ignores or does not track in OLD (charter, profiles, roster,
#     wrappers, messages, project ADRs, project scripts), minus environment junk;
#   - tracked ledgers and role files that OLD modified.
# Any other tracked kit file that OLD modified is NOT copied (it would shadow
# the kit). Its diff is saved under NEW/migration-review/ and listed as an open
# item in NEW/kit-upgrade-review.md for the PM to port by hand.
# OLD and NEW/kit are never written. Existing files in NEW are never overwritten.
#
# Verdicts (last line): MIGRATION-FAILED (exit 1) | DRY-RUN | MIGRATED.

set -uo pipefail

failmig() { echo "FAIL - $1"; echo "RESULT: MIGRATION-FAILED"; exit 1; }

DRY=0
PROJECT_NAME=""
OLD=""
NEW=""
while [ $# -gt 0 ]; do
  case "$1" in
    --dry-run) DRY=1; shift ;;
    --project-name)
      [ $# -ge 2 ] || failmig "args: --project-name requires a value"
      PROJECT_NAME="$2"; shift 2 ;;
    -*) failmig "args: unknown flag '$1'" ;;
    *) if [ -z "$OLD" ]; then OLD="$1"; elif [ -z "$NEW" ]; then NEW="$1"; else failmig "args: unexpected '$1'"; fi; shift ;;
  esac
done
{ [ -n "$OLD" ] && [ -n "$NEW" ]; } || failmig "args: usage: migrate-to-instance.sh [--dry-run] [--project-name NAME] OLD NEW"
{ [ -d "$OLD" ] && [ -d "$NEW" ]; } || failmig "root: OLD and NEW must be existing directories"
OLD="$(cd "$OLD" && pwd -P)"
NEW="$(cd "$NEW" && pwd -P)"
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"

[ "$OLD" != "$NEW" ] || failmig "root: OLD and NEW are the same directory"
[ -f "$NEW/kit/charter.template.md" ] || failmig "root: NEW/kit is not a kit checkout — add the kit at $NEW/kit first"
[ "$OLD" != "$NEW/kit" ] || failmig "root: OLD is the new instance's kit"
{ [ -f "$OLD/charter.md" ] && [ -f "$OLD/charter.template.md" ]; } \
  || failmig "root: OLD is not a single-root deployment (charter.md and charter.template.md expected)"
[ "$(git -C "$OLD" rev-parse --show-toplevel 2>/dev/null)" = "$OLD" ] || failmig "root: OLD is not the top of a Git checkout"
{ [ ! -e "$NEW/charter.md" ] && [ ! -e "$NEW/kit.lock" ]; } || failmig "root: NEW already holds an instance (charter.md or kit.lock present)"

junk() { # environment and runtime artifacts that are rebuilt, not migrated
  case "$1" in
    .DS_Store|*/.DS_Store|.venv/*|node_modules/*|__pycache__/*|*/__pycache__/*|.playwright-mcp/*|heartbeats/*|.team-loop/*|*.pyc|*.log|*.tmp|*render-tmp.*|.bootstrap-lock/*|.reconcile-lock/*) return 0 ;;
  esac
  return 1
}
is_ledger() { case "$1" in agents/lifecycle.md|agents/lessons.md|memory/pm.md|pm-decisions.md) return 0 ;; esac; return 1; }
is_role() {
  case "$1" in agents/pm.md|agents/*/*) return 1 ;; agents/*.md) ;; *) return 1 ;; esac
  grep -qiE '^##[[:space:]]+base agent' "$OLD/$1" 2>/dev/null
}

COPY=""
PORT=""
# Untracked and ignored files, one path per line (directories expanded).
while IFS= read -r f; do
  [ -n "$f" ] || continue
  junk "$f" && continue
  COPY="$COPY$f
"
done <<EOF_OTHERS
$(git -C "$OLD" ls-files --others)
EOF_OTHERS
# Tracked files the deployment modified.
while IFS= read -r f; do
  [ -n "$f" ] || continue
  [ -f "$OLD/$f" ] || { echo "WARN - $f: tracked file deleted in OLD; not migrated"; continue; }
  if is_ledger "$f" || is_role "$f"; then
    COPY="$COPY$f
"
  else
    PORT="$PORT$f
"
  fi
done <<EOF_MODIFIED
$(git -C "$OLD" diff --name-only HEAD)
EOF_MODIFIED

COPIED=0
while IFS= read -r f; do
  [ -n "$f" ] || continue
  if [ -e "$NEW/$f" ]; then echo "SKIP - $f: already present in NEW (never overwritten)"; continue; fi
  if [ "$DRY" = 1 ]; then echo "PLAN - copy $f"; continue; fi
  mkdir -p "$(dirname "$NEW/$f")" || failmig "mkdir: directory for $f failed"
  cp -p "$OLD/$f" "$NEW/$f" || failmig "copy: $f failed"
  COPIED=$((COPIED+1))
done <<EOF_COPY
$COPY
EOF_COPY

PORTS=0
while IFS= read -r f; do
  [ -n "$f" ] || continue
  PORTS=$((PORTS+1))
  echo "PORT - $f: local edits to a kit file; port by hand into the instance (diff: migration-review/$f.diff)"
  [ "$DRY" = 1 ] && continue
  mkdir -p "$(dirname "$NEW/migration-review/$f")" || failmig "mkdir: migration-review failed"
  git -C "$OLD" diff HEAD -- "$f" > "$NEW/migration-review/$f.diff" || failmig "diff: $f failed"
  if [ ! -f "$NEW/kit-upgrade-review.md" ]; then
    printf '# Kit upgrade review\n\nPort or decline each item, then tick it and add a short note. Open items fail validate-team.sh.\n\n' > "$NEW/kit-upgrade-review.md" \
      || failmig "write: kit-upgrade-review.md failed"
  fi
  printf -- '- [ ] %s <- local edits to a kit file (migration-review/%s.diff)\n' "$f" "$f" >> "$NEW/kit-upgrade-review.md" \
    || failmig "write: kit-upgrade-review.md failed"
done <<EOF_PORT
$PORT
EOF_PORT

if [ "$DRY" = 1 ]; then
  echo "RESULT: DRY-RUN — $PORTS kit-file edit(s) to port by hand; nothing written."
  exit 0
fi

if [ -n "$PROJECT_NAME" ]; then
  BOUT=$(bash "$SCRIPT_DIR/bootstrap-team.sh" --project-name "$PROJECT_NAME" "$NEW" 2>&1) || { printf '%s\n' "$BOUT" | tail -3; failmig "bootstrap: two-root bootstrap failed"; }
else
  BOUT=$(bash "$SCRIPT_DIR/bootstrap-team.sh" "$NEW" 2>&1) || { printf '%s\n' "$BOUT" | tail -3; failmig "bootstrap: two-root bootstrap failed"; }
fi
printf '%s\n' "$BOUT" | grep -E '^(DONE|WARN|TODO) ' || true
printf '%s\n' "$BOUT" | tail -1
echo "RESULT: MIGRATED — $COPIED file(s) copied, $PORTS kit-file edit(s) to port by hand; OLD untouched. Next: port the listed edits, then kit/scripts/validate-team.sh --mode deployment $NEW"
