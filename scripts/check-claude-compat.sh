#!/bin/bash
# check-claude-compat.sh — fail fast BEFORE bootstrap/deploy when the local
# Claude Code runtime cannot run this kit, instead of failing mid-run.
#
# Usage: scripts/check-claude-compat.sh [TEAM_ROOT]   (default: .)
#
# Checks:
#  1. `claude` CLI present and version >= MIN_VERSION (Dynamic Workflows —
#     the run-n-rounds engine — require 2.1.154+).
#  2. No wrapper in .claude/agents/ uses legacy/unknown frontmatter fields
#     (`reasoning_effort:`, `token_budget:`) — the runtime SILENTLY ignores
#     unknown fields, so a typo demotes a control to a no-op.
#
# Exit 0 = compatible; exit 1 = at least one FAIL.

MIN_VERSION="2.1.154"
ROOT="${1:-.}"
FAILURES=0

say()  { printf '%s - %s: %s\n' "$1" "$2" "$3"; }
pass() { say "PASS" "$1" "$2"; }
warn() { say "WARN" "$1" "$2"; }
fail() { say "FAIL" "$1" "$2"; FAILURES=$((FAILURES+1)); }

# version_ge A B -> true when A >= B (numeric, dot-separated)
version_ge() {
  [ "$(printf '%s\n%s\n' "$2" "$1" | sort -t. -k1,1n -k2,2n -k3,3n | head -1)" = "$2" ]
}

if ! command -v claude >/dev/null 2>&1; then
  fail "claude-cli" "'claude' not found on PATH — install Claude Code >= $MIN_VERSION"
else
  RAW=$(claude --version 2>/dev/null | head -1)
  VER=$(printf '%s' "$RAW" | grep -oE '[0-9]+\.[0-9]+\.[0-9]+' | head -1)
  if [ -z "$VER" ]; then
    warn "claude-version" "could not parse version from '$RAW' — verify >= $MIN_VERSION manually"
  elif version_ge "$VER" "$MIN_VERSION"; then
    pass "claude-version" "$VER >= $MIN_VERSION (Dynamic Workflows supported)"
  else
    fail "claude-version" "$VER < $MIN_VERSION — Dynamic Workflows (the engine) will fail at runtime; upgrade Claude Code"
  fi
fi

# Legacy/unknown frontmatter fields in active wrappers (templates excluded).
if [ -d "$ROOT/.claude/agents" ]; then
  BAD=""
  for w in "$ROOT"/.claude/agents/*.md; do
    [ -f "$w" ] || continue
    case "$w" in *.template.md|*/README.md) continue ;; esac
    # frontmatter = lines between the first two '---' markers
    FM=$(awk '/^---$/{n++; next} n==1{print} n>=2{exit}' "$w")
    for field in reasoning_effort token_budget; do
      if printf '%s\n' "$FM" | grep -qE "^${field}:"; then
        BAD="$BAD ${w#$ROOT/}($field)"
      fi
    done
  done
  if [ -n "$BAD" ]; then
    fail "wrapper-frontmatter" "legacy/unknown frontmatter field(s) — silently ignored by the runtime:$BAD (use 'effort'; token budgets are brief-level advisory)"
  else
    pass "wrapper-frontmatter" "no legacy reasoning_effort/token_budget frontmatter in active wrappers"
  fi
else
  warn "wrapper-frontmatter" "no .claude/agents directory at $ROOT — nothing to check"
fi

if [ "$FAILURES" -gt 0 ]; then
  echo "RESULT: INCOMPATIBLE — $FAILURES FAIL(s); fix before bootstrap/deploy."
  exit 1
fi
echo "RESULT: COMPATIBLE — Claude Code runtime checks passed."
exit 0
