# ADR 0003: Execution binds only the host-created product clone (R03b)

Date: 2026-10-07
Status: Accepted for implementation (policy: owner, ADR 0001 decision 5); owner ratification pending

## Context

- Handoff §5: a state-directory lock (R03a, ADR 0002) does not stop two state directories, or legacy, from mutating one checkout.
- The owner chose the policy (ADR 0001, 5): host-created isolated clone only; shared targets refused; legacy on that clone unsupported and documented, not enforced.
- Baseline 4a11924: the driver took any `root` (`.native`-resolved) and refused only a state directory inside it. Legacy has no target lock and must not change here.

## Decision

1. **Identity** (`src/loop/product-target.mjs`): `realpathSync.native` root, its (dev, ino), and `git rev-parse --path-format=absolute --show-toplevel --git-dir --git-common-dir` (ambient `GIT_*` dropped, `GIT_CEILING_DIRECTORIES` = parent) resolved with `.native` plus the common dir's (dev, ino).
2. **Isolation, before any lock or marker.** `acquireExecutionOwner({ store, target })` refuses:
   - a state directory inside or equal to the target: `SCOPE_DENIED` (R03a rule, unchanged code);
   - a target that is not a direct child of the state directory, or a state directory inside any Git repository (`git rev-parse` must report "not a git repository"): `TARGET_NOT_ISOLATED`. The direct-child rule gives a target exactly one possible state directory (nesting). The outside-repository rule prevents containment: otherwise host 2 could target a repository whose work tree holds host 1's state directory and clone, so its workers and snapshot would write to or open host 1's files (its snapshot opening host 1's lock file in-process would drop the lock, ADR 0002 P3);
   - not the Git root; git dir ≠ common dir or outside the root (linked worktree, separate git dir); `<common>/worktrees` non-empty; `objects/info/alternates` present: `TARGET_NOT_ISOLATED`.
3. **Binding.** Under the R03a kernel lock, in the same commit as `store_binding`, the first targeted acquire writes `target_binding` (relative path and common-dir path informational; root and common-dir (dev, ino) decide). Later targeted acquires compare and fail `TARGET_MISMATCH` without a marker. An untargeted acquire (demo, operator close) neither writes nor checks it.
4. **Held target.** `owner.assertHeld()` also stats root and common dir; a change fails `TARGET_MISMATCH`, so fenced `tick`/`claim`/settle stop. `createFixtureDriver` calls `assertOwnedTarget(owner, root)`: no target → `TARGET_NOT_ISOLATED`, another root → `TARGET_MISMATCH`.
5. The lock file stays `<state-dir>/execution-owner.sqlite`, outside the product, so P3 is unchanged: snapshots list only paths under the product root. CLI exit 4 adds both codes.

## Considered Alternatives

1. Lock inside the target's Git common dir: writes control files into the product and still binds no legacy writer.
2. Host registry keyed by (dev, ino): only writers using it are excluded; cross-state-directory consistency needs a shared location.
3. Accept external targets with a lock: legacy cannot join it, so "exclusion" would be a manual promise (handoff §5 forbids).

## Consequences

- Same state directory, two hosts: R03a. Different state directories cannot share a target: its parent is the only admissible state directory.
- Path aliases resolve to one identity; independent clones are different targets by construction.
- Worktrees and shared metadata are refused until a separate policy exists.
- Host death with an unresolved child: the R03a marker stays open; no takeover.
- A state directory inside a Git work tree (e.g. under a project checkout) is refused; use a directory outside any repository. The fixture CLI checks this before creating anything. Behavior change awaiting owner approval.
- Limitations: legacy `run-n-rounds` on the clone is not detected (owner decision, until R19). Same-UID code can still replace files; replacement is detected (`TARGET_MISMATCH`), not prevented. A state directory that another actor turns into a repository mid-execution is refused only at its next acquire. A `target_binding` lives in the lock file, so deleting that file resets it (ADR 0002 limit). `snapshots.mjs` keeps JS `realpathSync` on both sides of its root check; it is not an exclusion identity.
- Library callers that drive a product must pass `target` (compatibility break, tests updated).

## Follow-ups

- [ ] Owner ratification.
- [ ] R06: carry the policy and legacy limitation into the operating contract.
- [ ] R14: live admission acquires with `target`.
