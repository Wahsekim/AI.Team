# AI.Team

AI.Team is a team operating system for [Claude Code](https://claude.com/claude-code).
One persistent PM session runs a software project with a roster of AI agents
(architect, builders, QA, security, coach, auditor and others). The human owner
makes the decisions. The kit came out of a multi-agent team that ran a real
product for about three months, and it keeps that team's governance.

Status: alpha. CI runs a deterministic fault-injection suite on macOS. Use the
kit for attended, low-sensitivity pilots that you can roll back. [SECURITY.md](SECURITY.md) and
[docs/harness-assumptions.md](docs/harness-assumptions.md) state the limits.

## What it is

### Design ideas

- **A persistent PM and ephemeral workers.** The PM is the main session. It
  dispatches every worker and is the only session that commits. A worker does
  one task and ends. See [agents/pm.md](agents/pm.md).
- **Two team modes.** The specialist team, one role per profession, is the
  default. Router/Worker mode gives each ticket to common workers by duty
  (`exec`, `check`, `guard`) and runs a cycle as one batch
  ([ADR 0010](decisions/0010-router-worker-second-mode.md)).
- **Kit and instance in two roots.** A project keeps this repository
  read-only as `kit/` inside its instance root, which holds all project state.
  A kit upgrade never conflicts with that state
  ([ADR 0009](decisions/0009-kit-instance-separation.md)).
- **Mechanical checks over prose.** A rule that can be checked is a script, a
  test, a hook or an engine gate
  ([docs/failure-classes.md](docs/failure-classes.md)).
- **Budget and halt rules.** One table in the
  [charter](charter.template.md) sets the token budgets and the only reasons a
  count-directed loop may stop.
- **Facts in their own layer.** Universal rules live in the kit. Stack rules
  live in `profiles/stack.md` and project facts in `profiles/project.md`.

### Features

- Bootstrap on a blank project or an existing codebase, with a hiring step
  that starts from PM, one builder and one verifier.
- A loop engine (`run-n-rounds`) with a hard round count, a token gate, a
  verification gate and a guardian audit.
- Router/Worker batches (`scripts/rw-batch.mjs`) with a lock, write limits
  enforced by a hook, one commit per passed ticket, and a Security or
  Architect review of the tickets the kit flags
  ([ADR 0011](decisions/0011-router-worker-batch-review.md)).
  `scripts/team-mode.mjs` switches a team between modes.
- A validator (`scripts/validate-team.sh`), a runtime compatibility check
  (`scripts/check-claude-compat.sh`), a launch preflight
  (`scripts/preflight-run.mjs`) and a run reconciler
  (`scripts/reconcile-run.mjs`).
- Append-only ledgers with rotation, a lessons index, periodic audits and a
  failure-class catalog.
- Methods from pinned skill packs, injected into briefs for named role and
  task pairs.
- Pinned kit upgrades, a dashboard of the latest batch, context budgets for
  start-up reads and watchdog hooks.
- An experimental goal and graph supervisor in `src/loop/`, simulation only
  ([docs/loop-graph.md](docs/loop-graph.md)).

## How to use it

### Requirements

- Claude Code 2.1.154 or later. The kit targets Claude Code only. Check with
  `claude --version`. [docs/harness-assumptions.md](docs/harness-assumptions.md)
  lists the runtime features the kit uses and the fallback for each.
- git. A remote is not required.
- Node.js 22 or 24, bash with coreutils, grep and awk, and perl. Some
  Router/Worker tools and the loop supervisor need Node 24.
- macOS. CI runs on macOS. Linux and Windows are not tested.
- An issue tracker is optional. [methodologies/kanban.md](methodologies/kanban.md)
  describes the adapters and the fallback without one.

### How to Deploy

1. Create the instance root next to your product and add this repository as
   `kit/`:

   ```bash
   mkdir MyWorkspace/MyProduct.team && cd MyWorkspace/MyProduct.team && git init
   git submodule add https://github.com/Wahsekim/AI.Team.git kit
   kit/scripts/bootstrap-team.sh --project-name MyProduct --product-repo ../MyProduct .
   ```

   Bootstrap copies the seeds into the instance root, copies the loop engine
   and records the kit commit in `kit.lock`. It never writes under `kit/`.
2. Open Claude Code in the instance root with access to the product, and say
   `start team`:

   ```bash
   claude --add-dir /absolute/path/to/MyWorkspace/MyProduct
   ```

   The PM runs the bootstrap interview: the first-start placeholders
   ([docs/lazy-placeholders.md](docs/lazy-placeholders.md)), the hiring step
   and the team mode ([docs/staffing.md](docs/staffing.md)), then
   [docs/bootstrap-empty-project.md](docs/bootstrap-empty-project.md) or
   [docs/bootstrap-existing-project.md](docs/bootstrap-existing-project.md).
3. For unattended runs, add the hooks from
   [docs/harness-assumptions.md](docs/harness-assumptions.md) and install the
   watchdog (`scripts/watchdog/INSTALL.template.md`).
4. Check the deployment:

   ```bash
   kit/scripts/check-claude-compat.sh .
   kit/scripts/validate-team.sh --mode deployment .
   ```

### Start, stop and run rounds

- Say `start <project>`, `stop <project>` or `resume <project>`. By default
  one wake runs one cycle, reports and sleeps.
- Say "run N rounds" to delegate a count-directed loop under the charter's
  loop modes. The PM runs it by hand or through the engine
  ([docs/engine.md](docs/engine.md)), with `scripts/preflight-run.mjs` before
  every engine launch. A Router/Worker team runs each cycle as one batch and
  the PM follows the
  [batch runbook](docs/design/router-worker/batch.md).
- Your duties as the owner, and SAFE-MODE when you are away, are in
  [docs/owner-contract.md](docs/owner-contract.md).

### Upgrade the kit

Fast-forward `kit/` to a reviewed commit, then run `kit/scripts/pin-kit.sh .`
from the instance root. Files that bootstrap copied from seeds are not updated.
`pin-kit.sh` lists each changed seed in `kit-upgrade-review.md`, and the
validator fails until every item is ported or declined. To move an older
deployment that lives inside a clone of this repository, run
`kit/scripts/migrate-to-instance.sh` once. [docs/upgrade.md](docs/upgrade.md)
gives both procedures.

### Find the doc for a task

| To do this | Read |
|---|---|
| Know what every file is for | [docs/process-index.md](docs/process-index.md) and [CLAUDE.md](CLAUDE.md) |
| Follow the PM's cycle | [agents/pm.md](agents/pm.md) |
| Hire, add or retire roles | [docs/staffing.md](docs/staffing.md) |
| Fill the project and stack profiles | [profiles/project.template.md](profiles/project.template.md), [profiles/stack.template.md](profiles/stack.template.md) |
| See the portable workflows | [docs/workflow-catalog.md](docs/workflow-catalog.md) |
| Read the rules every agent follows | [agents/_shared/meta-rules.md](agents/_shared/meta-rules.md) |
| Run a count-directed loop | [docs/engine.md](docs/engine.md) |
| Switch a team between modes | [docs/design/router-worker/mode-switch.md](docs/design/router-worker/mode-switch.md) |
| Run a Router/Worker batch | [batch.md](docs/design/router-worker/batch.md), detail in [batch-reference.md](docs/design/router-worker/batch-reference.md) |
| Understand the Router/Worker design and its tools | [docs/design/router-worker/README.md](docs/design/router-worker/README.md) |
| Inject a reviewed method into a brief | [docs/role-skills.md](docs/role-skills.md) |
| See a batch as an HTML page | [docs/dashboard.md](docs/dashboard.md) |
| Match a failure to its mechanical control | [docs/failure-classes.md](docs/failure-classes.md) |
| Run the coaching and audit loops | [agents/self-improvement.md](agents/self-improvement.md) |
| Keep the start-up reads small | [docs/context-budget.md](docs/context-budget.md) |
| Check that the docs are complete | [docs/doc-completeness.md](docs/doc-completeness.md) |
| Understand the Claude Code integration and the runtime contract | [docs/claude-integration.md](docs/claude-integration.md), [docs/harness-assumptions.md](docs/harness-assumptions.md) |
| Port a lesson from an instance back into the kit | [docs/backport-ritual.md](docs/backport-ritual.md) |
| Upgrade the kit or migrate a deployment | [docs/upgrade.md](docs/upgrade.md) |

## Project rules

- **Licence.** MIT, see [LICENSE](LICENSE). Your instantiated files (charter,
  profiles, ledgers) are your own content.
- **Security.** Report a vulnerability as [SECURITY.md](SECURITY.md) describes.
  It also holds the rules for secrets and untrusted input.
- **How changes land.** Only the PM session commits, one conventional commit
  per slice on a working branch. Nothing is committed or pushed to `main`
  directly. See [ADR 0007](decisions/0007-pm-only-commits.md).
- **Public repository.** Tracked files hold synthetic data only. CI runs
  `scripts/check-public-data.sh` to refuse client identifiers.
- **Development notes stay local.** Plans, reviews, hand-offs and dated
  assessments of the kit's own development go in `dev-notes/`, which Git
  ignores. The kit's own ledgers are ignored too. `tests/tracked-tree.test.mjs`
  fails on a history folder or a dated file under `docs/`, and on a
  README over 200 lines.
- **Run the checks before a change lands.** From the repository root:
  `scripts/validate-team.sh .` and `node --test tests/*.test.mjs`.
- **Decisions.** Architecture decisions are ADRs in [decisions/](decisions/README.md),
  which lists the status of each. An ADR takes effect when the owner ratifies it.
- **Language.** Documentation is written in English.
