# Runtime-isolation gate: host observation and ownership lease (rollout gate G-02, offline part)

Status: offline, read-only. It does not activate a team, call a model or prove
that a runtime enforces anything.

The retry journal refuses to prepare or start a call unless every host admission
gate is `clear` ([retry accounting](retry-accounting.md)). Until now the
`runtime-isolation` gate was a value the host declared. This command observes it:

```sh
node kit/scripts/isolation-router-worker.mjs --team-root <team-root> --product-root <product-root> --lease <digest>
```

`<team-root>` is the directory the runtime would start in (an instance or a
staging copy). Both paths must be canonical. Exit 0 means `clear`; exit 2 means
`blocked`, `unknown` or an invalid request. The JSON record carries `gate`,
`status`, the product `head`, the three wrapper names, sorted `findings`
(`code`, `severity`, `detail`) and a digest of itself. Any `blocked` finding
gives `blocked`; otherwise any finding gives `unknown`; only an empty list is
`clear`. A host that issues a call on anything but `clear` violates the gate.

## What is observed

| Area | Finding | Severity |
|---|---|---|
| Product | `PRODUCT_NOT_REPOSITORY_ROOT`, `PRODUCT_NOT_SEPARATE`, `PRODUCT_NO_CANDIDATE` | blocked |
| Product | `PRODUCT_DIRTY` (uncommitted or untracked paths: existing work is unexplained) | blocked |
| Product | `PRODUCT_OPERATION_IN_PROGRESS` (index lock, merge, rebase, cherry-pick, revert, bisect) | blocked |
| Product | `PRODUCT_SHARED_METADATA` (more than one work tree on the repository) | blocked |
| Product | `IGNORED_PATHS_PRESENT`, `SUBMODULE_PRESENT`, `EXTERNAL_SYMLINK` (content the candidate diff cannot see) | unknown |
| Wrappers | `WRAPPER_MISSING`, `WRAPPER_IDENTITY`, `WRAPPER_INHERITS_ALL_TOOLS`, `DELEGATION_ALLOWED`, `PERMISSION_MODE` | blocked |
| Wrappers | `READ_ONLY_DUTY_CAN_WRITE` (check or guard lists or fails to deny Write/Edit/NotebookEdit) | blocked |
| Wrappers | `WRAPPER_INACTIVE_DRAFT` (the file still says "Do not run from this draft") | blocked |
| Wrappers | `BASH_NOT_SANDBOXED` (check or guard has Bash and no isolated runner is observed) | unknown |
| Ownership | `OWNERSHIP_NOT_HELD`, `OWNERSHIP_NOT_PRESENTED`, `OWNERSHIP_HELD_BY_OTHER` | blocked |
| Ownership | `OWNERSHIP_UNREADABLE` (a lease file that does not parse or does not match its digest) | unknown |
| Host settings | `HOST_PERMISSION_BYPASS` (non-default permission mode in `.claude/settings*.json` of either root) | blocked |
| Host settings | `BROAD_BASH_ALLOW`, `ADDITIONAL_DIRECTORIES`, `HOST_SETTINGS_UNREADABLE` | unknown |

Wrapper permissions are read from the files under `.claude/agents/` that the
roster names, never from a spec or a declaration. Setting values (paths, hosts,
rules) are counted and never copied into the record.

Every draft wrapper is marked inactive, so a staging copy produced by
`team-mode.mjs stage` always observes as `blocked`. That is intended: there is
no activation step yet.

## Accepted findings

A team root produced by [activation](activation.md) may carry
`acceptedUnknowns` from the owner approval in `profiles/team-mode.json`. Such a
finding is reported with severity `accepted` and does not keep the gate from
`clear`. Only `BASH_NOT_SANDBOXED` can be accepted; a `blocked` finding never
can, and a draft or a plain instance accepts nothing.

## What is not observed

The record lists these under `notObserved`:

- `independent-sessions`: three wrapper files do not prove three separate
  sessions or contexts at run time.
- `runtime-tool-enforcement`: frontmatter narrows the tool surface; whether the
  runtime honours it is only shown by a live run.
- `canary-negatives`: disposable negative probes (a check worker that tries to
  write, an exec worker that tries to leave the product root) need a live,
  owner-approved run.
- `network-and-external-services`.

## Ownership lease

```sh
node kit/scripts/lease-router-worker.mjs acquire --team-root <team-root> --product-root <product-root>
node kit/scripts/lease-router-worker.mjs status  --product-root <product-root>
node kit/scripts/lease-router-worker.mjs release --product-root <product-root> --lease <digest>
```

Exit 0 means done, 2 refused or invalid, 1 usage. The lease is one file,
`rw-ownership-lease.json`, in the repository's common Git directory. It is
therefore shared by every team root and every linked work tree of the product,
and it is not a work-tree path: `git status` does not show it and it cannot
enter the candidate diff. This is the only write these commands make.

- **Acquire** creates the complete record with a hard link, so of several hosts
  starting at once exactly one succeeds and the others get `LEASE_HELD`. A
  second session of the same team root is refused like any other host. The
  record holds the team root, the product root, a random nonce, a timestamp and
  its own digest.
- **Observe**: the isolation command is `clear` only when the product carries a
  readable lease whose digest equals `--lease` and whose team root is the
  observed team root. The record never names another holder.
- **Release** needs the digest of the lease that is held.
- **No expiry and no takeover.** A lease left by a host that crashed stays until
  someone who can read it with `status` releases it by its digest. A lease file
  that is unreadable is removed by the operator by hand; the tool refuses to
  guess.

Limits: the lease is advisory between cooperating hosts. It does not stop a
person or a process that ignores it from writing to the product, and it does not
cover a second clone of the same repository.

G-02 therefore stays open until a live, owner-approved run supplies the items
under `notObserved`. The offline part replaces a declared value with an observed
one, adds exclusive ownership and gives the host a refusal reason for zero-call
outcomes.
