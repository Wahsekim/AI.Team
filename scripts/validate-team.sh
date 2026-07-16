#!/bin/bash
# validate-team.sh — mechanical integrity checker for an AI.Team kit or deployment.
#
# Usage: scripts/validate-team.sh [--mode kit|deployment] [DEPLOYMENT_ROOT]   (default: auto-detect, .)
#
# Pure bash + grep/awk/sed/stat. No dependencies. Exit 0 = no FAIL, exit 1 = FAIL(s).
# One "PASS|FAIL|WARN|SKIP - <check>: <detail>" line per check. WARN/SKIP never fail.
#
# Modes:
#  - kit         -> validate a fresh kit (templates only); inapplicable checks SKIP.
#  - deployment  -> validate a deployed instance: the mandatory-artifact matrix must
#                   be complete; a missing artifact is a FAIL, never a silent skip.
#  - (no --mode) -> auto-detect: charter.md present = deployment, else kit. Auto-detect
#                   CANNOT catch a deployment that lost its charter — bootstrap Done
#                   checklists and CI must call --mode deployment explicitly.
#
# Verdicts (last line): KIT-VALID | DEPLOYMENT-READY | DEPLOYMENT-INCOMPLETE.
# Exit 0 means "no FAIL in the checked mode", NOT "healthy for every purpose".
#
# This script is the mechanical control for failure classes FC-8 (counter drift)
# and parts of FC-9 (staleness) plus single-source/instantiation drift —
# see docs/failure-classes.md. Wired into: agents/pm.md wake step 0, bootstrap
# Done checklists, and the recommended Stop hook (docs/harness-assumptions.md).

MODE="auto"
if [ "$1" = "--mode" ]; then
  case "$2" in
    kit|deployment) MODE="$2"; shift 2 ;;
    *) echo "FAIL - args: --mode must be 'kit' or 'deployment' (got '${2:-}')"; exit 1 ;;
  esac
fi
ROOT="${1:-.}"
FAILURES=0
STALE_DAYS=14

say()  { printf '%s - %s: %s\n' "$1" "$2" "$3"; }
pass() { say "PASS" "$1" "$2"; }
warn() { say "WARN" "$1" "$2"; }
skip() { say "SKIP" "$1" "$2"; }
fail() { say "FAIL" "$1" "$2"; FAILURES=$((FAILURES+1)); }

if [ ! -d "$ROOT" ]; then
  echo "FAIL - root: '$ROOT' is not a directory"
  exit 1
fi

# Deployment-mode marker: explicit --mode wins; auto-detect falls back to charter presence.
case "$MODE" in
  deployment) DEPLOYED=1 ;;
  kit)        DEPLOYED=0 ;;
  *)          DEPLOYED=0; [ -f "$ROOT/charter.md" ] && DEPLOYED=1 ;;
esac
echo "MODE: $MODE (validating as $([ "$DEPLOYED" = 1 ] && echo deployment || echo kit))"

mtime_of() { # portable mtime (epoch seconds): macOS then GNU
  stat -f %m "$1" 2>/dev/null || stat -c %Y "$1" 2>/dev/null
}

# --------------------- check -1: mandatory-artifact matrix (deployment mode only)
# Data-driven completeness gate: every artifact bootstrap is contractually required
# to produce. Missing OR EMPTY = FAIL — never a silent skip (a partial or hollow
# deployment must not validate green). browser-access.md is conditional (UI
# projects) and is enforced by the reference-integrity check below instead.
MANDATORY_ARTIFACTS="
CLAUDE.md
charter.md
profiles/project.md
profiles/stack.md
agents/roster.md
agents/_shared/verify-discipline.md
agents/lifecycle.md
agents/lessons.md
memory/pm.md
pm-decisions.md
"
if [ "$DEPLOYED" = 1 ]; then
  MISSING_ART=""
  EMPTY_ART=""
  for f in $MANDATORY_ARTIFACTS; do
    if [ ! -f "$ROOT/$f" ]; then MISSING_ART="$MISSING_ART $f"
    elif [ ! -s "$ROOT/$f" ]; then EMPTY_ART="$EMPTY_ART $f"
    fi
  done
  if [ -n "$MISSING_ART" ] || [ -n "$EMPTY_ART" ]; then
    DETAIL=""
    [ -n "$MISSING_ART" ] && DETAIL="missing:$MISSING_ART"
    [ -n "$EMPTY_ART" ] && DETAIL="$DETAIL empty:$EMPTY_ART"
    fail "mandatory-artifacts" "deployment has incomplete bootstrap-mandatory artifact(s): $DETAIL"
  else
    pass "mandatory-artifacts" "all bootstrap-mandatory artifacts present and non-empty"
  fi
  # Conditional artifact by reference-integrity: only OPERATIVE CONFIG surfaces
  # (roster table rows, wrappers, profiles) count as declaring the dependency —
  # kit prose that conditionally MENTIONS browser-access.md (e.g. agents/pm.md
  # "UI projects need...") must not fail a non-UI deployment (false-red fix).
  if [ ! -f "$ROOT/agents/_shared/browser-access.md" ]; then
    BA_REFS=""
    if [ -f "$ROOT/agents/roster.md" ] && \
       grep -E '^\|' "$ROOT/agents/roster.md" | grep -q 'browser-access\.md'; then
      BA_REFS="$BA_REFS agents/roster.md(row)"
    fi
    for f in profiles/project.md profiles/stack.md; do
      [ -f "$ROOT/$f" ] && grep -q 'agents/_shared/browser-access\.md' "$ROOT/$f" && BA_REFS="$BA_REFS $f"
    done
    if [ -d "$ROOT/.claude/agents" ]; then
      for w in "$ROOT"/.claude/agents/*.md; do
        [ -f "$w" ] || continue
        case "$w" in *.template.md|*/README.md) continue ;; esac
        grep -q 'browser-access\.md' "$w" && BA_REFS="$BA_REFS ${w#$ROOT/}"
      done
    fi
    if [ -n "$BA_REFS" ]; then
      fail "browser-access-ref" "operative config references agents/_shared/browser-access.md but it does not exist:$BA_REFS"
    else
      pass "browser-access-ref" "browser-access.md absent and not referenced by operative config (non-UI project)"
    fi
  else
    pass "browser-access-ref" "agents/_shared/browser-access.md present"
  fi
else
  skip "mandatory-artifacts" "kit mode — deployment artifact matrix not applicable"
fi

# ---------------------------------------------------------------- check 0: charter
if [ "$DEPLOYED" = 1 ]; then
  if [ -f "$ROOT/charter.md" ]; then
    pass "charter" "charter.md exists (deployed instance)"
  else
    fail "charter" "deployment mode but charter.md is missing (bootstrap incomplete or wrong root)"
  fi
elif [ -f "$ROOT/charter.template.md" ]; then
  skip "charter" "fresh kit (charter.template.md only; instantiate at bootstrap)"
else
  fail "charter" "neither charter.md nor charter.template.md found — not an AI.Team root?"
fi

# ------------------------------------------------- check 1: lifecycle log integrity
LC="$ROOT/agents/lifecycle.md"
if [ ! -f "$LC" ]; then
  if [ "$DEPLOYED" = 1 ]; then
    fail "lifecycle-exists" "deployed but agents/lifecycle.md missing"
  else
    skip "lifecycle-exists" "fresh kit — no agents/lifecycle.md yet"
  fi
else
  # Entry numbers, in file order (headers only; the Format example block is fenced
  # with {{...}} placeholders and never matches a literal '## [NNN]' with digits).
  NUMS=$(grep -E '^## \[[0-9]+\]' "$LC" | sed -E 's/^## \[([0-9]+)\].*/\1/')
  COUNT=$(printf '%s' "$NUMS" | grep -c '^[0-9]' 2>/dev/null)

  # 1a duplicates
  DUPES=$(printf '%s\n' "$NUMS" | grep '.' | sort | uniq -d)
  if [ -n "$DUPES" ]; then
    fail "lifecycle-duplicates" "duplicate [NNN] entries: $(echo $DUPES | tr '\n' ' ')"
  else
    pass "lifecycle-duplicates" "no duplicate [NNN] headers ($COUNT entries)"
  fi

  # 1b continuity (strictly +1 within the active file; archives roll the start forward)
  if [ "$COUNT" -le 1 ]; then
    pass "lifecycle-continuity" "$COUNT entries — continuity trivially holds"
  else
    GAPS=$(printf '%s\n' "$NUMS" | grep '.' | awk '
      NR>1 && $1+0 != prev+1 { printf "%03d->%03d ", prev, $1+0 }
      { prev=$1+0 }')
    if [ -n "$GAPS" ]; then
      fail "lifecycle-continuity" "non-consecutive [NNN] sequence: $GAPS"
    else
      pass "lifecycle-continuity" "[NNN] strictly consecutive across $COUNT entries"
    fi
  fi

  # 1c banned second-close headers ('## [NNN] ... close' style)
  CLOSES=$(grep -inE '^## \[[0-9]+\][^A-Za-z0-9]*close' "$LC")
  if [ -n "$CLOSES" ]; then
    fail "lifecycle-close-headers" "banned second 'close' header(s): $(echo "$CLOSES" | head -3 | tr '\n' ' ')"
  else
    pass "lifecycle-close-headers" "no second-close headers"
  fi

  # 1d counter line cross-check (Next NNN to assign == last entry + 1)
  CTR=$(grep -E 'Next NNN to assign' "$LC" | grep -oE '[0-9]+' | head -1)
  if [ -z "$CTR" ]; then
    warn "lifecycle-counter" "no 'Next NNN to assign' counter line found"
  elif [ "$COUNT" -eq 0 ]; then
    pass "lifecycle-counter" "counter=$CTR, no entries yet — nothing to reconcile"
  else
    LAST=$(printf '%s\n' "$NUMS" | grep '.' | tail -1)
    EXPECT=$((10#$LAST + 1))
    if [ "$((10#$CTR))" -eq "$EXPECT" ]; then
      pass "lifecycle-counter" "counter $CTR == last entry $LAST + 1"
    else
      fail "lifecycle-counter" "counter says $CTR but last entry is $LAST (expected $(printf '%03d' "$EXPECT"))"
    fi
  fi
fi

# --------------------- check 2: unresolved {{...}} placeholders in instantiated files
# Scope: ONLY files bootstrap is contractually required to fill. Kit reference files
# (templates.md, pm.md, lazy-placeholders.md, ...) legitimately carry {{...}} forever.
if [ "$DEPLOYED" = 0 ]; then
  skip "placeholders" "fresh kit — nothing instantiated to check"
else
  PH_FAILS=""
  PH_WARNS=""

  # charter: leftover ask:first_start = FAIL; other {{...}} = WARN (lazy defaults sanctioned)
  if grep -qE '\{\{[^}]*ask:first_start' "$ROOT/charter.md" 2>/dev/null; then
    PH_FAILS="$PH_FAILS charter.md(ask:first_start)"
  elif grep -q '{{' "$ROOT/charter.md" 2>/dev/null; then
    PH_WARNS="$PH_WARNS charter.md"
  fi

  # profiles: lazy placeholders are sanctioned -> WARN only
  for f in profiles/project.md profiles/stack.md; do
    [ -f "$ROOT/$f" ] && grep -q '{{' "$ROOT/$f" && PH_WARNS="$PH_WARNS $f"
  done

  # strict set: bootstrap MUST fully resolve these
  for f in agents/roster.md agents/_shared/verify-discipline.md \
           agents/_shared/browser-access.md CLAUDE.md; do
    [ -f "$ROOT/$f" ] && grep -q '{{' "$ROOT/$f" && PH_FAILS="$PH_FAILS $f"
  done

  # wrappers (non-template, non-README)
  if [ -d "$ROOT/.claude/agents" ]; then
    for w in "$ROOT"/.claude/agents/*.md; do
      [ -f "$w" ] || continue
      case "$w" in *.template.md|*/README.md) continue ;; esac
      grep -q '{{' "$w" && PH_FAILS="$PH_FAILS ${w#$ROOT/}"
    done
  fi

  if [ -n "$PH_FAILS" ]; then
    fail "placeholders" "unresolved {{...}} in bootstrap-mandatory files:$PH_FAILS"
  elif [ -n "$PH_WARNS" ]; then
    warn "placeholders" "lazy {{...}} still unresolved in:$PH_WARNS (sanctioned until needed)"
  else
    pass "placeholders" "no unresolved {{...}} in instantiated files"
  fi
fi

# ------------- check 3: .template.md referenced as if instantiated (instantiation drift)
# Post-bootstrap, operative pointers go to instantiated names. Wrappers must never
# point at ANY .template.md; instantiated ops files must not point at the
# verify-discipline/browser-access seeds (their instantiated twins exist by then).
if [ "$DEPLOYED" = 0 ]; then
  skip "template-refs" "fresh kit — template references are the normal state"
else
  TR_HITS=""
  if [ -d "$ROOT/.claude/agents" ]; then
    for w in "$ROOT"/.claude/agents/*.md; do
      [ -f "$w" ] || continue
      case "$w" in *.template.md|*/README.md) continue ;; esac
      grep -q '\.template\.md' "$w" && TR_HITS="$TR_HITS ${w#$ROOT/}"
    done
  fi
  for f in charter.md agents/roster.md profiles/project.md profiles/stack.md; do
    [ -f "$ROOT/$f" ] || continue
    if [ -f "$ROOT/agents/_shared/verify-discipline.md" ] && \
       grep -q 'verify-discipline\.template\.md' "$ROOT/$f"; then
      TR_HITS="$TR_HITS $f(verify-discipline.template.md)"
    fi
    if [ -f "$ROOT/agents/_shared/browser-access.md" ] && \
       grep -q 'browser-access\.template\.md' "$ROOT/$f"; then
      TR_HITS="$TR_HITS $f(browser-access.template.md)"
    fi
  done
  if [ -n "$TR_HITS" ]; then
    fail "template-refs" "template referenced as operative file in:$TR_HITS"
  else
    pass "template-refs" "no template-as-instance references in operative files"
  fi
fi

# ------------------------------- check 4: single-source drift (caps, bands, models)
# 4a token caps stated outside the charter table
if [ "$DEPLOYED" = 0 ]; then
  skip "drift-caps" "fresh kit — caps live as defaults in charter.template.md"
else
  CAPS=$(grep -E 'Per-spawn worker cap' "$ROOT/charter.md" 2>/dev/null | grep -oE '[0-9]{5,7}' | sort -u)
  if [ -z "$CAPS" ]; then
    warn "drift-caps" "could not extract cap values from charter.md budget table"
  else
    CAP_EXCL='^(charter\.md|charter\.template\.md|docs/lazy-placeholders\.md|agents/lifecycle\.md|pm-decisions\.md|memory/|messages/|agents/archive/|decisions/)'
    CAP_HITS=""
    for n in $CAPS; do
      HITS=$(grep -rl --include='*.md' -e "$n" "$ROOT" 2>/dev/null \
        | sed "s|^$ROOT/||" | grep -vE "$CAP_EXCL")
      [ -n "$HITS" ] && CAP_HITS="$CAP_HITS $n:[$(echo $HITS | tr '\n' ' ')]"
    done
    if [ -n "$CAP_HITS" ]; then
      fail "drift-caps" "charter cap value restated outside the charter table:$CAP_HITS"
    else
      pass "drift-caps" "cap values ($(echo $CAPS | tr '\n' ' ')) stated only in the charter table"
    fi
  fi
fi

# 4b tier-band table rows outside agents/pm.md (band cell shape: '| 45-75K |')
BAND_EXCL='^(agents/pm\.md|agents/archive/|messages/|memory/)'
BAND_HITS=$(grep -rlE --include='*.md' '\|\s*[0-9]{1,3}-[0-9]{1,3}K\s*\|' "$ROOT" 2>/dev/null \
  | sed "s|^$ROOT/||" | grep -vE "$BAND_EXCL")
if [ -n "$BAND_HITS" ]; then
  fail "drift-bands" "tier-band table rows outside agents/pm.md: $(echo $BAND_HITS | tr '\n' ' ')"
else
  pass "drift-bands" "tier-band rows live only in agents/pm.md"
fi

# 4c model assignments outside roster + wrappers (heuristic on common model-name shapes)
MODEL_RE='^[-*]?\s*([Mm]odel|[Mm]odel name)\s*[:=]\s*"?(opus|sonnet|haiku|fable|gpt-[a-z0-9]|o[0-9])'
MODEL_EXCL='^(agents/roster\.md|agents/roster\.template\.md|\.claude/agents/|agents/lifecycle\.md|pm-decisions\.md|memory/|messages/|agents/archive/|decisions/)'
MODEL_HITS=$(grep -rlE --include='*.md' "$MODEL_RE" "$ROOT" 2>/dev/null \
  | sed "s|^$ROOT/||" | grep -vE "$MODEL_EXCL")
if [ -n "$MODEL_HITS" ]; then
  fail "drift-models" "model assignment outside roster/wrappers (heuristic): $(echo $MODEL_HITS | tr '\n' ' ')"
else
  pass "drift-models" "no model assignments outside roster + wrappers (heuristic scan)"
fi

# ----------------------- check 5: every ACTIVE roster row has its dispatch wrapper
RM="$ROOT/agents/roster.md"
if [ ! -f "$RM" ]; then
  if [ "$DEPLOYED" = 1 ]; then
    fail "roster-wrappers" "deployed but agents/roster.md missing (bootstrap-blocking)"
  else
    skip "roster-wrappers" "fresh kit — roster not instantiated"
  fi
else
  MISSING=""
  CHECKED=0
  SKIPPED_ROWS=0
  while IFS= read -r line; do
    # Only roster TABLE ROWS are configuration; explanatory prose that mentions
    # wrapper paths must not be scanned (false-red fix).
    case "$line" in
      '|'*'.claude/agents/'*) ;;
      *) continue ;;
    esac
    # staffing status (docs/staffing.md): non-active rows need no wrapper
    if echo "$line" | grep -qE '\|\s*`?(not-hired|dormant)`?\s*\|'; then
      SKIPPED_ROWS=$((SKIPPED_ROWS+1)); continue
    fi
    W=$(echo "$line" | grep -oE '\.claude/agents/[A-Za-z0-9_.{}-]+\.md' | head -1)
    [ -n "$W" ] || continue
    case "$W" in *'{{'*) continue ;; esac   # unfilled slug caught by check 2
    CHECKED=$((CHECKED+1))
    [ -f "$ROOT/$W" ] || MISSING="$MISSING $W"
  done < "$RM"
  # inline-mode declaration: counts ONLY when a roster TABLE ROW names the inline
  # file — the roster template's explanatory prose also mentions it, and prose
  # must not be read as configuration (false-red fix).
  INLINE_DECLARED=0
  grep -E '^\|' "$RM" | grep -q 'INLINE_BASE_AGENT_MODE\.md' && INLINE_DECLARED=1
  if [ "$INLINE_DECLARED" = 1 ] && [ ! -f "$ROOT/.claude/agents/INLINE_BASE_AGENT_MODE.md" ]; then
    MISSING="$MISSING .claude/agents/INLINE_BASE_AGENT_MODE.md(inline-mode-declared)"
  fi
  if [ -n "$MISSING" ]; then
    fail "roster-wrappers" "active roster rows point at nonexistent wrapper(s):$MISSING"
  elif [ "$CHECKED" -eq 0 ] && [ "$SKIPPED_ROWS" -eq 0 ]; then
    # A deployment with NO dispatch path at all must not pass: either wrapper
    # rows exist, or inline mode is explicitly instantiated (false-green fix).
    if [ "$DEPLOYED" = 1 ] && [ "$INLINE_DECLARED" = 0 ] && [ ! -f "$ROOT/.claude/agents/INLINE_BASE_AGENT_MODE.md" ]; then
      fail "roster-wrappers" "deployment has NO wrapper-path roster rows and NO instantiated INLINE_BASE_AGENT_MODE.md — no sanctioned dispatch path exists"
    else
      warn "roster-wrappers" "roster.md has no wrapper-path rows — inline mode or unfilled roster?"
    fi
  else
    pass "roster-wrappers" "$CHECKED active wrapper path(s) exist on disk ($SKIPPED_ROWS non-active row(s) skipped)"
  fi
fi

# ------------------------------ check 6: staleness of PM state surfaces (>14 days)
if [ "$DEPLOYED" = 0 ]; then
  skip "staleness" "fresh kit — no live PM state to age"
else
  NOW=$(date +%s)
  STALE=""
  CHECKED_FILES=""
  ABSENT_FILES=""
  for f in memory/pm.md agents/lifecycle.md; do
    if [ ! -f "$ROOT/$f" ]; then ABSENT_FILES="$ABSENT_FILES $f"; continue; fi
    CHECKED_FILES="$CHECKED_FILES $f"
    MT=$(mtime_of "$ROOT/$f")
    [ -n "$MT" ] || continue
    AGE_D=$(( (NOW - MT) / 86400 ))
    [ "$AGE_D" -gt "$STALE_DAYS" ] && STALE="$STALE $f(${AGE_D}d)"
  done
  # A missing state file is a mandatory-artifacts FAIL; never report it as fresh here.
  if [ -n "$STALE" ]; then
    warn "staleness" "PM state older than ${STALE_DAYS}d:$STALE — verify state before trusting it (FC-9)"
  elif [ -z "$CHECKED_FILES" ]; then
    warn "staleness" "no PM state files exist to age-check (missing:$ABSENT_FILES — see mandatory-artifacts)"
  elif [ -n "$ABSENT_FILES" ]; then
    warn "staleness" "fresh:$CHECKED_FILES; missing:$ABSENT_FILES (see mandatory-artifacts)"
  else
    pass "staleness" "$(echo $CHECKED_FILES) touched within ${STALE_DAYS}d"
  fi
fi

# ---------------------------------------------------------------------- summary
if [ "$FAILURES" -gt 0 ]; then
  if [ "$DEPLOYED" = 1 ]; then
    echo "RESULT: DEPLOYMENT-INCOMPLETE — $FAILURES FAIL(s); investigate before dispatching (agents/pm.md wake step 0)."
  else
    echo "RESULT: KIT-INVALID — $FAILURES FAIL(s); investigate before dispatching (agents/pm.md wake step 0)."
  fi
  exit 1
fi
if [ "$DEPLOYED" = 1 ]; then
  echo "RESULT: DEPLOYMENT-READY — no FAIL (PASS/WARN/SKIP only)."
else
  echo "RESULT: KIT-VALID — no FAIL (PASS/WARN/SKIP only). Kit mode does NOT attest a deployment; run --mode deployment on deployed instances."
fi
exit 0
