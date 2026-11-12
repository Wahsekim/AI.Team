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
`WARN - layout: legacy single-root`. Migrate it once: create an instance root,
add `kit/`, bootstrap, then copy the instantiated files, ledgers, role files and
wrappers across, and validate. ADR 0009 lists the steps used for the first
migration.
