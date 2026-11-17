# A batch in a standing Router/Worker team

Status: the "before" and "abort" commands are built and tested offline on a
bootstrapped fixture. The "after" command is not built: a batch opened by
"before" can today only be aborted, not checked and closed. Not yet used on a
real team.
[ADR 0010](../../../decisions/0010-router-worker-second-mode.md), decisions 8 to 12.

```sh
node kit/scripts/rw-batch.mjs before BATCH.json --instance . [--start-as-is]
node kit/scripts/rw-batch.mjs abort --instance .
```

Exit 0 batch open or aborted, 2 refused, 1 usage. No model, no network.

## What the PM writes

```json
{
  "tickets": [
    { "id": "US-08", "title": "Retry failed tag-list loading",
      "goal": "Recover the list after a failed request",
      "acceptance": ["Failed loading shows Retry", "Retry reissues the request"],
      "paths": ["src/tag-list/**", "src/api/tags.ts"],
      "estimate": { "execTokens": 12000, "checkTokens": 6000, "reworkTokens": 6000 } }
  ],
  "verificationCommands": ["npm run test:tag-list"],
  "sensitivePaths": ["src/auth/**"],
  "nextLifecycleNumber": 41
}
```

| Field | Meaning |
|---|---|
| `id` | 1 to 40 letters, digits, dots, dashes or underscores; unique in the batch, whatever the case |
| `paths` | What the ticket's worker may write: a file, or a folder grant ending in `/**`. Never under `.git` or `.claude`. At most 100 paths over the whole batch |
| `expectedPaths` | The files the worker is expected to touch; by default the `paths` that are files. Required when a ticket grants only folders |
| `estimate` | Input-side tokens for execution, check and rework; their sum may not exceed the authorization per ticket |
| `sensitivePaths` | Paths no ticket of this batch may write. They are judged against `paths`, which is what bounds the worker, not against the plan: a ticket whose grant covers a sensitive path, or lies under one, is refused. An entry written as a bare folder (`src/auth`) guards everything under it. This lasts until the review of [ADR 0011](../../../decisions/0011-router-worker-batch-review.md) exists |
| `runId`, `date` (optional) | Default: `rw-<commit>-L<nextLifecycleNumber>` and today |

The PM does not write a ceiling, a number of rounds, a wrapper name or a
budget per ticket. Those come from the team.

## What "before" does, in order

1. **The team**: two-root layout, live in Router/Worker mode, dispatch by the
   engine, no interrupted mode switch, no batch already open, limits that are
   valid.
2. **The tickets**: each is complete, and no two tickets claim the same file. A
   folder grant claims every file under it; paths are compared without case.
3. **The product repository**: on a branch that is not a default branch, no Git
   operation in progress, nothing uncommitted or untracked. Git-ignored files
   are not counted. The team's own files are never counted: the team lives
   outside the product.
4. **The lock** on the product repository is taken. The team and the product
   are then read again: with the lock held, no mode switch and no change of
   limits can run.
5. **The engine's arguments are built and frozen**:

   | Argument | Value |
   |---|---|
   | rounds | the number of tickets |
   | output ceiling | N times the output allowance per ticket, plus the Guardian's share |
   | failure policy | halt on failure |
   | attempts per ticket | the team's limit (1 by default) |
   | authorization per ticket | the team's limit, the same for every ticket |
   | workers | the three wrappers the closed write boundary names |
   | baseline | the product's HEAD commit |

   The engine's own validator judges them in a dry run with no dispatch, and
   the static launch preflight's digest is chained into them.
6. **The isolation check** runs on the team and the product. Two findings are
   accepted by decision in a standing team: no sandbox around the workers'
   shell, and Git-ignored paths present. A caller cannot make it accept any
   other finding.
7. **The product is read once more**: what is there must be what step 3 found.
8. **The write boundary opens**, last: the exec worker may write the tickets'
   paths, the checker and the Guardian nothing.
9. **The batch record** `rw-batch.json` is written in the team's folder and
   printed. Its `args` are the arguments the PM passes to `run-n-rounds`. It
   also holds what "after" will need: the branch and commit, the paths that
   were already changed, each ticket's paths, the sensitive paths, the
   verification commands, the limits.

Any refusal after step 4 releases the lock, and closes the boundary if it was
opened.

## Abort

`abort` clears a batch that will not be run, and what a "before" that died
left behind: it closes the write boundary, releases the lock if this team holds
it, removes the batch record and appends one line to `pm-decisions.md`. It
checks nothing about the work; that is the "after" command. It never releases
another team's lock. It does not know whether the engine is running: aborting a
batch that is being run takes its lock and its write paths away mid-run.

When the write-boundary file is missing or was changed, abort still releases
the lock and removes the record, and says the boundary was not restored: every
agent write is then refused until a mode switch to specialist and back rebuilds
it.

A "before" that finds this team's lock with no batch record, or a boundary
that is not closed, refuses and names `abort`.

## What decides the limits

The ceiling, the attempts, the authorization, the tools and the workers come
from the team's own files: `profiles/team-mode.json`, `agents/roster.md` and
the write-boundary file. `BATCH.json` cannot change any of them; an unknown
field is refused. The limits are checked for validity where they are used.

They are not protected against the PM. The owner confirms the limits at the
switch or with `team-mode.mjs limits`, by a code typed at a terminal, but the
result is a file in the team's folder that a PM session can edit. Such an edit
does not pass through the confirmation and writes no ledger line. Nothing in
this command detects it.

## Start as is

`--start-as-is` lets a batch start on a repository that has uncommitted or
untracked paths. It does not override the default-branch rule or a Git
operation in progress. The paths are recorded in the batch record
(`preexisting`) and one line is appended to `pm-decisions.md`. They are to be
kept out of the tickets' commits by the "after" command.

## Refusals (`BATCH_REFUSED`)

- The team is not live in Router/Worker mode, a mode switch was interrupted, or
  a batch is already open.
- A ticket is incomplete, or two tickets claim the same file. The message names
  the tickets and the paths.
- A ticket claims a path under `.git` or `.claude`, could write a sensitive
  path, or grants only folders without `expectedPaths`.
- The product repository is on a default branch, not on a branch, has a Git
  operation in progress, or has uncommitted changes (the first ten paths are
  listed), or changed while the batch was being prepared.
- The lock is held. If this team holds it with no batch open, the message names
  `abort`.
- The batch cannot be frozen: an estimate above the authorization, a planned
  path under a sensitive path, a roster that does not staff the three workers.
- The launch preflight or the isolation check does not pass.

## Not covered

- **There is no "after" command yet.** Until it exists a batch can be aborted,
  not checked, settled and closed.
- **The default branch is recognised by name**: every remote's default,
  `init.defaultBranch`, `main`, `master`. A repository with no remote whose
  default branch has another name (`develop`) is not recognised.
- **The limits are not protected against the PM** (above).
- **The estimated output** the engine is told is half the ceiling. It is a
  figure the kit sets so that the engine's own checks on the ceiling hold; it
  is not a forecast.
- **The Guardian's estimate** at settlement is the authorization of one ticket.
  ADR 0010 sets the Guardian's share of the output ceiling only.
- **The hook must be loaded** in the PM's session. The command checks that it
  is registered and that its file exists, not that the running session read it.
- **Nothing has run with real agents** from a batch record.
