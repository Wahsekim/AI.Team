# Bootstrap Existing Project

Use this path when product code already exists. (Blank repo:
`docs/bootstrap-empty-project.md` — alternate path, not both.)

## Goal

Inventory the codebase before changing it. The first cycle should produce a
reliable map, not a speculative rewrite plan.

Instantiation principle: files ending `.template.md` are SEEDS. Bootstrap
copies each into its instantiated name and fills placeholders; deployed
sessions read only the instantiated files (`CLAUDE.md` -> "Templates vs
deployed instance").

## Local Inventory

Mechanical instantiation shortcut first: `scripts/bootstrap-team.sh
--project-name <name> --product-repo <path> [--ui] .` copies every seed to
its operational name (idempotent, never overwrites); the interview below then
only fills the remaining `ask:first_start` placeholders.

The PM or Architect scans:

- top-level tree and package manifests;
- build, test, lint, format, typecheck commands;
- CI or deployment files;
- `README`, `CLAUDE.md`, `AGENTS.md`, docs, ADRs;
- source directories and module boundaries;
- test folders and coverage shape;
- known generated artifacts or build outputs to ignore;
- current git status, without reverting unrelated changes.

## First Output

Create or update:

- **`charter.md` from `charter.template.md`** — the constitution; fill every
  `ask:first_start` placeholder with the owner, defaults elsewhere (budget/halt
  table starts on defaults, marked for recalibration)
- `profiles/project.md` (including `product_repo_path`, project slug, tracker
  adapter fields, and the Workflow Status section — status there GOVERNS
  charter rules that depend on a workflow, e.g. the hardening counter runs
  only while WF-18 is enabled)
- `profiles/stack.md`
- **HIRING STEP (before wrapper instantiation):** run the staffing
  questionnaire in `docs/staffing.md` with the owner (the codebase inventory
  answers most questions — UI? DB? auth/payments? toolchains?). Default =
  Minimum Viable Team; set each roster row's Status
  (`active | dormant | not-hired`) and record the outcome in the attach ADR
- `agents/roster.md` (Model + Reasoning columns filled — single source; see
  the model-tier guidance in `agents/roster.template.md`; Status column per
  the hiring step)
- one role file per ACTIVE role at `agents/<role_id>.md`
- **the dispatch path (BLOCKING):** one `.claude/agents/<project>-<role>.md`
  wrapper for each ACTIVE roster row (only active rows get wrappers —
  `docs/staffing.md`) from `role-wrapper.template.md` (model/reasoning
  copied from the roster) — OR, only if the runtime cannot install wrappers,
  `INLINE_BASE_AGENT_MODE.md` from its template, noted in the roster. Fill the
  roster wrapper column with paths that actually exist
- **`agents/_shared/verify-discipline.md`** from its `.template.md`, filled
  from the discovered stack (env prefix — record `none` explicitly if the
  stack has none — ports, launch profiles) — and
  `agents/_shared/browser-access.md` if the product has a UI (BLOCKING for
  the first code-shipping dispatch)
- rotation-regime surfaces initialized from seeds: `agents/lifecycle.md`,
  `agents/lessons.md` (empty index), `pm-decisions.md`, `messages/`, and
  `memory/pm.md` — replace the seed's placeholder block with a real dated
  attach-note block
- localized `CLAUDE.md` (project name in the start phrase; Authority Map
  filenames resolve to instantiated files)
- workflow status recorded (including WF-31 engine mode if count-directed
  loops are expected — see `docs/engine.md`)
- `docs/doc-completeness.md` status table
- `docs/process-index.md` pointers to real product docs
- first ADR: "AI team attached to existing project" (indexed in
  `decisions/README.md`; never cite an ADR number that does not exist)
- first audit note in `memory/pm.md` listing the paths actually verified —
  never a "Verified" claim pointing at a nonexistent artifact

## Base Agent Resolution

Before dispatching any worker (ACTIVE roster rows only — non-active roles
resolve their base agent at hire time):

1. Choose a base agent source for each active role from the base-agent library
   (`{{BASE_AGENT_ROOT}}`) when one exists ON THIS MACHINE.
2. Write that source into the role's `agents/<role_id>.md` file.
3. Verify the base file exists locally.
4. If no library exists on this machine, or no base agent fits, mark the role
   `synthetic` and keep the persona in the role file + templates — synthetic
   is a first-class mode; do not block on a missing library.
5. Ensure workflow-triggered roles exist as real files: `coach`, `auditor`, and
   `chaos` when enabled.
6. Create or verify project-scoped wrappers with role-specific model, reasoning
   effort, and token budget. Do not default active roles to all-purpose workers.
7. Verify enabled workflows have evidence surfaces in lifecycle, PM decisions,
   memory, lessons, ADRs, docs, or tracker fields.

This step is required for existing projects because a copied roster table is not
enough. The deployed team must be dispatchable from files.

## Existing Project Safety Rules

- Do not modify code during inventory unless the owner explicitly asks.
- Do not normalize style until conventions are discovered.
- Do not introduce new libraries before checking existing dependencies and official docs.
- Prefer the repo's current architecture over a new abstraction.
- Preserve user or previous-agent changes in the worktree.
- If tests fail at baseline, record the failure as baseline; do not hide it.

## Suggested First Tickets

1. Architect: architecture map and risk register.
2. QA: baseline verification command matrix.
3. PM: doc completeness gap analysis.
4. Coach: extract project-specific rules from observed failures.
5. Auditor: review PM/agent setup after 5-10 lifecycle entries.

## Existing Project Done

The attach phase is done when:

- `charter.md` exists with first-start placeholders resolved and `CLAUDE.md`
  is localized;
- stack profile is locked enough to dispatch workers;
- `_shared/verify-discipline.md` (and `browser-access.md` if UI) instantiated;
- every active role has a role file and base-agent resolution;
- the dispatch path exists as real files: per-role wrappers OR
  `INLINE_BASE_AGENT_MODE.md`;
- every enabled workflow has a status and required role files;
- commands are known or marked unknown with reason;
- doc gaps are explicit;
- backlog has small tickets ordered by risk and dependency;
- the hiring step ran: roster Status column set per `docs/staffing.md`,
  outcome recorded in the attach ADR;
- `scripts/validate-team.sh <deployment root>` exits 0 (SKIPs allowed; any
  FAIL means the attach phase is not done);
- the PM can tell which agent should own a change without re-scanning the whole repo.
