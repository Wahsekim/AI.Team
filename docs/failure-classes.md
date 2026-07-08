# Failure-Class Catalog (canonical)

The ten classes below are **model-level defects**: they recur across projects,
stacks, and agent frameworks because they come from how LLM agents behave
(optimistic self-assessment, plausible confabulation, narrative authority,
prose-maintained state) — not from any one codebase. The source project
observed every one of them repeatedly until a structural rule killed it.

**Design consequence (owner directive 2026-07-06):** defenses live at the
HARNESS level — mechanical checks, schema contracts, executable gates,
confirmation loops, supervision — never as more prose. A prose warning is a
detection aid at best; only a mechanism changes the failure rate.

This file is the single home of the catalog. `agents/self-improvement.md`
points here; do not restate the catalog elsewhere. Per class: (a) abstract
statement, (b) detection signal, (c) the mechanical control in this kit with
exact file/feature, (d) residual risk, honestly stated.

## Summary map

| # | Class | Primary mechanical control | Status |
|---|---|---|---|
| FC-1 | Brief undersizing | lifecycle schema estimate/actual/variance fields + charter variance trigger + engine ceiling formula | existing |
| FC-2 | Fabricated externals | verifier execution-grounding (engine fail-closed `commandsRun`) + WF-13 primary-source brief line | existing |
| FC-3 | Measurement artifacts | engine triple fail-closed verifier gate + QA commands/exit-code table + instantiated `verify-discipline.md` | existing |
| FC-4 | Unverified handoffs | M3 template contract (required brief output line) + verbatim failure-report paste in fix briefs | existing (contract-level) |
| FC-5 | Selective execution | Mandatory Brief Line 1: file-by-file outcome table + QA pre-pass BLOCK | existing |
| FC-6 | Owner-perspective drift | M5 two-signal DoD + `browser-access.md` + engine `e2ePass` sub-gate + owner spot-review duty (`docs/owner-contract.md`) | existing + new |
| FC-7 | Premature halt | `run-n-rounds.js` literal `for (i < N)` + charter closed halt list + chaos auto-fire | existing |
| FC-8 | Counter drift | `scripts/validate-team.sh` checks 1a-1d (continuity, dupes, second-close, counter cross-check) + atomic counter block | new + existing |
| FC-9 | Stale-state bookkeeping | Mandatory Brief Line 4 stale-finding pre-flight + validator staleness warning | existing + new |
| FC-10 | Defect-class recurrence | M6 sentinel (test/grep gate) + staffing expansion trigger (`docs/staffing.md`) | existing + new |

## FC-1 — Brief undersizing

- **Abstract:** agents estimate work by visible edit surface and systematically
  ignore investigation and verification cost; result is chronic +50–150%
  token variance and blown budgets.
- **Observed as (source project):** persistent overshoot across dozens of
  dispatches until three-driver sizing (M1) replaced surface-size estimation.
- **Detection signal:** `Variance` at lifecycle close above the charter
  threshold; three same-sign variances in the `agents/pm.md` step-10 pre-flag
  scans.
- **Mechanical control:** the lifecycle entry schema (`agents/lifecycle.md`
  Format) REQUIRES `Estimated tokens` before dispatch and harness-measured
  `Tokens` + `Variance` at close (harness rules 1-2 — an unclosable field, not
  advice); the charter variance threshold mechanically queues a Coach trigger;
  the engine's `budgetCeilingTokens` formula (`docs/engine.md`) derives loop
  ceilings from tier estimates, bounding the damage of any one misestimate;
  the per-spawn hard cap (charter table) forces splits at scoping.
- **Residual risk:** estimation itself stays judgement; bands are START values
  needing recalibration. The controls bound damage and force feedback — they
  do not make the first estimate right.

## FC-2 — Fabricated externals (APIs, packages, flags)

- **Abstract:** models confabulate plausible-but-nonexistent libraries, API
  signatures, and config options when generating outside verified knowledge;
  the fabrication is fluent and self-consistent, so downstream agents build on
  it.
- **Observed as (source project):** one fabricated package cost a 6-retry
  chain before a primary-source check became mandatory (WF-13).
- **Detection signal:** build/install failures naming unknown symbols or
  packages; a retry chain circling one external reference.
- **Mechanical control:** the execution-grounding backstop — the engine's
  fail-closed verifier gate (`docs/engine.md`) REJECTS any `pass=true` without
  actually-executed `commandsRun` at exit 0, so a fabricated dependency cannot
  survive a code-shipping gate (the build is the oracle). Upstream, the WF-13
  primary-source line is a standing brief contract (`agents/templates.md`
  Global Worker Rules).
- **Residual risk:** references that are never executed (docs text, comments,
  advice-only output) bypass the build oracle; the primary-source check itself
  is agent-executed. A runtime web-verification hook would close the gap —
  see `docs/harness-assumptions.md`.

## FC-3 — Measurement artifacts (false green)

- **Abstract:** verification signals produced against cached, stale, or
  wrong-profile state — or through pipelines that mask exit codes — read green
  without touching ground truth; the agent then reports honestly-believed
  false success.
- **Observed as (source project):** exit-code-masking pipes, cached builds,
  and a dev-profile boot that verified the wrong database.
- **Detection signal:** PASS verdicts missing the commands/exit-code table;
  warning-count claims without a clean build; green results on a
  non-production-like profile.
- **Mechanical control:** the engine verifier gate is fail-closed three ways
  (`docs/engine.md`): missing/thrown verdict → `fixRetestQueue`; `pass=true`
  without grounded `commandsRun` (all exit 0) → rejected; `pass=true` with
  `staticPass=false` or `e2ePass=false` → rejected. The QA template
  (`agents/templates.md`) makes the "Commands run | Exit code" table a
  required output. `agents/_shared/verify-discipline.md` is
  bootstrap-BLOCKING (both bootstrap docs), so clean-state/env-prefix rules
  exist as an instantiated file before the first code-shipping dispatch.
- **Residual risk:** `commandsRun` content is verifier-REPORTED; a
  hallucinating verifier defeats it (engine honesty note). The guardian
  cross-checks patterns and token deltas, not transcripts. M4 distrust still
  applies.

## FC-4 — Unverified handoffs (diagnosis contagion)

- **Abstract:** an agent inherits another agent's diagnosis as fact and
  implements against it; a wrong diagnosis propagates at full implementation
  cost (30–50K-token phantom-fix retries) because nothing forces a confirming
  probe.
- **Observed as (source project):** repeated phantom fixes built on a prior
  agent's mis-diagnosis.
- **Detection signal:** a "fix" that does not change the failure signature;
  retries citing the same inherited cause without new evidence.
- **Mechanical control:** M3 is enforced as a TEMPLATE CONTRACT, not advice:
  the `HANDOFF-HYPOTHESIS CHECK:` line (`agents/_shared/meta-rules.md` M3) is
  a required first-2K-token brief artifact, and shipping-role brief templates
  (`agents/templates.md`, e.g. Backend "Handoff-hypothesis check" section)
  demand the confirmed/mis-diagnosed report in the output. Engine fix-retest
  drain (`docs/engine.md`) pastes the verifier failure report VERBATIM into
  the fix brief — the downstream agent gets evidence, not narrative.
- **Residual risk:** the confirming probe is itself agent-run; a lazy probe
  can rubber-stamp. The ~2K-vs-30-50K cost asymmetry keeps the control
  positive-value even at partial compliance.

## FC-5 — Selective execution

- **Abstract:** given an N-item sweep, agents complete a subset (often a
  prefix), then report full completion; the omission is silent and fluent.
- **Observed as (source project):** multi-file sweep briefs silently skipping
  files while claiming done.
- **Detection signal:** claimed scope vs briefed checklist diff; absence of a
  per-item outcome table.
- **Mechanical control:** Mandatory Brief Line 1 (`agents/templates.md` ->
  Mandatory Brief Lines): any brief naming >=3 files or using sweep keywords
  MUST require the file-by-file outcome table `{path, status, rationale}`, and
  the PAIRED QA brief carries `Pre-pass check: no table -> BLOCK as incomplete
  before running anything` — a schema-shaped gate executed by a second agent.
- **Residual risk:** table rows can themselves be confabulated; QA
  spot-verifies rows rather than re-executing every one. `validate-team.sh`
  cannot see product sweeps — this control lives entirely in the
  brief/verifier pair.

## FC-6 — Owner-perspective drift

- **Abstract:** process signals (green suites, closed tickets) substitute for
  product truth; everything reads done while the flow is unusable from the
  user's seat.
- **Observed as (source project):** dev-DB boot, wrong launch profile, raw
  i18n keys rendered on screen — all behind green suites.
- **Detection signal:** M5 four-question scan (visual / auth / data path /
  performance) fails; owner spot review finds breakage the ledgers missed.
- **Mechanical control:** M5 two-signal close is wired into the charter
  Definition of Done (Signal A suites + Signal B production-like smoke);
  `agents/_shared/browser-access.md` (bootstrap-instantiated for UI projects)
  mandates real-browser rendered evidence; the E2E-ownership Mandatory Brief
  Line assigns the e2e smoke per ticket; the engine enforces the `e2ePass`
  sub-gate fail-closed.
- **Residual risk:** the process is structurally blind to what only a human
  perceives (visual quality, feel, "would I use this"). The designated
  backstop is the owner's periodic real-device spot review — a NAMED DUTY in
  `docs/owner-contract.md`, not a hope.

## FC-7 — Premature halt / author-identity trap

- **Abstract:** an agent given an explicit count/boundary re-frames it as its
  own judgement call and stops early ("diminishing returns", a worker's HALT
  verdict) — narrative authority silently overriding a directive the agent
  did not own.
- **Observed as (source project):** PM judgement-halts of count-directed loops
  short of N.
- **Detection signal:** halt reason not on the charter's closed halt list;
  iterations < N with no listed cause.
- **Mechanical control:** `.claude/workflows/run-n-rounds.js` encodes the
  count as a literal `for (i < N)` — a runtime fact no narrative can re-frame;
  the charter halt list is a CLOSED SET; any non-listed halt auto-fires the
  chaos role for halt-investigation BEFORE halting (charter + `agents/pm.md`
  Anti-Patterns); hand-run loops log the Q-gate line every cycle close.
- **Residual risk:** hand-run mode still depends on the PM honoring the
  Q-gate (prose-adjacent); the engine's inverse failure — runaway /
  failure-to-halt — is audited by the guardian node, which is post-hoc, not
  preventive.

## FC-8 — Counter drift

- **Abstract:** prose-maintained state (counters incremented inside narrative
  text) silently diverges from ground truth because nothing mechanical ever
  re-derives it.
- **Observed as (source project):** the hardening counter ran 41/25 unnoticed;
  the pre-rotation lifecycle log accumulated duplicate headers.
- **Detection signal:** structured counter vs close-line increments diverging;
  lifecycle `[NNN]` gaps, duplicates, or second `close` headers.
- **Mechanical control:** `scripts/validate-team.sh` (checks 1a-1d)
  mechanically re-derives lifecycle integrity — continuity, duplicate `[NNN]`,
  banned second-close headers, and counter-line cross-check — at every PM wake
  (step 0 in `agents/pm.md`) and via the recommended Stop-hook
  (`docs/harness-assumptions.md`). Underneath: the structured counter block in
  `memory/pm.md` is canonical, increments are atomic dual-writes, and rotation
  forces reconciliation.
- **Residual risk:** the validator re-derives lifecycle-derived counters only;
  semantic counters (e.g. `coaching_triggers_queued`) still rest on the
  dual-write discipline.

## FC-9 — Stale-state bookkeeping

- **Abstract:** agents act on recorded state (audit findings, spec docs,
  memory notes) without checking whether reality moved since it was written;
  workers re-fix fixed things and briefs cite dead criteria.
- **Observed as (source project):** briefs sourcing acceptance criteria from
  audit docs older than the last completed batch.
- **Detection signal:** workers reporting ALREADY-FIXED items; a brief citing
  a document older than the last batch with no pre-flight.
- **Mechanical control:** Mandatory Brief Line 4 (`agents/templates.md`):
  briefs sourced from an older audit/spec doc MUST embed the stale-finding
  pre-flight — 1-2 narrow greps the worker runs FIRST, marking already-fixed
  criteria and skipping them (conditional-mandatory per `agents/pm.md`
  estimation rules). `validate-team.sh` adds a mtime staleness WARNING
  (>14 days on `memory/pm.md` / `agents/lifecycle.md`) so an abandoned state
  surface is flagged before it is trusted.
- **Residual risk:** pre-flight greps are narrow by design; semantic staleness
  (a criterion that changed meaning rather than got fixed) needs the verifier
  or the owner.

## FC-10 — Defect-class recurrence

- **Abstract:** agents patch instances, not classes; the same defect class
  recurs indefinitely because nothing forces generalization from the second
  occurrence.
- **Observed as (source project):** one class of user-visible string leaks
  (raw locale keys / hardcoded literals) recurred SIX times, each patched as a
  one-off.
- **Detection signal:** second occurrence of a class in lifecycle/lessons; QA
  FAILs sharing a class signature.
- **Mechanical control:** M6's mechanical half is the SENTINEL: after the
  one-dispatch whole-codebase sweep, a test or grep gate is added so the class
  cannot silently recur (the sentinel turns recurrence into a build/verify
  failure). At the process level, `docs/staffing.md` adds the expansion
  trigger — the same defect class FAILing verification twice in one area is a
  mechanical hire signal for the specialist role. `validate-team.sh` is itself
  the sentinel set for PROCESS-defect classes (drift, counters,
  instantiation).
- **Residual risk:** sentinel creation is agent work and can be skipped under
  pressure; defect classes without a cheap test/grep signature resist
  sentinels and stay coaching-dependent.

## Update rule

New class or changed control → update THIS file (and its summary map), then
point at it — never fork the catalog into overlays or self-improvement prose.
Porting instance lessons back into the kit: `docs/backport-ritual.md`.
