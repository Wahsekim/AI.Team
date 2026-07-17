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
TMP=""
trap 'rm -f "${TMP:-}" 2>/dev/null' EXIT

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

# Root lock (F-07): two concurrent bootstraps with different flags would each
# instantiate part of the tree and both exit 0 — a mixed-config deployment.
if [ "$DRY" != 1 ]; then
  BOOT_LOCK="$ROOT/.bootstrap-lock"
  if ! mkdir "$BOOT_LOCK" 2>/dev/null; then
    # Stale-lock recovery (R5-12a): a SIGKILL inside the lock window would
    # brick every later run. Mirror reconcile-run.mjs acquireLock: if the
    # recorded owner pid is dead, reclaim and retry ONCE; a live owner blocks
    # as before.
    lock_pid=$(cat "$BOOT_LOCK/pid" 2>/dev/null || echo "")
    case "$lock_pid" in ''|*[!0-9]*) lock_pid="" ;; esac
    if [ -z "$lock_pid" ]; then
      # R6-09: a missing pid file may just be a concurrent bootstrap inside
      # its mkdir->pid-write init window — grace-wait and re-read before
      # judging, instead of reclaiming a lock that is being born.
      sleep 1
      lock_pid=$(cat "$BOOT_LOCK/pid" 2>/dev/null || echo "")
      case "$lock_pid" in ''|*[!0-9]*) lock_pid="" ;; esac
      if [ -z "$lock_pid" ]; then
        # Still ownerless after the grace re-read: reclaim ONLY a demonstrably
        # old lock — a FRESH ownerless lock is treated as held (R6-09).
        # GNU stat first: on Linux, BSD-style 'stat -f %m' SUCCEEDS but prints
        # the mount point, which would poison the arithmetic (same pattern as
        # scripts/watchdog/start-watchdog.sh).
        lock_mtime=$(stat -c %Y "$BOOT_LOCK" 2>/dev/null || stat -f %m "$BOOT_LOCK" 2>/dev/null || echo "")
        case "$lock_mtime" in ''|*[!0-9]*) lock_mtime="" ;; esac
        now_s=$(date +%s)
        if [ -z "$lock_mtime" ] || [ $((now_s - lock_mtime)) -le 10 ]; then
          failboot "another bootstrap appears to be in progress (lock $BOOT_LOCK is ownerless but fresh) — wait for it, or remove it manually if it persists"
        fi
      fi
    fi
    if [ -n "$lock_pid" ] && kill -0 "$lock_pid" 2>/dev/null; then
      failboot "another bootstrap appears to be in progress (lock $BOOT_LOCK held by live pid $lock_pid) — wait for it"
    fi
    echo "WARN - lock: stale $BOOT_LOCK (owner pid '${lock_pid:-unknown}' not running) — reclaiming"
    rm -rf "$BOOT_LOCK"
    mkdir "$BOOT_LOCK" 2>/dev/null \
      || failboot "cannot acquire lock $BOOT_LOCK even after clearing a stale one — resolve manually"
  fi
  echo $$ > "$BOOT_LOCK/pid"
  # Ownership-verified release (R6-09): the EXIT trap re-reads the recorded
  # pid and deletes the lock ONLY if it is our own — a run exiting after
  # losing a race must never clean up someone else's live lock.
  trap 'rm -f "${TMP:-}" 2>/dev/null; if [ "$(cat "$BOOT_LOCK/pid" 2>/dev/null)" = "$$" ]; then rm -rf "$BOOT_LOCK" 2>/dev/null; fi' EXIT
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
  # Atomic render (R-09): copy + substitute into a same-directory temp file,
  # then rename — an interrupt mid-substitution never leaves a half-rendered
  # target that a retry would then skip via never-overwrite.
  TMP="$ROOT/${target}.render-tmp.$$"
  cp "$ROOT/$seed" "$TMP" || { rm -f "$TMP"; failboot "copy: $seed -> $target failed"; }
  substitute "$TMP"
  mv "$TMP" "$ROOT/$target" || { rm -f "$TMP"; failboot "rename: $target failed"; }
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

# Gates decide the SINGLE final verdict (R-09/F-07) — automation reads the
# last line only, so it must never say BOOTSTRAPPED when any gate failed:
#   compat FAIL      -> PENDING-RUNTIME-COMPAT (runtime on this machine cannot run the kit)
#   validator FAIL   -> PENDING-STAFFING (structure incomplete)
#   placeholders     -> INSTANTIATED-PENDING-INTERVIEW
#   all clean        -> BOOTSTRAPPED
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
# Fail-closed (R5-08), like the validator gate below: the gate is clean only
# when the checker RAN and passed. Explicit interpreter — a copy/unzip that
# drops the exec bit must not silently skip the gate.
COMPAT_CLEAN=0
if [ -f "$SCRIPT_DIR/check-claude-compat.sh" ]; then
  if COUT=$(bash "$SCRIPT_DIR/check-claude-compat.sh" "$ROOT" 2>&1); then
    COMPAT_CLEAN=1
  fi
  printf '%s\n' "$COUT" | tail -1
else
  echo "WARN - compat: scripts/check-claude-compat.sh missing — compatibility gate NOT run (fail-closed)"
fi
VALIDATOR_CLEAN=0
if [ -x "$SCRIPT_DIR/validate-team.sh" ]; then
  if VOUT=$("$SCRIPT_DIR/validate-team.sh" --mode deployment "$ROOT" 2>&1); then
    VALIDATOR_CLEAN=1
  fi
  printf '%s\n' "$VOUT" | tail -1
fi
if [ "$PENDING" -gt 0 ]; then
  echo "RESULT: INSTANTIATED-PENDING-INTERVIEW${CREATED:+ — created:$CREATED} — $PENDING ask:first_start placeholder(s) remain. Next: PM interview (docs/bootstrap-*.md), staffing (docs/staffing.md), wrappers, then validate-team.sh --mode deployment must exit 0."
elif [ "$VALIDATOR_CLEAN" != 1 ]; then
  echo "RESULT: PENDING-STAFFING${CREATED:+ — created:$CREATED} — interview placeholders resolved but the deployment is NOT structurally complete (see validator output above: wrappers/staffing/ledgers still needed). Not BOOTSTRAPPED."
elif [ "$COMPAT_CLEAN" != 1 ]; then
  echo "RESULT: PENDING-RUNTIME-COMPAT${CREATED:+ — created:$CREATED} — structure complete but the Claude runtime on THIS machine failed the compatibility gate (see above). Not BOOTSTRAPPED."
else
  echo "RESULT: BOOTSTRAPPED${CREATED:+ — created:$CREATED} — structure and runtime compatibility gates passed."
fi
exit 0
