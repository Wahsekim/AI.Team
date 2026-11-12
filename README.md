# AI.Team - Portable Multi-Agent Team Template

> **Status: Engineering Alpha.**
> Validated: deterministic mock/fault-injection suite (`tests/`) + macOS/Linux
> CI (Node 22/24, ShellCheck, full-history secret scan).
> NOT yet validated: real-Claude end-to-end runs, unattended operation on
> private code. Open owner decisions: permission manifest, retention/TTL,
> branch rules, first release.
> Use for attended, low-sensitivity, rollback-able pilots only — see
> `SECURITY.md` and `docs/harness-assumptions.md` for the boundaries.

> "Portable" means the TEAM is portable across projects (drop the kit next to
> any product repo and bootstrap) — not portable across agent runtimes. The
> kit targets **Claude Code only** (>= 2.1.154); other runtimes are out of
> scope unless a future ADR says otherwise.

A reusable **team operating system for [Claude Code](https://claude.com/claude-code)**:
one persistent PM session orchestrating a roster of specialist AI agents
(architect, backend, frontend, UX, QA, data, security, coach, auditor, chaos)
to run a software project end to end — product scope, tickets, implementation,
verification, audits, and self-improvement — with a human owner in the loop
for decisions only.

It is the distilled, project-neutral version of a multi-agent team system that
ran a real product for ~3 months. The governance that made it survive is
included: a constitution (charter) with hard budget/halt rules, append-only
audit ledgers, a mechanical loop engine for unattended runs, a curated
failure-class catalog, and validation scripts.

It works against either:

1. **Empty project mode** - no codebase exists yet; the PM bootstraps product scope,
   stack choice, docs, tickets, and first implementation slices.
2. **Existing project mode** - a codebase already exists; the PM first inventories
   repo structure, current docs, conventions, tests, risks, and open work before
   dispatching agents.

## Requirements

- **Claude Code >= 2.1.154** (tested against 2.1.x, July 2026) with the
  Workflow tool (Dynamic Workflows require 2.1.154+), project-scoped subagent
  registry (`.claude/agents/`), hooks, and background agent dispatch. Check
  yours with `claude --version`. Every missing primitive has a documented
  fallback — see the degradation table in `docs/harness-assumptions.md`.
  Note: per-role token budgets in this kit are ADVISORY brief-level targets;
  the runtime enforces `model`, `effort`, and `maxTurns` from wrapper
  frontmatter, but no frontmatter field hard-caps tokens per agent.
- **git** (local use is enough; no remote required).
- **Node.js 22 or 24** (the fault-injection test suite and
  `scripts/reconcile-run.mjs`), **bash + coreutils/grep/awk** (validator,
  bootstrap, watchdog), and **perl** (bootstrap placeholder substitution).
  Supported OS: macOS and Linux (CI runs both); Windows/WSL is untested —
  the reconciler relies on POSIX same-directory rename semantics.
- Optional: an issue tracker (Jira / Linear / GitHub Projects). Without one,
  the Kanban methodology falls back to a file-based board — see
  `methodologies/kanban.md`.

## How to Deploy

1. **Create an instance root for the project and add this repo as `kit/`.**
   The kit stays a clean, read-only checkout; everything the team writes
   (charter, profiles, roster, role files, ledgers, wrappers) lives in the
   instance root, so a kit update never conflicts with project state
   ([ADR 0009](decisions/0009-kit-instance-separation.md)).

   ```text
   MyWorkspace/
     MyProduct/          <- your product code (created at bootstrap if absent)
     MyProduct.team/     <- instance root: this project's team state, its own Git repo
       kit/              <- this repo as a Git submodule, never edited here
   ```

   ```bash
   mkdir MyWorkspace/MyProduct.team && cd MyWorkspace/MyProduct.team && git init
   git submodule add https://github.com/Wahsekim/AI.Team.git kit
   kit/scripts/bootstrap-team.sh --project-name MyProduct --product-repo ../MyProduct .
   ```

   Bootstrap instantiates the seeds from `kit/` into the instance root, copies
   the loop engine, and records the kit commit in `kit.lock`.

2. **Open Claude Code in the instance root — with the product repo added —
   and say `start team`.** The product repo is a sibling directory, so the
   session needs explicit access to it:

   ```bash
   cd MyWorkspace/MyProduct.team
   claude --add-dir /absolute/path/to/MyWorkspace/MyProduct
   ```

   The instance root is the team root. A team-relative path (`agents/...`,
   `docs/...`, `scripts/...`) resolves there when it exists, otherwise under
   `kit/`. The PM wakes, reads `CLAUDE.md`, and runs the bootstrap interview:
   - fills `charter.md` and `profiles/project.md` / `profiles/stack.md`;
   - asks only the first-start placeholders (project name, repo path, token
     caps, tracker...) — see `docs/lazy-placeholders.md`;
   - runs the staffing questionnaire (`docs/staffing.md`) — default is a
     Minimum Viable Team of PM + 1 builder + 1 verifier, other roles stay
     dormant until a trigger promotes them; hired roles get their role file
     with `kit/scripts/bootstrap-team.sh --roles <role_id>,... .`;
   - then follows `docs/bootstrap-empty-project.md` or
     `docs/bootstrap-existing-project.md` depending on your answer.

   **Updating the kit later** (`docs/upgrade.md`): fast-forward `kit/` to the
   reviewed commit, then run `kit/scripts/pin-kit.sh .`. Scripts, docs, shared
   rules and the PM protocol update with `kit/`. `charter.md`, hired role
   files, ledgers and the instance `CLAUDE.md` were copied from seeds once and
   are not updated; `pin-kit.sh` lists the seeds that changed so the PM ports
   them by hand.

   **Migrating an older deployment.** A deployment made by cloning this repo
   and bootstrapping inside it (single root) keeps project state in tracked
   kit files, so `git pull` conflicts. It still works for now and the
   validator reports it as legacy. Migrate it once:

   ```bash
   mkdir MyWorkspace/MyProduct.team && cd MyWorkspace/MyProduct.team && git init
   git submodule add https://github.com/Wahsekim/AI.Team.git kit
   kit/scripts/migrate-to-instance.sh --dry-run ../AI.Team .      # plan only
   kit/scripts/migrate-to-instance.sh --project-name MyProduct ../AI.Team .
   kit/scripts/validate-team.sh --mode deployment .
   ```

   The script copies project state (charter, profiles, roster, wrappers,
   ledgers, edited role files, messages, project ADRs and scripts) and never
   writes to the old checkout or to `kit/`. Edits the old deployment made to
   other kit files (for example `CLAUDE.md` or `docs/`) are not copied: their
   diffs are saved under `migration-review/` and listed in
   `kit-upgrade-review.md` for the PM to port by hand.

   **Ledgers are never tracked in this repository.** The kit ships
   `agents/lifecycle.template.md`, `agents/lessons.template.md`,
   `memory/pm.template.md` and `pm-decisions.template.md`; bootstrap creates
   the live files in the instance. The maintainers' own ledgers for developing
   the kit live at the usual paths in their checkout and are gitignored.

3. **Wire the recommended hooks** (optional but advised for unattended runs):
   merge the `settings.json` snippet from `docs/harness-assumptions.md` into
   your deployment's `.claude/settings.json`, and install the watchdog per
   `scripts/watchdog/INSTALL.template.md`.

4. **Verify the deployment** at any time:

   ```bash
   kit/scripts/check-claude-compat.sh .            # runtime version + wrapper frontmatter + no seeds in the registry
   node kit/scripts/preflight-run.mjs args.json --team-root . --product-root ../<product>   # before EVERY engine launch
   kit/scripts/validate-team.sh --mode deployment . # deployed instance: full artifact matrix + kit pin/clean checks
   (cd kit && scripts/validate-team.sh . && node --test tests/*.test.mjs)   # the kit itself: validator + fault-injection suite
   ```

   Pure bash (validator) + node (tests); exit 0 = no FAIL **in the checked
   mode** — kit mode does not attest a deployment, so deployed instances must
   use `--mode deployment`. The validator is also the wake-step-0 integrity
   gate the PM runs every cycle.

5. **Drive it.** `start <project>` / `stop <project>` for daily cycles. Your
   duties as the human owner (decision SLA, weekly ledger scan, real-device
   review, SAFE-MODE when absent) are defined in `docs/owner-contract.md`.

## The Operating Model

### Experimental goal/graph supervisor (simulation only)

An opt-in **Node 24+** foundation now lives in `src/loop/`. It provides strict
goal contracts, DAG scheduling, a deterministic reducer, and transactional
SQLite state/events/outbox storage. It does **not** replace `run-n-rounds`.

```bash
node scripts/team-run.mjs demo .team-loop demo-1
node scripts/team-run.mjs status .team-loop demo-1
node scripts/team-run.mjs audit .team-loop demo-1
```

This demonstration deliberately fails one mock gate, repairs, and passes a
final-candidate mock gate. Every response is labelled `simulation: true`;
`COMPLETED` means the simulation completed, **not that product code was built
or verified**. No Claude calls, product writes, or legacy ledger writes occur.
See [implementation status and next steps](docs/loop-graph.md).

### Experimental Router/Worker mode (offline only, not launchable)

Router/Worker is a second, optional team topology. The specialist team described
under "Existing team model" stays the default and is unchanged. The mode changes
how work is allocated and keeps the same control plane (charter, budgets, ledgers,
independent verification, PM-only commits).

| Concept | Meaning in this mode |
|---|---|
| Router | A responsibility of the existing PM session, not an extra agent: establish authority and budget, select methods, compile briefs, dispatch, gather evidence |
| Worker | One common protocol instantiated per task by duty, replacing permanent frontend/backend/QA roles |
| `exec` duty | Implementation of one outcome across layers (UI, domain logic, tests) |
| `check` duty | Independent acceptance, in a separate session from the one that wrote the change |
| `guard` duty | The Chaos/Guardian audit |
| Skill | A pinned task method the PM selects explicitly per duty from `config/router-worker/catalog.json`; today only `pstack-blast-radius`, for `check` |

Work is routed by the smallest verifiable outcome, not by file type or
profession. Architect, Coach, Auditor and Security triggers are retained.
Retries are counted per stable ticket and duty: one initial call plus at most
two retries, with no reset when the model, skill or worker instance changes.
[ADR 0008](decisions/0008-router-worker-topology.md) records the owner's approval
of these two mappings only.

What exists today is offline tooling in `src/router-worker/`: a deterministic
compiler (first-attempt `exec` and `check` previews only), local source/context
preflight, inert deployment drafts, candidate/check-record binding and persisted
retry accounting. No command activates a Router/Worker team or calls a model.

```sh
node --test tests/router-worker-*.test.mjs
node scripts/compile-router-worker.mjs INPUT.json
node scripts/preflight-router-worker.mjs INPUT.json TEAM_ROOT APPROVAL_PATH APPROVAL_SHA256
node scripts/team-mode.mjs preview SPEC.json
node scripts/team-mode.mjs draft SPEC.json NEW.rw-draft.json
node scripts/team-mode.mjs verify SPEC.json DRAFT.json
node kit/scripts/team-mode.mjs preview SPEC.json --instance .   # from a two-root instance root
```

Node 22 supports the non-SQLite tools; retry persistence and its registry require
Node 24+. `INPUT.json` and `SPEC.json` must follow the documented contracts; test
fixtures are synthetic, not project approval. Draft output is JSON, not installed
wrappers. There is no activation or live model command. All successful artifacts
remain non-launchable; **do not pass a preview plan to the live count engine**.
No existing bootstrap, engine, roster or skill-pack behavior is replaced.

Start with the [PR scope and reviewer guide](docs/design/router-worker/pr-handoff.md),
[implementation status](docs/design/router-worker/implementation-status.md) and
[design](docs/design/router-worker/README.md). Real deployment,
permission/session enforcement and usage settlement remain follow-up work.

Project-maintained documentation is written in English. Translated historical
reviews retain their original dates and evidence limits; translation is not a new
review or approval.

### Existing team model

The important extraction from the source project is not the ASP.NET stack. The reusable system
is the operating model:

- one persistent PM loop;
- named specialist roles with stable responsibilities;
- one role file per active agent, including base-agent source resolution;
- standing meta-rules (M1-M6) and shared verification/browser disciplines in
  `agents/_shared/`;
- stack rules behind a lazy `profiles/stack.md`;
- project facts behind `profiles/project.md`;
- append-only lifecycle, PM decisions, memory, messages, lessons index, and
  ADRs — all under the slim-active + archive rotation regime;
- coach-curated lessons index and independent periodic audit;
- a mechanical count-directed loop engine with a guardian audit node
  (`.claude/workflows/run-n-rounds.js`, contract in `docs/engine.md`);
- Claude cold-start indexes and project-scoped agent wrappers.

### Role-specific method injection (skill packs)

The kit vendors a few reviewed methods from
[Matt Pocock's skills](https://github.com/mattpocock/skills) and
[Pstack](https://github.com/cursor/plugins/tree/main/pstack) under
`agents/skill-packs/`, pinned by upstream commit and file SHA-256 in
`agents/skill-packs/lock.json`. Nothing is installed as a plugin, and workers
receive no slash command or new permission.

When the PM builds a brief and has explicitly classified the task as one of the
allowlisted role/task pairs, it runs the renderer and adds the printed excerpt to
that worker's brief:

```sh
node scripts/role-skills.mjs brief backend debug
node scripts/role-skills.mjs brief qa impact-review
```

| Role | Task | Method injected |
|---|---|---|
| PM | `spec` | to-spec |
| PM | `tickets` | to-tickets |
| Backend or Frontend | `debug` | diagnosing-bugs |
| Architect | `interface-design` | architect rationale and design red flags |
| QA, Verifier or Reviewer | `impact-review` | blast-radius |

Any other role/task pair prints nothing, so ordinary work gets no extra prompt.
The renderer verifies the pinned source offline before emitting text. Each
excerpt opens with a notice that the brief's scope, budget, stop rules and
verification gates take precedence and that the method grants no permission to
spawn agents, choose models, invoke other skills, publish issues, push or deploy.
Injection does not prove the worker followed the method; the brief
still requires observable evidence. `verify` checks the pins, `check-upstream`
reports drift without adopting it, and `refresh` is a reviewed PM action
([ADR 0007](decisions/0007-pm-only-commits.md)). Details: `docs/role-skills.md`.

Router/Worker mode reads the same pinned snapshots through its own catalog and
leaves this role/task interface unchanged.

## Start Here

| Goal | Read |
|---|---|
| Install this team into a new blank repo | `docs/bootstrap-empty-project.md` |
| Attach this team to an existing repo | `docs/bootstrap-existing-project.md` |
| Understand what every file is for | `docs/process-index.md` |
| See all portable workflows preserved from the source team workspace | `docs/workflow-catalog.md` |
| Read the standing meta-rules every agent follows | `agents/_shared/meta-rules.md` |
| Run owner count directives mechanically | `docs/engine.md` |
| Configure project name, PM name, tracker, language | `profiles/project.template.md` |
| Configure or lazily discover the stack | `profiles/stack.template.md` |
| See document completeness expectations | `docs/doc-completeness.md` |
| Understand Claude integration and index preservation | `docs/claude-integration.md` |
| Understand self-improvement loops | `agents/self-improvement.md` |
| Read the canonical failure-class catalog (mechanical controls per class) | `docs/failure-classes.md` |
| Run the mechanical integrity check (wake step 0 / bootstrap gate) | `scripts/validate-team.sh <root>` |
| Decide which roles to hire (MVT, questionnaire, triggers) | `docs/staffing.md` |
| See what the runtime must provide + deployment hooks | `docs/harness-assumptions.md` |
| Know the human owner's duties and SAFE-MODE | `docs/owner-contract.md` |
| Port an instance lesson back into this template | `docs/backport-ritual.md` |
| Update the kit in a deployed instance, or migrate a single-root deployment | `docs/upgrade.md` |
| Inject a reviewed method into a worker brief, or update the skill packs | `docs/role-skills.md` |
| Understand the experimental Router/Worker mode and its rollout gates | `docs/design/router-worker/README.md` |

## Directory Shape

```text
AI.Team/
  CLAUDE.md                    # cold-start primer for future Claude Code sessions
  charter.template.md          # constitution SEED -> instantiated as charter.md at bootstrap
  profiles/                    # project and stack profiles, lazily locked
  agents/                      # PM, roster, templates, lifecycle, lessons index
    <role_id>.md               # one file per active role, with base agent source
    _shared/                   # meta-rules M1-M6 + verify/browser discipline templates
    skill-packs/               # pinned upstream method snapshots + lock.json
  scripts/role-skills.mjs      # renders a reviewed method excerpt for a role/task brief
  src/router-worker/           # experimental Router/Worker offline tooling (non-launchable)
  config/router-worker/        # Router/Worker method catalog and coverage map
  docs/workflow-catalog.md     # portable workflows preserved from the source team workspace
  docs/engine.md               # count-directed loop engine contract
  methodologies/               # Kanban default + lazy methodology packs
  decisions/                   # ADR index + template
  docs/                        # bootstrap, process map + rotation regime, completeness
  memory/                      # PM state and atomic counters
  messages/                    # inter-agent daily dialogue
  scripts/validate-team.sh     # mechanical integrity checker (kit + deployments)
  scripts/bootstrap-team.sh    # instantiates seeds into a project instance root (never writes kit/)
  scripts/pin-kit.sh           # records a reviewed kit upgrade in an instance (kit.lock, engine copy)
  scripts/migrate-to-instance.sh # moves a single-root deployment into an instance root
  scripts/preflight-run.mjs    # static launch preflight + frozen launch-bundle digest
  scripts/now-utc.sh           # the only sanctioned ledger timestamp source
  agents/_seeds/               # wrapper + inline-mode SEEDS (never inside .claude/agents/)
  scripts/watchdog/            # copied hang-detection hooks from the source team workspace
  .claude/agents/              # LIVE project-scoped Claude agent wrappers only (seeds: agents/_seeds/)
  .claude/workflows/           # run-n-rounds loop engine
```

## Key Principle

Keep universal rules universal, keep stack facts in the stack profile, and keep
project facts in the project profile.

Example:

- Universal: "framework entry points stay thin; business logic belongs in the
  application/domain layer."
- Stack adapter: "For ASP.NET Razor Pages, PageModel handlers stay thin; services
  hold non-trivial logic."
- Project profile: "For this project, deployment is macOS LAN, single user, FR/ZH/EN."

## First Command Pattern

Use a project-specific phrase once the placeholders are resolved:

```text
start {{PROJECT_NAME}}
stop {{PROJECT_NAME}}
resume {{PROJECT_NAME}}
```

Before `{{PROJECT_NAME}}` is known, use:

```text
start team
```

The PM should then initialize `profiles/project.md` and `profiles/stack.md`.

## License

MIT — see [LICENSE](LICENSE). You may use, modify, and redistribute this kit,
including commercially, with attribution. Instantiated deployments (your
`charter.md`, profiles, ledgers) are your own content and are not required to
be shared.
