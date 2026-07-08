# Bootstrap Empty Project

Use this path when there is no product code yet. (Attaching to code that
already exists: `docs/bootstrap-existing-project.md` — alternate path, not
both.)

## Goal

Create enough product definition, stack direction, docs, tickets, and first
verification path that the team can start shipping small vertical slices.

Instantiation principle: files ending `.template.md` are SEEDS. Bootstrap
copies each into its instantiated name and fills placeholders; deployed
sessions read only the instantiated files (`CLAUDE.md` -> "Templates vs
deployed instance").

## PM First Cycle

1. Create `profiles/project.md` from `profiles/project.template.md`.
2. Ask first-start placeholders from `docs/lazy-placeholders.md` (includes
   project slug, per-role model tiers, and base-agent library location).
3. **Create `charter.md` from `charter.template.md`** — this is the
   constitution the PM loop depends on. Fill every `ask:first_start`
   placeholder (owner answers); leave genuinely-unknown values as placeholders
   with their `default:`. The budget/halt table starts on defaults, marked for
   recalibration. Templates stay untouched as reference.
4. Read `docs/workflow-catalog.md` and record each workflow's status
   (enabled / deferred / profile-bound / disabled) in the Workflow Status
   section of `profiles/project.md`. Status there GOVERNS: a deferred/disabled
   workflow suspends the charter rules that depend on it (e.g. the hardening
   counter runs only while WF-18 is enabled).
5. Ask whether the owner wants a stack chosen now or after a short architecture
   spike. Create `profiles/stack.md` from `profiles/stack.template.md`
   (`status: unresolved` until locked).
6. **Create the product repo** at the `product_repo_path` recorded in
   `profiles/project.md`. Creating the empty directory / `git init` /
   placeholder README is team-ops the PM may do directly (if git is
   unavailable or barred for the session, defer `git init` as an explicit
   owner-handoff line — do not block bootstrap on it); the runnable
   skeleton itself is a WORKER ticket (see First Tickets — the PM never writes
   product code). Then create minimal product docs in it:
   - `README.md`
   - `docs/USAGE.md`
   - `docs/technical.md`
   - `docs/functional.md`
7. Write the first ADRs in `decisions/` and index them in
   `decisions/README.md`:
   - project operating model;
   - issue tracker source of truth (+ tracker adapter choice, see
     `methodologies/kanban.md`);
   - stack choice or stack-spike plan;
   - documentation completeness policy.
   Profiles hold the VALUES; ADRs hold the WHY. Recording a choice only in a
   profile does not discharge this step. Never cite an ADR number that does
   not exist in `decisions/`.
8. **HIRING STEP (before any wrapper is instantiated).** Run the staffing
   questionnaire in `docs/staffing.md` with the owner. Default = Minimum
   Viable Team (PM + 1 builder + 1 verifier); questionnaire answers promote
   additional roles to `active` NOW, everything else stays `dormant` /
   `not-hired`. Record the outcome in the bootstrap ADR (one line per
   non-default status). Then create `agents/roster.md` (Model + Reasoning
   columns filled — single source; model-tier guidance in
   `agents/roster.template.md`) with the Status column set per the hiring
   step, and one `agents/<role_id>.md` file per ACTIVE role (non-active
   roles get their role file at hire time).
9. Resolve base agents: if a base-agent library exists at the
   `{{BASE_AGENT_ROOT}}` the owner named, verify each path on THIS machine;
   if the library is absent, mark ALL roles `synthetic` (the role file +
   templates carry the persona) — synthetic is a first-class mode, not a
   degradation. Do not block on a missing library.
10. **Instantiate the dispatch path (BLOCKING — dispatch is impossible without
    it).** Default: create one `.claude/agents/<project>-<role>.md` wrapper
    for each ACTIVE roster row (only active rows get wrappers —
    `docs/staffing.md`) from `.claude/agents/role-wrapper.template.md`,
    copying model/reasoning from the roster and setting token budget.
    Documented fallback (only if the runtime cannot install wrappers): copy
    `.claude/agents/INLINE_BASE_AGENT_MODE.template.md` to
    `INLINE_BASE_AGENT_MODE.md` and note inline mode in `agents/roster.md`.
    One of the two MUST exist as real files before any dispatch. Fill the
    roster's wrapper column with the paths you actually created — never with
    paths that do not exist.
11. **Instantiate the shared discipline files (BLOCKING once the stack is
    locked).** Create `agents/_shared/verify-discipline.md` from its
    `.template.md`, filled from `profiles/stack.md` (env prefix — record
    `none` explicitly if the stack has none — ports, launch profiles, clean
    build commands). If the product has a UI, also create
    `agents/_shared/browser-access.md` (tool, whitelist, viewports, smoke
    credential). `_shared/meta-rules.md` applies as-is from day 1. PM cycle
    step 6 (fold `_shared/` excerpts) is unexecutable until this is done.
12. **Localize `CLAUDE.md`:** fill the project name into the start phrase,
    confirm every Authority Map filename now resolves to an instantiated file,
    and note the deployment date. A cold second session reads `CLAUDE.md`
    first — if it still describes the un-instantiated kit, every later step
    re-breaks.
13. Initialize the rotation-regime surfaces from their seeds:
    `agents/lifecycle.md` (counter at 001), `agents/lessons.md` (empty index),
    `pm-decisions.md`, `messages/`, and `memory/pm.md` — REPLACE the memory
    seed's placeholder block with a real dated cycle-001 block (real date,
    real open threads); never leave `YYYY-MM-DD` or already-resolved threads
    in place.
14. If count-directed loops are expected, verify the workflow runtime can run
    `.claude/workflows/run-n-rounds.js` and read `docs/engine.md`.
15. Record the bootstrap-validation result in `memory/pm.md` (bootstrap note):
    list the paths actually verified. Never write a "Verified" claim that
    points at a file or log that does not exist.
16. Seed the backlog with 5-10 thin, ordered tickets.

## Recommended First Tickets

1. Architect: confirm/lock stack from owner constraints, write ADR.
2. Backend (or Architect): scaffold the product repo skeleton — the runnable
   first slice the PM may not write herself.
3. Data/Backend: choose persistence and migration strategy.
4. Security/Backend: choose auth/session baseline if user data exists.
5. UX: first three screens or flows.
6. QA: verify scaffold with real build/test/run evidence.
7. PM: update docs and close bootstrap state.
8. PM: verify `coach`, `auditor`, and `chaos` role files exist if their workflow
   triggers are enabled.

## Empty Project Done

The bootstrap is done when:

- `charter.md` exists with first-start placeholders resolved;
- `CLAUDE.md` is localized (authority map resolves to instantiated files);
- stack profile is locked or an explicit spike is open;
- product repo exists at `product_repo_path` with a runnable skeleton or a
  documented first-slice plan;
- docs completeness checklist exists;
- every active role has a role file and base-agent resolution (library
  verified on this machine, or synthetic);
- the dispatch path exists as real files: per-role wrappers OR
  `INLINE_BASE_AGENT_MODE.md`;
- the four first ADRs exist and are indexed in `decisions/README.md`;
- enabled workflows have required role files and evidence surfaces;
- `_shared/verify-discipline.md` (and `browser-access.md` if UI) instantiated;
- lifecycle, PM decisions, memory (real cycle-001 block), messages, and the
  lessons index are initialized per the rotation regime;
- the hiring step ran: roster Status column set per `docs/staffing.md`
  questionnaire, outcome recorded in the bootstrap ADR;
- `scripts/validate-team.sh <deployment root>` exits 0 (SKIPs allowed; any
  FAIL means bootstrap is not done);
- next PM cycle can pull a concrete ticket without asking "what is this project?"
