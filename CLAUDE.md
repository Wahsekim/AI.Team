# CLAUDE.md

Cold-start primer for the portable AI team. Read this first, then follow the
authoritative files linked below.

## What This Folder Is

`AI.Team/` is not product code. It is a reusable team operating system extracted
from a real-world multi-agent project (upgraded 2026-07-06 against the source
project's final state — see `docs/source-map.md`).

It can run against:

- a blank project that needs product scope, stack choice, docs, and first code;
- an existing project that needs inventory, stabilization, backlog, and disciplined
  agent dispatch.

## Templates vs Deployed Instance (read this first)

Files ending `.template.md` are SEEDS. Bootstrap instantiates each into its
operational name and fills placeholders:

| Seed | Instantiated as (what deployed sessions read) |
|---|---|
| `charter.template.md` | `charter.md` |
| `profiles/project.template.md` | `profiles/project.md` |
| `profiles/stack.template.md` | `profiles/stack.md` |
| `agents/roster.template.md` | `agents/roster.md` |
| `agents/_shared/verify-discipline.template.md` | `agents/_shared/verify-discipline.md` |
| `agents/_shared/browser-access.template.md` | `agents/_shared/browser-access.md` (UI projects) |
| `.claude/agents/role-wrapper.template.md` | `.claude/agents/<slug>-<role>.md` (one per spawnable role) — or `INLINE_BASE_AGENT_MODE.md` fallback |

**Deployed instance:** read ONLY the instantiated files; templates are
reference. If an instantiated file is missing, bootstrap is incomplete —
follow the bootstrap doc before dispatching. **Fresh kit (nothing
instantiated):** you are pre-bootstrap; start at the PM Start Protocol below.
Bootstrap also LOCALIZES this file (project name in the start phrase,
deployment date) so a second cold session is routed at the instantiated set.

## Authority Map

Instantiated names; pre-bootstrap, the `.template.md` seed stands in.

| Surface | Purpose | Default owner |
|---|---|---|
| `charter.md` | constitution, loop modes, canonical budget/halt table | human owner |
| `profiles/project.md` | project facts and placeholders | PM + owner |
| `profiles/stack.md` | stack conventions, commands, brief adapter blocks | Architect + PM |
| `agents/pm.md` | persistent PM loop + tier bands (single source) | PM |
| `agents/roster.md` | team roles; models/reasoning (single source) | owner + PM |
| `agents/_shared/meta-rules.md` | standing meta-rules M1-M6 | Coach |
| `agents/_shared/verify-discipline.md` + `browser-access.md` | verification + browser disciplines | Architect + PM |
| `agents/templates.md` | per-role brief templates | Coach |
| `agents/lifecycle.md` | append-only spawn log (counter rules) | PM |
| `pm-decisions.md` | terse PM dispatch ledger | PM |
| `memory/pm.md` | PM state, atomic counters, next-wake notes | PM |
| `agents/lessons.md` | one-line lessons index (Coach curates) | Coach |
| `agents/self-improvement.md` | coaching/audit loops (catalog: `docs/failure-classes.md`) | Coach + Auditor |
| `docs/failure-classes.md` | canonical failure-class catalog + mechanical controls | Coach + Auditor |
| `scripts/validate-team.sh` | mechanical integrity checker (PM wake step 0, bootstrap gate; `--mode deployment` on deployed instances) | PM |
| `scripts/check-claude-compat.sh` | runtime version + wrapper-frontmatter gate (pre-bootstrap) | PM |
| `scripts/bootstrap-team.sh` | idempotent template instantiation (mechanical half of bootstrap) | PM |
| `scripts/measure-context.sh` + `docs/context-budget.md` | cold-start context ratchet | PM + Coach |
| `tests/` (`node --test tests/*.test.mjs`) | fault-injection suite for engine, validator, compat gate, watchdog | PM + Auditor |
| `docs/staffing.md` | hiring step, MVT, expansion/retirement triggers | Coach proposes, owner ratifies |
| `docs/harness-assumptions.md` | runtime contract, degradation table, deployment hooks | PM |
| `docs/owner-contract.md` | owner duties + SAFE-MODE (human half of the charter) | human owner |
| `docs/backport-ritual.md` | instance-lesson → template porting ritual | human owner |
| `.claude/workflows/run-n-rounds.js` + `docs/engine.md` | count-directed loop engine + contract | PM |
| `decisions/` | ADRs and decision history | owner-ratified |
| `docs/process-index.md` | map of process surfaces + rotation regime | PM |
| `docs/workflow-catalog.md` | portable workflow inventory | PM + Auditor |

Conflicts resolve upward:

```text
human owner / charter
  -> ADRs
  -> profiles/project.md + profiles/stack.md
  -> roster + _shared rules + agent overlays + templates
  -> lifecycle / lessons / memory logs
```

Single-source values (never restate — `agents/_shared/README.md`): models and
reasoning live ONLY in the roster; tier bands ONLY in `agents/pm.md` Rules;
budget/halt axes ONLY in the charter table.

## PM Start Protocol

When the owner says `start {{PROJECT_NAME | localized at bootstrap}}` or
`start team`:

0. Run `scripts/validate-team.sh .` (from this folder) — investigate any FAIL
   before anything else; SKIPs are normal pre-bootstrap.
1. Read `profiles/project.md` if present, otherwise initialize from
   `profiles/project.template.md`.
2. Read `profiles/stack.md` if present, otherwise run the lazy stack discovery
   protocol in `profiles/stack.template.md`.
3. Read `charter.md` (if missing: bootstrap is incomplete — instantiate from
   `charter.template.md` per the bootstrap doc).
4. Read `agents/pm.md`, `agents/_shared/meta-rules.md`,
   `docs/workflow-catalog.md`, `agents/lifecycle.md` last 10 entries,
   `pm-decisions.md` last 20 lines, `memory/pm.md` counters + last blocks,
   and the `agents/lessons.md` index (index-only — never full archives).
5. If this is a blank project, follow `docs/bootstrap-empty-project.md`.
6. If this is an existing project, follow `docs/bootstrap-existing-project.md`.
   Both bootstrap paths include the HIRING STEP (`docs/staffing.md`) before
   wrapper instantiation, and end with `scripts/validate-team.sh` exiting 0.
   The owner's side of the contract (decision SLA, spot review, SAFE-MODE):
   `docs/owner-contract.md`.
7. Run one cycle only, report, and sleep — unless the owner delegated a
   count-directed loop (charter loop modes; engine contract in `docs/engine.md`).

## Hard Rules

- The PM is the persistent main session. Workers are ephemeral.
- Workers do not spawn workers. Only the PM dispatches.
- Workers do not use external service MCPs unless the project explicitly permits it;
  ticket sync belongs to the PM. No MCP calls inside autonomous loops.
- PM must dispatch active worker roles through named project-scoped wrappers
  when the runtime supports them; all-purpose dispatch is a bootstrap failure
  unless wrapper mode is unavailable and inline fallback is logged.
- Every dispatch gets a lifecycle entry with estimated tokens before work starts.
- Every close gets actual harness-measured tokens, variance, outcome, progress,
  and handoffs (M4: never trust self-report).
- Enabled workflows in `docs/workflow-catalog.md` must have matching role files
  and evidence surfaces before product workers are dispatched.
- A code-shipping change is not done until the configured verification gate passes;
  user-facing work also needs the M5 owner-perspective close.
- Count-directed loops halt ONLY per the charter halt list; any other halt
  fires the chaos role for halt-investigation first.
- Engine-mode loops: paste the engine's emitted log blocks VERBATIM
  (`docs/engine.md`); manual re-derivation is banned.
- Do not commit, push, deploy, or publish unless the owner explicitly asks.
- Preserve append-only logs; rotate per the rotation regime
  (`docs/process-index.md`); supersede with dated entries instead of rewriting
  history.

## Lazy Placeholders

If a placeholder is unresolved and blocks work, ask the owner once, then write the
answer into `profiles/project.md` or `profiles/stack.md` (or the placeholder's
single-source home — `docs/lazy-placeholders.md`).

If a stack convention, library API, or methodology convention needs up-to-date
external knowledge, ask whether to search the web. When searching later, prefer
official documentation, package registries, and primary sources.

## Claude Integration

This template preserves the source project's pattern of:

- a root `CLAUDE.md` cold-start index;
- `.claude/agents/` project-scoped wrappers;
- `.claude/workflows/` for the count-directed loop engine;
- agent overlays pointing at project profiles and templates;
- watchdog hooks for long unattended sessions.

See `docs/claude-integration.md`.
