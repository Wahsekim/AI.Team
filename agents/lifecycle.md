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

Next NNN to assign: **009**

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
- Acceptance update: 2026-10-06T13:38:47Z OK (CI run 37471272538 green on fb8e106; all R01 criteria met)

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
- Status: completed
- Completed: 2026-10-06T14:13:38Z
- Tokens: 189797 (cumulative; attempt 1 182333 + record-wording correction 7464)
- Variance: -53%
- PM overhead: ~20000 tok (est)
- Outcome: commit 761ba27 adds tests/loop-driver-crash.test.mjs (27 tests: 5 boundaries x 5 reps + 2 negatives) and tests/fixtures/driver-crash-host.mjs; src/loop untouched; 422/422 Node 24, 348/74 skips/0 fail Node 22; new file ~28 s; mutation checks M1/M2/M3b fail as intended; no orphans; 6 out-of-scope findings; Linux/CI pending
- Progress: yes
- Handoffs:
    - reviewer [005] needs commit 761ba27 + docs/rollout-evidence/R02/
    - R05 needs F2/F3; R03/R12 need F4; chaos/coach: F1 (untimed Atomics.wait in existing fixture host)
- Retry-of: none
- Diverged-from: none
- Round-trip: 1 (resumed for REV-01/REV-05 record wording after [005] review; same NNN)
- Notes: INLINE FALLBACK (see [001]). Baseline for R02 = HEAD after R01 docs commit + gitignore chore (recorded by the implementer). CI on fb8e106 (run 37471272538) still pending at dispatch; R02 pauses if it fails.
- Acceptance update: 2026-10-06T14:26:38Z KO on CI criterion (run 37478414519 ubuntu-24: legacy watchdog R-10 start-lock test got 2 loops; new tests 27/27 on Linux) -> corrective card R02-FIX-1 [006]
- Acceptance update: 2026-10-07T06:46:59Z OK (CI run 37583184155 green on ec6eefa incl. the R02 tests on ubuntu/macOS Node 24)

## [005] Independent Reviewer (loop-rollout-reviewer) - 2026-10-06T14:13:38Z
- Ticket: R02
- Spawned by: PM (Claude Fable 5.1 main session)
- Brief: Independent review of commit 761ba27 (R02) — reproduce suite counts on Node 24/22, new-file stability x3, one mutation each for duplicate-spawn and saved-PID KO, orphan check; verify the five boundary mappings against code; check hooks are test-only and the real driver path is exercised; adjudicate F1-F6 and uncertainties; writes docs/rollout-evidence/R02/review.md only.
- Model: opus (owner directive "opus 5 max")
- Reasoning: max (prompt-level)
- Estimated tokens: 150000
- Sub-decision count: 0
- Status: completed
- Completed: 2026-10-06T14:22:41Z
- Tokens: 129486
- Variance: -14%
- PM overhead: ~10000 tok (est)
- Outcome: all 16 digests OK; 27/27 x3 (27.0 s each), 422/422 Node 24, 348/74/0 Node 22; own mutations K1 (10/27 fail) and K2 (1 fail) confirm test strength; all four plan boundaries covered by real killed hosts; 0 P1, 1 P2 (pre-existing F1 -> R02b), 6 P3; recommends OK locally, BLOCKED on CI
- Progress: yes
- Handoffs:
    - implementer [004] needs REV-01/REV-05 record wording (sent via resume)
    - PM needs CI on ffa4ee4 for the POSIX/Linux criterion
    - follow-up card R02b: bound Atomics.wait in tests/fixtures/fixture-crash-host.mjs:10
- Retry-of: none
- Diverged-from: none
- Round-trip: none
- Notes: INLINE FALLBACK (see [001]). Reviewer != implementer (handoff §2). Push of 761ba27 is held until this review closes.

## [006] Implementer (loop-rollout-implementer) - 2026-10-06T14:26:38Z
- Ticket: R02-FIX-1
- Spawned by: PM (Claude Fable 5.1 main session)
- Brief: Diagnose and fix CI run 37478414519 failure on ubuntu-24: legacy tests/watchdog.test.mjs:162 "R-10 concurrent SessionStart hooks spawn at most one loop" got 2 under the added parallel load of tests/loop-driver-crash.test.mjs. Root-cause with evidence (real start-lock race vs test fragility vs cross-test interference), smallest fix, no timeout bumps, no assertion weakening, no rerun-until-green. One commit, no push. Evidence docs/rollout-evidence/R02-FIX-1/.
- Model: opus (owner directive "opus 5 max")
- Reasoning: max (prompt-level)
- Estimated tokens: 250000
- Sub-decision count: 1 (fix locus: legacy lock vs legacy test vs new tests' isolation — decided by evidence)
- Status: completed
- Completed: 2026-10-06T15:05:31Z
- Tokens: 127096 (cumulative; attempt 1 98800 + attempt 2 self-cleaning test fix 28296)
- Variance: -49%
- PM overhead: ~15000 tok (est)
- Outcome: root cause A — real race in scripts/watchdog/start-watchdog.sh: hook released the mkdir lock before the forked loop exec'd, so a delayed second hook saw a non-watchdog argv, deleted the PID file and spawned a second loop; fix 1038a1c holds the lock until pid_is_watchdog (bounded ~5 s) + deterministic FIFO regression test; 423/423 Node 24, 349/74/0 Node 22; shellcheck clean; CI pending
- Progress: yes
- Handoffs:
    - reviewer [007] needs commit 1038a1c + docs/rollout-evidence/R02-FIX-1/
    - PM pushes after review; CI on new head then re-evaluates R02
- Retry-of: none
- Diverged-from: none
- Round-trip: 1 (resumed for review F1/F2/F3 -> second commit ec6eefa; same NNN)
- Notes: INLINE FALLBACK (see [001]). Separately scoped legacy compatibility fix per plan §6 if the locus is legacy. Push held until this card closes.
- Notes (hygiene): implementer disclosed a stray attempt-1 background chain (rep.sh + 8 yes loads, ~16:33-17:17 local) that ran the new test against the unfixed script, produced the orphans found by [007], and made its attempt-1 'no load' labels inaccurate (all runs still passed; digests intact). PM killed the orphans; chain now gone.
- Acceptance: 2026-10-07T06:46:59Z OK (CI run 37583184155 green on ec6eefa)

## [007] Independent Reviewer (loop-rollout-reviewer) - 2026-10-06T15:05:31Z
- Ticket: R02-FIX-1
- Spawned by: PM (Claude Fable 5.1 main session)
- Brief: Independent review of commit 1038a1c — verify the race mechanism against the script, reproduce the FIFO reproducer before/after (via git archive of ffa4ee4), check the bounded wait vs the lock back-off timing for determinism, check the new test's failure-path cleanup (pre-exec child blocked on FIFO), hook latency impact, shellcheck, suites on Node 24/22. Writes docs/rollout-evidence/R02-FIX-1/review.md only.
- Model: opus (owner directive "opus 5 max")
- Reasoning: max (prompt-level)
- Estimated tokens: 120000
- Sub-decision count: 0
- Status: completed
- Completed: 2026-10-06T15:15:14Z
- Tokens: 107713 (cumulative; review 99631 + attempt-2 confirmation 8082)
- Variance: -10%
- PM overhead: ~10000 tok (est)
- Outcome: mechanism confirmed line by line; FIFO reproducer baseline 2 loops 3/3, HEAD 1 loop 3/3; 423/423 Node 24, 349/74/0 Node 22; determinism margin ~25x; production fix OK; P2 F1: new test's failure path leaves a pre-exec child blocked on the FIFO and hangs the runner (KO class) — concrete finally fix verified in scratch; P3 F2 unbounded poll, F3 cap is ~6.3-7.6 s not ~5 s, F4 note; found leftover orphans from the implementer run on this host
- Progress: yes
- Handoffs:
    - implementer [006] needs F1/F2/F3 as a second commit (sent via resume)
    - PM: kill leftover PIDs 65040/65085 (done), push after attempt 2
- Retry-of: none
- Diverged-from: none
- Round-trip: 1 (resumed to confirm ec6eefa; self-cleaning criterion now OK)
- Notes: INLINE FALLBACK (see [001]). Reviewer != implementer. Push held until this review closes.

## [008] Implementer (loop-rollout-implementer) - 2026-10-07T06:46:59Z
- Ticket: R02b
- Spawned by: PM (Claude Fable 5.1 main session)
- Brief: Corrective card from R02 review (P2 F1): bound the untimed Atomics.wait in tests/fixtures/fixture-crash-host.mjs:10 so a crash host whose runner dies between pause and kill cannot live forever; add/extend a test proving the bound; one commit, no push.
- Model: opus (owner directive "opus 5 max")
- Reasoning: max (prompt-level)
- Estimated tokens: 60000
- Sub-decision count: 0
- Status: spawned
- Completed:
- Tokens:
- Variance:
- PM overhead: ~8000 tok (est)
- Outcome:
- Progress:
- Handoffs:
- Retry-of: none
- Diverged-from: none
- Round-trip: none
- Notes: INLINE FALLBACK (see [001]). Smallest corrective card per handoff §8; PM reviews the diff directly if <= 30 lines, else dispatches a reviewer.
