# Review remediation — deployment evidence review of 2026-09-25

Source: the independent deployment-evidence review of the UHF Locator POC
pilot (reviewer round 1, goal `46a0a1d13a61bcdb`), which classified the pilot's
22 incidents into six P2 findings, one P3 finding and 18 recommendation
dispositions, and proposed development slices A–F. This file maps every
finding and accepted recommendation to the kit change that closes it, and names
what is deliberately deferred. It is a porting record (`docs/backport-ritual.md`),
not a restatement of the review.

## Findings

| Finding | Kit change | Evidence surface |
|---|---|---|
| F-01 execution success hid an unmet delivery requirement (US-02) | engine status axes `executionStatus / acceptanceStatus / deliveryStatus` + `done`; plan `deliveryRequired`; worker `delivery` contract; `allPassed` requires `done`; recovery + halt on pending delivery | `run-n-rounds.js`; `tests/run-n-rounds.test.mjs` F-01 (US-02 replay fails closed; doc-only task still completes; failed optional landing never blocks); `docs/failure-classes.md` FC-11 |
| F-02 missing guardian discovered after productive work; seed registered as a live agent | seeds moved to `agents/_seeds/`; `validate-team.sh` + `check-claude-compat.sh` FAIL on any seed or placeholder `name:` inside `.claude/agents/` (seeds are no longer exempt); `scripts/preflight-run.mjs` proves every dispatched type has a live wrapper with a matching frontmatter name, rejects stale wrappers with `--session-started`, records runtime identity | `tests/validate-team.test.mjs`, `tests/check-claude-compat.test.mjs`, `tests/preflight-run.test.mjs` |
| F-03 hardware smoke oracle satisfiable by handshake traffic | "Oracle falsifiability" section in `verify-discipline` (template + instance); Mandatory Brief Line 7; evidence must carry the test-file hash and a negative control. The product test itself (`integration_test/reader_bridge_test.dart`) is product work and was NOT modified here | `agents/_shared/verify-discipline.template.md`, `agents/templates.md` |
| F-04 board helper could drop a card from every list | `scripts/op-board.py` rewritten: journal before mutation, add-to-target first, readback, then removal, final readback, `reconcile` command; project constants removed (`OP_URL`, `OP_PROJECT` required); 14 failure-injection tests wired into `node --test` | `tests/op_board_test.py`, `tests/op-board.test.mjs` |
| F-05 workflow labels hid the task purpose | plan `title / workKind / layers` (presentation only, validated, frozen in the plan); one shared formatter (`src/loop/display.mjs`, byte-mirrored in the engine and parity-tested); compact label `<ticket> · <title> · <Build|Verify|Audit>`; titles in the ledgers; ID-only fallback when absent | `tests/run-n-rounds.test.mjs` F-05, `tests/loop-display.test.mjs` |
| F-06 new supervisor had no display metadata | `RunSpec schemaVersion 2` adds a required `display` field to `TaskSpec`; v1 closed and replayed unchanged; `renderRunSummary` + `team-run.mjs show`; simulation labelled in text and JSON | `src/loop/contracts.mjs`, `docs/loop-graph.md`, `tests/loop-display.test.mjs` |
| F-07 coaching trigger count wrong | engine `coaching.observations` (typed, unique ids, engine units) + `beyondThresholdCount` with a strict `> 50%` rule; the review's five inputs yield four; deployed PM memory corrected 19 → 18 with a dated note | `tests/run-n-rounds.test.mjs` F-07 |

## Recommendation dispositions

| # | Decision in the review | What changed here |
|---|---|---|
| 1 registration preflight | accept with changes | `preflight-run.mjs` (static, free); no paid probe; `--session-started` instead of "always restart" |
| 2 launch script / shared briefs | accept with changes | deferred — the preflight freezes the args by digest; a deterministic launcher with an equivalence test is Slice B follow-up |
| 3 single accounting unit | accept principle, reject conversion | `coaching.meter` names the unit; `docs/harness-assumptions.md` row forbids ratio conversion |
| 4 / 16 freeze policies incl. product primer | accept | preflight bundle hashes wrappers, role files, charter, profiles, shared rules, ADRs, product primer, engine, args; `launchManifestDigest` bound into the BATCH header; freeze rule in `docs/engine.md` |
| 5 decision verdict / independent continuation | conditional | not implemented — continuation still needs dependency/scope proof; `failurePolicy: continue` semantics unchanged |
| 6 bootstrap permissions | partial | preflight records product candidate + runtime identity; no Git bypass; permission escalation stays an owner decision (`docs/engine.md`) |
| 7 non-code incomplete step | accept, broaden | `deliveryRequired` per item; not every task requires a commit |
| 8 reduce bootstrap reads | accept | `measure-context.sh` now measures EVERY live wrapper's read closure (the deployed instance exceeds its ratchet — see below); duplication reduction is owner/Coach work |
| 9 auto-detect interview values | partial | deferred |
| 10 basic-board adapter | conditional | F-04 fixed before promotion; helper is capability-agnostic (env-configured), still optional |
| 11 mechanical UTC | accept | `scripts/now-utc.sh` + timestamp rule in `docs/engine.md` |
| 12 git index / pathspec discipline | accept contextual rule | "Landing / git index discipline" in `verify-discipline`; PM landing rule in `docs/engine.md` |
| 13 toolchain project markers | partial | deferred (not generalized from the unproven FVM root cause) |
| 14 pre-create coach | optional | not done; trigger semantics fixed first (F-07) |
| 15 owner directive inbox | accept with urgent exception | rule in `docs/engine.md` (queue + adoption boundary; stop/security/revocation/budget apply immediately) |
| 17 in-band Q3/Q4 attestation | accept with redesign | `reconcile-run.mjs --monitoring`: observer + interval + coverage + events, one idempotent ledger line; absence stays UNKNOWN |
| 18 PM lands denied commits | conditional | delivery-pending drain rule in `docs/engine.md` (exact diff, staged-intent check, gates, receipt ref, owner authority) |

## Deployed-instance consequences (not committed to the kit)

- `measure-context.sh` now reports 12,531 tokens for the chaos closure and
  11,141 for the frontend closure against the instance's 11,000 ratchet. The
  overlay growth is real (instance failure patterns in `agents/chaos.md`); the
  budget was NOT raised. Owner/Coach decision: port the patterns to the lessons
  index or raise the ratchet consciously in `docs/context-budget.md`.
- `scripts/op-board.py` now needs `OP_URL` and `OP_PROJECT` exported; the
  recorded `profiles/op-board.json` state file keeps working.
- `memory/pm.md` counter corrected (F-07) with a dated note.

## Deferred (review slices C–E beyond the bounded changes above)

- Host-issued gate receipts (candidate/oracle hashes, argv, exit status,
  output digest) replacing verifier-reported `commandsRun` — Slice D.
- Provider-usage vs engine-unit reconciliation, stale-quota pause, decision
  objects with scope/expiry, dependency-aware continuation — Slice E.
- Live Loop/Graph provider adapter — the supervisor remains simulation-only.
- Product-side fixes (reader smoke oracle, release build, ADR amendment
  provenance) — product repo work, out of this kit's scope.
