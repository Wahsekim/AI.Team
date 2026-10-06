# Agent Lifecycle Log

Append-only record of every worker dispatch. PM owns this file.
Rotation: slim-active + archive — the standing rule in
`docs/process-index.md` -> Rotation Regime.

## Format

```md
## [NNN] {{ROLE_DISPLAY_NAME}} ({{ROLE_ID}}) - {{UTC_TIMESTAMP}}
- Ticket: {{TICKET_ID | none}}
- Spawned by: {{PM_NAME}}
- Brief: {{ONE_LINE_SCOPE}}
- Model: {{MODEL | per agents/roster.md}}
- Reasoning: {{REASONING | per agents/roster.md}}
- Estimated tokens: {{INTEGER}}
- Sub-decision count: {{INTEGER}}
- Status: spawned | running | completed | failed | aborted
- Completed: {{UTC_TIMESTAMP}}
- Tokens: {{INTEGER}}                     # harness-measured; dual-record self-report >30% divergence (M4)
- Variance: {{+/-N%}}
- PM overhead: ~{{INTEGER}} tok (est)
- Outcome: {{ONE_LINE_RESULT}}
- Progress: yes | no
- Handoffs:
    - {{ROLE_ID}} needs {{THING}} for {{TICKET_ID}}
- Retry-of: {{NNN | none}}
- Diverged-from: {{NNN | none}} - {{WHAT_CHANGED_ON_RETRY}}
- Round-trip: {{N | none}}
- Notes: {{OPTIONAL - coaching trigger queued, escalation, Q-gate line}}
```

## Counter

Next NNN to assign: **005**

## Counter and header rules

1. `NNN` is a monotonic 3-digit counter, never reused, even after failures.
2. **One `## [NNN]` header per entry, EVER.** Duplicate `[NNN]` numbers and
   second `## [NNN] close`-style headers are BANNED — close info updates the
   original block in place; the header is immutable. (The source project's
   pre-rotation log accumulated duplicate headers; do not repeat.)
3. A re-spawn for the same ticket gets a NEW NNN with `Retry-of: <prior NNN>`.
4. All timestamps UTC, ISO 8601.
5. If a worker dies before closing, the PM fills the close fields with
   `Notes: closed by PM (worker died)`.

## Engine-mode compressed format

For `run-n-rounds` engine loops, the PM pastes the engine's emitted block
VERBATIM (see `docs/engine.md` — manual re-derivation banned). The emitted
block already satisfies this format: it starts with the `### BATCH` header
(which carries the run's `runId` — if a BATCH header with that runId is
already in this file, the run was already reconciled: never paste twice),
each numbered entry carries SEPARATE worker/verifier token figures
(`~N tok worker / ~N tok verifier` — the engine's harness deltas, never the
aggregate divided by N), the verifier verdict is in each entry line, and the
guardian verdict arrives as its own numbered entry at the end of the block.
Compressed one-line entries are valid closes in this mode.

## Harness Rules

1. Estimate before dispatch.
2. Close every entry.
3. Variance above the charter's coaching threshold (charter -> Cost
   Discipline — single source, not restated here) queues a Coach trigger
   (batched — drained in one Coach dispatch).
4. Stop on the empty-loop pattern.
5. Retries must diverge (`Diverged-from` filled).
6. Workers cannot spawn workers.
7. Progress must be observable.
8. Any halt of a count-directed loop outside the charter halt list triggers a
   chaos-role halt-investigation BEFORE the halt.

## Rotation

When the active file exceeds ~400 lines of entries: move closed entries to
`agents/archive/lifecycle-<from>_<to>.md` (byte-identical, immutable), keep the
counter line, and keep a one-line-per-entry recent-history summary for
continuity. Reconcile any counters derived from this log (hardening counter)
at rotation time.

---

<!-- Entries below. -->

## [001] Implementer (loop-rollout-implementer) - 2026-10-06T12:49:35Z
- Ticket: R01
- Spawned by: PM (Claude Fable 5.1 main session, owner-directed dispatch)
- Brief: R01 establish release baseline — verify SHA/clean state, rerun suite on Node 24/22 + kit checks, record CI availability, refresh stale checkpoint summary, write docs/rollout-evidence/R01/acceptance.md. Docs/evidence only; no runtime changes; no git mutations.
- Model: opus (owner directive "opus 5 max"; kit pre-bootstrap, no roster)
- Reasoning: max (prompt-level; no wrapper frontmatter available)
- Estimated tokens: 150000
- Sub-decision count: 0
- Status: completed
- Completed: 2026-10-06T12:59:51Z
- Tokens: 139544 (cumulative; attempt 1 126807 + attempt 2 correction 12737)
- Variance: -7%
- PM overhead: ~15000 tok (est)
- Outcome: R01 local criteria OK (395/395 Node 24.21.0; 306 legacy + 89 experimental; Node 22 348/47 skip/0 fail; fixture CLI exit 7 on 22; kit checks pass); card BLOCKED on CI (no PR); 4 doc edits; 22 logs + acceptance.md written; no git mutations
- Progress: yes
- Handoffs:
    - reviewer needs exact diff + logs for R01 (lifecycle [003])
    - owner needs to open draft PR codex/loop-graph-mvp -> main for CI evidence
- Retry-of: none
- Diverged-from: none
- Round-trip: 1 (resumed for REV-01/REV-03 wording correction after [003] review; same NNN, no re-spawn)
- Notes: INLINE FALLBACK — kit is pre-bootstrap (no .claude/agents wrappers, no INLINE_BASE_AGENT_MODE.md); dispatched via runtime general-purpose agent at owner's explicit direction. CI matrix evidence pre-identified as owner-blocked (ci.yml triggers on PR/main only; no PR for codex/loop-graph-mvp).
- Acceptance: 2026-10-06T13:08:54Z BLOCKED-on-owner (local criteria OK, reviewed by [003]); acceptance.md sha256 a1615b44fef319e68d1a4701e2e0ad09b8d97d5c2460e76e4c807521c3b55e63; docs/loop-graph.md sha256 ac1d2ffbcb4579c5e7cbebc326b4076a9706b8c2376a49cedf8f7c31e2e41627

## [002] Planner-Assessor (loop-rollout-assessor) - 2026-10-06T12:49:35Z
- Ticket: R01-R05-assessment
- Spawned by: PM (Claude Fable 5.1 main session, owner-directed dispatch)
- Brief: Handoff §1 team response for R01–R05 only — owners per card, feasibility vs actual baseline with file:line grounding, effort + subdivision (R03a/R03b, R04), test environments and CI evidence path, evidence location + first checkpoint. Read-only on repo; writes docs/rollout-evidence/assessment-R01-R05.md only.
- Model: opus (owner directive "opus 5 max")
- Reasoning: max (prompt-level)
- Estimated tokens: 200000
- Sub-decision count: 0
- Status: completed
- Completed: 2026-10-06T12:58:13Z
- Tokens: 174699
- Variance: -13%
- PM overhead: ~10000 tok (est)
- Outcome: wrote docs/rollout-evidence/assessment-R01-R05.md (328 lines); R01 reachable locally but OK needs owner PR for CI; R02-R05 feasible with decisions; proposes R03a/b, R04a/b, R05a/b splits and re-baselined allowances
- Progress: yes
- Handoffs:
    - owner needs answers to assessment §5 Q1-Q7 before R02 dispatch
- Retry-of: none
- Diverged-from: none
- Round-trip: none
- Notes: INLINE FALLBACK (see [001]). Must not run the full test suite concurrently with [001].

## [003] Independent Reviewer (loop-rollout-reviewer) - 2026-10-06T12:59:51Z
- Ticket: R01
- Spawned by: PM (Claude Fable 5.1 main session, owner-directed dispatch)
- Brief: Independent review of R01 deliverable — reproduce material claims (suite on Node 24/22, fixture CLI exit codes, kit checks, gh queries), verify log digests, check docs/loop-graph.md edits for factual accuracy and overclaiming, adjudicate implementer findings F1-F4, scan evidence logs for sensitive content. Writes docs/rollout-evidence/R01/review.md only.
- Model: opus (owner directive "opus 5 max")
- Reasoning: max (prompt-level)
- Estimated tokens: 100000
- Sub-decision count: 0
- Status: completed
- Completed: 2026-10-06T13:07:28Z
- Tokens: 122517
- Variance: +23%
- PM overhead: ~10000 tok (est)
- Outcome: all digests match; Node 24/22 suites, fixture CLI exit codes, kit checks and gh queries reproduced with no mismatch; 0 P1, 2 P2 (REV-01 overclaim in Next-sequence note, REV-02 usage figure missing), 5 P3; agrees card BLOCKED on owner PR with all local criteria OK
- Progress: yes
- Handoffs:
    - implementer [001] needs to reword REV-01/REV-03 (sent via resume, attempt 2)
    - acceptance owner (PM) needs to record usage + verdict in acceptance.md
- Retry-of: none
- Diverged-from: none
- Round-trip: none
- Notes: INLINE FALLBACK (see [001]). Reviewer is not the implementer (handoff §2).

## [004] Implementer (loop-rollout-implementer) - 2026-10-06T13:32:55Z
- Ticket: R02
- Spawned by: PM (Claude Fable 5.1 main session, owner-directed; owner answered Q3 "start R02 now")
- Brief: R02 prove driver crash behavior — test-only boundary hooks + killed-host tests at the four driver boundaries (claim-before-start, process-before-receipt, receipt-before-settle, projection-before-ACK), 5 repetitions, bounded orphan lifetime, reopen-and-inspect assertions. One commit, no push, evidence under docs/rollout-evidence/R02/ (gitignored).
- Model: opus (owner directive "opus 5 max")
- Reasoning: max (prompt-level)
- Estimated tokens: 400000
- Sub-decision count: 1 (test-hook injection pattern — PM pre-decided: follow existing adapter hook pattern, inert when unset)
- Status: spawned
- Completed:
- Tokens:
- Variance:
- PM overhead: ~20000 tok (est)
- Outcome:
- Progress:
- Handoffs:
- Retry-of: none
- Diverged-from: none
- Round-trip: none
- Notes: INLINE FALLBACK (see [001]). Baseline for R02 = HEAD after R01 docs commit + gitignore chore (recorded by the implementer). CI on fb8e106 (run 37471272538) still pending at dispatch; R02 pauses if it fails.
