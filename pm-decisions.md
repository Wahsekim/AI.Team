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
