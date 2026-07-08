# Source Map From the Original Project

This file records what was preserved from the original team system and
where it landed in the portable template. **Provenance-only:** it has no
operational role in a deployment — safe to delete (or ignore) in deployed
instances; no other kit file depends on it.

**Provenance:** extracted 2026-05-19; **upgraded 2026-07-06 against the source workspace
state as of 2026-07-06** — charter v6.1 (canonical budget/halt table, loop
modes, batched coaching), the 2026-07-03 lessons/overlay consolidation
(`_shared/` + meta-rules M1-M6 + slim-active/archive rotation), ADR 0049
(halt rule + guardian scope) and ADR 0050 (`run-n-rounds` engine, incl. the
2026-07-03 spent0/budget-semantics amendment), auditor Mode-1 retirement,
security-role standing trigger, and the guardian polarity-flip.

| Source surface | Portable destination | Preserved capability |
|---|---|---|
| `README.md` | `README.md` | project map and start points |
| `CLAUDE.md` | `CLAUDE.md`, `docs/claude-integration.md` | cold-start index and hard rules |
| `charter.md` (v6.1) | `charter.template.md` | constitution, budget/halt table, loop modes, hardening wave, harness rules |
| source PM overlay | `agents/pm.md` | persistent PM loop, tier calibration, engine reconciliation, anti-patterns |
| `agents/roster.md` | `agents/roster.template.md` | stable role ledger; single source for models/reasoning |
| `agents/templates.md` | `agents/templates.md` | reusable brief scaffolding |
| `agents/_shared/meta-rules.md` | `agents/_shared/meta-rules.md` | M1-M6 standing meta-rules |
| `agents/_shared/verify-discipline.md` | `agents/_shared/verify-discipline.template.md` | clean-state verification discipline (stack values -> placeholders) |
| `agents/_shared/browser-access.md` | `agents/_shared/browser-access.template.md` | real-browser UI verification mandate (origins/viewports -> placeholders) |
| `agents/lifecycle.md` | `agents/lifecycle.md` | append-only spawn audit + counter rules + engine BATCH format |
| `pm-decisions.md` | `pm-decisions.md` | terse PM ledger |
| `memory/pm.md` | `memory/pm.md` | self-summary, atomic counters, next-wake memory |
| `agents/lessons.md` (index regime) | `agents/lessons.md` | one-line lessons index + archive rotation |
| source coach overlay | `agents/coach.md`, `agents/self-improvement.md` | coach loop, lessons-index consolidation authority |
| source auditor overlay | `agents/auditor.md`, `agents/self-improvement.md` | Mode-2 periodic audit, meta:product KPI, primer-drift check |
| source security overlay | `agents/security.md` | standing auth/session trigger, ADR value-pinning mandate |
| source chaos/guardian overlay | `agents/chaos.md` | guardian verify-node, halt investigation, chaos gate, harness constraints |
| `.claude/workflows/run-n-rounds.js` (ADR 0050) | `.claude/workflows/run-n-rounds.js`, `docs/engine.md` | count-directed loop engine + contract |
| charter/overlays/ADRs 0049-0050 | `docs/workflow-catalog.md` (incl. WF-31) | portable workflow inventory |
| `decisions/` | `decisions/` | ADR discipline |
| `docs/team-process.md` | `docs/process-index.md` | process surface index + rotation regime |
| `.claude/agents/` | `.claude/agents/` | project-scoped Claude agent wrappers |
| `scripts/watchdog/` | `scripts/watchdog/` | heartbeat and hang detection |
| recurring failure history (lessons archive) | `docs/failure-classes.md` (via `agents/self-improvement.md`) | distilled failure-class catalog + mechanical controls (watch from day 1) |

Stack-specific source-project rules were not deleted; they were isolated into
`profiles/stack-profiles/aspnet-razor-htmx.md` as an example adapter.
