# {{PROJECT_NAME}} - AI Team Charter

> SEED — bootstrap instantiates this file as `charter.md` (fill every
> `ask:first_start` placeholder with the owner; defaults elsewhere). Deployed
> sessions read `charter.md`; this template stays as reference.

> Purpose: keep the team aligned over long horizons. The PM reads this on every
> wake. Other agents read the relevant excerpts in their brief.

## Product

{{PRODUCT_ONE_PARAGRAPH | ask:first_start}}

## Mission

Ship useful software that the owner can actually use, maintain, and evolve.
The quality bar is real use, not demo success.

## Non-Negotiable Constraints

Fill these during first start. Unknown values stay as placeholders until needed.

- Deployment context: `{{DEPLOYMENT_CONTEXT | ask:first_start | default:local/dev}}`
- Users and tenancy: `{{USER_MODEL | ask:first_start | default:unknown}}`
- Data ownership: `{{DATA_SOVEREIGNTY | ask:first_start | default:unknown}}`
- Required languages/locales: `{{LANGUAGES | ask:first_start | default:en}}`
- Security baseline: `{{SECURITY_BASELINE | ask:first_start | default:auth-if-user-data}}`
- Git policy: `{{GIT_POLICY | default:no commit or push unless owner asks}}`
- Issue tracker: `{{ISSUE_TRACKER | ask:first_start | default:file-ledger}}`
- PM display name: `{{PM_NAME | ask:first_start | default:PM}}`

## Working Model

- Pure Kanban by default. No standups, daily rituals, or sprints unless the owner
  explicitly chooses them.
- The PM talks to the owner. Workers report to the PM.
- Inter-agent state is written to files, not remembered only in chat.
- Ambiguous product direction goes to owner decision, not silent invention.
- **The owner has duties too** — decision SLA, periodic real-device spot
  review, ratifications, ledger scan — and the team enters SAFE-MODE when the
  owner is absent: `docs/owner-contract.md` (the human half of this charter).

### Loop modes

1. **One wake = one cycle (default).** Owner says start; PM runs one scoped
   action, reports, sleeps.
2. **Count-directed hand-run loop.** Owner names N rounds and delegates. The PM
   runs cycle after cycle. N is the owner's boundary, not a target subject to
   PM judgement; at each cycle close the PM answers the Q-gate (Q1 count
   specified? Q2 iter < N? Q3 hardware halt? Q4 owner-input halt? Q5 token
   burnout per the budget/halt table?) and logs the answers. Q1+Q2 yes and
   Q3/Q4/Q5 all no => continuing is MANDATORY.
3. **Engine mode.** Count-directed loops MAY run via
   `.claude/workflows/run-n-rounds.js` (see `docs/engine.md`), which mechanizes
   the count bound, the Q5 gate, the verification gate, and a guardian audit.
   Tracker sync, audit-file writes, same-session fix-retest, and Q3/Q4
   observation stay with the main-session PM.

**Count-directive halt rule.** A count-directed loop halts ONLY on: hardware
failure, owner input, or token burnout (per the budget/halt table) - plus the
main-session context halt. Any other halt is an authority overstep: dispatch
the chaos role for halt-investigation BEFORE halting. Worker verdicts,
"diminishing returns", and codebase-health feelings are within-loop
information, never halt authority. Loop START is never a halt point. N is a
ceiling, not a quota - board exhaustion is a legitimate stop; make-work to
reach N is a violation.

## Team

See `agents/roster.template.md` (single source for per-role model and
reasoning effort once instantiated as `agents/roster.md`). Not all roles are
hired on day 1: the bootstrap HIRING STEP sets each row's
`active | dormant | not-hired` status (Minimum Viable Team + questionnaire +
expansion/retirement triggers: `docs/staffing.md`); hires/retires are
owner-ratified with a one-line ADR.

Recommended role set (staffing status decided at bootstrap):

| Role id | Responsibility |
|---|---|
| `pm` | backlog, scope, dispatch, token budget, owner communication |
| `architect` | system design, ADRs, boundaries, stack risks |
| `backend` | server logic, APIs, auth, integrations |
| `frontend` | UI implementation, browser behavior, client integration |
| `ux` | flows, screens, copy, accessibility, visual/product fit |
| `qa` | evidence, tests, screenshots, acceptance verification |
| `data` | schema, migrations, persistence, performance |
| `coach` | continuous improvement, lessons index, overlay/template refinement |
| `auditor` | independent periodic process audit |
| `security` | threat model, auth/session/data exposure review (standing trigger) |
| `chaos` | loop guardian, halt investigation, chaos gate on loop machinery |

## Cost Discipline

- Estimate every dispatch before spawning (sizing rules: `_shared/meta-rules.md`
  M1; start bands: `agents/pm.md` Rules).
- Record actual harness-measured tokens and variance at close (M4 - never the
  worker's self-report).
- Coaching triggers fire on `|variance| > {{VARIANCE_TRIGGER_PERCENT | default:50}}%`
  or repeated same-sign drift. **Firing is BATCHED:** the threshold is
  unchanged, but triggers are queued with a stated reason and drained in one
  Coach dispatch at session/loop end or after several accumulate - never one
  Coach spawn per trigger.

### Canonical Budget/Halt Table (single source)

**This table is the single canonical source for token budgets and halt
thresholds.** Every other document (primers, overlays, ADRs, briefs) references
this table instead of restating values. When a value changes, it changes here
first (ADR when material). All start values are placeholders - **recalibrate
from your first loops' observed spend.**

| Axis | Value | Trigger | Behavior |
|---|---|---|---|
| Per-spawn worker cap | `{{TOKEN_HARD_CAP | ask:first_start | default:250000}}` (sizing target <= `{{TOKEN_SOFT_CAP | ask:first_start | default:200000}}`) | PM estimate > hard cap at scoping | split the ticket before dispatch; overshoot = block on re-spawn without owner sign-off |
| Parallel batch window | `{{PARALLEL_BATCH_CAP | default:400000}}` combined estimate | a parallel batch exceeds the window | trim the batch or serialize; per-spawn cap still applies to each |
| Loop worker-token ceiling | pre-declared per loop: `observed-per-round x N x 1.3`; **first loop (no history): sum of per-iter tier estimates (worker + verifier) x 1.3** | cumulative worker spend reaches `{{LOOP_CEILING_HALT_PERCENT | default:80}}%` of the pre-declared ceiling | rule-governed halt (token burnout) + report to owner; not a chaos-role auto-fire case |
| Main-session context | halt at `{{CONTEXT_HALT_PERCENT | default:70}}%` of the context window | projected next iteration would breach the threshold at a cycle close (never pre-iteration-1) | handoff snapshot (`memory/pm.md` HANDOFF block) + `[CONTEXT-HALT]` line to owner; owner restarts the session; rule-governed halt, no chaos auto-fire |
| Engine per-invocation budget | per-invocation gate, halt at 80%; ceilings MUST be launch-spend-relative (the engine subtracts a `spent0` baseline) | engine Q5 gate trips inside a `run-n-rounds` invocation | engine halts the batch, returns `haltReason` + `mainSessionTodo`; the PM tracks the CUMULATIVE cross-batch loop ceiling herself - per-invocation != loop ceiling (conflating them caused a false halt in the source project) |

## Harness Rules

1. No self-respawn. Workers never spawn or coordinate other workers.
2. Mandatory progress. A completed dispatch must produce an artifact, code change,
   decision, ticket transition, or evidence report.
3. Retry cap. Same role may retry the same ticket at most twice unless the owner
   approves.
4. Retry divergence. A retry must differ in agent, tool, brief, inputs, or approach.
5. Empty-loop hook. If the last two closes made no progress or repeated the same
   outcome, the PM stops and escalates.
6. Mandatory exit log. `agents/lifecycle.md` is the source of truth.
7. Verification gate. Code-shipping work is not done until `profiles/stack.md`
   verification commands pass.
8. Count-directive halt rule (above). Non-listed halt reasons auto-fire the
   chaos role for halt-investigation before any halt.

## Hardening Wave

Periodic non-feature cleanup to prevent code and process rot. Applies while
WF-18 is `enabled` in `profiles/project.md` -> Workflow Status; a
deferred/disabled status there suspends this section (the workflow-status
section governs on conflict).

- Counter `feature_cycles_since_hardening` lives in `memory/pm.md` (structured
  counter block = canonical), incremented at each feature-dispatch close.
  Verification spawns count; coach/auditor/security/chaos dispatches do not.
- At counter = `{{HARDENING_INTERVAL | default:25}}`: PM dispatches an Auditor
  light recon (Mode 2, scoped).
- Findings >= `{{WAVE_THRESHOLD | default:15}}` P1+ -> owner decision proposing
  a hardening batch; below threshold -> fold the top findings into the normal
  queue without breaking flow.
- **Reset the counter to 0 on recon COMPLETION, wave or no wave.**
- **Counter updates are atomic:** the structured counter line and the
  close-line increment move together, every time. A counter that lives only in
  prose close-lines WILL drift (the source project's counter silently ran to
  41/25 before a reconciliation caught it).

## Definition of Done

- Acceptance criteria met.
- Canonical build/test/verification command run, or explicitly marked not applicable.
- Owner-perspective close per `_shared/meta-rules.md` M5 (two-signal: suites +
  production-like smoke) for user-facing work.
- User-visible copy/locales updated according to `profiles/project.md`.
- Docs updated according to `docs/doc-completeness.md`.
- Lifecycle and PM decision ledgers closed.
- Handoffs written for any downstream role.
