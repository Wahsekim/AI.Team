# Self-Improvement Loop

This file preserves the team's ability to summarize itself, learn from
failures, update prompts/templates, and periodically audit the PM. Standing
meta-rules distilled from the source project live in
`agents/_shared/meta-rules.md` (M1-M6) — read those first.

## Failure-Class Catalog (watch for these from day 1)

**The canonical catalog lives in `docs/failure-classes.md`** — ten
MODEL-level failure classes (they recur across projects and stacks because
they come from how LLM agents behave), each with its abstract statement,
detection signal, the MECHANICAL control in this kit (engine gate, schema
field, validator check, template contract), and residual risk. Concrete
source-project incidents appear there as "observed as" one-liners.

Do not restate the catalog here or in overlays; point at it. Working rules:

- Ship the mechanical control before the failure, not after — every class
  recurred in the source project until a STRUCTURAL rule (not prose) killed
  it.
- New failure observed → check the catalog first: an instance of an existing
  class strengthens that class's control; a genuinely new class extends
  `docs/failure-classes.md` (and its summary map) via the rule-promotion path
  below.
- `scripts/validate-team.sh` mechanically re-derives the process-integrity
  classes (counter drift, single-source drift, instantiation drift) at every
  PM wake — a FAIL there is failure-class evidence, treat it as such.

## Coach Loop

The Coach is event-triggered, not calendar-triggered.

Triggers are QUEUED with a stated reason and drained BATCHED — one Coach
dispatch at session/loop end or after several accumulate (per charter):

- 10 new lifecycle entries since last coaching note;
- any harness-rule violation;
- `|estimated - actual| / estimated` above the charter variance threshold;
- three same-sign variances for one role;
- owner request;
- empty-loop hook fired and owner unblocked it.

Coach reads: `agents/lifecycle.md` recent entries, `pm-decisions.md`,
`agents/lessons.md` index, affected role overlays/templates, recent
`memory/pm.md` blocks.

Coach outputs:

1. KPI summary: count, success rate, mean variance, repeated failures.
2. One index line per new lesson + the operational rule landed in the owning
   overlay / `_shared/` file (regime in `agents/coach.md`).
3. Template/overlay changes when a lesson needs structural enforcement.
4. Consolidation: recurring lesson families folded into meta-rules or band
   rows; index lines re-statused.
5. Member (hire/retire) proposal only if supported by at least two lifecycle
   entries or a fired `docs/staffing.md` trigger (Recruiter mission —
   `agents/coach.md`); owner ratifies.

## Auditor Loop (Mode 2 — periodic only)

Independent review, not loyal to PM or Coach. Per-PR code review is retired
(never used in the source project; the QA gate covers per-change review).

Runs on: hardening counter threshold, owner request, major ADR cluster,
repeated unresolved drift. Checklist (full version in `agents/auditor.md`)
includes the **meta:product token-ratio KPI (flag > 0.5)** and the
**primer-vs-charter drift check**. Output starts with findings, ordered by
severity, GREEN/AMBER/RED.

## Chaos / Guardian Loop

The chaos role guards the loop machinery (see `agents/chaos.md`):

- **guardian verify-node** on every engine batch (runaway / missed-halt /
  budget-gate / dropped fix-retests);
- **halt-investigation** auto-fired before any non-listed halt of a
  count-directed loop;
- **chaos gate**: injected-failure tests before trusting new/changed loop
  machinery.

Note: deterministic stall SIMULATION was proven unreachable on this harness
class — do not rebuild it; real-stall recovery is proven by production
incidents (details in `agents/chaos.md` Harness constraints).

## PM Self-Summary

At the end of each cycle, PM appends to `memory/pm.md`: current state,
surprises, open threads, counters (atomically), what the next wake should
inspect first. This is the continuity surface across context resets.

## Rule Promotion Path

```text
failure or drift observed
  -> lifecycle evidence
  -> lessons index line + rule in owning overlay/_shared file
  -> template/overlay change if structural
  -> meta-rule when a family recurs (Coach consolidation)
  -> failure-class catalog update if a NEW class (docs/failure-classes.md)
  -> mechanical control (validator check / engine gate / template contract)
     when the class needs harness-level enforcement
  -> chaos test if recovery behavior must be proven
  -> ADR if governance or project policy changed
  -> process-index update only if a new surface exists
  -> template back-port when the lesson is model-level (docs/backport-ritual.md)
```

## Anti-Pattern

Do not solve agent mistakes by renaming the agent. First improve: brief shape;
template gates; stack profile; verification command; token tier; role
boundary.
