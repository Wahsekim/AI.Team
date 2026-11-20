# A batch in a standing Router/Worker team

Status: "before", "after", "commit" and "abort" are built and tested offline
on a bootstrapped fixture, with the real engine run on mock agents; so is
"settle". The review of ADR 0011 is not built. Not yet used on a real team.
[ADR 0010](../../../decisions/0010-router-worker-second-mode.md), decisions 8 to 12.

```sh
node kit/scripts/rw-batch.mjs before BATCH.json --instance . [--start-as-is]
node kit/scripts/rw-batch.mjs after RESULT.json --instance .
node kit/scripts/rw-batch.mjs settle METER.json --instance . [--run <run id>]
node kit/scripts/rw-batch.mjs commit --instance .
node kit/scripts/rw-batch.mjs abort --instance .
```

Exit 0 done, 2 refused or (for `after` and `settle`) a batch in review, 1 usage. No model,
no network.

## The order of a batch

| Step | Who | What |
|---|---|---|
| 1 | PM | `before BATCH.json`: the batch is checked, frozen and opened |
| 2 | PM | runs `run-n-rounds` with the `args` of the batch record |
| 3 | PM | `after RESULT.json`, with the engine's return: the run is checked, the write limits close, the lock is released |
| 4 | PM | `scripts/reconcile-run.mjs RESULT.json .`: lifecycle and message ledgers, as in specialist mode |
| 5 | PM | `scripts/measure-spawn.mjs <session-dir> --json > METER.json`, then `settle METER.json`: usage per ticket. The next `before` is refused until this is done |
| 6 | PM | `commit`: one commit per ticket that passed; the batch is archived |

`abort` replaces steps 2 to 6 for a batch that will not be run. `settle` may
also come after `commit`, with `--run <run id>`, for an archived batch; it
must come before the next batch.

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
| `commitMessage` (optional) | The message of the ticket's commit, one line; by default `<id>: <title>` |
| `runId`, `date` (optional) | Default: `rw-<commit>-L<nextLifecycleNumber>-<time>`, new at every `before`, and today |

The PM does not write a ceiling, a number of rounds, a wrapper name or a
budget per ticket. Those come from the team.

## What "before" does, in order

1. **The team**: two-root layout, live in Router/Worker mode, dispatch by the
   engine, no interrupted mode switch, no batch already open, every archived
   batch that ran settled or marked as not metered, limits that are
   valid and are the ones the last ledger line binds (see "What decides the
   limits"). Every verification command of the batch is one of the commands the
   owner confirmed for the team (`allowedCommands` in its limits).
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
   paths, the checker and the Guardian nothing. The exec worker and the checker
   may run the batch's verification commands; see "The workers' shell".
9. **The batch record** `rw-batch.json` is written in the team's folder and
   printed. Its `args` are the arguments the PM passes to `run-n-rounds`. It
   also holds what "after" will need: the branch and commit, the paths that
   were already changed, each ticket's paths, the sensitive paths, the
   verification commands, the limits.

Any refusal after step 4 releases the lock, and closes the boundary if it was
opened.

## After

`after RESULT.json` takes the engine's return.

1. **Is it this batch's return?** The return is matched against the frozen
   arguments: run id, rounds, ceiling, attempts, the plan's tickets and workers
   in order, the Guardian's record, the lifecycle count. A return that does not
   match is refused and **nothing changes**: the lock stays held and the write
   boundary stays open.
2. **What the batch changed**: every path the work tree holds now that was not
   already there when the batch opened. Each path belongs to the ticket whose
   `paths` cover it, or to none.
3. **Findings**:

   | Finding | Meaning | Commits |
   |---|---|---|
   | `WRITE_OUTSIDE_PATHS` | paths changed that no ticket covers, for instance through a worker's shell | the paths are left uncommitted; the tickets are still committed |
   | `HOOK_SAW_NO_WORKER` | files changed and the hook logged no worker call since the batch opened: the session did not load it, so the write limits were not enforced during the run | not held |
   | `NESTED_REPOSITORY` | a worker created a Git repository inside the product; Git would commit a link to it, not its files | the folder is left uncommitted |
   | `PREEXISTING_PATH_CHANGED` | a path that was already changed when the batch started as is was changed again | not held; the path is never committed |
   | `LEDGER_NOT_WRITTEN` | `pm-decisions.md` could not be appended | not held |
   | `HOOKS_CHANGED` | the folder Git runs commit hooks from was moved, or a file in it was added, removed or changed since the batch opened | all held |
   | `HOOKS_WRITTEN` | a path was changed where the hooks live or beside husky's stub folder, for instance through a worker's shell | all held |
   | `BOUNDARY_CHANGED` | the write-boundary file is not the one the batch opened | all held |
   | `PRODUCT_HEAD_MOVED`, `PRODUCT_BRANCH_CHANGED` | someone committed or changed branch during the batch | all held |
   | `GUARDIAN_NOT_CLEAN` | the Guardian did not answer, or did not find the run clean | all held |
   | `BOUNDARY_NOT_RESTORED`, `LOCK_RELEASE_FAILED`, `LOCK_NOT_HELD_BY_THIS_BATCH` | the batch could not be closed completely | not held |

4. **The write boundary closes and the lock is released**, whatever the
   findings: a lock must not outlive its batch.
5. **The commit plan**: one commit for each ticket that passed and changed
   something, of that ticket's own paths. A ticket that did not pass, or was not
   run because the batch halted, is not in the plan. A ticket passed when the
   engine's record says it is done and nothing else in that record says
   otherwise (a failed verification, a pending fix or recovery).
6. **The record** `rw-batch-after.json` and one line in `pm-decisions.md`.
   `status` is `clean` when there is no finding and the engine reports no
   blocker, otherwise `review`. `next` says what the PM must do when something
   is left or held. `limits` lists each limit that stopped work, for the owner
   (see "What decides the limits"): the engine halted on its output ceiling
   (`outputAllowancePerTicket`, observed as the output metered per ticket
   dispatched); a ticket whose clean execution failed its check on the last
   attempt allowed (`attemptsPerTicket`, with the tickets); a worker's shell
   command the hook refused during the batch (`allowedCommands`, observed as the
   command's text, at most 20). Empty when none applies.

The close is claimed before anything is changed. A second `after` on the same
batch is refused while the first is under a minute old; an `after` that died is
taken up by the next call, which recognises the boundary it already closed
(the batch's own three workers, no write path) and the lock it already
released. A claim with no readable time, or one from the future, counts as
dead. The take-over is not exclusive: an `after` that runs for more than a
minute could be taken over while it still runs.

"All held" means the kit commits nothing of that batch: what ran is not what
was frozen, and the PM or the owner judges it by hand.

## The workers' shell

Nobody answers a permission prompt in a batch the owner does not attend
([ADR 0010](../../../decisions/0010-router-worker-second-mode.md), amendment of
2026-11-18). The team's limits hold the list of commands a worker may run,
`allowedCommands`: proposed from the required gates of `profiles/stack.md`,
shown in the switch proposal and confirmed by the owner with it, changed later
with `team-mode.mjs limits` and the same confirmation.

While a batch is open, the hook that bounds the workers' writes also judges
their shell:

| Call | Decision |
|---|---|
| exec worker or checker, `cd "<product root>" && <command>` with a command of the batch | approved: no permission prompt |
| the same with the product root unquoted, when its path needs no quotes | approved |
| the same command alone, when the shell is at the product root | approved |
| any other text: an argument added, two commands joined, a pipe, another folder, a command of the team's list that is not this batch's | refused, and the refusal names the commands that run |
| a confirmed command asked to run outside the sandbox | refused |
| the Guardian, any command | refused |
| any worker when no batch is open | refused |
| any subagent when the boundary file is missing or was changed | refused |
| the PM's session; a governance role while the boundary file is intact | not judged |

The text must be the confirmed command exactly; only spaces and line breaks
around it are ignored. A worker reads files with its file tools; it has no
`ls`, `cat` or `git` in a batch. A command a ticket needs and the list lacks is
the owner's to add, before the batch.

A command is confirmed as one line of at most 300 printable ASCII characters
with single spaces, so that what the owner reads in the proposal is all there
is. `before` refuses a product repository whose path cannot be written inside a
quoted shell command.

A team that went live before the list existed has an empty one, and a boundary
that does not judge its workers' shell. `before` refuses its batches until the
owner confirms the commands with `team-mode.mjs limits`, which also closes
that shell.

## Settle

`settle METER.json` sets each ticket's measured usage against its
authorization. `METER.json` is what `scripts/measure-spawn.mjs` reads from the
session's transcripts: one row per agent, with its tokens.

1. The engine's return, kept by `after` (`rw-batch-return.json`), must still
   be the return the batch was closed with: its digest is in the record of
   `after`.
2. A session holds the engine runs of every batch it ran. The engine names
   the run in the Guardian's brief (`Loop config: runId=<run id>`): the run
   settled is the one whose Guardian transcript names this batch's run id. A
   meter in which no run is named so, or two are, is refused. Two batches of
   the same tickets have the same briefs; the id is what tells them apart.
3. The metered agents of that run must be the calls of the batch, in the
   engine's order: execute and check for each ticket that ran, then the
   Guardian.
4. A call whose transcript does not carry the brief frozen for it is a
   finding (`BRIEF_NOT_FOUND`).
5. Per ticket: tokens spent, tokens authorized, and a gate that is `blocked`
   when the authorization is used up. The Guardian's usage is compared with its
   own figure.

The record is `rw-batch-settlement.json`, archived with the batch
(`settlement.json`); one line goes to `pm-decisions.md`. Its `limits` list holds
one `authorizationPerTicket` entry when a ticket used more than 80% of its
authorization: the largest usage observed, the tickets, and a proposal; empty
otherwise. `status` is `clear`
or `review`; exit 2 on review. A batch is settled once.

`settle` takes no lock. With `--run` it settles an archived batch, committed
or abandoned; without it, a batch whose archive already exists is settled in
its archive. If `commit` or `abort` archives the batch while it is being
settled, the settlement is moved into the archive. A record of an earlier
batch still in the team's root when the next batch opens (commits made,
return, settlement) belongs to no batch and is removed by `before`.

**The next batch waits for it**
([ADR 0010](../../../decisions/0010-router-worker-second-mode.md), second
amendment of 2026-11-18). `before` refuses while an archived batch that ran
(its archive holds the record of `after`) has no settlement, and names the
batch and the two commands. The settlement counts only when it is a sealed
settlement or mark of that run (its stage, its run id the name of the archive,
its digest). Only folders in `batches/` are read. A batch aborted before
`after` leaves no archive, and so nothing to settle, whether or not the engine
ran.

A batch whose usage cannot be measured (the session's transcripts are gone, its
records are damaged) is marked instead:

```sh
node kit/scripts/rw-batch.mjs settle --not-metered "<reason>" --instance . [--run <run id>]
```

The reason is one line of at most 200 characters, with no line separator or
bidirectional control. The mark takes the place of the settlement
(`stage: batch-not-metered`) and one line goes to `pm-decisions.md` before it,
which is where the owner sees which batch was passed over and why: a line that
cannot be written leaves no mark. Without `--run`, the run id read from the
closed batch must be the batch record's. A batch is settled or marked once.

Settlement reports cost. It does not hold or undo a commit: a ticket that went
over its authorization and passed its check is still committed. The
authorization is a limit judged afterwards, as ADR 0010 says; what a batch over
it should cost the team is the PM's and the owner's to decide.

## Commit

`commit` makes the planned commits on the batch's branch, in the order of the
tickets, then moves the batch's records to `batches/<run id>/` and appends one
line to `pm-decisions.md`. It takes the lock for its length. It pushes nothing.

- It refuses when the product is no longer on the batch's branch, when a Git
  operation is in progress, when the commit hooks were changed or moved, when
  an archive of this batch was already started, when the work
  tree is not exactly what `after` saw, or when the branch is not the batch's
  starting commit plus the commits this command itself made.
- The plan is derived again from the tickets: a path is committed only inside
  the paths of a ticket that passed.
- After each commit it checks that the commit landed on the branch and holds
  exactly the ticket's paths. A commit hook that adds or drops paths stops the
  batch there; the commit is left as it is.
- Paths are given to Git literally, on standard input: no pattern, no limit on
  their number. Staged deletions and renames made by a worker are committed.
- A path that was changed before the batch (start as is) is never in a commit,
  staged or not.
- The repository's own commit hooks run. If one refuses a commit, the commits
  already made stay, the batch stays open, and running `commit` again makes
  only what is missing. The commits made are recorded by their ids
  (`rw-batch-commits.json`), so a hook that rewrites messages does not confuse
  the resume. Each recorded commit is checked again to hold its ticket's paths.
  A commit made just before the command died, and so never recorded, is taken
  up when it is the next planned one: its parent is the expected commit and it
  holds exactly that ticket's paths. A commit made by hand that fits the same
  description is taken up too; the kit compares paths, not content.
- A commit is made with the repository's identity, or the one given in
  `GIT_AUTHOR_*` and `GIT_COMMITTER_*`. Every other `GIT_*` variable is ignored.
- A `commit` that died after archiving the batch is finished by the next call.
- What is not committed stays in the work tree and is listed (`left`): a ticket
  that did not pass, a path outside every ticket. The next "before" then
  refuses until the PM commits or discards those paths, or starts as is.

The commits are made by the PM's session running this command, with the
repository's Git identity ([ADR 0007](../../../decisions/0007-pm-only-commits.md)).

## When the kit will not commit a batch

A batch that `after` closed and `commit` refuses (all commits held, the branch
moved, a hook changed a commit, the records were edited) is not stuck:
`abort` closes the write boundary and releases the lock if `after` did not get
that far, archives the records under `batches/<run id>/` with a note, writes
"ARCHIVED WITHOUT COMMIT" to `pm-decisions.md`, and commits nothing. Commits
the kit had already made for the batch stay on the branch and are named. The
rest of what the batch changed is still in the product work tree; the PM or the
owner commits it by hand on the working branch, or discards it. `abort`
releases any lock this team holds, so it must not be run while a `commit` of
the same team is running. The next "before" then needs a
clean repository or "start as is", as after any batch that left paths behind.

## Commit hooks

A commit runs the repository's hooks, as the PM's user. "Before" records where
Git runs them from (links resolved) and a digest of the files there, and
refuses a ticket that would write in that folder, in the folder a link to it
points at, or beside husky's `_` stub folder. `after` holds every commit of a
batch during which a hook file appeared, changed or was moved, also in
`.git/hooks`, and `commit` checks again.

A tool that installs hooks during a batch (husky's `prepare`, lefthook,
git-lfs), or a stray file such as `.DS_Store` in the hooks folder, holds the
whole batch for the same reason. Files in subfolders of the hooks folder are
not compared.

This finds a hook that was written or moved. It does not find a hook that calls
a script a worker edited (`npm test`, a lint script): such a hook runs the
worker's code at commit time. Workers already run as the PM's user with no
sandbox ([ADR 0010](../../../decisions/0010-router-worker-second-mode.md),
decision 3), so this adds no access they did not have during the batch.

## What these commands trust

`after` trusts the engine's return for what happened in the run; it checks that
the return fits the frozen batch and that a ticket's own record is consistent,
not that the checker really ran. The batch records carry digests that detect an
accidental edit, not a deliberate one: a PM session can rewrite a record and
its digest. What reaches a path, the ledger or a commit message is therefore
checked again when it is read, and the commit plan is derived again from the
tickets. A PM that edits the engine's return can still get a failed ticket
committed.

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

Only the owner changes them
([ADR 0010](../../../decisions/0010-router-worker-second-mode.md), amendment of
2026-11-20): at the switch or with `team-mode.mjs limits`, by a code typed at a
terminal. Three mechanisms hold that:

- **The ledger binds them.** The `MODE SWITCH` line into Router/Worker mode and
  each `LIMITS CHANGED` line end with `limits <digest>`. `before` refuses
  (`LIMITS_NOT_BOUND`) when the digest of the profile's limits is not the one
  on the last such line, and names `team-mode.mjs limits`. A team that went
  live before lines carried a digest is refused the same way; the owner binds
  its limits with `team-mode.mjs limits` and `{}`, a request that changes
  nothing, which is accepted only while the limits are unbound. The proposal
  then says so (`unbound`).
- **No file tool writes them.** The hook refuses a Write, Edit, MultiEdit or
  NotebookEdit of the team's `profiles/team-mode.json` from any session, the
  PM's included, whatever path, case or link names it. A shell command that
  writes the file is not judged by the hook; the ledger digest catches it at
  the next `before`.
- **The kit reports, the owner decides.** `after` and `settle` list the limits
  that stopped or nearly stopped work, each with `limit`, `observed`, `current`
  and `proposal`: a LIMITS.json fragment the owner may confirm. A token value
  is proposed as the next thousand above 1.25 times what was observed; an
  attempts value as one more, up to 3; a refused command gets no proposal.
  Nothing writes a limit from that list.

A PM session that forges a ledger line together with the digest of the limits
it wrote is not detected (see "What these commands trust").

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

The limits not being the ones the ledger binds is refused with its own code,
`LIMITS_NOT_BOUND`.

## Not covered

- **A batch the engine ran and `abort` cleared before `after`** is not
  settled and does not hold the next batch: `abort` leaves no archive for it,
  and the kit cannot tell whether the engine ran. Its ledger line says only
  that the batch was aborted and that nothing about the work was checked.
- **`commit` does not wait for the settlement**; the next `before` does. The
  mark "not metered" is the PM's word: the kit records the reason and does not
  judge it. The owner reads those lines at the spot review.
- **The meter is trusted.** `settle` checks that the transcripts carry the
  frozen briefs and are in the engine's order, not that they are the real ones.
  The run is told by the id in the Guardian's brief (the user's request, which
  the runtime puts first in each transcript, is not read), which is the engine's
  own wording: an engine that words it differently makes `settle` refuse, and
  the tests read that wording from the real engine.
- **Two runs of one id in one session** are refused by `settle`: the same
  batch record run twice, or a `runId` written in BATCH.json and used again
  after an `abort` that made no archive.
- **A run whose Guardian left no transcript** cannot be settled: nothing names
  it.
- **`settle` at the same moment as `commit` or `abort`** can lose its record
  in the instant the archive is made; the ledger line is then the only trace,
  and `settle --run <run id>` writes it again.
- **The authorizations are those of the batch record**, which `before` froze
  from the team's limits. `settle` does not read the limits again.
- **What a confirmed command does is not bounded.** The list bounds which
  commands a worker starts, not what they write: a test runner writes its
  caches, and a script named in the list does whatever it holds. A worker that
  may write a file the command runs can change what the command does; the
  after-run check and the commit plan still judge every changed path.
- **The approval has not run with real agents.** That the runtime skips the
  permission prompt on the hook's decision is taken from Claude Code's
  documentation, which also says a `deny` or `ask` rule in the settings still
  applies, and that no decision approves "actions no mode auto-approves". It
  is first exercised in the attended run on the real team.
- **A hook that cannot run decides nothing.** If the hook's file is missing or
  fails to load, the runtime sends the call to the session's own permissions.
- **The list is as protected as the other limits** (see "What decides the
  limits"). An edit of the boundary file by hand is not prevented; an edited
  boundary is refused by the hook and reported by `after` only if its digest
  was not recomputed.
- **The hook log keeps the text of a worker's refused shell command** (at most
  300 characters), so that `after` can report it. Values that look like
  secrets are replaced by `<redacted>` first: a `NAME=value` whose name holds
  TOKEN, SECRET, PASS, KEY, AUTH or CRED, an `Authorization`, `Cookie` or
  `X-Api-Key` header, credentials in a URL, and any run of 32 or more
  letters, digits or `+_=-` (a path keeps its slashes). A secret in another shape is still kept in
  `.claude/rw-write-boundary.log.jsonl` and in the record.
- **The briefs and the shared disciplines still speak of a free shell**: an
  environment prefix before a command, `git diff` to report a change. Those
  calls are refused in a batch.
- **Only the three workers are bounded.** The PM's session and the governance
  roles keep the shell their own permissions give them.
- **The review of [ADR 0011](../../../decisions/0011-router-worker-batch-review.md)
  is not built.** Until then a ticket that passed its check is committed with
  no security or architecture review, and a ticket that could write a sensitive
  path is refused by "before".
- **A ticket that did not pass keeps its changes in the work tree.** They are
  not saved aside and removed; ADR 0011 does that for a rejected ticket.
- **Git-ignored files a worker wrote are invisible**, inside or outside the
  tickets' paths. ADR 0010 tolerates ignored build output; nothing compares it
  with the state before the batch.
- **Not tried:** commit signing, LFS or clean filters, sparse checkout, linked
  worktrees.
- **The default branch is recognised by name**: every remote's default,
  `init.defaultBranch`, `main`, `master`. A repository with no remote whose
  default branch has another name (`develop`) is not recognised.
- **A forged ledger line is not detected** (above).
- **The estimated output** the engine is told is half the ceiling. It is a
  figure the kit sets so that the engine's own checks on the ceiling hold; it
  is not a forecast.
- **The Guardian's estimate** at settlement is the authorization of one ticket.
  ADR 0010 sets the Guardian's share of the output ceiling only.
- **The hook must be loaded** in the PM's session. The command checks that it
  is registered and that its file exists, not that the running session read it.
- **Nothing has run with real agents** from a batch record.
