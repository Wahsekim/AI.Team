# PM Decisions

Terse ledger. One line for dispatch, one line for close. Owner's primary audit
surface — scannable in under a minute.

Budget/halt values live in the charter's Canonical Budget/Halt Table —
reference it, never restate values here.
Rotation: slim-active + archive (`docs/process-index.md` -> Rotation Regime).
When the ledger grows past ~200 lines, rotate to
`pm-decisions-archive-<from>_<to>.md` (byte-identical, immutable) and keep the
tail verbatim for continuity.

## Format

```text
YYYY-MM-DD {{TICKET_ID}} -> {{ROLE_DISPLAY_NAME}}, est {{N}} tok, brief: agents/lifecycle.md#[NNN], why: {{ONE_PHRASE}}
            -> closed: actual {{N}} tok (var {{+/-N%}}), outcome: {{<=30_WORDS}}, lifecycle: [NNN]
```

Engine-mode batches: one dispatch+close line per iteration, reconstructed from
the engine's `results[]` (per `docs/engine.md`), under a dated batch line.

---
2026-10-06 R01 -> Implementer, est 150000 tok, brief: agents/lifecycle.md#[001], why: owner directed rollout execution; plan §5 says R01 first
2026-10-06 R01-R05-assessment -> Planner-Assessor, est 200000 tok, brief: agents/lifecycle.md#[002], why: handoff §1 requires team assessment before implementation beyond R01
            -> closed: actual 174699 tok (var -13%), outcome: assessment-R01-R05.md written; R01 OK blocked on owner PR for CI; R02-R05 feasible pending 7 owner questions, lifecycle: [002]
            -> closed: actual 126807 tok (var -15%), outcome: R01 local criteria OK, card BLOCKED on owner PR for CI; 4 doc edits, 22 logs, acceptance.md, lifecycle: [001]
2026-10-06 R01 -> Independent Reviewer, est 100000 tok, brief: agents/lifecycle.md#[003], why: handoff §2 requires reviewer != implementer before acceptance
            -> closed: actual 122517 tok (var +23%), outcome: review reproduced all claims, 0 P1 / 2 P2 / 5 P3, agrees BLOCKED on owner PR; REV-01 wording sent back to implementer, lifecycle: [003]
2026-10-06 R01 ACCEPTANCE: BLOCKED-on-owner (all local criteria OK, 0 P1 after review; CI needs owner PR). Totals harness-measured: R01 262061 tok, assessment 174699 tok. Next: owner answers assessment §5 Q1-Q7 + opens draft PR; then R02 dispatch.
2026-10-06 OWNER: agents may commit per card and push branch codex/loop-graph-mvp only (never main/force); evidence files stay uncommitted. PM opened draft PR #1 (head fb8e106), CI run 37471272538 queued.
2026-10-06 R02 -> Implementer, est 400000 tok, brief: agents/lifecycle.md#[004], why: owner Q3 = start R02 on local R01 evidence; R01 docs committed a45d9eb, evidence gitignored 156f37c
2026-10-06 R01 ACCEPTED: OK (CI run 37471272538 all green on fb8e106). Owner Q4: evidence local, ledgers committed; Q5: R03b isolated-clone policy accepted.
2026-10-06 OWNER Q6: R05 closes via existing abandon (explicit close -> R07). Q7: R04a/b + R05a/b splits approved; allowances provisional, re-baseline by 2026-10-08. Recorded in decisions/0001. CI on ad89e22 green.
            -> closed: actual 182333 tok (var -54%), outcome: R02 commit 761ba27, 27 new killed-host driver tests green on Node 24, 6 out-of-scope findings, review pending, lifecycle: [004]
2026-10-06 R02 -> Independent Reviewer, est 150000 tok, brief: agents/lifecycle.md#[005], why: handoff §2; push held until review
2026-10-06 OWNER: rollout plan docs kept local (gitignored). ADR 0001 committed.
            -> closed: actual 129486 tok (var -14%), outcome: R02 review clean (0 P1, 1 pre-existing P2 -> card R02b), all four boundaries covered; pushed 761ba27..ffa4ee4, CI pending, lifecycle: [005]
2026-10-06 CHECKPOINT-1 (ADR 0001 §7, due by 2026-10-08): harness-measured actuals — R01 impl 139,544 / review 122,517 (total 262,061); R02 impl 189,797 / review 129,486 (total 319,283); R01-R05 assessment 174,699; agents total 756,043. Both cards landed under the assessment's provisional ranges. Re-baselined allowances from R03a onward: implementation <=300k, review <=150k per card; a DoR estimate above 300k impl triggers subdivision before dispatch; two attempts max unchanged. Plan §2 S/M token bands (8-30k) are superseded for agent execution by this line.
2026-10-06 R02 CI KO: run 37478414519 ubuntu-24 fails legacy watchdog R-10 start-lock test (got 2 loops); new R02 tests 27/27 on Linux; macOS cancelled (fail-fast). Push held.
2026-10-06 R02-FIX-1 -> Implementer, est 250000 tok, brief: agents/lifecycle.md#[006], why: plan §3/§6 — failed test is KO until fixed in its own card; legacy fix separately scoped
            -> closed: actual 98800 tok (var -60%), outcome: real start-lock race (class A) fixed in 1038a1c with FIFO regression test; 423/423; review pending, lifecycle: [006]
2026-10-06 R02-FIX-1 -> Independent Reviewer, est 120000 tok, brief: agents/lifecycle.md#[007], why: handoff §2; legacy script change needs independent reproduction before push
            -> closed: actual 99631 tok (var -17%), outcome: fix confirmed; P2 test failure-path orphan -> attempt 2 sent to [006]; PM killed leftover test orphans 65040/65085, lifecycle: [007]
            -> closed: actual 107713 tok cumulative (var -10%), outcome: ec6eefa confirmed, self-cleaning OK, recommends accepting 1038a1c+ec6eefa pending CI, lifecycle: [007]
2026-10-07 R02-FIX-1 ACCEPTANCE: local OK, BLOCKED-on-CI. Pushing 1038a1c+ec6eefa to codex/loop-graph-mvp for the Linux confirmation.
2026-10-07 R02-FIX-1 ACCEPTED: OK (CI run 37583184155 all green on ec6eefa). R02 ACCEPTED: OK (same run; new tests pass on ubuntu/macOS). Ledgers committed and pushed per owner Q4.
2026-10-07 R02b -> Implementer, est 60000 tok, brief: agents/lifecycle.md#[008], why: R02 review P2 F1 (untimed Atomics.wait in existing crash host) — smallest corrective card
2026-10-07 CI green on ledger commit 7480b0e (run 37583441118). Branch head = PR #1 head = 7480b0e; working tree clean except R02b in progress.
            -> closed: actual 61881 tok (var +3%), outcome: R02b commit 53296f6, PM direct review OK, pushed, CI pending, lifecycle: [008]
2026-10-07 R03a -> Implementer (step 1 design record), est 300000 tok total, brief: agents/lifecycle.md#[009], why: next card after R02/R02b OK; assessment requires lock design sign-off before code
2026-10-07 R02b ACCEPTED: OK (CI run 37583985152 all green on 53296f6). G0 progress: R01 OK, R02 OK, R02b OK; R03a step 1 (design) in progress; R03b, R04a/b, R05a/b pending.
2026-10-07 CI green on ledger commit 12f78ea (run 37584217904). PR #1 head = 12f78ea, every run since the R02-FIX-1 push green.
            -> closed: actual 143752 tok (step 1), outcome: ADR 0002 drafted; PM signed off Q1-Q5 yes with conditions; step 2 -> [010], lifecycle: [009]
2026-10-07 R03a step 2 -> Implementer (fresh), est 250000 tok, brief: agents/lifecycle.md#[010], why: implement signed-off ADR 0002; fresh agent cheaper than 144k resume
2026-10-07 R03a -> Independent Reviewer, est 150000 tok, brief: agents/lifecycle.md#[011], why: handoff §2; store/driver change needs independent reproduction before push
            -> closed: actual 188910 tok (var -24%), outcome: R03a implemented in ace398b, T1-T13 green, review pending, push held, lifecycle: [010]
            -> closed: actual 168474 tok (var +12%), outcome: R03a review KO — P1 second-store marker bypass, P2 operator-close identity + probe test; attempt 2 sent to [010], lifecycle: [011]
2026-10-07 R03a ACCEPTANCE: OK locally, BLOCKED-on-CI (ace398b + 8044a0b; review [011] §8 confirms P1/P2 fixed). Pushed for CI.
2026-10-07 FLAKE-1 -> Implementer, est 120000 tok, brief: agents/lifecycle.md#[012], why: two load-sensitive experimental tests found during R03a review/verification (plan §3: own fix card)
2026-10-07 R03a ACCEPTED: OK (CI run 37590174571 all green on 8044a0b). G0 progress: R01, R02, R02b, R03a OK; FLAKE-1 in progress; R03b, R04a/b, R05a/b pending. ADR 0002 awaits owner ratification.
2026-10-07 CI on ledger commit e1c2edf: conclusion=success (runs/37590427063).
2026-10-07 FLAKE-1 closed-impl: actual 95067 tok (var -21%), outcome: 713c390 tests-only; BLOCKED on new product defect PROC-1 (process-runner EPERM-on-zombie misclassification), lifecycle: [012]
2026-10-07 FLAKE-1 -> Independent Reviewer, est 100000 tok, brief: agents/lifecycle.md#[013], why: mocked-timer test changes need independent check they cannot mask real failures
2026-10-07 PROC-1 -> Implementer, est 150000 tok, brief: agents/lifecycle.md#[014], why: product defect found by FLAKE-1 verification; plan §3 own fix card; affects cancellation semantics (R04/R12)
2026-10-07 PROC-1 closed-impl: actual 76876 tok (var -49%), outcome: 7881d1f fixes zombie-window EPERM misclassification with red-then-green + mock-free repro; review pending, lifecycle: [014]
2026-10-07 PROC-1 -> Independent Reviewer, est 110000 tok, brief: agents/lifecycle.md#[015], why: src cancellation-classification change; consumers' fail-closed semantics must be independently verified
2026-10-07 PROC-1 ACCEPTANCE: OK locally, BLOCKED-on-CI (review [015] clean; record wording on Linux corrected). Follow-up candidates: PROC-2 (PID reuse after reap), R12 escaped-descendant note. Push waits for FLAKE-1 review [013].
            -> [015] closed: actual 84675 tok (var -23%), outcome: PROC-1 review clean, 0 P1/P2, lifecycle: [015]
2026-10-07 [013] closed: actual 85051 tok (var -15%), outcome: FLAKE-1 review OK-pending-PROC-1 with 1 P2 (mocked timeout case assertion) -> attempt 2 sent to [012], lifecycle: [013]
2026-10-07 FLAKE-1 ACCEPTANCE: OK locally, BLOCKED-on-CI (713c390 + 4a11924). PROC-1 + FLAKE-1 pushed together for CI.
2026-10-07 R03b -> Implementer, est 250000 tok, brief: agents/lifecycle.md#[016], why: next G0 card; owner Q5 policy fixed; R03a primitive available
2026-10-07 FLAKE-1 ACCEPTED: OK; PROC-1 ACCEPTED: OK (CI run 37596638884 all green on 4a11924). G0 progress: R01, R02, R02b, R03a, FLAKE-1, PROC-1 OK; R03b in progress; R04a/b, R05a/b pending. Follow-up candidates: PROC-2, R12 escaped-descendant note.
2026-10-07 CI on ledger commit: run=52b1490 conclusion=success (runs/37596936039).
2026-10-07 R03b closed-impl: actual 170985 tok (var -32%), outcome: ae082d3 implements target isolation; PM probe: documented fixture command from repo root now exits 4 (state dir inside a Git repo) — review to adjudicate, lifecycle: [016]
2026-10-07 R03b -> Independent Reviewer, est 150000 tok, brief: agents/lifecycle.md#[017], why: handoff §2; stricter-than-briefed rule has a user-visible consequence
            -> [017] closed: actual 113033 tok (var -25%), outcome: R03b review KO — outside-repo rule kept (containment hazard), P1 untested driver guard, P2 docs; attempt 2 sent, lifecycle: [017]
2026-10-07 OWNER-DECISION NEEDED: R03b makes state directories inside any Git repository unsupported (documented fixture commands change). Rationale: containment hazard (review [017]).
2026-10-07 OWNER: approved R03b behavior change — state directories must be outside any Git repository (documented commands updated). R03b attempt 2 = 963be6a (F-01..F-06 fixed); reviewer confirmation requested.
2026-10-07 R03b ACCEPTANCE: OK locally, BLOCKED-on-CI (ae082d3 + 963be6a; review [017] confirms). Docs commit records owner approval (ADR 0003 status, index, loop-graph.md wording). Pushing.
            -> [017] final: actual 131548 tok cumulative (var -12%), outcome: R03b attempt 2 confirmed, OK locally pending CI, lifecycle: [017]
2026-10-07 R04a -> Implementer, est 220000 tok, brief: agents/lifecycle.md#[018], why: next G0 card (R04 split approved Q7); R03a/R03b landed; store-side stop record first, driver observation in R04b
2026-10-07 R03b ACCEPTED: OK (CI run 37629561431 all green on f19e221). G0 progress: R01, R02, R02b, R03a, R03b, FLAKE-1, PROC-1 OK; R04a in progress; R04b, R05a, R05b pending. R03 (both halves) complete.
2026-10-07 CI on ledger commit: run=4a2a0d7 conclusion=success (runs/37629878776).
2026-10-07 R04a closed-impl: actual 181740 tok (var -17%), outcome: 7b008e8 durable stop record + R-1 version rule + read interface; replay-compat break for pre-R04a stop events flagged; review pending, lifecycle: [018]
2026-10-07 R04a -> Independent Reviewer, est 150000 tok, brief: agents/lifecycle.md#[019], why: handoff §2; reducer/store change on the stop path
            -> [019] closed: actual 144432 tok (var -4%), outcome: R04a review OK on core guarantee, P2 legacy replay -> attempt 2; PM decided the R04b pending-projection rule; follow-ups STOP-2/STOP-3, lifecycle: [019]
2026-10-07 R04a ACCEPTANCE: OK locally, BLOCKED-on-CI (7b008e8 + 812bbf4; review [019] confirms). Docs commit: ADR 0004 status + wording, README rows 0002/0004. Pushing.
2026-10-07 R04b -> Implementer, est 250000 tok, brief: agents/lifecycle.md#[020], why: second half of R04 (Q7 split); R04a contract + PM pending-projection rule fixed
2026-10-07 NOTE: docs/loop-graph.md:278 still reads "(R04b decision pending)" across a line break; fix deferred to the R04b docs commit to avoid concurrent edits of the same file. [019] final: actual 158113 tok cumulative (var +5%).
2026-10-07 R04a ACCEPTED: OK (CI run 37634701791 all green on 551133b). G0 progress: R01, R02, R02b, R03a, R03b, R04a, FLAKE-1, PROC-1 OK; R04b in progress; R05a, R05b pending. Follow-up cards queued: STOP-2, STOP-3, PROC-2.
2026-10-07 CI on ledger commit: run=7f13bc6 conclusion=success (runs/37634961493).
2026-10-07 R04b closed-impl: actual 223423 tok (var -11%), outcome: 16ea22f driver stop observation + cancellation + pending-projection rule + observer-failure reporting; review pending, lifecycle: [020]
2026-10-07 R04b -> Independent Reviewer, est 160000 tok, brief: agents/lifecycle.md#[021], why: handoff §2; driver/reducer change on the cancellation path
2026-10-07 NOTE: the deferred loop-graph.md wording ('R04b decision pending') was removed by the R04b docs rewrite in 16ea22f; no PM edit needed.
            -> [021] closed: actual 149651 tok (var -6%), outcome: R04b review OK on safety, P2 status-state tests -> attempt 2; PM decision: post-observer-failure hard stop not cancelling the running effect = documented limitation (revisit R12/R14), lifecycle: [021]
2026-10-07 R04b ACCEPTANCE: OK locally, BLOCKED-on-CI (16ea22f + ca09d36; review [021] confirms). Pushing. Follow-up: R04b-P3 (two test gaps).
2026-10-07 R05a -> Implementer, est 200000 tok, brief: agents/lifecycle.md#[022], why: next G0 card (R05 split approved Q7); X5 inspection-mutates-state must close before recovery commands
2026-10-07 R04b ACCEPTED: OK (CI run 37641008156 all green on ca09d36). R04 complete. G0 progress: R01, R02, R02b, R03a, R03b, R04a, R04b, FLAKE-1, PROC-1 OK; R05a in progress; R05b pending; then G0 exit review. Follow-ups queued: STOP-2, STOP-3, PROC-2, R04b-P3.
2026-10-07 CI on ledger commit: run=834d398 conclusion=success (runs/37641465611).
2026-10-07 R05a closed-impl: actual 231801 tok (var +16%), outcome: 50cde2e read-only inspection + inspect command; hot-journal limitation flagged; review pending, lifecycle: [022]
2026-10-07 R05a -> Independent Reviewer, est 150000 tok, brief: agents/lifecycle.md#[023], why: handoff §2; read-only guarantees and the hot-journal crash case need independent characterization
            -> [023] closed: actual 122017 tok (var -19%), outcome: R05a review OK on core; P2 F2/F3 -> attempt 2; hot-journal snapshot read + recover-journal = binding R05b precondition, lifecycle: [023]
2026-10-07 R05a ACCEPTANCE: OK locally, BLOCKED-on-CI (50cde2e + 22f6a91; review [023] confirms). Pushing.
2026-10-07 R05b -> Implementer, est 260000 tok, brief: agents/lifecycle.md#[024], why: last G0 card (R05 split approved Q7); R05a preconditions (snapshot read, recover-journal, abandon guard) are binding
2026-10-07 R05a ACCEPTED: OK (CI run 37644352082 all green on 22f6a91). G0 progress: R01-R04 (all halves), R05a, FLAKE-1, PROC-1 OK; R05b implementation on disk uncommitted (agent interrupted by host sleep), resumed to verify, record and commit.
