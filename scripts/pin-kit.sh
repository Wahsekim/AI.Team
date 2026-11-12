#!/bin/bash
# pin-kit.sh — record a kit upgrade in a two-root instance
# (decisions/0009-kit-instance-separation.md).
#
# Usage: kit/scripts/pin-kit.sh [--dry-run] [ROOT]   (default ROOT: .)
#
# Run AFTER moving kit/ to the reviewed commit (git -C kit pull --ff-only, or a
# submodule update). It rewrites kit.lock, re-copies the engine, and lists the
# seeds that changed since the old pin whose instantiated twins exist in the
# instance — those are ported by hand; instance files are never overwritten.
# Each listed seed is appended to kit-upgrade-review.md as an open '- [ ]' item;
# validate-team.sh fails the deployment until every item is ticked ('- [x]',
# ported or declined with a note), so a missed port cannot stay silent.
#
# Verdicts (last line): PIN-FAILED (exit 1) | DRY-RUN | KIT-PIN-UNCHANGED | KIT-PINNED.

set -uo pipefail

failpin() { echo "FAIL - $1"; echo "RESULT: PIN-FAILED"; exit 1; }

DRY=0
ROOT="."
while [ $# -gt 0 ]; do
  case "$1" in
    --dry-run) DRY=1; shift ;;
    -*) failpin "args: unknown flag '$1'" ;;
    *) ROOT="$1"; shift ;;
  esac
done

KIT="$ROOT/kit"
ENGINE=".claude/workflows/run-n-rounds.js"
{ [ -f "$ROOT/kit.lock" ] && [ -d "$KIT" ]; } || failpin "root: '$ROOT' is not a two-root instance (kit.lock and kit/ required)"
[ "$(sed -n 1p "$ROOT/kit.lock")" = "instance_schema=1" ] || failpin "lock: kit.lock is malformed or uses an unsupported instance schema"
OLD=$(sed -n 2p "$ROOT/kit.lock" | LC_ALL=C grep -E '^kit_commit=([0-9a-f]{40}|unversioned)$' | cut -d= -f2)
[ -n "$OLD" ] || failpin "lock: kit.lock has no valid kit_commit line"

KIT_REAL="$(cd "$KIT" && pwd -P)"
KIT_TOP=$(git -C "$KIT" rev-parse --show-toplevel 2>/dev/null) || KIT_TOP=""
{ [ -n "$KIT_TOP" ] && [ "$(cd "$KIT_TOP" && pwd -P)" = "$KIT_REAL" ]; } \
  || failpin "kit: kit/ is not a Git checkout — a version cannot be pinned"
NEW=$(git -C "$KIT" rev-parse HEAD 2>/dev/null) || failpin "kit: cannot read kit/ HEAD"

DIRTY=$(git -C "$KIT" status --porcelain | cut -c4- | head -5 | tr '\n' ' ')
[ -z "$DIRTY" ] || failpin "kit: kit/ has local changes; the kit is read-only for deployments: $DIRTY"
[ -f "$KIT/$ENGINE" ] || failpin "kit: kit/$ENGINE missing — broken kit checkout"

if [ "$OLD" = "$NEW" ] && cmp -s "$ROOT/$ENGINE" "$KIT/$ENGINE"; then
  echo "RESULT: KIT-PIN-UNCHANGED — kit.lock already records $NEW"
  exit 0
fi

# The engine copy is replaced, so a local edit to it would be lost silently.
if [ -f "$ROOT/$ENGINE" ] && ! cmp -s "$ROOT/$ENGINE" "$KIT/$ENGINE"; then
  if [ "$OLD" = "unversioned" ] \
     || ! git -C "$KIT" show "$OLD:$ENGINE" 2>/dev/null | cmp -s - "$ROOT/$ENGINE"; then
    failpin "engine: the instance engine copy was edited or does not match the pinned kit; restore it from the old pin before upgrading"
  fi
fi

ITEMS=""
if [ "$OLD" != "unversioned" ] && git -C "$KIT" cat-file -e "$OLD^{commit}" 2>/dev/null; then
  while IFS= read -r seed; do
    [ -n "$seed" ] || continue
    case "$seed" in
      CLAUDE.instance.template.md) target="CLAUDE.md" ;;
      *.template.md) target="${seed%.template.md}.md" ;;
      agents/*.md) target="$seed" ;;
      *) continue ;;
    esac
    [ -f "$ROOT/$target" ] || continue
    echo "REVIEW - $target: kit/$seed changed since the old pin; port what applies by hand (git -C kit diff $OLD $NEW -- $seed)"
    ITEMS="$ITEMS- [ ] $target <- kit/$seed ($(printf '%.7s' "$OLD")..$(printf '%.7s' "$NEW"))
"
  done <<EOF_SEEDS
$(git -C "$KIT" diff --name-only "$OLD" "$NEW")
EOF_SEEDS
else
  echo "WARN - review: old pin '$OLD' is not available in kit/; changed seeds cannot be listed"
fi

if [ "$DRY" = 1 ]; then
  echo "RESULT: DRY-RUN — would pin $OLD -> $NEW and re-copy $ENGINE; nothing written."
  exit 0
fi

mkdir -p "$ROOT/.claude/workflows" || failpin "mkdir: .claude/workflows failed"
TMP="$ROOT/$ENGINE.pin-tmp.$$"
if ! { cp "$KIT/$ENGINE" "$TMP" && mv "$TMP" "$ROOT/$ENGINE"; }; then rm -f "$TMP"; failpin "copy: $ENGINE failed"; fi
TMP="$ROOT/kit.lock.pin-tmp.$$"
if ! { printf 'instance_schema=1\nkit_commit=%s\n' "$NEW" > "$TMP" && mv "$TMP" "$ROOT/kit.lock"; }; then
  rm -f "$TMP"; failpin "write: kit.lock failed"
fi
if [ -n "$ITEMS" ]; then
  REVIEW_FILE="$ROOT/kit-upgrade-review.md"
  if [ ! -f "$REVIEW_FILE" ]; then
    printf '# Kit upgrade review\n\nPort or decline each item, then tick it and add a short note. Open items fail validate-team.sh.\n\n' > "$REVIEW_FILE" \
      || failpin "write: kit-upgrade-review.md failed"
  fi
  printf '%s' "$ITEMS" >> "$REVIEW_FILE" || failpin "write: kit-upgrade-review.md failed"
  echo "DONE - kit-upgrade-review.md: open items appended"
fi
echo "RESULT: KIT-PINNED — $OLD -> $NEW; run kit/scripts/validate-team.sh --mode deployment $ROOT"
