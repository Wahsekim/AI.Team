# A batch in a standing Router/Worker team

Status: the "before" command is built and tested offline on a bootstrapped
fixture. The "after" command is not built: a batch opened by "before" can today
only be closed by hand. Not yet used on a real team.
[ADR 0010](../../../decisions/0010-router-worker-second-mode.md), decisions 8 to 12.

```sh
node kit/scripts/rw-batch.mjs before BATCH.json --instance . [--start-as-is]
```

Exit 0 batch open, 2 refused, 1 usage. No model, no network.

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
| `paths` | What the ticket's worker may write: a file, or a folder grant ending in `/**` |
| `expectedPaths` (optional) | The files the worker is expected to touch; by default the `paths` that are files |
| `estimate` | Input-side tokens for execution, check and rework; their sum may not exceed the authorization per ticket |
| `sensitivePaths` | Paths no ticket of this batch may plan to edit. Until the review of [ADR 0011](../../../decisions/0011-router-worker-batch-review.md) exists, a ticket that does is refused |
| `runId`, `date` (optional) | Default: `rw-<commit>-<N>` and today |

The PM does not write a ceiling, a number of rounds, a wrapper name or a
budget per ticket. Those come from the team.

## What the command does, in order

1. **The team**: two-root layout, live in Router/Worker mode, dispatch by the
   engine, no interrupted mode switch, no batch already open.
2. **The tickets**: each is complete (goal, acceptance, paths, estimate), and
   no two tickets claim the same file. A folder grant claims every file under
   it.
3. **The product repository**: on a branch that is not the default branch (the
   remote's default, `init.defaultBranch`, `main` or `master`), no Git
   operation in progress, nothing uncommitted or untracked. Git-ignored files
   are not counted. The team's own files are never counted: the team lives
   outside the product.
4. **The lock** on the product repository is taken.
5. **The write boundary** goes from "no batch open" to this batch: the exec
   worker may write the tickets' paths, the checker and the Guardian nothing.
6. **The engine's arguments are built and frozen**:

   | Argument | Value |
   |---|---|
   | rounds | the number of tickets |
   | output ceiling | N times the output allowance per ticket, plus the Guardian's share |
   | failure policy | halt on failure |
   | attempts per ticket | the team's limit (1 by default) |
   | authorization per ticket | the team's limit, the same for every ticket |
   | workers | the three wrappers the roster names |
   | baseline | the product's HEAD commit |

   The engine's own validator judges them in a dry run with no dispatch, and
   the static launch preflight's digest is chained into them.
7. **The isolation check** runs on the team and the product. Two findings are
   accepted by decision in a standing team: no sandbox around the workers'
   shell, and Git-ignored paths present.
8. **The batch record** `rw-batch.json` is written in the team's folder and
   printed. Its `args` are the arguments the PM passes to `run-n-rounds`.

Any refusal after step 4 closes the boundary again and releases the lock.

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
- The product repository is on its default branch, not on a branch, has a Git
  operation in progress, or has uncommitted changes (the first ten paths are
  listed).
- The lock is held.
- The batch cannot be frozen: an estimate above the authorization, a planned
  path under a sensitive path, a roster that does not staff the three workers.
- The launch preflight or the isolation check does not pass.

## Not covered

- **There is no "after" command yet.** Until it exists, closing a batch means
  releasing the lock with `scripts/lease-router-worker.mjs`, removing
  `rw-batch.json`, and the boundary stays open.
- **The estimated output** the engine is told is half the ceiling. It is a
  figure the kit sets so that the engine's own checks on the ceiling hold; it
  is not a forecast.
- **The Guardian's estimate** at settlement is the authorization of one ticket.
  ADR 0010 sets the Guardian's share of the output ceiling only.
- **The hook must be loaded** in the PM's session. The command checks that it
  is registered and that its file exists, not that the running session read it.
- **Nothing has run with real agents** from a batch record.
