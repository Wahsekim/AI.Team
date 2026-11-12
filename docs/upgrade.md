# Upgrading the kit in a deployed instance

Applies to two-root instances (`decisions/0009-kit-instance-separation.md`):
the instance root holds project state, `kit/` is a read-only checkout of this
repository pinned by `kit.lock`. Run everything from the instance root.

## Steps

1. Close the current cycle. Do not upgrade during an engine run.
2. Check the starting point: `kit/scripts/validate-team.sh --mode deployment .`
   must report no `kit-clean`, `kit-pin` or `kit-shadow` FAIL.
3. Move the kit to the reviewed commit:

   ```bash
   git -C kit fetch
   git -C kit merge --ff-only <reviewed-commit>     # or: git submodule update --remote kit
   ```

   This is a fast-forward because nothing under `kit/` is ever written by the
   deployment. If it is refused, something wrote into `kit/`; move that content
   to the instance root and restore the kit before continuing.
4. Preview, then record the upgrade:

   ```bash
   kit/scripts/pin-kit.sh --dry-run .
   kit/scripts/pin-kit.sh .
   ```

   `pin-kit.sh` rewrites `kit.lock`, re-copies `.claude/workflows/run-n-rounds.js`
   and prints one `REVIEW` line per changed seed whose instantiated file exists
   in the instance. It appends the same items to `kit-upgrade-review.md` as
   open `- [ ]` entries.
   It writes the review entries first, then the engine copy, then `kit.lock`.
   If it fails part-way (`RESULT: PIN-FAILED`), `kit.lock` still names the old
   commit: fix the cause and run it again. Entries already recorded, open or
   ticked, are not added twice. A `.pin-lock` directory serializes runs; remove
   it only if the run that created it died. Do not delete
   `kit-upgrade-review.md`: the validator cannot tell a deleted record from an
   upgrade with nothing to port.
5. Port each `REVIEW` item by hand. Instance files are never overwritten, so a
   change to `charter.template.md`, a ledger header, a role seed or the
   instance `CLAUDE.md` seed reaches the project only when the PM copies the
   relevant part across. Read the diff the line names, apply what fits or
   decline it, then tick the entry (`- [x]`) with a short note. The validator
   fails the deployment while any entry is open, so the project cannot keep
   running on old rules without a recorded decision.
6. Validate: `kit/scripts/validate-team.sh --mode deployment .` must exit 0.
7. Commit the instance root (new submodule pointer, `kit.lock`, engine copy and
   any ported changes) as one commit.

## What changes automatically and what does not

| Surface | On upgrade |
|---|---|
| Kit scripts, docs, shared rules, methodologies, `agents/pm.md`, skill packs | Updated with `kit/` |
| Loop engine copy | Re-copied by `pin-kit.sh`; a locally edited copy is refused |
| `charter.md`, profiles, roster, role files, ledgers, `CLAUDE.md` | Unchanged; ported by hand from the `REVIEW` list |

## Legacy single-root deployments

A deployment bootstrapped inside a clone of this repository keeps project state
in tracked kit files, so `git pull` conflicts. The validator reports it as
`WARN - layout: legacy single-root`. Migrate it once:

```bash
mkdir ../MyProduct.team && cd ../MyProduct.team && git init
git submodule add https://github.com/Wahsekim/AI.Team.git kit
kit/scripts/migrate-to-instance.sh --dry-run <old-checkout> .
kit/scripts/migrate-to-instance.sh --project-name <name> <old-checkout> .
kit/scripts/validate-team.sh --mode deployment .
```

`migrate-to-instance.sh` copies the files Git ignores or does not track in the
old checkout (minus environment artifacts such as `.venv/`) and the tracked
ledgers and role files the deployment modified, then runs the two-root
bootstrap. It never writes to the old checkout or to `kit/` and never
overwrites a file in the new instance. Other tracked kit files the deployment
edited (`CLAUDE.md`, `.gitignore`, `docs/`, `scripts/`) are not copied, because
they would shadow the kit: each diff is saved under `migration-review/` and
added to `kit-upgrade-review.md` as an open item. Port the project-specific
part of each into an instance file (the instance `CLAUDE.md`, a new document
under `docs/`, or a script flag) and tick the item. Keep the old checkout until
one attended cycle has closed in the new instance.

Project state is found by comparing the old checkout with its kit baseline, the
kit commit the deployment was made from. A kit commit is one found in the
history of the new instance's `kit/`; a remote of the old checkout is not
evidence, because a deployment snapshot may have been pushed to a backup or a
fork. When the old checkout's `HEAD` is a kit commit, it is the baseline. When
the deployment was committed on top of the kit, the script stops, prints the
number of local commits and a candidate, and needs `--baseline <kit commit>`;
the named commit must also be in the history of `kit/`. If the deployment came
from an unmerged kit branch, fetch that branch in `kit/` first. Committed, staged and unstaged differences from the baseline are
all migrated: added files are copied, changed ledgers and role files are copied,
other changed kit files become review items. A ledger identical to the baseline
holds no project history and is seeded fresh. A project file at a path the new
kit also ships is saved under `migration-review/` as a review item, not copied
over that path.

## Maintainers: the kit's own ledgers

The kit's development ledgers (`agents/lifecycle.md`, `agents/lessons.md`,
`memory/pm.md`, `pm-decisions.md`) are gitignored and local to each
maintainer checkout. The change that stopped tracking them is a deletion in
Git, so the first pull or merge that brings it into another checkout removes
those four working files there (or conflicts if they were edited). Copy them
aside before pulling and put them back afterwards; earlier committed entries
remain available with `git show <commit>:agents/lifecycle.md`.
