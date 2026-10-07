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
