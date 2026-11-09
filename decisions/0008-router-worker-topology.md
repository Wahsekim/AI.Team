# ADR 0008: Optional Router/Worker topology

Date: 2026-11-09
Status: Accepted — topology equivalence and retry mapping only; live activation remains gated

## Context

The owner requested an optional task-oriented team alongside the existing
specialist topology, retaining all harness rules. PM remains the main session
and sole committer. Changing topology must not silently remove verification,
guardian, security, staffing or accounting obligations.

## Decision

1. Keep specialist deployment and its existing entry points unchanged. Add a
   separate explicit `router-worker` drafting path; first release is attended,
   serial and named-wrapper based. It does not activate Loop/Graph live execution.
2. Map bounded implementation to `worker-exec`, independent verification to
   `worker-check`, and guardian/chaos obligations to `worker-guard`. These are
   owner-ratified responsibility mappings for the optional Router/Worker mode's
   named QA/Chaos requirements. The general worker protocol may use reviewed
   methods; methods cannot grant tools or spawn privileges.
3. Preserve Architect, Coach, Auditor and Security sources and triggers. The
   initial draft does not claim their runtime staffing is complete. Enabled
   workflows with missing appointments, methods or independent permissions block
   activation. Dormant placeholders in an inert draft are not a waiver.
4. Preserve stable ticket/duty retry accounting, original round-trip and empty-
   loop stops, count/Q gates, same-session repair discipline and lifecycle logs.
   Count by stable ticket + duty: one initial attempt and at most two retries,
   with no reset by model, method, wrapper or instance changes. Owner accepted
   that combining specialist roles may reduce total retry opportunities. Original
   round-trip, empty-loop, budget and security stops still take precedence.
5. Keep original budget units, measured-versus-self-report distinction, batched
   Coach and independent periodic Auditor. No model/effort defaults are invented;
   generated wrappers copy the explicitly proposed roster values.
6. Offline artifacts are non-launchable. A draft is JSON data, never an installed
   wrapper registry. Local hash consistency does not establish human approval,
   actual runtime isolation or functional quality.

## Alternatives

- Replace the specialist team: rejected by the owner's coexistence requirement.
- Add a generalist to the old roster without a distinct mode: not selected for
  this experiment because it mixes the comparison's task-routing variables.
- Add another paid routing agent: unnecessary; the PM already owns dispatch and
  is accountable for scope, budgets and decisions.
- Remove QA/Chaos or make the author self-verify: incompatible with retained
  harness obligations.

## Consequences

The new mode can be developed and tested without changing deployed teams.
Compatibility suites remain relevant. Offline success cannot be labelled rollout
completion. A fresh trial still needs a real project/stack, runtime capability
evidence, an approved responsibility map and an owner-authorized spending limit.

Migration, concurrent workers, automatic upstream skill adoption, commits by
workers/bots and automatic publishing remain outside this decision.

## Ratification checklist

- [x] Owner accepts exec/check/guard equivalence, preserving all governance rules.
- [x] Owner accepts stable duty retry counting and understands its scope change.
- [ ] Concrete governance staffing and sensitive-change triggers are covered.
- [ ] Trial project, permission boundaries, context limits and paid-run cap approved.
- [ ] Runtime smoke and independent functional/pairing evidence collected.

Owner ratification was received in this task on 2026-11-09 for the two checked
items only. It does not authorize paid calls, live execution, deployment or
publication. Project-specific coverage and staffing must still be demonstrated.

Until the remaining gates are met, tooling must continue to report non-launchable
status. This ADR defines optional topology equivalence; it does not waive charter,
staffing, independent verification or governance requirements in either mode.
