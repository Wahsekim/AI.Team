# Documentation Completeness

This file defines what "docs are complete enough" means. It preserves the
source-project discipline of keeping user docs, technical docs, process docs, decisions,
audits, and self-improvement logs as separate surfaces.

## Product Documentation

| Surface | Required for blank project | Required for existing project | Owner |
|---|---:|---:|---|
| `README.md` | yes | yes | PM/Architect |
| `docs/USAGE.md` | before first user delivery | if product is runnable | PM/UX/QA |
| `docs/technical.md` | after stack lock | yes | Architect |
| `docs/functional.md` | after first feature map | yes | PM/UX |
| `docs/specs/` | when feature specs exist | if local convention exists | UX/PM |
| `docs/qa/` or `docs/audits/` | after verification begins | yes | QA/Auditor |
| screenshots/video evidence | for UI-affecting work | for UI-affecting work | QA/UX |

## Team Documentation

| Surface | Purpose |
|---|---|
| `AI.Team/CLAUDE.md` | cold-start index |
| `AI.Team/charter.md` (seed: `charter.template.md`) | constitution + canonical budget/halt table |
| `AI.Team/profiles/project.md` | project-specific facts |
| `AI.Team/profiles/stack.md` | stack-specific rules and commands |
| `AI.Team/docs/process-index.md` | where every process surface lives + rotation regime |
| `AI.Team/agents/roster.md` (seed: `roster.template.md`) | team role ledger (single source for models/reasoning) |
| `AI.Team/agents/_shared/` | meta-rules M1-M6 + verify/browser discipline |
| `AI.Team/agents/lifecycle.md` | append-only dispatch history |
| `AI.Team/pm-decisions.md` | PM decision ledger |
| `AI.Team/memory/pm.md` | PM state, counters, next-wake notes |
| `AI.Team/agents/lessons.md` | one-line lessons index (archives hold history) |
| `AI.Team/docs/engine.md` | count-directed loop engine contract |
| `AI.Team/decisions/README.md` | ADR index |

## Completeness Gate Per Ticket

Before closing a ticket, answer:

1. Did this change affect user behavior? Update user docs.
2. Did this change affect architecture, commands, dependencies, or deployment?
   Update technical docs or stack profile.
3. Did this change create or revise a policy? Write an ADR.
4. Did this change teach the team something reusable? Append a lesson.
5. Did this change expose a process gap? Trigger Coach or Auditor.
6. Did this change affect UI? Attach rendered evidence.

## Anti-Duplication Rule

Do not copy the same explanation into every file.

- Lifecycle = full close artifact.
- PM decisions = terse dispatch/close ledger.
- Memory = delta and next-wake context.
- ADR = why a decision was made.
- Technical docs = current state.
- Lessons = how team behavior changes next time.

