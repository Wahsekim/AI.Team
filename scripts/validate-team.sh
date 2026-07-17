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
# Verdicts (last line): KIT-VALID | DEPLOYMENT-STRUCTURALLY-COMPLETE | DEPLOYMENT-INCOMPLETE.
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

mtime_of() { # portable mtime (epoch seconds): GNU first — on Linux the BSD
  # form 'stat -f %m' SUCCEEDS but prints the mount point, not a timestamp.
  MT_OUT=$(stat -c %Y "$1" 2>/dev/null || stat -f %m "$1" 2>/dev/null)
  case "$MT_OUT" in ''|*[!0-9]*) return 1 ;; *) printf '%s\n' "$MT_OUT" ;; esac
}

inline_mode_ok() { # R5-06: the inline-mode file must be a REAL dispatch doc,
  # not a placeholder — at least one markdown heading and >= 200 bytes.
  # A '-s' test alone lets a one-byte 'x' pass as configuration.
  # R6-07(d): a heading plus padding is still hollow — require the key
  # sections the instantiated seed (INLINE_BASE_AGENT_MODE.template.md)
  # actually carries: the Base Agent requirement and the dispatch/assembly
  # guidance. Permissive on wording so a genuine bootstrap output passes.
  IM_FILE="$ROOT/.claude/agents/INLINE_BASE_AGENT_MODE.md"
  [ -f "$IM_FILE" ] || return 1
  grep -q '^#' "$IM_FILE" || return 1
  grep -qiE 'base agent' "$IM_FILE" || return 1
  grep -qiE 'dispatch|assembly' "$IM_FILE" || return 1
  IM_BYTES=$(wc -c < "$IM_FILE" | tr -d '[:space:]')
  [ "${IM_BYTES:-0}" -ge 200 ]
}

fm_clean_value() { # R6-06(c): normalize one frontmatter value from the strict
  # flat subset — strip an unquoted trailing ' #comment' plus trailing space.
  # Heuristic: a value starting with a quote is never comment-stripped; a
  # value that IS a comment ('# ...') cleans to empty; otherwise everything
  # from the first ' #' is dropped.
  FMV="$1"
  case "$FMV" in
    \"*|\'*) ;;
    \#*) FMV="" ;;
    *) FMV=$(printf '%s' "$FMV" | sed -E 's/[[:space:]]#.*$//') ;;
  esac
  printf '%s\n' "$FMV" | sed -E 's/[[:space:]]+$//'
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

  # 1d counter line cross-check (Next NNN to assign == last entry + 1).
  # Missing counter is a FAIL on deployments: the engine/reconciler contract
  # depends on it, and a silently absent counter is exactly how drift starts.
  CTR=$(grep -E 'Next NNN to assign' "$LC" | grep -oE '[0-9]+' | head -1)
  if [ -z "$CTR" ]; then
    if [ "$DEPLOYED" = 1 ]; then
      fail "lifecycle-counter" "no 'Next NNN to assign' counter line found — required on deployments (engine/reconciler contract)"
    else
      warn "lifecycle-counter" "no 'Next NNN to assign' counter line found"
    fi
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
    # R6-07(a): kit fixtures are not dispatch configurations — an active row
    # pointing at README.md or any .template.md fakes dispatchability even
    # though the file exists on disk.
    case "$W" in
      */README.md|*.template.md)
        MISSING="$MISSING $W(not-a-dispatch-wrapper:kit-fixture)"; continue ;;
    esac
    if [ "$W" = ".claude/agents/INLINE_BASE_AGENT_MODE.md" ]; then
      # R6-07(a): the inline-mode FILE is a mode declaration, not a per-role
      # wrapper. The sanctioned cell form is 'inline mode — <path>' (roster
      # template "Wrapper-column honesty"); a cell that IS the bare path uses
      # it as a wrapper path and fails. Either way the INLINE_DECLARED gate
      # below enforces the file itself.
      CELL=$(printf '%s\n' "$line" | awk -F'|' '{
        for (i = 2; i <= NF; i++) if ($i ~ /\.claude\/agents\//) {
          gsub(/`/, "", $i); gsub(/^[[:space:]]+|[[:space:]]+$/, "", $i)
          print $i; exit
        }
      }')
      [ "$CELL" = "$W" ] && MISSING="$MISSING $W(inline-mode-file-used-as-wrapper-path)"
      continue
    fi
    CHECKED=$((CHECKED+1))
    [ -f "$ROOT/$W" ] || MISSING="$MISSING $W"
  done < "$RM"
  # inline-mode declaration: counts ONLY when a roster TABLE ROW names the inline
  # file — the roster template's explanatory prose also mentions it, and prose
  # must not be read as configuration (false-red fix).
  INLINE_DECLARED=0
  grep -E '^\|' "$RM" | grep -q 'INLINE_BASE_AGENT_MODE\.md' && INLINE_DECLARED=1
  # Inline file must be a REAL dispatch doc: a one-byte placeholder is not a
  # dispatch configuration (F-05; hardened per R5-06 — see inline_mode_ok).
  if [ "$INLINE_DECLARED" = 1 ] && ! inline_mode_ok; then
    MISSING="$MISSING .claude/agents/INLINE_BASE_AGENT_MODE.md(inline-mode-declared,missing-or-hollow:needs-heading+base-agent+dispatch/assembly-text,>=200-bytes)"
  fi
  if [ -n "$MISSING" ]; then
    fail "roster-wrappers" "active roster rows point at nonexistent or placeholder wrapper(s):$MISSING"
  elif [ "$CHECKED" -eq 0 ] && [ "$SKIPPED_ROWS" -eq 0 ]; then
    # A deployment with NO dispatch path at all must not pass: either wrapper
    # rows exist, or inline mode is explicitly instantiated (false-green fix).
    if [ "$DEPLOYED" = 1 ] && [ "$INLINE_DECLARED" = 0 ] && ! inline_mode_ok; then
      fail "roster-wrappers" "deployment has NO wrapper-path roster rows and NO instantiated INLINE_BASE_AGENT_MODE.md — no sanctioned dispatch path exists"
    else
      warn "roster-wrappers" "roster.md has no wrapper-path rows — inline mode or unfilled roster?"
    fi
  else
    pass "roster-wrappers" "$CHECKED active wrapper path(s) exist on disk ($SKIPPED_ROWS non-active row(s) skipped)"
  fi
fi

# ------------- check 5a: active roster rows carry role file + dispatch (R5-05)
# The roster table is the staffing contract: an ACTIVE role must have BOTH a
# role file at agents/<role_id>.md AND a sanctioned dispatch path (a
# .claude/agents/*.md wrapper, the PM's 'main session', or instantiated inline
# mode). Check 5 above only sees rows that already NAME a wrapper path, so an
# active row with no path at all was invisible before this check.
# Parsing assumptions (column POSITIONS vary per deployment): role_id = FIRST
# data cell (backticks stripped); status = LAST cell of the row (the roster
# table keeps Status last); dispatch detection = substring match on the whole
# row. The status keyword is the FIRST WORD of the cell — 'dormant (active if
# UI)' is dormant, never active. Non-active rows are never failed here.
if [ "$DEPLOYED" = 0 ]; then
  skip "roster-contract" "kit mode — staffing contract applies to deployed rosters only"
elif [ ! -f "$RM" ]; then
  skip "roster-contract" "agents/roster.md missing (already a roster-wrappers FAIL)"
else
  RC_FAILS=""
  RC_ACTIVE=0
  while IFS= read -r line; do
    case "$line" in '|'*) ;; *) continue ;; esac   # table rows only, never prose
    ST=$(printf '%s\n' "$line" | awk -F'|' '{
      for (i = NF; i >= 2; i--) if ($i ~ /[^[:space:]]/) {
        gsub(/`/, "", $i); sub(/^[[:space:]]+/, "", $i)
        split($i, a, /[[:space:]]/); print a[1]; exit
      }
    }')
    [ "$ST" = "active" ] || continue   # header, |---| separator, non-active rows fall out here
    RID=$(printf '%s\n' "$line" | awk -F'|' '{ gsub(/[[:space:]`]/, "", $2); print $2 }')
    [ -n "$RID" ] || continue
    case "$RID" in *'{{'*) continue ;; esac   # unfilled slug caught by check 2
    RC_ACTIVE=$((RC_ACTIVE+1))
    if [ ! -s "$ROOT/agents/$RID.md" ]; then
      RC_FAILS="$RC_FAILS $RID(agents/$RID.md missing-or-empty)"
    # R6-07(c): a role file must carry the dispatchable substance the kit seeds
    # carry ('## Base Agent' + '## Project Overlay' / '## Dispatch Assembly'
    # in agents/*.md) — a one-byte stub fakes staffing. Permissive on wording:
    # any base-agent mention plus overlay/dispatch/assembly guidance passes.
    elif ! grep -qiE 'base agent' "$ROOT/agents/$RID.md" || \
         ! grep -qiE 'overlay|dispatch|assembly' "$ROOT/agents/$RID.md"; then
      RC_FAILS="$RC_FAILS $RID(agents/$RID.md hollow:needs-base-agent+overlay/dispatch/assembly-sections)"
    fi
    case "$line" in
      *'.claude/agents/'*'.md'*|*'main session'*) ;;   # row names its own dispatch path
      *) inline_mode_ok || RC_FAILS="$RC_FAILS $RID(no-dispatch-path:no-wrapper,no-main-session,no-inline-mode)" ;;
    esac
  done < "$RM"
  if [ -n "$RC_FAILS" ]; then
    fail "roster-contract" "active roster row(s) break the deployment invariant:$RC_FAILS"
  elif [ "$RC_ACTIVE" -eq 0 ]; then
    warn "roster-contract" "no active roster rows found — staffing not instantiated yet?"
  else
    pass "roster-contract" "$RC_ACTIVE active row(s) carry role file + dispatch path"
  fi
fi

# -------------------- check 5b: wrapper frontmatter schema (deployment mode)
# A wrapper that exists but carries no runtime-enforced config is a shell —
# `name` alone dispatches with inherited-everything (R-05). Required keys:
# name, description, model, effort. tools/permissionMode absent -> WARN
# (least-privilege advisory until the permission manifest lands).
if [ "$DEPLOYED" = 1 ] && [ -d "$ROOT/.claude/agents" ]; then
  FM_FAILS=""
  FM_WARNS=""
  FM_CHECKED=0
  # R6-07(b): this glob is a SUPERSET of the wrapper paths active roster rows
  # can legitimately reference — check 5 fails referenced-but-missing files
  # and README/template/inline placeholder names, so every dispatchable
  # wrapper on disk passes through this schema gate.
  for w in "$ROOT"/.claude/agents/*.md; do
    [ -f "$w" ] || continue
    case "$w" in *.template.md|*/README.md|*INLINE_BASE_AGENT_MODE.md) continue ;; esac
    FM_CHECKED=$((FM_CHECKED+1))
    # R6-06(a): the strict flat subset requires line 1 to be exactly '---' —
    # with prose before the block the runtime sees no frontmatter at all.
    if [ "$(head -n 1 "$w")" != "---" ]; then
      FM_FAILS="$FM_FAILS ${w#$ROOT/}(no-frontmatter-at-line-1)"
      continue
    fi
    # R5-06: frontmatter must be a CLOSED block — with a lone opening '---'
    # the runtime sees no frontmatter at all, so the wrapper is a shell.
    if [ "$(grep -cE '^---$' "$w")" -lt 2 ]; then
      FM_FAILS="$FM_FAILS ${w#$ROOT/}(unterminated-frontmatter)"
      continue
    fi
    # R6-06(b): keys are read ONLY between the first two '---' delimiters
    # (line 1 is guaranteed '---' by the check above).
    FM=$(awk '/^---$/{n++; next} n==1{print} n>=2{exit}' "$w")
    # R6-06(d): the strict flat subset reads ONE value per key — a repeated
    # key ('model: sonnet' + 'model: ""') is ambiguous, not configuration.
    FM_DUPES=$(printf '%s\n' "$FM" | sed -nE 's/^([A-Za-z][A-Za-z0-9_-]*):.*/\1/p' | sort | uniq -d | tr '\n' ',' | sed 's/,$//')
    if [ -n "$FM_DUPES" ]; then
      FM_FAILS="$FM_FAILS ${w#$ROOT/}(duplicate-key:$FM_DUPES)"
      continue
    fi
    MISSING_KEYS=""
    # Keys must carry a NON-EMPTY value — 'model:' alone is a shell, not
    # config (F-05). YAML-semantically-empty tokens ("", '', ~, null) are
    # missing too, not values (R5-06). Values are comment-stripped FIRST
    # (R6-06c) so 'effort: high # note' passes and 'description: # x' fails.
    for k in name description model effort; do
      V=$(fm_clean_value "$(printf '%s\n' "$FM" | sed -nE "s/^${k}:[[:space:]]*//p" | head -1)")
      case "$V" in
        ''|'""'|"''"|'~'|null) MISSING_KEYS="$MISSING_KEYS $k" ;;
      esac
    done
    # R5-06: effort must be a value the runtime accepts — a hyphenated
    # pseudo-band like 'low-medium' silently dispatches as nothing.
    EFF=$(fm_clean_value "$(printf '%s\n' "$FM" | sed -nE 's/^effort:[[:space:]]*//p' | head -1)")
    EFF=${EFF#\"}; EFF=${EFF%\"}; EFF=${EFF#\'}; EFF=${EFF%\'}
    case "$EFF" in
      ''|'~'|null) ;;                  # absent/empty is reported by the key loop above
      low|medium|high|xhigh|max) ;;    # runtime effort enum
      *) FM_FAILS="$FM_FAILS ${w#$ROOT/}(invalid-effort:$EFF,allowed:low|medium|high|xhigh|max)" ;;
    esac
    # maxTurns is part of the wrapper contract (role-wrapper.template.md):
    # required, positive integer (comment-stripped first — R6-06c).
    MT=$(fm_clean_value "$(printf '%s\n' "$FM" | sed -nE 's/^maxTurns:[[:space:]]*//p' | head -1)")
    MT=${MT#\"}; MT=${MT%\"}
    printf '%s\n' "$MT" | grep -qE '^[1-9][0-9]*$' || MISSING_KEYS="$MISSING_KEYS maxTurns(positive-int)"
    [ -n "$MISSING_KEYS" ] && FM_FAILS="$FM_FAILS ${w#$ROOT/}(missing:$MISSING_KEYS )"
    if ! printf '%s\n' "$FM" | grep -qE '^(tools|permissionMode):'; then
      FM_WARNS="$FM_WARNS ${w#$ROOT/}"
    fi
  done
  if [ -n "$FM_FAILS" ]; then
    fail "wrapper-frontmatter" "wrapper(s) violate the strict flat frontmatter subset this validator implements (line 1 '---', closed block, unique non-empty 'key: value' lines):$FM_FAILS"
  elif [ "$FM_CHECKED" -eq 0 ]; then
    skip "wrapper-frontmatter" "no active wrappers to check (inline mode?)"
  elif [ -n "$FM_WARNS" ]; then
    warn "wrapper-frontmatter" "$FM_CHECKED wrapper(s) OK; no tools/permissionMode (inherits ALL tools — least-privilege advisory):$FM_WARNS"
  else
    pass "wrapper-frontmatter" "$FM_CHECKED active wrapper(s) carry required frontmatter"
  fi
else
  skip "wrapper-frontmatter" "kit mode or no .claude/agents — wrapper schema not applicable"
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
  # Honest verdict (R-05): this validator proves STRUCTURE (files, wiring,
  # counters, wrapper schema), not semantic readiness — it does not start the
  # runtime, resolve stack commands, or dispatch a probe. "READY" is reserved
  # for a future semantic gate.
  echo "RESULT: DEPLOYMENT-STRUCTURALLY-COMPLETE — no FAIL (PASS/WARN/SKIP only). Structural checks only: run a real dispatch smoke before trusting the deployment end-to-end."
else
  echo "RESULT: KIT-VALID — no FAIL (PASS/WARN/SKIP only). Kit mode does NOT attest a deployment; run --mode deployment on deployed instances."
fi
exit 0
