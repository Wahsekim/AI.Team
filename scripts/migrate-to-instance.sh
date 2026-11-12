#!/bin/bash
# migrate-to-instance.sh — move a legacy single-root deployment into a two-root
# instance (decisions/0009-kit-instance-separation.md).
#
# Usage: kit/scripts/migrate-to-instance.sh [--dry-run] [--project-name NAME] [--baseline COMMIT] OLD NEW
#   OLD  the legacy deployment: a kit clone that was bootstrapped in place
#   NEW  the new instance root, already holding the kit checkout at NEW/kit
#
# Copies project state from OLD to NEW, then runs the two-root bootstrap:
#   - files Git ignores or does not track in OLD (charter, profiles, roster,
#     wrappers, messages, project ADRs, project scripts), minus environment junk;
#   - files OLD added relative to the kit baseline, committed or not;
#   - ledgers and role files that differ from the baseline.
# Any other kit file that differs from the baseline is NOT copied (it would
# shadow the kit). Its diff is saved under NEW/migration-review/ and listed as an
# open item in NEW/kit-upgrade-review.md for the PM to port by hand. The same
# holds for a project file at a path the new kit also ships.
#
# The baseline is the kit commit the deployment was made from. It defaults to
# HEAD when HEAD is on a remote branch. A checkout with local commits must name
# it with --baseline: project state committed locally is otherwise invisible.
# OLD and NEW/kit are never written. Existing files in NEW are never overwritten.
#
# Verdicts (last line): MIGRATION-FAILED (exit 1) | DRY-RUN | MIGRATED.

set -uo pipefail

failmig() { echo "FAIL - $1"; echo "RESULT: MIGRATION-FAILED"; exit 1; }

DRY=0
PROJECT_NAME=""
BASELINE=""
OLD=""
NEW=""
while [ $# -gt 0 ]; do
  case "$1" in
    --dry-run) DRY=1; shift ;;
    --project-name)
      [ $# -ge 2 ] || failmig "args: --project-name requires a value"
      PROJECT_NAME="$2"; shift 2 ;;
    --baseline)
      [ $# -ge 2 ] || failmig "args: --baseline requires a commit"
      BASELINE="$2"; shift 2 ;;
    -*) failmig "args: unknown flag '$1'" ;;
    *) if [ -z "$OLD" ]; then OLD="$1"; elif [ -z "$NEW" ]; then NEW="$1"; else failmig "args: unexpected '$1'"; fi; shift ;;
  esac
done
{ [ -n "$OLD" ] && [ -n "$NEW" ]; } || failmig "args: usage: migrate-to-instance.sh [--dry-run] [--project-name NAME] [--baseline COMMIT] OLD NEW"
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

LOCAL_COMMITS=$(git -C "$OLD" rev-list HEAD --not --remotes 2>/dev/null)
if [ -n "$BASELINE" ]; then
  BASE=$(git -C "$OLD" rev-parse --verify -q "$BASELINE^{commit}") || failmig "baseline: '$BASELINE' is not a commit in OLD"
  git -C "$OLD" merge-base --is-ancestor "$BASE" HEAD || failmig "baseline: $BASE is not an ancestor of OLD's HEAD"
  git -C "$OLD" cat-file -e "$BASE:charter.template.md" 2>/dev/null || failmig "baseline: $BASE is not a kit commit (no charter.template.md)"
elif [ -n "$LOCAL_COMMITS" ]; then
  CANDIDATE=$(git -C "$OLD" rev-parse --verify -q "$(printf '%s\n' "$LOCAL_COMMITS" | tail -1)^" || echo none)
  failmig "baseline: OLD has $(printf '%s\n' "$LOCAL_COMMITS" | wc -l | tr -d ' ') local commit(s) on no remote branch, so the kit commit it was deployed from is unknown and committed project state could be missed — check it and pass --baseline <kit commit> (candidate: $CANDIDATE)"
else
  BASE=$(git -C "$OLD" rev-parse HEAD) || failmig "baseline: OLD has no HEAD commit"
fi

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
PORT_FILES=""
# A project file: copied, unless the new kit ships the same path (it would shadow it).
project_file() {
  junk "$1" && return 0
  if [ -e "$NEW/kit/$1" ] && ! is_ledger "$1" && ! is_role "$1"; then
    PORT_FILES="$PORT_FILES$1
"
  else
    COPY="$COPY$1
"
  fi
}
# Untracked and ignored files, one path per line (directories expanded).
while IFS= read -r f; do
  [ -n "$f" ] || continue
  project_file "$f"
done <<EOF_OTHERS
$(git -C "$OLD" ls-files --others)
EOF_OTHERS
# Everything that differs from the kit baseline: local commits, index and work tree.
while IFS="	" read -r status f; do
  [ -n "$f" ] || continue
  [ -f "$OLD/$f" ] || { echo "WARN - $f: kit file deleted in OLD; not migrated"; continue; }
  if [ "$status" = "A" ]; then
    project_file "$f"
  elif is_ledger "$f" || is_role "$f"; then
    COPY="$COPY$f
"
  else
    PORT="$PORT$f
"
  fi
done <<EOF_CHANGED
$(git -C "$OLD" diff --name-status --no-renames "$BASE")
EOF_CHANGED

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

review_item() {
  if [ ! -f "$NEW/kit-upgrade-review.md" ]; then
    printf '# Kit upgrade review\n\nPort or decline each item, then tick it and add a short note. Open items fail validate-team.sh.\n\n' > "$NEW/kit-upgrade-review.md" \
      || failmig "write: kit-upgrade-review.md failed"
  fi
  printf -- '- [ ] %s\n' "$1" >> "$NEW/kit-upgrade-review.md" || failmig "write: kit-upgrade-review.md failed"
}

PORTS=0
while IFS= read -r f; do
  [ -n "$f" ] || continue
  PORTS=$((PORTS+1))
  echo "PORT - $f: local edits to a kit file; port by hand into the instance (diff: migration-review/$f.diff)"
  [ "$DRY" = 1 ] && continue
  mkdir -p "$(dirname "$NEW/migration-review/$f")" || failmig "mkdir: migration-review failed"
  git -C "$OLD" diff "$BASE" -- "$f" > "$NEW/migration-review/$f.diff" || failmig "diff: $f failed"
  review_item "$f <- local edits to a kit file (migration-review/$f.diff)"
done <<EOF_PORT
$PORT
EOF_PORT

while IFS= read -r f; do
  [ -n "$f" ] || continue
  PORTS=$((PORTS+1))
  echo "PORT - $f: project file at a path the new kit also ships; port by hand (copy: migration-review/$f)"
  [ "$DRY" = 1 ] && continue
  mkdir -p "$(dirname "$NEW/migration-review/$f")" || failmig "mkdir: migration-review failed"
  cp -p "$OLD/$f" "$NEW/migration-review/$f" || failmig "copy: $f failed"
  review_item "$f <- project file at a path the kit also ships (migration-review/$f)"
done <<EOF_PORT_FILES
$PORT_FILES
EOF_PORT_FILES

if [ "$DRY" = 1 ]; then
  echo "RESULT: DRY-RUN — baseline $BASE; $PORTS item(s) to port by hand; nothing written."
  exit 0
fi

if [ -n "$PROJECT_NAME" ]; then
  BOUT=$(bash "$SCRIPT_DIR/bootstrap-team.sh" --project-name "$PROJECT_NAME" "$NEW" 2>&1) || { printf '%s\n' "$BOUT" | tail -3; failmig "bootstrap: two-root bootstrap failed"; }
else
  BOUT=$(bash "$SCRIPT_DIR/bootstrap-team.sh" "$NEW" 2>&1) || { printf '%s\n' "$BOUT" | tail -3; failmig "bootstrap: two-root bootstrap failed"; }
fi
printf '%s\n' "$BOUT" | grep -E '^(DONE|WARN|TODO) ' || true
printf '%s\n' "$BOUT" | tail -1
echo "RESULT: MIGRATED — $COPIED file(s) copied, $PORTS item(s) to port by hand (baseline $BASE); OLD untouched. Next: port the listed edits, then kit/scripts/validate-team.sh --mode deployment $NEW"
