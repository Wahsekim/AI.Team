#!/bin/bash
# check-claude-compat.sh — fail fast BEFORE bootstrap/deploy when the local
# Claude Code runtime cannot run this kit, instead of failing mid-run.
#
# Usage: scripts/check-claude-compat.sh [--allow-unknown-version] [TEAM_ROOT]   (default: .)
#
# Checks (fail-closed — reassessment N-11):
#  1. `claude` CLI present and version >= MIN_VERSION (Dynamic Workflows —
#     the run-n-rounds engine — require 2.1.154+). An UNPARSABLE version is a
#     FAIL (not a warn-and-pass) unless --allow-unknown-version is given.
#  2. Every active wrapper's frontmatter keys are validated against the
#     official subagent field allowlist — the runtime SILENTLY ignores unknown
#     fields, so any typo demotes a control to a no-op. Unknown key = FAIL.
#
# Exit 0 = compatible; exit 1 = at least one FAIL.

MIN_VERSION="2.1.154"
ALLOW_UNKNOWN_VERSION=0
if [ "$1" = "--allow-unknown-version" ]; then
  ALLOW_UNKNOWN_VERSION=1; shift
fi
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
    if [ "$ALLOW_UNKNOWN_VERSION" = 1 ]; then
      warn "claude-version" "could not parse version from '$RAW' — proceeding ONLY because --allow-unknown-version was given; verify >= $MIN_VERSION manually"
    else
      fail "claude-version" "could not parse version from '$RAW' — fail-closed (an unknown runtime must not pass a compatibility gate); re-run with --allow-unknown-version to override manually"
    fi
  elif version_ge "$VER" "$MIN_VERSION"; then
    pass "claude-version" "$VER >= $MIN_VERSION (Dynamic Workflows supported)"
  else
    fail "claude-version" "$VER < $MIN_VERSION — Dynamic Workflows (the engine) will fail at runtime; upgrade Claude Code"
  fi
fi

# Wrapper frontmatter schema: keys must come from the official subagent field
# allowlist (code.claude.com/docs/en/sub-agents, verified 2026-07). Space-
# delimited for portable bash matching.
ALLOWED_KEYS=" name description model effort maxTurns tools disallowedTools permissionMode color background isolation skills mcpServers memory initialPrompt hooks "
if [ -d "$ROOT/.claude/agents" ]; then
  BAD=""
  SCANNED=0
  for w in "$ROOT"/.claude/agents/*.md; do
    [ -f "$w" ] || continue
    case "$w" in *.template.md|*/README.md) continue ;; esac
    SCANNED=$((SCANNED+1))
    # frontmatter = lines between the first two '---' markers; keys = top-level 'key:'
    KEYS=$(awk '/^---$/{n++; next} n==1 && /^[A-Za-z_][A-Za-z0-9_]*:/{sub(/:.*/,""); print} n>=2{exit}' "$w")
    for k in $KEYS; do
      case "$ALLOWED_KEYS" in
        *" $k "*) ;;
        *) BAD="$BAD ${w#$ROOT/}($k)" ;;
      esac
    done
  done
  if [ -n "$BAD" ]; then
    fail "wrapper-frontmatter" "unknown/legacy frontmatter key(s) — SILENTLY IGNORED by the runtime, the control is a no-op:$BAD (allowed: $ALLOWED_KEYS)"
  elif [ "$SCANNED" -eq 0 ]; then
    warn "wrapper-frontmatter" "no active wrappers in $ROOT/.claude/agents to scan (templates/README excluded)"
  else
    pass "wrapper-frontmatter" "$SCANNED active wrapper(s): all frontmatter keys on the official allowlist"
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
