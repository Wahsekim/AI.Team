# teamai-cli → AI.Team port plan (2026-10-14)

> Status: VERIFIED 2026-10-14 — every change below was checked by an
> independent read-only verifier (four slices, one subagent each) against both
> repos and, for P01/P02, against real Claude Code transcripts on this machine
> (structure only). Verdicts: 8 ADOPT-WITH-CHANGES, 3 REJECT, 1 REJECT (defer).
> Original claims are kept verbatim; corrections are recorded inside each
> **Verification** block, never by rewriting the claim.
> Scope: PORT selected mechanics from Tencent `teamai-cli` into existing
> AI.Team surfaces. No rebuild, no new roles, no new workflows. AI.Team stays
> Claude-Code-only (README); cross-tool distribution is NOT ported.

Source repo: `/Users/yang/Documents/git-workspace/teamai-cli` (main @ 4372650,
2026-10-14). Line numbers cite that checkout. Target paths are relative to
this repo.

Legend — **Claims** are numbered factual statements. **Verification** holds
the verifier's Truth (per claim), Value (H/M/L), Feasibility (S/M/L effort +
blockers), Verdict (ADOPT / ADOPT-WITH-CHANGES / REJECT) and Notes.

Slices: A = P01 P02 P08 · B = P03 P04 P12 · C = P05 P06 P07 P10 · D = P09 P11.

Figures (source `figures/teamai-port-plan.drawio`, five pages; PNG exports
beside it, verified visually after export):

| Page | File | Shows |
|---|---|---|
| 1 | `figures/teamai-port-plan-1-overview.png` | the 9 adopted changes pinned to the PM one-cycle loop and the engine strip; rejected items boxed |
| 2 | `figures/teamai-port-plan-2-p01-measure-spawn.png` | P01: transcript layout (`subagents/agent-<id>.jsonl` + meta), join key, dedup, 4 token classes, landing in lifecycle |
| 3 | `figures/teamai-port-plan-3-p02-friction-score.png` | P02: human-prompt filter, event detection, weights, gate, counts-only output, Coach trigger |
| 4 | `figures/teamai-port-plan-4-p03-p12-lesson-lifecycle.png` | P03+P12: candidate creation path (Coach-owned index), state transitions with numeric thresholds, citation counting to stdout |
| 5 | `figures/teamai-port-plan-5-p09-notify.png` | P09: post-reconcile drain step, opt-in gate, three events, redact, HMAC, bounded POST, failure path |

P04, P05, P10 are text-rule changes and have no figure.

---

## Revised execution order (post-verification)

| Order | ID | Change (as amended) | Verdict | Effort | Value |
|---|---|---|---|---|---|
| 1 | P01 | `scripts/measure-spawn.mjs`: per-subagent tokens from `<session>/subagents/**/agent-*.jsonl`, joined via `toolUseResult.agentId`; dedup by `message.id`; require the 4 token fields, tolerate unknown keys | ADOPT-WITH-CHANGES | S–M | H |
| 2 | P04 | Evidence-gated severity + no-restate + inline labels into `methodologies/code-review.md`; QA/Auditor get the rule in their own vocabulary (PASS/FAIL note, RED/AMBER cite) | ADOPT-WITH-CHANGES | S | M |
| 3 | P03 | Optional `- Lessons: <LNN,…\|none>` lifecycle line; citation counts printed by a WARN check / `lessons-stats.sh`, never written into the index; fold rule merged into Coach regime; reconcile counts at rotation | ADOPT-WITH-CHANGES | S | M |
| 4 | P02 | `scripts/friction-score.mjs`: human prompts only (exclude `isMeta`/`promptSource`/`toolUseResult`/task notifications), counts only, score per window; new Coach trigger bullet in `agents/pm.md` step 14 | ADOPT-WITH-CHANGES | S | M |
| 5 | P10 | One rule line in `docs/process-index.md`; real argv loops in `validate-team.sh` and `check-claude-compat.sh` (reject extra args); `watchdog-loop.sh` rejects a leading `-` | ADOPT-WITH-CHANGES | S | L–M |
| 6 | P05 | No new lib: add teamai's missing secret shapes (PEM, `AIza`, stripe, sendgrid, slack webhook, extra AWS, `hf_`/`glpat-`/`npm_`) to the engine's existing `redact` in `run-n-rounds.js:329-346` + tests; reconciler may *refuse* on a secret shape, never rewrite | ADOPT-WITH-CHANGES | S | L |
| 7 | P08 | `scripts/digest.mjs` with two explicit grammars (tolerant `- Key: value` + engine one-line); variance for standard entries only; role→governance/feature mapping defined in-script | ADOPT-WITH-CHANGES | M | M |
| 8 | P12 | PM adds Mandatory Brief Line 8 to QA briefs (trigger: `Retry-of` ≠ none or defect-class hit) asking for `Lesson-candidate:`; PM copies it into lifecycle `Notes:`; **Coach** appends the `candidate` index line | ADOPT-WITH-CHANGES | S | L–M |
| 9 | P09 | `scripts/notify.mjs`, opt-in (`TEAM_NOTIFY_URL` unset → no-op); events `halt` (non-count-complete haltReason, context-halt), `needs-decision`, `guardian-blocked`; ≤10 s wall cap, exit 0 on failure with WARN; added to the `docs/engine.md` drain checklist | ADOPT-WITH-CHANGES | S–M | M |
| — | P06 | `validate-team.sh --json` | REJECT (defer) | — | L |
| — | P07 | Detached Stop-hook validator | REJECT | — | L |
| — | P11 | Tier aliases + wrapper hash sidecars | REJECT | — | L |

Rejections in one line each: P06 has no consumer today (preflight never calls
the validator; the Stop hook uses only the exit code). P07 solves a latency
that does not exist (validator measured 0.1–0.35 s). P11's premise was wrong
(bootstrap does not write wrappers; check 5c already forces roster model ==
wrapper model literally; Claude Code frontmatter cannot resolve tier names).

---

## P01 — Transcript-measured per-spawn tokens (makes M4 mechanical)

**Source (teamai):** `src/dashboard-collector.ts:322-336` reads the Claude
JSONL transcript at Stop, sums `input_tokens`, `output_tokens`,
`cache_read_input_tokens`, `cache_creation_input_tokens` per assistant entry,
deduplicated by `message.id` (fallback `requestId`); `src/model-pricing.ts:18-27`
prices in USD/MTok under a versioned table (`anthropic-2026-09-09`), stores
integer micro-dollars, leaves unknown models unpriced rather than $0.

**Target (AI.Team):** new `scripts/measure-spawn.mjs` + `tests/measure-spawn.test.mjs`;
one paragraph in `agents/lifecycle.md` → Harness Rules; the existing
"Per-spawn token measurement" row in `docs/harness-assumptions.md`.

**Change:**
1. `node scripts/measure-spawn.mjs <session-dir|transcript.jsonl> [--agent <id>] [--json]`
   prints per-session and per-subagent totals for the four token classes,
   deduplicated by `message.id`, plus an optional `$` column from a
   `scripts/lib/model-pricing.json` carrying a `tableVersion`.
2. Lifecycle close rule: `Tokens:` may cite the engine delta (existing) AND
   the transcript measurement; when both exist and diverge >30%, dual-record
   (extends the existing M4 dual-record rule rather than replacing it).
3. No reconciler change in this slice.

**Claims:**
- C1. AI.Team's lifecycle `Tokens:` values are hand-entered by the PM from the Agent-tool result; no script in `scripts/` reads a transcript today.
- C2. Claude Code writes `~/.claude/projects/<cwd-slug>/<sessionId>.jsonl`; assistant entries carry `message.usage` with the four token fields and `message.id`.
- C3. Subagent (Agent-tool) spend is attributable from the transcript(s): either sidechain entries in the main file or per-agent files in the same directory.
- C4. `docs/harness-assumptions.md` lists "Per-spawn token measurement" as an assumed primitive and admits three meters disagree 1.8–2.9x.

**Value hypothesis:** FC-1 calibration and the "single token meter" gap need a
meter that is neither self-report nor engine-only; four token classes explain
the 1.8–2.9x disagreement (cache read vs creation).

**Feasibility notes:** transcript format is harness-internal; fail loudly on
schema drift.

**Verification (slice A):**
- Truth: C1 TRUE — only transcript/jsonl hit in `scripts/` is `watchdog-loop.sh:50` (hang log, not a session transcript); `lifecycle.md:98` shows a hand-composed "(cumulative; …)" value. C2 TRUE — 131/131 assistant entries in a sample session carry `message.usage` + `message.id` + `requestId`. C3 TRUE via per-agent files, NOT sidechain entries: main files have 0 `isSidechain:true` / 0 `agentId` across 152 files; each subagent lives at `<sessionId>/subagents/agent-<agentId>.jsonl` with a sibling `agent-<agentId>.meta.json` (keys agentType, description, toolUseId, spawnDepth, model); every entry there has `isSidechain:true` + `agentId`, assistant entries add `attributionAgent`; join key = main file's Agent-tool `toolUseResult.{agentId, description, resolvedModel, status, outputFile}`; engine/workflow agents sit at `<sessionId>/subagents/workflows/wf_<id>/agent-<id>.jsonl` beside `journal.jsonl` (330 subagent files across 10 project dirs). C4 TRUE — `harness-assumptions.md:34` (primitive), `:47` (1.8–2.9x row).
- Value: H — closes the `harness-assumptions.md:34/:44` gap where per-spawn measurement is assumed but hand-done; gives FC-1 a non-self-report, non-engine meter.
- Feasibility: S–M — attribution data exists on disk; read-only, local, no hard-rule conflict. Prerequisite: fail-loud schema rule.
- Verdict: **ADOPT-WITH-CHANGES** — (a) scope per-subagent totals to `subagents/**/agent-*.jsonl`, join through `toolUseResult.agentId` + `meta.json.toolUseId`; do not look for `isSidechain` in the main file; (b) edit the existing degradation row at `harness-assumptions.md:44`, do not add one; (c) also walk `subagents/workflows/wf_*/` so engine `budget.spent()` deltas can be cross-checked.
- Notes: dedup by `message.id` is required (69 distinct ids over 131 assistant entries in one file; 8,113 corpus-wide duplicates, usage identical each time). Main files hold one `cost-state` entry (`totalCostUSD`, `modelUsage`, `hasUnknownModelCost`) usable as a sanity check. Usage carries extra keys (`server_tool_use`, `iterations`, `speed`, `fallback_credit`, `cache_creation`): the drift rule must require the four token fields to be present, not reject unknown keys.

---

## P02 — Friction score → Coach trigger queue

**Source (teamai):** `src/types.ts:1835-1840` default correction keywords
(zh/en/ja; team-extensible); `src/dashboard-collector.ts:386-402, 2149-2153`
interrupt = `[Request interrupted by user`, correction = human prompt ≤60 s
after a Stop matching a keyword; `src/types.ts:1947-2007` score:
interrupt/reject/correction 20 each, toolError tiers 3→10 / 5→18 / 8→25;
`src/contribute-check.ts:606` hint only when score ≥20 AND tool calls ≥15.

**Target (AI.Team):** new `scripts/friction-score.mjs` + test; `agents/pm.md`
step 14 gains one bullet; `memory/pm.md` Counters block already has
`coaching_triggers_queued`.

**Change:**
1. Script reads a session transcript, emits `{interrupts, rejects, corrections, toolErrors, toolCalls, score}`; `--threshold 20 --min-tools 15` defaults copied.
2. PM step 14 adds trigger: "friction score ≥ threshold → queue one Coach trigger with the score breakdown as the stated reason".
3. PM→worker corrections are NOT transcript-derived: lifecycle `Retry-of:` already records them.

**Claims:**
- C1. `agents/pm.md` step 14 lists exactly: 10 new entries, harness-rule violation, variance threshold, three same-sign variances, owner request, empty-loop hook — no owner-correction signal.
- C2. The lifecycle schema already has `Retry-of` and `Diverged-from` fields.
- C3. teamai's correction detection is keyword + 60 s window + tool-count gate as cited.
- C4. The Claude transcript marks user interrupts with the literal prefix `[Request interrupted by user`.

**Value hypothesis:** the only Coach trigger that measures the OWNER's
corrections of the PM; today the PM self-reports "surprises" in `memory/pm.md`.

**Feasibility notes:** keyword false positives — keep the 60 s window and the
tool-call gate; keyword list as an owner-editable JSON file.

**Verification (slice A):**
- Truth: C1 PARTIAL — `pm.md:167-171` lists "two consecutive failures on one role" and "post-empty-loop unblock", not "three same-sign variances" (that list is `self-improvement.md:36-42`; same-sign appears in pm.md only as the pre-flag at `:150`). The "no owner-correction signal" half is TRUE. C2 TRUE — `lifecycle.md:28-29`. C3 TRUE — `types.ts:1833-1840`, `dashboard-collector.ts:2149-2153`, `contribute-check.ts:606`; the once-per-session dedup is the `hinted` state at `:44`/`:487`, not `:606`. C4 TRUE (prefix) — real markers are `[Request interrupted by user]` and `[Request interrupted by user for tool use]`, in `user` entries as `text` blocks.
- Value: M — only signal of the owner correcting the PM; serves M4 self-report optimism and FC-6. Sparse: 13 interrupts across 152 local sessions.
- Feasibility: S — Stop anchor exists in transcripts (`system/stop_hook_summary`, `turn_duration` entries). `SECURITY.md:22`: counts only, never prompt text.
- Verdict: **ADOPT-WITH-CHANGES** — (a) fix the C1 wording to match `pm.md:167-171`; (b) count only human prompts: exclude user entries with `isMeta`, `promptSource` or `toolUseResult`, and task notifications; (c) never emit matched prompt text.
- Notes: the PM session is persistent, so "once per session" is too coarse — score per window. The owner-editable keyword JSON is necessary, not optional.

---

## P08 — Deterministic digest (KPIs without an LLM pass)

**Source (teamai):** `src/session-trends.ts:323-370` last 7 d vs prior 7:
successRate, avgPrompts, avgDuration, avgRequestCost, cacheReadShare,
correctionRate; `succeeded` = no error, zero interrupts, no correction (`:89`);
`src/digest.ts:269-407`.

**Target (AI.Team):** new `scripts/digest.mjs` + test; `agents/coach.md` reads
the digest first; `agents/auditor.md` meta:product KPI sourced from it.

**Change:**
1. Script parses `agents/lifecycle.md` (estimate, actual, variance, outcome, progress, retry-of) and optional `measure-spawn` output; prints per window: dispatches, success rate, mean |variance|, repeated-failure classes, retry count, PM-overhead share, 7d-vs-prior-7d deltas.
2. Coach brief template says "read `digest` output, then only the lifecycle entries it flags".

**Claims:**
- C1. Coach KPI summary today is produced by the Coach agent reading raw ledgers.
- C2. The lifecycle entry format is regular enough to parse (fixed `- Key: value` lines).
- C3. `agents/auditor.md` has a meta:product token-ratio KPI (flag > 0.5) with no scripted source.

**Value hypothesis:** Coach dispatches are themselves spend; a deterministic
pre-pass cuts the ledger read and makes KPIs reproducible.

**Feasibility notes:** engine-mode compressed entries must parse too.

**Verification (slice A):**
- Truth: C1 TRUE — `self-improvement.md:46-47`, `templates.md:252-258`. C2 PARTIAL — standard format (`lifecycle.md:9-31`) is mostly `- Key: value` but real entries deviate: indented `- Handoffs:` sub-bullets in all 25 entries; a parenthesised key `- Notes (hygiene):` (`:229`); non-integer `Tokens` with "(cumulative; …)" (`:98`); Variance with trailing prose (`:290`); `PM overhead: ~N tok (est)` (`:100`). Engine-mode format (`lifecycle.md:49-60`) is not `- Key: value`: a `### BATCH <date> <runId> — …` header (`run-n-rounds.js:856`) then one-line entries `## [NNN] <agentType> <ticket> — <verdict>, ~N tok worker / ~N tok verifier, <summary>` (`:370`) and a guardian line (`:851`); engine entries have no Estimated/Variance fields; no real BATCH block exists yet; `agents/archive/` does not exist. C3 TRUE — `auditor.md:43-45`, no script computes it.
- Value: M — reproducible Coach KPIs, no equivalent script (`op-board.py`, `reconcile-run.mjs` compute no KPIs). meta:product needs a governance-vs-feature split the lifecycle has no field for.
- Feasibility: M — two grammars (tolerant `- Key: value` with nested Handoffs + engine one-line regex; `reconcile-run.mjs:126,231` reusable for the BATCH header); Tokens = leading integer; Variance unavailable for engine entries unless joined to the engine `coaching` return.
- Verdict: **ADOPT-WITH-CHANGES** — (a) specify both grammars explicitly, with leading-integer extraction and parenthesised-key tolerance; (b) variance KPIs for standard entries only, engine entries "variance n/a"; (c) define the governance/feature role mapping in the script (a lifecycle field would be a schema change).
- Notes: a validator lint pinning the grammar would stop future drift from silently breaking the digest.

---

## P03 — Lesson citation counting + numeric status thresholds

**Source (teamai):** adoption = session reads a recalled doc within 24 h,
credited once per session (`src/recall-adoption.ts:1-6`); confidence
`0.4·min(1,0.1r+0.3u)+0.3·recency180d+0.3·u/r` (`src/maintenance/confidence.ts:26-41`);
prune <0.15 or (>180 d and <0.3), never-voted skipped (`src/maintenance/prune.ts`);
promote needs ≥0.90 / ≥5 upvotes / ≥2 users / ≥14 d (`src/maintenance/promote.ts:26-29`).

**Target (AI.Team):** `agents/lessons.md`, `agents/coach.md` → Lessons Regime,
`scripts/validate-team.sh` (one WARN-class check), test.

**Change:**
1. Citation rule: a lifecycle entry or brief that applies a lesson writes `Lessons: L12, L07` (optional ledger line).
2. Mechanical counts: validator (or `scripts/lessons-stats.sh`) greps `\bL[0-9]{2,3}\b` per LNN across `agents/lifecycle.md`, prints `cited=N last=<entry>`.
3. Thresholds: `candidate → active` at ≥2 citations in distinct entries; `active → obsolete` candidate after 30 dispatches with 0 citations (WARN only); fold proposal at ≥5 citations across ≥2 roles.
4. No LLM promote/quality-rewrite ported.

**Claims:**
- C1. `agents/lessons.md` statuses are `active | folded-M<N> | superseded-by-LNN | obsolete | candidate | archived`; codification threshold is prose only.
- C2. No lifecycle entry or brief template line records which lessons were applied.
- C3. `scripts/validate-team.sh` has a `warn()` helper.
- C4. The lessons index currently holds zero entries.

**Value hypothesis:** turns "lessons are evidence, not vibes" into a count the
Coach cannot skip.

**Feasibility notes:** pure grep/awk; must respect the index-only read budget.

**Verification (slice B):**
- Truth: C1 TRUE — `lessons.md:11-13`; only numeric neighbours are the fold rule "3+ lessons with one root cause" (`coach.md:56`) and "≥2 lifecycle entries" for member proposals (`coach.md:71`). C2 TRUE — neither `lifecycle.md:9-31` nor `templates.md:169-268` has a lessons-applied line; `\bL[0-9]{2,3}\b` matches nothing today. C3 TRUE — `validate-team.sh:38`. C4 TRUE — `lessons.md:24-27` holds only an HTML comment. Source cite correction: the prune `<0.3 && >180d` branch is `prune.ts:69`; never-voted skip is `prune.ts:56-57`.
- Validator compatibility: PASS — checks 1a-1d (`validate-team.sh:184-244`) grep only `^## \[[0-9]+\]` headers and the counter; checks 4a/4c exclude lifecycle.md (`:333`, `:360`); test fixtures (`tests/validate-team.test.mjs:47, 517, 537`) do not constrain body lines.
- Budget: OK — index counted in both wake sets (`context-budget.md:20-21`); writing `cited=N` into the index would cost ~750 tokens at the ~150-line cap (`process-index.md:53`) and still fit worker headroom (~1,700); printing to stdout costs nothing.
- Value: M — serves FC-10 and the curation gap at `coach.md:55-63`; yields nothing until the index has lessons.
- Feasibility: S — grep/awk WARN check + one test. Prerequisites: counts undercount after rotation (`process-index.md:51-56`) → reconcile at rotation like the hardening counter; engine-mode one-line entries (`lifecycle.md:55-66`) carry no `Lessons:` line.
- Verdict: **ADOPT-WITH-CHANGES** — print counts to stdout (validator WARN or `lessons-stats.sh`), never write them into the index; add `- Lessons: <LNN,… | none>` to the lifecycle Format block as optional; merge the "≥5 citations across ≥2 roles" fold proposal with the existing "3+ lessons, one root cause" rule in one place (Coach Lessons Regime), not restated in lessons.md.
- Notes: the "30 dispatches" obsolete window should stay within one active-file span (~400 entry-lines) or count from the canonical counter block.

---

## P04 — Evidence-gated review severity + "one representative real run"

**Source (teamai):** `AGENTS.md` → Code Review Rules.

**Target (AI.Team):** `methodologies/code-review.md`, `agents/templates.md` →
QA and Auditor sections.

**Change:**
1. `methodologies/code-review.md`: P1 evidence gate, P3 ceiling for speculative risk, no-restate rule, inline severity wording.
2. QA template: "one representative real-run record; extra profiles/platforms at most P3 when flagged untestable".
3. Auditor template: same severity gate.

**Claims:**
- C1. `methodologies/code-review.md` defines scope + output template but no evidence requirement per severity.
- C2. QA template does not state a "one representative run suffices" rule; FC-2/FC-3 are the targeted classes.
- C3. teamai's rules are as cited in `AGENTS.md`.

**Value hypothesis:** FC-2 and reviewer noise; text-only.

**Feasibility notes:** S; risk of conflict with an existing severity scheme.

**Verification (slice B):**
- Truth: C1 TRUE — `code-review.md:15-28` has a bare `[P1]` example, no gate. C2 PARTIAL — no "one run suffices" rule (`templates.md:169-200`); FC-2 is fabricated APIs/packages/flags (`failure-classes.md:24, 56`), a weak fit; FC-3 (`:25`) fits; "reviewer noise" is not a catalogued class. C3 TRUE with nuance (`AGENTS.md:43-76`): a runtime-behavior PR *lacking* the real-run record is itself `[P1 blocking]`; docs-only/tests-only exempt; stale-commit test record is "a note".
- Severity conflict: `auditor.md:51-53` uses GREEN/AMBER/RED; per-PR review mode is retired (`auditor.md:16-19`); QA output is PASS/FAIL/BLOCKED (`templates.md:197`); Security says "ordered by severity" with no scale (`templates.md:237`).
- Value: M — gate + inline wording in code-review.md is cheap and new; the QA real-run rule is mostly redundant with "ACTUALLY EXECUTE … real exit code" (`templates.md:181-187`), so only the anti-matrix ceiling is new there.
- Feasibility: S — text-only, no hard-rule conflict; code-review.md referenced only from `methodologies/README.md:10`.
- Verdict: **ADOPT-WITH-CHANGES** — port items 1 and 4 (evidence gate, P3 ceiling, no-restate, inline labels) into code-review.md only; QA template phrases it in QA vocabulary ("untested extra profiles/platforms flagged untestable → note, not FAIL"), no P-levels; Auditor maps the gate to RED/AMBER (RED must cite a lifecycle entry or the exact rule), no P1/P2/P3 import.

---

## P12 — Auto-draft a `candidate` lesson at card close

**Source (teamai):** `src/import-mr.ts:47-97` drafts one learning per MR;
`src/ci/extract-mr.ts` comment mode with a 👎 rejection marker.

**Target (AI.Team):** `agents/templates.md` → QA section, `agents/coach.md`
→ Lessons Regime, `agents/lessons.md`.

**Change:**
1. QA close emits an optional `Lesson-candidate: <≤12 words> (evidence [NNN])` line when the ticket needed ≥1 retry or a defect-class hit.
2. PM appends it as a `candidate` index line; Coach promotes or drops.

**Claims:**
- C1. `agents/lessons.md` already defines `candidate`.
- C2. Today only the Coach writes index lines.
- C3. The QA template has a close/report contract where one more conditional line fits.

**Value hypothesis:** lessons captured at the moment of evidence.

**Feasibility notes:** index spam risk gated by the trigger.

**Verification (slice B):**
- Truth: C1 TRUE — `lessons.md:12-13`. C2 TRUE — `coach.md:16, 44-53`, `lessons.md:7`; additionally `pm.md:367` forbids the PM from editing "lessons bodies (Coach/owner surfaces)", so step 2 ("PM appends") conflicts. C3 PARTIAL — QA has an output contract (`templates.md:191-198`) but none of its lines is conditional; conditional lines are PM-inserted Mandatory Brief Lines (`templates.md:28-70`), not QA outputs; QA cannot see "needed ≥1 retry" (that is `Retry-of:` in the PM-owned lifecycle, `lifecycle.md:26`). Source cites TRUE (`import-mr.ts:47-97`, 3000-char slice at `:51`; 👎 at `read-rejections.ts:5`).
- Value: L–M — cuts capture latency, but the Coach is already event-triggered on repeated failures (`pm.md:326`) and FC-10 is covered by the M6 sentinel.
- Feasibility: S — text-only; blocked as written by `pm.md:367` and Coach index ownership.
- Verdict: **ADOPT-WITH-CHANGES** — the PM adds a new Mandatory Brief Line 8 to the QA brief (trigger: `Retry-of` ≠ none or a defect-class hit) asking QA for `Lesson-candidate: <≤12 words> (evidence [NNN])`; the PM copies that line into the lifecycle entry's `Notes:` (`lifecycle.md:30` already allows "coaching trigger queued"); the **Coach**, not the PM, appends the `candidate` index line.

---

## P05 — Redact filter before ledger writes

**Source (teamai):** `src/utils/redact.ts:41-72`: layer 1 masks literal env
values whose NAME matches TOKEN|SECRET|KEY|PASSWORD|PASSWD|_PAT|CREDENTIAL
(≥8 chars); layer 2 regexes for PEM, vendor prefixes, JWT, `key=value` (≥16),
`Authorization: Bearer`; replacement `<REDACTED:label>`.

**Target (AI.Team):** new `scripts/lib/redact.mjs` + test; call site in
`scripts/reconcile-run.mjs`; one line in `SECURITY.md`.

**Change:**
1. Port the two layers as a pure function.
2. Reconciler applies it to all strings it writes; appends ` [redacted:N]` to the batch header when anything was redacted.
3. Not applied to PM in-session Edit writes (documented residual risk).

**Claims:**
- C1. `SECURITY.md` → Data in ledgers states rules but names no mechanical filter; CI has a full-history secret scan.
- C2. `scripts/reconcile-run.mjs` is the single mechanical writer of lifecycle BATCH blocks and the messages log block.
- C3. The reconciler already sanitizes single-line invariants (R6-08) — a redact pass fits the same place.

**Value hypothesis:** prevent, not just detect.

**Feasibility notes:** regexes must not mangle runIds/SHAs.

**Verification (slice C):**
- Truth: C1 PARTIAL — CI half TRUE (`.github/workflows/ci.yml:50-69`, gitleaks v8.30.1 full history); "names no mechanical filter" FALSE: `SECURITY.md:60-64` already names "The engine's redactor". C2 TRUE — only `reconcile-run.mjs` writes these blocks (`:210`, `:327`, `:372`); `preflight-run.mjs:195` writes `--out` only; `run-n-rounds.js` returns blocks, never writes; the PM's verbatim manual paste is a sanctioned fallback (`run-n-rounds.js:895`). C3 PARTIAL — the reconciler REJECTS (dies on CR/LF, `:117-124`), it does not sanitize; the sanitize+redact step is upstream in the engine: `redact` `run-n-rounds.js:329-346`, `cleanLine` `:358`, `redactDeep` `:354-356`, applied at `:464/:547/:772`, tests `tests/run-n-rounds.test.mjs:514-601`. Source cites TRUE.
- Ledger false-positive scan: teamai's KV/Bearer/JWT/PEM/vendor regexes over `agents/lifecycle.md`, `pm-decisions.md`, `memory/pm.md`, `messages/`: **0 hits**.
- Value: L — the engine already redacts every string before it reaches `lifecycleEntries`/`messagesLogBlock`; teamai's only real addition is extra token shapes (PEM, `AIza`, stripe, sendgrid, slack webhook, extra AWS prefixes, `hf_`/`glpat-`/`npm_`).
- Feasibility: S — appending ` [redacted:N]` to the BATCH header would make the reconciler path diverge from the manual verbatim-paste path (header regex `:126` still matches).
- Verdict: **ADOPT-WITH-CHANGES** — do not create `scripts/lib/redact.mjs`; add teamai's missing shapes (PEM included) to the existing engine `redact` (`run-n-rounds.js:329-346`) with cases in `tests/run-n-rounds.test.mjs`; if a reconciler check is still wanted, make it *refuse* (die) on a secret shape like its other invariants, never rewrite text; fix the C1 wording.
- Notes: skip layer 1 (env-value masking) — the engine has no env channel and gitleaks covers it.

---

## P06 — `validate-team.sh --json`

**Source (teamai):** `src/doctor.ts:132-145, 733-736` `--json` shape; check
registry with `informational`.

**Target (AI.Team):** `scripts/validate-team.sh`, tests, `scripts/preflight-run.mjs`.

**Change:** `--json` flag emitting `{ok, mode, failures, checks:[{level, id, msg}]}`; text default unchanged.

**Claims:**
- C1. `scripts/validate-team.sh` prints `LEVEL - id: msg` via `say()`; no structured output.
- C2. `scripts/preflight-run.mjs` or the recommended Stop hook currently parse/grep the text output.
- C3. Check IDs are stable strings usable as JSON keys.

**Verification (slice C):**
- Truth: C1 TRUE — `validate-team.sh:36-40`; some output bypasses `say()` (`:43` raw "FAIL - root", `:29` args, `:53` "MODE:", final RESULT lines). C2 FALSE — `preflight-run.mjs` never calls the validator; the Stop hook uses only the exit code (`harness-assumptions.md:81`); `bootstrap-team.sh:223-226` uses exit code + `tail -1`; the only text parsers are tests (`tests/validate-team.test.mjs:89-241`). C3 PARTIAL — 19 kebab-case IDs are stable but each is emitted many times per run (e.g. roster-wrappers ×6, lifecycle-counter ×6), so they collide as object keys; an array is fine.
- Value: L — no fragile grep to remove; useful only once a consumer exists.
- Feasibility: S–M — argv parsing only looks at `$1 == --mode` (`:26-32`), so `--json` needs a real argv loop; bash JSON escaping; non-`say` echo lines need routing.
- Verdict: **REJECT (defer)** — no consumer today. Reopen if a machine consumer appears. If built, `checks` must be an array.

---

## P07 — Detached Stop-hook validator with a time budget

**Source (teamai):** `src/hook-handlers.ts:68-101` foreground budget 4,500 ms;
detached re-exec `src/hook-dispatch-cli.ts:113-139`; stdin read abandons after
1,000 ms; `~/.teamai/debug.log` rotates at 5 MB.

**Target (AI.Team):** `docs/harness-assumptions.md` Stop hook snippet,
`scripts/watchdog/`, `agents/pm.md` wake step 0.

**Change:** Stop hook runs the validator detached into a result file; PM reads it at wake.

**Claims:**
- C1. The recommended Stop hook runs `validate-team.sh` synchronously.
- C2. Claude Code Stop hooks block session end until the command returns.
- C3. No deployment-local state dir for hook outputs exists yet.

**Verification (slice C):**
- Truth: C1 TRUE — `harness-assumptions.md:81`; `|| echo` means the hook never fails anyway. C2 NOT FOUND — no repo doc states Stop-hook blocking or timeouts; only gitignored local evidence (`docs/rollout-evidence/R02-FIX-1/review.md:119`: "hook timeout (believed to be 60 s, unverified)"); teamai's 4,500 ms budget derives from a CodeBuddy 10 s hard kill (`hook-handlers.ts:50-68`), not Claude Code; `watchdog-loop.sh:4` says Stop "fires per response". C3 TRUE — only `~/.claude/heartbeats` (outside repo) and `.team-loop/` (team-run store, `.gitignore:29`). Source cites TRUE.
- Timing: `time bash scripts/validate-team.sh .` = 0.09–0.11 s (verifier) / 0.35 s wall (PM re-run), kit and `--mode deployment` alike.
- Value: L — 0.1 s is nowhere near any hook budget; no failure class served.
- Feasibility: S but net negative — in-session FAIL echo lost; per-response Stop firing + `nohup … &` → overlapping writers on one result file; `--json` is silently ignored today (only `$1` parsed).
- Verdict: **REJECT** — revisit only if a deployment measures validator time near a documented Claude Code hook timeout.

---

## P10 — `--dry-run` refusal rule for scripts

**Source (teamai):** `src/dry-run-guard.ts:12-151` allowlist; refusal exit 1.

**Target (AI.Team):** `docs/process-index.md`, scripts that parse argv, tests.

**Change:** a script receiving `--dry-run` without a preview MUST refuse with exit 1; never ignore the flag.

**Claims:**
- C1. Verifier enumerates which AI.Team scripts accept `--dry-run` and whether any ignores it silently.
- C2. teamai's guard semantics are as cited.

**Verification (slice C):**
- Truth: C1 per script — `bootstrap-team.sh`: real `--dry-run` preview (`:49`, `:62`, test `bootstrap-team.test.mjs:92`), unknown flag refused (`:50`). `reconcile-run.mjs`: no dry-run, unknown refused/die (`:41`). `preflight-run.mjs`: refused exit 1 (`:46`). `team-run.mjs`: extra args → INVALID_SPEC (`:51-52`), recovery flags allowlisted (`:28-36`). `measure-context.sh` (`:20`), `now-utc.sh` (`:9-12`), `op-board.py` (`:184-185`): refused. `validate-team.sh`: leading flag becomes ROOT and fails (`:42-44`) but TRAILING flags (`. --dry-run`) are **silently ignored** (`:26-32`, only `$1` examined; read-only script). `check-claude-compat.sh` (`:19-22`): same, trailing flags silently ignored, read-only. `watchdog-loop.sh`: `$1` taken as session_id and the charset allows `-`, so `--dry-run` is **accepted as a session id** (`:25-27`). `heartbeat.sh`, `start-/stop-watchdog.sh`: argv not read. `run-n-rounds.js`: no argv; no unknown-key check found. C2 TRUE — `dry-run-guard.ts:12, :105, :126-131`, `index.ts:91-92`.
- Value: L–M — the three named targets already refuse; real gaps are silent trailing args in two read-only validators and the watchdog session-id path. None can produce a silently-real ledger write.
- Feasibility: S — no hard-rule conflicts.
- Verdict: **ADOPT-WITH-CHANGES** — one rule line in `docs/process-index.md` ("unknown flags, including `--dry-run`, exit 1; never ignore"); real argv loops in `validate-team.sh` and `check-claude-compat.sh` that reject extra args; `watchdog-loop.sh` rejects a leading `-`; no change to reconcile-run, team-run or bootstrap.

---

## P09 — Signed webhook on halt / Q4 owner-input events

**Source (teamai):** `src/webhook.ts:23-113` payload, whole-body redaction,
`X-TeamAI-Signature: sha256=<HMAC>`, 2^n backoff, 4xx (except 429) not
retried; `src/webhook-formatters.ts` Feishu/WeCom text.

**Target (AI.Team):** new `scripts/notify.mjs` + test; `docs/owner-contract.md`,
`docs/engine.md` reconciliation step; secret by env-var name only.

**Change:**
1. `node scripts/notify.mjs --event halt|needs-decision --json <file>` posts to `TEAM_NOTIFY_URL` with HMAC from `TEAM_NOTIFY_SECRET`; json|feishu|wecom.
2. Invoked by the PM after `reconcile-run.mjs` (serial-PM-only).

**Claims:**
- C1. `docs/owner-contract.md` sets a decision SLA (48 h) but names no out-of-session delivery channel.
- C2. `docs/engine.md` forbids IO inside the workflow body; post-reconcile is the sanctioned place.
- C3. The charter's halt list includes Q4 owner-input halts that surface only in the PM's ≤100-word report.

**Verification (slice D):**
- Truth: C1 TRUE — `owner-contract.md:10-11` (SLA), `:55-56` (Needs-Decision queued in "tracker or `pm-decisions.md`"); no out-of-session channel. C2 PARTIAL — `engine.md:82-83` (no IO/clock in a workflow body); `:313-346` reconciler first then a drain checklist (tracker sync … Q3/Q4 attestation); nothing names post-reconcile as the notification place; Q4 events are free-text strings in the PM-authored `--monitoring` JSON (`:354-358`), not structured events. C3 PARTIAL — charter halt list includes owner input (`charter.template.md:49-52, 59-60`); halts also surface in the attestation ledger line (`engine.md:360`) and `[CONTEXT-HALT]` (`charter.template.md:124`), not only the ≤100-word report (`pm.md:180`). Network rules: none forbid HTTPS from PM-run scripts; related only `CLAUDE.md:121-122` (no MCP in loops) and WF-14 (`workflow-catalog.md:168-175`, hangs must be bounded); `SECURITY.md:17-22` env-var reference satisfied. Source cites TRUE.
- Value: M — fills a real gap (unattended halt / Needs-Decision can wait out the 48 h SLA unseen), but a Q4 halt is triggered by the owner's own input, so notifying on it tells the owner nothing. Useful triggers: `haltReason` (Q5/budget), `[CONTEXT-HALT]`, `guardian.verdict != clean`, new Needs-Decision items. Closest existing equivalent: watchdog's local-only `osascript` hang notice (`watchdog-loop.sh:97-98`).
- Feasibility: S–M — no hard-rule conflict if run serially after reconcile. Prerequisites: hard per-request timeout + bounded retry total (WF-14); must never fail or block the drain checklist; payload redacted (depends on P05's engine redactor).
- Verdict: **ADOPT-WITH-CHANGES** — events `halt` (any non-`count-complete` haltReason, plus context-halt), `needs-decision`, `guardian-blocked`; drop Q4 as a trigger; add the step explicitly to the `engine.md:345-346` drain checklist; hard-cap total wall time (≤10 s), exit 0 on delivery failure with WARN; opt-in (no-op when `TEAM_NOTIFY_URL` unset).
- Notes: reuse the engine's redactor (P05) for the outbound body; add one `harness-assumptions.md` degradation row (no URL → no push, SLA clock unchanged).

---

## P11 — Model tier aliases in the roster + wrapper content hash

**Source (teamai):** `src/models/aliases.ts:25-32, 503-534`; `src/resources/delivered-copies.ts:644-647`.

**Target (AI.Team):** `agents/roster.template.md`, `scripts/bootstrap-team.sh`,
`scripts/validate-team.sh`, `scripts/preflight-run.mjs`.

**Change:** named tiers in the roster with one mapping table; bootstrap writes a `.sha256` sidecar per wrapper; validator distinguishes owner-edited (WARN) from template drift (FAIL).

**Claims:**
- C1. The roster is the single source of model/reasoning values; role rows carry literal model names today.
- C2. `scripts/preflight-run.mjs --session-started` rejects wrappers modified after session start but cannot tell owner edits from template drift.
- C3. `scripts/validate-team.sh` has an instantiation-drift class check (4c).

**Verification (slice D):**
- Truth: C1 PARTIAL — single source TRUE (`CLAUDE.md:50,87`; `_shared/README.md:25`; `roster.template.md:5-8`); template rows carry placeholders like `{{BACKEND_MODEL | ask:first_start}}` (`:68-78`) that become literals after the interview; the "Choosing Models" menu is already tier-based (`:24-33`); the roster's existing `Tier` column means dispatch cadence ("persistent", "event-triggered"), so the plan's `tier` name collides. C2 PARTIAL — preflight compares mtimes, not hashes (`preflight-run.mjs:130,132`; hashes only for the manifest `:59-63,157-167`); it cannot attribute an edit, but its purpose is stale hot-reload detection, where any post-start edit needs a restart regardless of author. C3 PARTIAL — 4c is `drift-models` (model-name regex outside roster/wrappers, `:358-366`); instantiation-drift is check 3 `template-refs` (`:291`); the relevant check is 5c `roster-binding` (`:612-690`), which requires the roster cell to EXACTLY equal the wrapper's `model:` (`:670`) — tier names in the roster would FAIL it. Sidecars: validator globs only `.claude/agents/*.md` (`:142,275,300,532`), so `*.md.sha256` would be ignored; `.claude/agents/README.md:3-9` restricts only frontmatter `.md`. Bootstrap does NOT instantiate wrappers (`bootstrap-team.sh:3-5`, pairs `:117-125`); it substitutes only PROJECT_NAME and PRODUCT_REPO_PATH via `perl -0pi` (`:137,141,179`). Source cites TRUE (`aliases.ts:2,57,503-534`; `delivered-copies.ts:644-647` — teamai keeps hashes in one record, not per-file sidecars).
- Value: L — model churn is already a roster-cell edit plus the wrapper copy that 5c enforces; Claude Code `model:` frontmatter cannot resolve custom tier names, so wrappers keep literals; drift attribution has no target because wrappers are hand-made from `agents/_seeds/role-wrapper.template.md`, never rendered. No FC served.
- Feasibility: M–L — needs a wrapper-rendering step that does not exist, a 5c rewrite, a column rename, a 4c regex update, and sidecar bookkeeping with no consumer.
- Verdict: **REJECT** — premise off. Optional documentation-only alternative: a "Model tier" annotation column beside the literal Model cell.

---

## Explicitly not ported

- Cross-tool distribution, `pull`/`push`, provider adapters (AI.Team is Claude-only by ADR).
- Auto-applied team hooks on member machines (trust model weaker than AI.Team's deny-list stance).
- Learnings pushed without review to an orphan branch (conflicts with owner ratification).
- LLM-driven promote / quality-rewrite (Coach already is the LLM; only thresholds are ported).
- 5,000-line source files.

## Verification method

Four read-only Explore subagents, one per slice, each given the document,
both repo paths and a strict output contract (Truth per claim with cites,
Value, Feasibility, Verdict). The PM spot-checked six teamai cites before the
plan was written and re-checked the two verdict-reversing findings (5c
equality at `validate-team.sh:670`; validator wall time) before accepting
P07/P11 rejections. Claim wording errors found by verifiers (P02 C1, P05 C1,
P08 C2, P11 C1–C3) are recorded above, not rewritten.
