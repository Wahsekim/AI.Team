# A batch in a standing Router/Worker team: reference

The detail behind the PM's runbook, [batch.md](batch.md): what each command
checks and records, the rules of moves, resume, reviews and limits, and what
the kit does not cover. The runbook sends you to a section here by its title.
[ADR 0010](../../../decisions/0010-router-worker-second-mode.md), decisions 8 to 12;
[ADR 0011](../../../decisions/0011-router-worker-batch-review.md) for the review.

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
| `sensitivePaths` | Paths whose tickets Security always reviews ([ADR 0011](../../../decisions/0011-router-worker-batch-review.md), decision 6). They are judged against `paths`, which is what bounds the worker, not against the plan: a ticket whose grant covers a sensitive path, or lies under one, is declared sensitive (`sensitivePath:<entry>`). An entry written as a bare folder (`src/auth`) guards everything under it. At least one entry |
| `riskFlags` (optional) | 1 to 10 plain names (`auth`, `payments`), each named once. Each declares the ticket sensitive (`riskFlag:<name>`). What a ticket declares is frozen in the record as its `declared` list. A declared-sensitive ticket that passed and changed something is flagged for Security on every changed path, even when no trigger matches, and is not committed without a passed Security verdict; one that changed nothing is not committed, so it is not flagged |
| `commitMessage` (optional) | The message of the ticket's commit, one line; by default `<id>: <title>` |
| `dependsOn` (optional) | Ids of tickets this one builds on: an earlier ticket of the batch, or a ticket of an archived batch. Frozen in the record (`[]` when absent); an escalated ticket blocks every ticket that depends on it, directly or through others (see "Review verdict, commit gate and escalation") |
| `moves` (optional) | Tracked files the worker renames: `[{ "from": "src/a.js", "to": "lib/a.js" }]`. Each gives the exec worker one exact command, `mkdir -p -- "<folder>" && git --literal-pathspecs mv -- "<from>" "<to>"`, where `<folder>` is the folder of `to` (Git does not create it, and an earlier `git rm` may have removed it); a `to` at the top of the product gives the `git mv` alone. An empty list declares nothing, as an absent one. Frozen in the record (`[]` when absent). See "Moves and deletions" |
| `deletes` (optional) | Tracked files the worker deletes: `["src/old.js"]`. Each gives the exec worker one exact command, `git --literal-pathspecs rm -q -- "<path>"`. An empty list declares nothing, as an absent one. Frozen in the record (`[]` when absent) |
| `verificationCommands` (optional, per ticket) | 1 or more of the batch's `verificationCommands`, each once. The ticket's exec and check briefs list only these, so a ticket that changes a document need not run the product's test suite. Absent, the ticket runs the batch's whole list. The hook still accepts the batch's whole list from any worker, and the review's re-verification runs the whole list. Frozen in the ticket's entry of the record when given |
| `resume` (optional) | A patch in the team's folder that holds the work an earlier batch left for this ticket, as `left` prints it: `"left/<run id>/US-08.patch"`. "before" applies it to the product, so what it changes is the ticket's. See "Resuming left work" |
| `runId`, `date` (optional) | Default: `rw-<commit>-L<nextLifecycleNumber>-<time>`, new at every `before`, and today |

The PM does not write a ceiling, a number of rounds, a wrapper name or a
budget per ticket. Those come from the team.

## What "before" does, in order

1. **The team**: two-root layout, live in Router/Worker mode, dispatch by the
   engine, the gate path off (`gatePath` false or absent in
   `profiles/team-mode.json`; anything else is refused with
   `GATE_PATH_REFUSED`, ADR 0010 decision 15), no interrupted mode switch, no batch already open, every archived
   batch that ran settled or marked as not metered, limits that are
   valid and are the ones the last ledger line binds (see "What decides the
   limits"), a valid review trigger list (see "Review triggers"), no batch in
   review, and both reviewers staffed: the roster names a wrapper for
   `security` and for `architect` whose file declares that same name (owner
   decision of 2026-11-20). No ticket of the batch is blocked by an escalation
   the owner has not acknowledged (see "Review verdict, commit gate and
   escalation"; refused with `TICKET_ESCALATED`).
2. **The tickets**: each is complete, and no two tickets claim the same file. A
   folder grant claims every file under it; for this question alone paths are
   compared without case, since on a case-insensitive file system `src/A.js`
   and `src/a.js` are one file. Each file a ticket moves or deletes is one
   plain path inside its `paths` (see "Moves and deletions"), compared with
   case, as `after` and the hook compare: a path that its grant covers only in
   another case is refused with the spelling to use. Every verification command of the batch is one
   of the commands the owner confirmed for the team (`allowedCommands` in its
   limits); this is checked right after the tickets, before the escalations and
   the product, and again under the lock.
3. **The product repository**: on a branch that is not a default branch, no Git
   operation in progress, nothing uncommitted or untracked. Under the lock
   (step 4), a ticket's path, folder grant, expected path, move or delete that
   names a tracked file, or an existing file or folder, in another case than
   Git gives it, or, for a part Git does not track, the file system, is
   refused where the file system folds case (an exact name always wins), and
   the refusal gives the spelling to use and which of the two gave it: Git reports the work in its own spelling, and `after`
   would find it outside the ticket. Git-ignored files
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
   may run the batch's verification commands, and the exec worker the Git
   commands of the tickets' moves and deletions; see "The workers' shell".
   Each ticket's `resume` patch is then applied to the work tree (see
   "Resuming left work").
9. **The batch record** `rw-batch.json` is written in the team's folder, last,
   and printed. The ledger lines of the batch (started as is, commits made
   outside the kit, runs again, resumes, review triggers) are appended just
   before it: a `before` that dies between leaves lines of a batch that never
   opened (no record, no archive under that run id), and the next `before`
   writes them again under its own run id. Its `args` are the arguments the PM passes to `run-n-rounds`. It
   also holds what "after" will need: the branch and commit, the paths that
   were already changed, each ticket's paths, the sensitive paths, the
   verification commands, the limits. It holds `outsideCommits`, the commits
   made outside the kit (below): `{since: {runId, commit}, commits: [id,
   ...], count}`, the first 100 ids, oldest first, and how many there are, or
   `{since, commits: null, reason}` when they could not be told (`since` is
   null when no batch was archived on the branch, and its `commit` is null when
   the newest archive on the branch cannot be read). Each ticket's entry holds
   `earlierRuns` (below): `{runs: [{runId, ticket, status}], count}`, the
   newest 20 runs, oldest batch first, and how many there are (`runs` is
   empty and `count` 0 when there are none).

Any refusal after step 4 releases the lock, and closes the boundary if it was
opened. A patch already applied in step 8 is taken back out of the work tree.

**Commits made outside the kit** ([ADR 0011](../../../decisions/0011-router-worker-batch-review.md),
amendment of 2026-11-26) are read with the lock held. The newest archived
batch on the same branch (by `openedAt`) ended at its last kit commit
(`commit.json`, or `commits.json` for a batch aborted part-way through
`commit`), or at its start commit when the kit committed nothing. When that end
is an ancestor of HEAD, every commit between them was made outside `commit`:
by hand, by a merge, or during the batch itself. The first 100 of their ids
and their count are frozen in the record, so a merge that brings thousands of
commits does not swell it, and once the record is written one ledger line
names them for the owner's spot review: `BATCH <run> COMMITS MADE OUTSIDE THE
KIT (owner spot review): <n> commit(s) on <branch> since batch <run> ended at
<commit> (<the first ten ids>, ...)`. There is no line when there are none.
With no archived batch on the branch the record says so, and there is no line.
When an earlier batch is archived on the branch and the commits cannot be told,
the record gives the reason and one line says it, for the owner's spot review:
`BATCH <run> COMMITS MADE OUTSIDE THE KIT CANNOT BE TOLD (owner spot review): on
<branch> since batch <run>: <reason>`. The reasons are: the end is not an
ancestor of HEAD (the branch was rebuilt by hand); Git could not tell whether
it is, or could not list the commits (a commit the repository does not hold, a
command that failed or ran past a minute), with Git's own error; the batch
record of the newest archive on the branch cannot be read. An archive whose
batch record cannot be read is placed by the times its other records carry
(`after.json`, `abandoned.json`, `commit.json`) and by the branch `commit.json`
names; with no time it counts as the newest, and with no branch as one on this
branch, since otherwise its own commits would be counted as made outside the
kit against an older batch. Nothing is refused on any of this. A batch aborted
before `after` is not archived, so the next batch names the same commits again.

**Earlier runs of a ticket** ([ADR 0010](../../../decisions/0010-router-worker-second-mode.md),
amendment of 2026-11-26, "the kit saves left work and counts its runs"). For each
ticket, the archived batches in which the engine ran a ticket of the same id
(compared without case), or one whose `paths` overlap its `paths` (the
comparison of two tickets claiming one file), and the kit did not commit it.
The engine ran a ticket when `after` recorded an outcome for it (`passed` or
`not-passed`; a ticket the engine never reached, `not-run`, is not a run). The
kit committed it when the archive's `commit.json` or `commits.json` lists a
commit for it. Each entry is `{runId, ticket, status}`: the archived batch, the
ticket's id there, and its status. Once the record is written, one ledger line
per such ticket names them for the owner's spot review: `BATCH <run> RUNS
<ticket> AGAIN (owner spot review): <n> earlier run(s) by the engine that the
kit did not commit: ..., <run> as <ticket> (<status>)` (the newest ten, after
`...,` when there are more).
Nothing is refused: whether a count should stop a batch is the owner's to
decide, and [ADR 0008](../../../decisions/0008-router-worker-topology.md) sets
the attempts within one run. Each archive's batch record is read once, its
`after.json`, `commit.json` and `commits.json` once each, with no Git call, so
the scan stays small however many batches a team archived.

## After

`after RESULT.json` takes the engine's return.

1. **Is it this batch's return?** The return is matched against the frozen
   arguments: run id, rounds, ceiling, attempts, the plan's tickets and workers
   in order, the Guardian's record, the lifecycle count. A return that does not
   match is refused and **nothing changes**: the lock stays held and the write
   boundary stays open.
2. **What the workers did.** The findings that need no command come first:
   the boundary, the branch, the hooks, the Guardian, the hook log
   (`HOOK_SAW_NO_WORKER`, `CHECK_RUNS_MISSING`) and the paths the workers
   changed outside every ticket (`WRITE_OUTSIDE_PATHS`). They describe the run,
   so they are judged on the tree the workers left, before anything below
   changes it.
3. **The work of each ticket that did not pass is set aside.** When none of
   those findings holds every commit and at least one ticket passed, each
   ticket that did not pass, or was not run, and whose paths show as changed is
   saved as a binary patch at `left/<run id>/<ticket>.patch` in the team folder
   and taken out of the product tree, with the step `left` uses (see "Resuming
   left work"): nothing is removed before the patch is on disk, and a patch
   already at that place is never written over. The engine halts a batch at its
   first failed ticket, so "earlier tickets passed, the last one failed" is the
   usual shape of a batch with a failure, and that ticket's code would
   otherwise fail the commands of the passed ones. The record lists each in
   `setAside`: `{ticket, state: "patch", patch, paths, resume, resumeProblem?}`,
   where `paths` are the paths taken out, which `left` counts as that ticket's
   once the PM has applied the patch back, and `resume` is the value a ticket
   of a later batch names to take the work back, or null with `resumeProblem`
   when `before` would refuse the patch as it stands; or `{ticket, state: "in-tree", paths, problem, patch?}` for a ticket
   that could not be set aside (a Git operation in progress, a patch with other
   bytes already there, a removal that failed), of which nothing was removed,
   or, after a removal that failed part-way, whose saved patch is the complete
   one. `next` names each patch and its `resume` value, and the ledger line
   names each ticket set aside with its patch. An `after` that takes over from
   one that died between two set-asides finds the patch the dead one saved for
   a ticket no longer in the tree and lists that ticket the same way, its
   `paths` read from the patch.
4. **The kit verifies the tree it would commit.** Only when every changed path
   in the tree is a path of a passed ticket (no path outside every ticket, no
   path changed before the batch, no ticket left in the tree by a failed
   set-aside, no nested repository) does `after` run the commands. It runs the
   union of the passed tickets' own `verificationCommands` (a ticket without
   its own list uses the batch's list), in the batch's order: a command every
   passed ticket left out is one the PM said they do not need. It runs them on
   the product as it stands, from the product root, under the lock the batch
   still holds, as `review-brief` runs its commands: only those that are both
   frozen in the batch and still in the team's confirmed `allowedCommands`
   (`/bin/sh -c`, 15 minutes each, output truncated and digested). A command
   that failed or timed out is run once more, after the others: `after` cannot
   be run again once it closed the batch, so one flaky run must not hold it for
   good. The record keeps the run in `verification`: `{ran, failed, commands:
   [{command, exit, timedOut, overflowed?, outputDigest, tail, again?}],
   dropped}`, where `again` is the second run of that command (`{exit,
   timedOut, overflowed?, outputDigest, tail}`) and `overflowed` is true when
   the output passed the runner's buffer limit (64 MiB), which also stops the
   command. A command whose second run failed too, or no confirmed command
   left to run, is the finding `VERIFICATION_FAILED`: the kit cannot tell which ticket broke the tree, so
   it commits none. Then the hooks are judged again on the tree as the
   commands left it: a command that writes into the folder Git runs hooks from
   (`HOOKS_CHANGED`) or beside husky's stub folder (`HOOKS_WRITTEN`) holds every
   commit, as a worker's write does. When something else is in the tree,
   `after` runs no command: `verification` is `{ran: false, failed: false,
   commands: [], dropped: [], reason, paths}`, with the paths in the way, the
   finding `VERIFICATION_NOT_RUN` carries the same `reason` and `paths`, `next`
   says that the kit did not verify the tree it will commit and why, and the
   passed tickets are planned as before. A batch another finding holds, or one
   with no ticket passed, sets nothing aside and runs no command
   (`ran: false`, no `reason`). A batch an earlier kit opened is verified the
   same way, from the commands its record froze.
5. **What the batch changed**, read again after the commands ran, since they
   may write files (a generator, a formatter): every path the work tree holds
   now that was not already there when the batch opened. Each path belongs to
   the ticket whose `paths` cover it, or to none. What `after` pins is what the
   commands left, a path one of them wrote outside every ticket is added to
   `WRITE_OUTSIDE_PATHS`, and `commit` compares the tree with that.
6. **Findings**:

   | Finding | Meaning | Commits |
   |---|---|---|
   | `WRITE_OUTSIDE_PATHS` | paths changed that no ticket covers, through a worker's shell (judged at step 2) or written by the kit's run of the commands (step 5) | the paths are left uncommitted; the tickets are still committed |
   | `HOOK_SAW_NO_WORKER` | files changed and the hook logged no call of the batch's three workers since the batch opened (a call of another agent of the team does not count): the session did not load it, so the write limits were not enforced during the run, or the hook ran and could not append to its log. A resumed path that still holds what `before` applied is not such a change | all held |
   | `VERIFICATION_FAILED` | the kit's own run of the passed tickets' verification commands on the tree of the planned commits (step 4) had a command that failed or timed out, and again when run a second time (`commands`: each with the second run's `exit`, `timedOut`, and `overflowed` when its output passed the buffer limit), or no confirmed command left to run (`commands` empty, `dropped` the ones the passed tickets need). `next` names the commands, then `abort` and `left` | all held |
   | `VERIFICATION_NOT_RUN` | the kit did not run the commands, since the tree held more than the planned commits after step 3 (`reason`, and `paths`: each path in the way, changed before the batch, outside every planned commit, or of a ticket that could not be set aside). `next` says the kit did not verify the tree it will commit, and why | not held |
   | `CHECK_RUNS_MISSING` | for a verification command of the batch, the hook logged fewer approved runs of it by the checker since the batch opened than there are passed tickets that verify with it (a ticket without its own `verificationCommands` verifies with the batch's whole list). Lists each such command with `needed` and `seen`. A run by the exec worker does not count. The log does not say which ticket's checker skipped its run, so no ticket is told apart. Not checked for a batch an earlier kit opened, whose hook did not log approved commands | all held |
   | `NESTED_REPOSITORY` | a worker created a Git repository inside the product; Git would commit a link to it, not its files | the folder is left uncommitted |
   | `PREEXISTING_PATH_CHANGED` | a path that was already changed when the batch started as is was changed again | not held; the path is never committed |
   | `LEDGER_NOT_WRITTEN` | `pm-decisions.md` could not be appended | not held |
   | `HOOKS_CHANGED` | the folder Git runs commit hooks from was moved, or a file in it was added, removed or changed since the batch opened, judged before the kit's run of the commands and again after it. A commit by hand runs the hooks as the PM, so `next`, the refusal of `commit` and `abort` tell the PM to inspect that folder and remove every hook the batch added or changed before any commit by hand | all held |
   | `HOOKS_WRITTEN` | a path was changed where the hooks live or beside husky's stub folder, through a worker's shell, or by the kit's run of the commands (judged again after it) | all held |
   | `BOUNDARY_CHANGED` | the write-boundary file is not the one the batch opened | all held |
   | `PRODUCT_HEAD_MOVED`, `PRODUCT_BRANCH_CHANGED` | someone committed or changed branch during the batch | all held |
   | `GUARDIAN_NOT_CLEAN` | the Guardian did not answer, asked to halt and investigate, or found a runaway or a failed check at risk of being dropped; or the engine's own figures show a budget gate that did not behave (`budgetGate: inconsistent`): `tripped` does not match the final spend against 80% of the ceiling, or, for a standing batch, the engine's trace of its gate decisions (`budgetStatus.gateTrace`) is missing or malformed, shows a call dispatched at or above that line or one declined below it, or shows fewer or more dispatched exec and checker calls than the return reports. Only then do the engine's blockers name the Guardian (`guardian-unavailable` or `guardian-not-clean`) | all held |
   | `GUARDIAN_ATTENTION` | the Guardian found no such problem but did not call the run clean (`missedHaltRisk`, or `budgetGateCorrect: false` with consistent engine figures). The engine tells the Guardian of a batch that no observer watches the run by design, that the PM attests an owner stop or a hardware halt after it (`reconcile-run.mjs --monitoring`), and that the ceiling comes from the owner's limits, so neither the missing observer nor a ceiling far above the spend is a finding, and a Guardian that finds nothing wrong answers `clean`. Its findings are in the engine's return for the PM to read; no blocker names the Guardian. A batch held by another finding is not put in review | not held |
   | `BOUNDARY_NOT_RESTORED`, `LOCK_RELEASE_FAILED`, `LOCK_NOT_HELD_BY_THIS_BATCH` | the batch could not be closed completely | not held |

7. **The write boundary closes and the lock is released**, whatever the
   findings: a lock must not outlive its batch. When a ticket is flagged for a
   reviewer the boundary goes to the review state instead of closed (see
   "Review state and brief").
8. **The commit plan**: one commit for each ticket that passed and changed
   something, of that ticket's own paths. A ticket that did not pass, or was not
   run because the batch halted, is not in the plan. A ticket passed when the
   engine's record says it is done and nothing else in that record says
   otherwise (a failed verification, a pending fix or recovery).
9. **The record** `rw-batch-after.json` and one line in `pm-decisions.md`.
   `status` is `clean` when there is no finding, the engine reports no
   blocker and no ticket is flagged for a reviewer, otherwise `review`. `next` says what the PM must do when something
   is left or held. `limits` lists each limit that stopped work, for the owner
   (see "What decides the limits"): the engine halted on its output ceiling
   (`outputAllowancePerTicket`, observed as the output metered per ticket
   dispatched); a ticket whose clean execution failed its check on the last
   attempt allowed (`attemptsPerTicket`, with the tickets); a worker's shell
   command the hook refused during the batch (`allowedCommands`, observed as the
   command's text, at most 20). Empty when none applies.

The close is claimed before anything is changed, and the claim names the
process that made it (`pid`). Since `after` runs the verification commands, it
can run for as long as the product's checks take: a second `after` on the same
batch is refused while the claim's process is alive, however old the claim.
The refusal names `abort` as the way out when that process is not an `after`
of this batch any more (the system gave its id to another program). An
`after` whose process is gone is taken up by the next call, which
recognises the boundary it already closed (the batch's own three workers, no
write path) and the lock it already released, and runs the commands again. A
claim that names no process, written by an earlier kit, is taken to be running
while it is under a minute old; one with no readable time, or one from the
future, counts as dead.

"All held" means the kit commits nothing of that batch: what ran is not what
was frozen, or the tree fails its verification and no ticket can be told
apart, and the PM or the owner judges it by hand. Such a batch is not put
in review. Each ticket still keeps the reviewers it needs (`tickets[].review`).
`next` names `abort`, which archives the batch and takes each ticket flagged for
review out of the work tree as a patch (see "Abort"), then `left`, which does
the same for every other ticket's work (see "Resuming left work"): only what
belongs to no ticket may then be committed by hand. When a batch that is not
held leaves paths behind, `next` names `left` too, to run once the batch is
committed or archived.

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
| exec worker, the same with a Git command of the batch's declared `moves` or `deletes` (see "Moves and deletions") | approved; the checker and the Guardian are refused it |
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
`ls`, `cat` or `git` in a batch, apart from the exact Git commands of the
batch's declared moves and deletions. Each brief of a standing batch says so,
and gives the path rule: a team-relative path (`agents/...`, `docs/...`) is
read in the team root when it exists there, otherwise under `kit/`, and the
ticket's paths are relative to the product root. A command a ticket needs and the list lacks is
the owner's to add, before the batch.

The hook logs every call in `.claude/rw-write-boundary.log.jsonl` of the team
folder. The checker's approved call carries the verification command it
matched, as the batch froze it (without the `cd`); the exec worker's approved
call carries none, since its moves and deletions name product paths; a refused
call carries its own text, redacted (see "Not covered"). `after` counts the
checker's approved runs of each command (`CHECK_RUNS_MISSING`). `before` marks
the batch record (`hookLogsCommands`) so that `after` counts them only for a
batch whose hook logs them. The checker's brief of a standing batch therefore
tells it to run every verification command it lists, each exactly as given, and
to omit none: a command a ticket does not need is left out by the PM, through
the ticket's own `verificationCommands`, not by the checker. The exec worker is
not told to run them all, and its runs are not counted.

### Moves and deletions

With its file tools a worker can write a file but not rename or delete one
([ADR 0010](../../../decisions/0010-router-worker-second-mode.md), amendment of
2026-11-24). A ticket that needs it declares the files in `moves` and
`deletes`, and "before" checks them:

- each `from`, `to` and deleted path is one plain file path: no folder grant,
  no `.` or `..` part, none of `` " $ ` \ ! * ? [ ] { } : ``, no control,
  bidirectional or zero-width character, written in composed Unicode (NFC),
  not under `.git` or `.claude`; it lies inside the ticket's `paths`, compared
  with case as `after` compares, and is spelled as Git spells what it tracks
  and, for what Git does not track, as the file system does; no path is named twice in the ticket's moves and
  deletes (compared without case);
- each `from` and each deleted path is a file tracked at the product's HEAD;
  a `from` is not a symbolic link, at HEAD or in the work tree, since a later
  path could reach through a moved link out of the grant (a deleted path may
  be one: `git rm` removes the link itself and never follows it);
- no path a ticket moves or deletes has assume-unchanged or skip-worktree set
  in the index: `git status` does not look at such a path, so the work tree
  may hold there what neither HEAD nor the status shows;
- no path the batch moves or deletes lies under another such path, over all
  its tickets, compared without case: the commands run one after another, and
  the first could redirect the second;
- each `to` does not exist, and the nearest folder of it that exists is a real
  folder of the product, not a link, judged by its real path as the file
  system stores it (case included, composed and decomposed Unicode compared as one);
- at most 100 moves and deletions over the whole batch.

No move lands in a submodule: a product whose index holds one opens no batch
at all (`SUBMODULE_PRESENT`, step 6).

From each it derives one exact command. The exec worker's shell accepts the
commands of the whole batch, all tickets together, as its write paths are all
tickets' `paths`, for that batch only; no other worker's shell accepts them:

| Declared | Command |
|---|---|
| a move into a folder | `mkdir -p -- "<folder>" && git --literal-pathspecs mv -- "<from>" "<to>"`, `<folder>` being the folder of `to` |
| a move to the top of the product | `git --literal-pathspecs mv -- "<from>" "<to>"` |
| a deletion | `git --literal-pathspecs rm -q -- "<path>"` |

Git takes each path as written, never as a pattern, as `commit` does. Every
move makes its folder when it runs, not only when the folder is missing at
"before": an earlier ticket's `git rm` of the last file of a folder removes
the folder, and the move into it must still land. `mkdir -p` does nothing
when the folder is there.

The exec brief lists the ticket's own commands as `gitCommands`, beside its
`writePaths` (the ticket's `paths`) and `plannedPaths`. It tells the worker to
run only those, says that the other tickets' moves and deletions are not its
to run though the host accepts them, and that it runs no other command, Git
included. A worker that runs another `git mv`, the
same one with a flag added, or one of these commands from the checker is
refused like any other command. "after" and `commit` treat the result as any
other change: both sides of a rename and the deleted path lie in the ticket's
`paths` and go into that ticket's commit.

A command is confirmed as one line of at most 300 printable ASCII characters
with single spaces, so that what the owner reads in the proposal is all there
is. A switch into Router/Worker mode, and then `before`, refuse a product
repository whose path cannot be written inside a quoted shell command.

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
authorization: the largest usage observed, the tickets, and a proposal; and
one `staffing.<duty>.maxTurns` entry when a worker call used every turn its
staffing allows (the meter's `uniqueMessages`), which is how a call that ended
without a report stopped at its turn limit. Staffing is not a limit: the entry
has no proposal and says it changes with a mode switch. Empty otherwise. `status` is `clear`
or `review`; exit 2 on review. A batch is settled once.

**Reviewer calls**
([ADR 0011](../../../decisions/0011-router-worker-batch-review.md), decision 23).
`settle` refuses while the batch is in review. Each judged reviewer call (each
verdict made from a transcript) is set against `authorizationPerReviewerCall`,
frozen in the batch record's `limits` by `before`. Its usage is the meter row of
a main-session agent of that reviewer's wrapper whose transcript is the file the
verdict was judged from. The record's `reviews` list has one entry per call:
`reviewer`, `attempt`, `transcript`, `spentTokens`, `authorizedTokens`,
`overrun`. `reviewCost` is their total, apart from the tickets' usage, and the
ledger line states both. A call over its authorization puts the batch in
`review` and adds an `authorizationPerReviewerCall` entry to `limits` with a
proposal; nothing is held or undone, as the reviewer's turn limit was the brake
during the call. A judged call the meter does not hold is a finding,
`REVIEW_NOT_METERED`, with null usage. A reviewed batch whose verdicts are
missing is refused.

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
line to `pm-decisions.md`. It takes the lock for its length (see "The lock of
a command"). It pushes nothing.

- It refuses when the product is no longer on the batch's branch, when a Git
  operation is in progress, when the commit hooks were changed or moved, when
  an archive of this batch was already started, when the work
  tree is not exactly what `after` saw (the same paths, and for each ticket to
  commit, reviewed or not, the content `after` recorded), or when the branch is
  not the batch's starting commit plus the commits this command itself made.
- The plan is derived again from the tickets: a path is committed only inside
  the paths of a ticket that passed.
- After each commit it checks that the commit landed on the branch and holds
  exactly the ticket's paths. A commit hook that adds or drops paths stops the
  batch there; the commit is left as it is.
- Paths are given to Git literally, on standard input: no pattern, no limit on
  their number. Staged deletions and renames made by a worker, through its
  ticket's `moves` and `deletes`, are committed in the ticket's commit, both
  sides of a rename included.
- A path that was changed before the batch (start as is) is never in a commit,
  staged or not.
- The repository's own commit hooks run. If one refuses a commit, the commits
  already made stay, the batch stays open, and running `commit` again makes
  only what is missing. The commits made are recorded by their ids
  (`rw-batch-commits.json`), so a hook that rewrites messages does not confuse
  the resume. Each recorded commit is checked again to hold its ticket's paths.
  Each new commit must also hold, in every file, the bytes `after` recorded: a
  commit hook that rewrites and stages a file (a formatter, for instance) stops
  `commit`, which leaves that commit as it is and names the files.
  A commit made just before the command died, and so never recorded, is taken
  up when it is the next planned one: its parent is the expected commit and it
  holds exactly that ticket's paths. A commit made by hand that fits the same
  description is taken up too, but only when its files are what `after` saw:
  the work tree holds the content `after` recorded and nothing of the ticket's
  paths differs from the commit. Otherwise `commit` refuses and records nothing.
  A pre-commit hook that rewrites a file (a formatter) is accepted on a normal
  `commit`, but a commit it rewrote is not what `after` saw, so if the command
  dies right after it, the take-up refuses and the batch is aborted. Whether to
  accept such a commit is open (R23-01, case 2), an owner decision.
- A commit is made with the repository's identity, or the one given in
  `GIT_AUTHOR_*` and `GIT_COMMITTER_*`. Every other `GIT_*` variable is ignored.
- A `commit` that died after archiving the batch is finished by the next call.
  One that died between two commits (a tool timeout, a closed terminal) left
  its lock and its recorded commits: the next `commit` takes the lock over and
  makes only the commits still missing, as after a hook's refusal.
- What is not committed stays in the work tree and is listed (`left`): a ticket
  that did not pass and that `after` did not set aside (a held batch, a batch
  in which no ticket passed, a set-aside that failed), a path outside every ticket (one `after`'s own run of the
  verification commands wrote included), a path written since `after` that
  `resolve` recorded (`wrote`: a cache a verification command wrote when a
  review was briefed, for instance). A ticket `resolve` held, or `after` set
  aside, is a patch, not a change in the work tree. The next "before" then refuses until the PM deals with those
  paths, or starts as is: `left` saves each ticket's work among them as a
  patch and takes it out (see "Resuming left work"), and the PM commits or
  discards by hand only what belongs to no ticket.

The commits are made by the PM's session running this command, with the
repository's Git identity ([ADR 0007](../../../decisions/0007-pm-only-commits.md)).

## Review triggers

[ADR 0011](../../../decisions/0011-router-worker-batch-review.md), decisions 1,
3 and 8 to 10. The flags gate the commit: see "Review verdict, commit gate and
escalation" and "Resolve".

The list has two parts of the same shape:

| Part | File | Owner |
|---|---|---|
| General | `kit/config/router-worker/review.json`: the reviewers (`security`, `architect`) and the kit's triggers and rules, ids starting with `kit.` | the kit |
| Project | `profiles/review.json` in the team's folder, instantiated by bootstrap from `kit/profiles/review.template.json` (empty); ids never start with `kit.` | Security and Architect propose, the owner confirms |

The project part may also hold `generated`: glob patterns of files a tool
writes from reviewed sources (generated code, translation tables). A ticket
declared sensitive is flagged for Security on its other changed paths only;
when it changed generated files alone, on all of them. A trigger still flags a
generated file. Adding a pattern narrows the review, so `before` logs it with
the removed triggers for the owner's spot review (`generated <pattern>`).

```json
{ "schemaVersion": 1,
  "triggers": [{ "id": "billing", "reviewers": ["security"], "match": { "glob": ["src/billing/**"], "contains": ["invoice"] } }],
  "rules": [{ "id": "no-raw-sql", "reviewer": "security", "text": "Queries go through the repository layer." }],
  "adrs": ["decisions/0003-auth.md"] }
```

A `glob` matches the whole path (`**/` any folders, `*` and `?` inside one);
`contains` is a substring of the path. Both ignore case. Adding a reviewer is
one entry in the kit's `reviewers` plus its triggers. The kit's triggers: a
dependency manifest, lock file or registry setting (Security and Architect), a
path containing auth, session, token, crypto, secret or credential (Security), a
database migration (Architect and Security), a CI or deployment file at any
depth (Security), lint and test configuration (Architect). `auth` also flags
paths such as `author.md`: a substring over-flags, which costs a review, where
a narrower pattern would miss `oauth/` or `authz.js`.

- **"before"** refuses a batch when `profiles/review.json` is missing or not
  valid, and says how to fix it. It freezes the merged list with its digest
  in the batch record (`review`). `triggerChanges` in the record names each
  pattern, rule and ADR added or removed since the list frozen by the newest
  archived batch (by `openedAt`), and the ledger gets
  `REVIEW TRIGGERS ADDED: ...` and `REVIEW TRIGGERS REMOVED OR NARROWED (owner spot review): ...`.
  A narrowed trigger shows as the patterns it lost; a rule whose text changed
  is both removed and added. With no archived list, or one of the wrong
  shape or digest, the whole list is logged as `FROZEN ... (owner spot
  review)`. A batch aborted before `after` is not archived, so the next batch
  is compared with the same archived list and logs the same changes again.
- A batch opened by a kit older than this list holds no `review`; `after`
  refuses it. A batch left open across a kit upgrade is aborted and run again.
- **"after"** gives each ticket that passed and changed something a
  `review`: `required` (reviewers, in the kit's order), `because` (reviewer,
  trigger, path; or reviewer `security`, `declared`, path for each changed path
  of a ticket that declared itself sensitive) and `flaggedFiles`, and a `content` (a digest of each of its
  changed paths, flagged or not, as after saw it). `reviews` lists, per
  reviewer, the tickets it must review.

## Review state and brief

[ADR 0011](../../../decisions/0011-router-worker-batch-review.md), decisions 4,
11 and 12. Built and tested offline.

- **"before"** records the reviewers' wrappers in the batch record
  (`reviewWrappers`, reviewer to wrapper name), read from the roster like the
  workers'.
- **"after"**, when any ticket is flagged, writes the write boundary in the
  `review` state instead of closed (see
  [write-boundary.md](write-boundary.md#a-standing-team-adr-0010-decision-12)).
  The lock is still released. `status` is `review`, the ledger line names the
  reviewers, and `next` names `review-brief` for each.
- **While a batch is in review** "before", a mode switch and a change of limits
  are refused. `abort` closes the review state and archives the batch with
  nothing committed; `resolve` ends the review state once every verdict is in.
- **`review-brief --reviewer R`** prints the brief the PM gives reviewer R's
  wrapper, and appends it, sealed, to `rw-batch-review-R.json` (one entry per
  attempt: run, reviewer, wrapper, attempt, `seq` (one more than the highest
  `seq` among the briefs of this batch, every reviewer's), `briefDigest`,
  `madeAt`, the tickets with
  their goal, acceptance, changed and flagged paths, content digests and the
  flagged paths that are symbolic links with their targets (`links`), the
  rule ids, the ADRs, each verification command's exit and output digest).
  When a command failed or timed out, it also says so on standard error (the
  result's `notice`) and tells the PM to brief again before dispatching the
  reviewer if the failure is flaky or its cause is gone. `review-brief` takes
  no lock around reading the briefs and writing its own: two briefs made at the
  same time for different reviewers can get the same `seq`, and two for the
  same reviewer can lose one. The
  brief holds, for each ticket R must review: the goal and acceptance, the
  reason it was flagged, and the flagged files as absolute paths to open with
  the Read tool, with the rule the judging applies (next section). Each flagged
  file has one kind, decided by `readingOf` in
  `src/router-worker/read-coverage.mjs` for the brief and the judging alike: a
  symbolic link (shown with its target, made plain as paths are in records,
  and not opened); a deleted path (marked, nothing to open); media, an image,
  PDF or notebook named by its extension (`.png`, `.jpg`, `.jpeg`, `.gif`,
  `.webp`, `.pdf`, `.ipynb`) whose leading bytes are that format's (the PNG,
  JPEG, GIF or WebP signature, `%PDF`; a notebook is JSON text), which the Read
  tool reads by its extension (marked to be read once); misnamed, a file with
  one of those extensions and other bytes, such as a Git LFS pointer, on which
  every Read fails (marked, not to be opened); binary, any other file with a
  NUL byte in its first 8,000 bytes (marked, not to be opened: the tool does not
  show it); large, a text file over 256 KB, more than the tool reads whole
  (`WHOLE_BYTES`; marked with its size, not to be opened: the reviewer judges
  it from its diff as the brief shows it and reports a rule the diff does not
  let it judge as not-checked, naming the file); and text, all the rest. A
  text file over 2,000 lines or 40 KB is marked with
  its line count, its size and the ranges to read it in: one `limit` for the
  file, `lines × 40 KB / bytes` rounded down, at least 1 and at most 2,000, and
  the offsets 1, 1 + limit, and so on (the first three and the last when there
  are more than six), so that each range holds about 40 KB: with the line
  numbers the tool adds, 60 KB of dense text reaches its output cap of about
  25,000 tokens (`RANGE_BYTES`). A large file gives up the reading of its
  unchanged part: a lock file of a megabyte would take some twenty ranged
  Reads near that cap, about 300,000 tokens, for a review that is about its
  diff. Then the diff of
  those tickets from the batch's start, untracked files included: whole while
  it, fenced, fits in 60,000 characters. Over that, the section holds every
  changed path in ticket order, and every character it adds counts against the
  60,000: the opening sentence, each path's label and fence, each sentence
  standing for a diff not shown, and the resumed patches. Each path gets its
  whole diff if the room left holds it, otherwise its removed lines under
  their hunk headers, otherwise one line with its counts of added and removed
  lines that tells the reviewer to report a rule resting on its removed lines
  as not-checked. A path whose added lines are not shown is named with the
  instruction to open it with the Read tool for them. A binary file is named
  as a binary file. Once not even a path's line fits, one closing line says
  how many paths are left, names them in ticket order as far as the cap
  allows, counts the ones it does not name, and tells the reviewer to open
  each. That per-path
  diff does not follow renames, so a path's removed lines stay with it. For a
  ticket that resumed earlier work the brief names its patch in the team's
  folder. Then R's rules as `id: text`; the ADRs as absolute paths; the
  output tail of each verification command; the batch-review protocol
  (`agents/router-worker-review.md`); and the report schema, to be returned as
  the last fenced json block. It never holds a worker's report, the checker's
  verdict or another reviewer's report. The diff and each output tail sit in a
  fence longer than any backtick run inside them, so worker text cannot close
  it and forge a section.
- **The kit runs the verification commands** for the brief
  (`src/router-worker/run-commands.mjs`): only a command both frozen in the
  batch and in the team's bound `allowedCommands`, with `/bin/sh -c` from the
  product root, 15 minutes each, as the PM's user; the last 4,000 characters of
  its output are kept with a digest of all of it. A frozen command the owner no
  longer confirms is named as not run.
- **`--ticket ID`** adds an elective review of a ticket that passed with
  changes; it binds like a required one, is recorded as `elective`, and stays in
  every later brief of that reviewer. Its flagged files are all its changed
  paths.
- **Refused**: no batch in review; a reviewer the kit does not name, or one
  with no ticket; a briefed ticket with a changed path holding a control
  character (named with the ticket: the reviewer cannot be told to open it); a
  changed path of a briefed ticket whose content differs from what "after"
  recorded, before or after the verification commands ran; a brief record that
  was edited; a new brief while R's latest brief has no verdict (a judged
  transcript or a recorded no-answer), since it may have been dispatched (rule
  B1, next section). Three exceptions let the latest brief be made again: a
  verification command of it failed or timed out, as its notice says; a
  path it pinned no longer holds what it pinned (a file's content, a link's
  target), since its dispatch could not then be judged; or the earlier kit
  made it (its tickets carry no `links`, which every brief of this kit
  records), since that brief told the reviewer to read each file in one
  `Read`, which the judging no longer accepts for a long file.
  `validate-team.sh` checks both parts with the same code.

## Review verdict, commit gate and escalation

[ADR 0011](../../../decisions/0011-router-worker-batch-review.md), decisions 3,
13, 16, 17 and 19, with the owner's answers of 2026-11-20. Built and tested
offline on transcript fixtures.

- **`review --reviewer R --transcript T`** judges R's report from R's own
  session transcript and appends the verdict, sealed, to
  `rw-batch-reviews.json` (archived as `reviews.json`). The transcript must lie
  at `<projects>/<project>/<session>/subagents/agent-<id>.jsonl`, where
  `<projects>` is `$CLAUDE_CONFIG_DIR/projects` or `~/.claude/projects` (an
  engine workflow's agents lie under `workflows/` and are refused); its
  `.meta.json` names R's wrapper as `agentType`; its first user entry is not
  relayed by the workflow harness and carries R's latest brief unchanged (the
  body between the brief's heading and its `briefDigest:` line has that
  digest); and its `Read` tool calls of the absolute path of each flagged file
  that is text or media evidence it. A `Read` counts only when the
  `tool_result` with its `tool_use_id` is in the transcript and is not an
  error. One such `Read` evidences a media file, a PDF read with `pages`
  included. The `Read`s of a text file, taken together, must cover every line
  of it: a `Read` covers the lines from its `offset` (1 when absent; 0 is read
  as 1) through `offset + limit - 1`, and 2,000 lines when it has no `limit`,
  since the Read tool returns at most 2,000 lines without one (`READ_LINES`).
  The lines are counted from the file's bytes at judging, one per newline and
  one more for text after the last; an empty file has one. So one plain
  `Read` evidences a file of up to 2,000 lines, consecutive ranged `Read`s a
  longer one, and a single plain `Read` of a longer one does not. A link, a
  deleted path, a binary, misnamed or large file need no `Read`, and the
  report need not list them as read. The refusal names each file with the
  first line no `Read`
  covered, or as not opened. The report is the last fenced `json` block of the
  last assistant message; a `REPORT.json` given must be equal to it.
- **Every dispatch is judged** (decisions 3 and 4). Three rules, all about R's
  latest brief, so that the PM cannot choose which report counts and a healthy
  review is never refused for it:
  - **B1.** `review-brief` makes no new brief while the latest one has no
    verdict, with the two exceptions above (previous section).
  - **B2.** Before a transcript T that carries the latest brief is judged,
    every other subagent transcript of R's wrapper that carries the same brief
    (the same heading, so the same run and attempt) and began before T must be
    judged; otherwise the judgment is refused, naming them, and nothing is
    recorded. Judging the earliest uses the attempt, as any judgment does, and
    T then carries an earlier attempt's brief. A file given that does not
    carry the latest brief is judged as if there were no transcript: while
    any transcript carries the latest brief, the judgment is refused, naming
    it, and no attempt is used, so a stray file cannot use the attempt of a
    rejecting report. When none carries it, the file is judged and refused
    (`REVIEW_BRIEF_NOT_FOUND`, among others), which uses the attempt. A
    transcript that carries a brief of an earlier attempt or of another run is
    not waited for: B1 and B3 already closed that attempt.
  - **B3.** `review --no-answer` is refused while any transcript of R's
    wrapper carries the latest brief: the PM judges that transcript instead. A
    reviewer that stopped without a report is judged `REVIEW_NO_REPORT`, which
    uses the attempt. `--no-answer` is for a dispatch that left no transcript.

  A transcript carries a brief when its first user entry has the brief's
  heading as a line (`# Batch review brief: R, run <run>, attempt <n>`); it
  began at that entry's `timestamp` (then by path). The scan for B2 and B3
  looks in every session of every project folder under `<projects>`
  (`<projects>/*/*/subagents/agent-*.jsonl`) whose `.meta.json` names R's
  wrapper, opens only the files modified at or after the brief was made (less
  two seconds for a coarse file clock), and reads each only as far as its
  first user entry. The transcript being judged is told from the others by its
  real path. A transcript that grew after its judgment (a reviewer resumed
  with a new brief) still begins with the brief it was first given, so it
  never holds up a later brief; judged again on a later attempt, it is refused
  `REVIEW_BRIEF_NOT_FOUND`, which uses that attempt, and `settle` counts its
  usage once.
  Judgments of one team run one at a time: `review` and `review --no-answer`
  hold `rw-batch-reviews.json.lock` from reading the verdicts to writing them
  back, a second one waits, and a lock older than a minute is taken over.
- **The verdict is derived by the kit**, per ticket of the brief: every flagged
  file listed in `filesRead` with `read: true`; every rule of the frozen list
  reported `pass`, `fail` or `not-checked`; not every rule `not-checked`; a
  `GREEN`, `AMBER` or `RED` item, `RED` exactly when a rule failed; each failed
  rule with a fix and a proposed control (`detects`, `variation`,
  `toolCanDetect`). A rule reported more than once for a ticket with
  different results, or a ticket listed more than once with different
  verdicts, is refused. Any gap refuses the report. A failed rule rejects the
  ticket; `AMBER` does not (the ticket is committed and the PM files the
  concern, kept as `finding`, as a backlog ticket). A single `not-checked` is
  recorded in the verdict and the ledger.
- **Verdict entry**: `{stage: "review-verdict", runId, reviewer, attempt,
  briefAttempt, briefDigest, outcome: "accepted"|"refused"|"not-obtained",
  refusals: [{code, detail}], transcript: {file, digest, agentType},
  reportDigest, tickets: [{id, verdict: "passed"|"rejected"|"not-obtained",
  item, fails, notChecked, finding, fix?, control?}], judgedAt}`. Each judgment
  writes a `REVIEW <run> <reviewer> ACCEPTED|REFUSED|NOT OBTAINED` ledger line.
  Refusal codes: `REVIEW_TRANSCRIPT_PLACE`, `REVIEW_NOT_REVIEWER`,
  `REVIEW_WORKFLOW_AGENT`, `REVIEW_BRIEF_NOT_FOUND`,
  `REVIEW_TRANSCRIPT_NO_OPEN`, `REVIEW_NO_REPORT`, `REVIEW_REPORT_MISMATCH`,
  `REVIEW_REPORT_SHAPE`, `REVIEW_FILE_NOT_READ`, `REVIEW_RULE_CONFLICT`,
  `REVIEW_ITEM_CONFLICT`, `REVIEW_RULE_MISSING`, `REVIEW_RULE_NO_EVIDENCE` (a
  rule row with no note saying what was checked, or why it was not),
  `REVIEW_ALL_NOT_CHECKED`, `REVIEW_ITEM_MISSING`, `REVIEW_VERDICT_MISMATCH`,
  `REVIEW_CONTROL_MISSING`, `REVIEW_NO_ANSWER`. A transcript that cannot be
  read, one already judged, one refused by B2, a no-answer refused by B3, or a
  flagged path that changed since the brief (a file's content, a link's
  target) is refused without recording an attempt.
- **One more attempt.** After a refused report the next `review` needs a new
  brief: `review-brief` makes attempt 2 with the refusal reasons in the brief
  (`retryReason`). The refusal's `next` says to dispatch the reviewer with it
  as a new agent, never by resuming or messaging the earlier one: a resumed
  reviewer's transcript begins with its first brief, so its judgment is
  refused `REVIEW_BRIEF_NOT_FOUND` and the review ends not obtained. A second
  refused report, or `review --no-answer` on the
  second attempt, records `not-obtained` for every ticket of R's brief. A
  reviewer is judged once: after `accepted` or `not-obtained` no brief or
  verdict is made for it in this batch.
- **Commit gate.** `commit` refuses while a reviewer that a planned ticket
  needs has no final verdict. A ticket needs each reviewer a trigger required
  and each reviewer whose brief named it electively (an elective review binds).
  A ticket rejected, or whose review was not obtained, is held by `resolve`
  (next section). `commit` of a flagged batch refuses without a finished
  resolution and commits `resolution.commits`. The commit record carries
  `held: [{ticket, reason, patch}]` and `escalations`, and the ledger line names
  both. `commit` also refuses when `reviews/tickets.jsonl` holds a
  `rejected` or `not-obtained` line for this run that the reviewer's final
  verdict does not show: deleting or rewriting `rw-batch-reviews.json` to have
  a ticket judged again does not reset its rejection. A judgment that died
  after that line and before its verdict is recovered by judging the same
  transcript again, as the refusal says; one that then passed on a new
  attempt is refused the same way, and the batch is aborted.
- **Across batches.** Each final outcome that is not a pass is appended to
  `reviews/tickets.jsonl` as `{ticket, runId, reviewer, outcome:
  "rejected"|"not-obtained", finding, resumedFrom?, at}`, once per ticket, run
  and reviewer. `resumedFrom: {runId, ticket}` is present when the batch record
  froze a held patch as the ticket's `resume`: a patch at
  `reviews/held/<run id>/<ticket>.patch`, or a copy elsewhere in the team folder
  whose digest is that of a file under `reviews/held/`. A ticket's adverse
  outcomes are the lines under its id (compared without case) and the lines of
  every ticket whose work it continues, followed from `resumedFrom` to
  `resumedFrom`, so the same work filed again under a new id with its held
  patch as `resume` keeps its count
  ([ADR 0011](../../../decisions/0011-router-worker-batch-review.md), amendment
  of 2026-11-26, "a rejection counts with the work it resumes"). Paths count for
  nothing: a line written with `paths` and no `resumedFrom` counts by its id
  only. A ticket with adverse outcomes in
  two distinct batches is escalated, whether they are two rejections, two
  reviews not obtained, or one of each (PM decision of 2026-11-22): `{id:
  "ESC-<ticket>-<run>", kind: "second-rejection"|"review-not-obtained-again"|"repeated-adverse",
  ticket, reviewer, runIds, paths, findings: [{ticket, runId, reviewer, outcome,
  finding}], at}` (`paths`: the paths the ticket changed in that batch, which
  are the paths of its held patch; `findings` name each line counted, under
  whichever id) in `reviews/escalations.jsonl`, an `ESCALATED` ledger line,
  which names the other ids (`ticket <id> (resuming the work of <other id>)`), and
  the verdict's `escalated` list. Two reviewers rejecting the same ticket in one
  batch count once.
- **What an escalation blocks** (owner rule of 2026-11-20: report to the human,
  block what is related, replan the rest). "before" refuses a batch that holds
  the escalated ticket, a ticket whose paths overlap the escalated ticket's
  paths (the same comparison as two tickets claiming one file), or a ticket
  that depends on a blocked ticket, directly or through others, in this batch
  or an archived one. Every other batch opens. A ticket that depends on an
  archived ticket whose paths overlap the escalated ticket's paths is not
  blocked: the archived ticket was committed after its own review, and only
  the tickets of the batch are compared by path.
- **The owner lifts an escalation** with `node kit/scripts/team-mode.mjs
  acknowledge <escalation id> --instance <instance-root>`, confirmed like a
  limit change by typing the code at an interactive terminal: a call that does
  not say the code was typed at a terminal, or whose process has none, is
  refused, with the same `node --test` exception. It appends
  `{id, escalationDigest, acknowledgedAt, atTerminal: true}` to
  `reviews/acknowledged.jsonl` and an `ESCALATION ... ACKNOWLEDGED` ledger line
  that says "typed at an interactive terminal". Only a line with
  `atTerminal: true` whose `escalationDigest` is the digest of the escalation
  as it stands lifts it. A PM session that fakes a terminal, sets
  `NODE_TEST_CONTEXT`, or appends a forged line with the right digest is not
  detected (see "What these commands trust").
- The kit checks the transcript's place, shape and content; it cannot prove that
  the reviewer, and not the PM's session, wrote it.
- The Coach takes the findings from `reviews/tickets.jsonl` and the verdicts
  after the batch, off the critical path, and writes a text rule only for a
  class the reviewer reports no tool can detect; the Auditor measures the
  controls built from proposed ones (decisions 21 and 22).

## Resolve

[ADR 0011](../../../decisions/0011-router-worker-batch-review.md), decisions 14
and 15, with the owner's answer of 2026-11-20: decision 15 also applies to a
ticket held because its review was not obtained.

`rw-batch.mjs resolve --instance <instance-root>` runs once every reviewer of a
flagged batch has a final verdict, before `commit`. It takes the lock and checks
that the product is on the batch's branch at the batch's start commit, with no
Git operation in progress and the same commit hooks, and that every changed path
of a ticket still to be committed or held has the content `after` pinned
(`tickets[].content`). It also reads the verification commands the kit ran when
the reviews were briefed. Across every reviewer's briefs of the batch, the most
recent complete run decides: the brief with the highest `seq`, never the wall
clock, among the briefs that ran every frozen command (none dropped). A brief
that ran no command, or dropped one, clears nothing, though a failure in it
still holds; when no brief is complete, every recorded failure counts. A
brief recorded before `seq` existed comes before every numbered one, and such
briefs are ordered by `madeAt` among themselves. A later run that passed clears
an earlier failure, and a later failure stands, whatever the commands wrote in
between. When the most recent run failed or timed out and the tree is exactly
what would be committed (nothing changed before the batch, `after` left no
path, and no review holds a ticket), it refuses and names the command, and
`abort` is the way out. Otherwise every failure at a brief is recorded in the
resolution (`failedAtBrief`) and on its ledger line. A batch whose briefs ran
no command and recorded no failure (the batch freezes none, or none is still
confirmed for the team) is never held here. A reviewer's verdict is
never changed by it. Then:

1. **Held patches.** For each ticket rejected or whose review was not obtained,
   the kit makes a binary patch of the ticket's changed paths against the
   batch's start, untracked files included, through an index of its own (the
   paths go to Git literally, on standard input). It is saved under the team
   folder at `reviews/held/<run id>/<ticket>.patch` with its digest. It applies
   with `git apply` on the batch's start commit.
2. **Removal.** The ticket's paths go back to the batch's start: a path the start
   holds is checked out from it, index included; a new path is unstaged and
   deleted. The kit checks that none of them still shows as changed.
3. **Re-verification.** When a ticket after the first removed one is still to be
   committed, the kit runs the batch's verification commands from the product
   root, only those that are both frozen in the batch and still in the team's
   confirmed `allowedCommands` (`/bin/sh -c`, 15 minutes each, output truncated
   and digested). If one fails or times out, if none could run, or if a command
   changed the content of a path still to be committed, every ticket after the
   first removed one is also saved as a patch and removed, with the reason
   `verification-failed-after-removal`. If a command changed an earlier
   ticket's path, the holding starts at that ticket.
4. **Paths written since `after`.** Every time, whether the commands ran again
   or not, each path that is changed in the product now, was not left by
   `after`, and is no path of a ticket to commit is recorded as `wrote`: a
   cache or a generated file a verification command wrote when a review was
   briefed or at step 3, or a file written by hand. `commit` leaves these
   uncommitted and names them, and the next `before` sees them as any path left
   in the tree. A path of a ticket to commit whose content changed is still
   refused, as above.
5. The review state closes, a `BATCH <run> RESOLVED` line goes to
   `pm-decisions.md`, naming the paths written since `after`, and the lock is
   released.

Exit 0 when nothing is held, 2 when a ticket is held. A second `resolve` returns
the same record.

**Resolution record** `rw-batch-resolution.json` (archived as
`resolution.json`): `{stage: "batch-resolved", runId, batchDigest, afterDigest,
reviewsDigest, resolvedAt, removed: [{ticket, reason:
"rejected"|"review-not-obtained"|"verification-failed-after-removal", patch,
patchDigest, paths}], verification: {ran, failed, commands: [{command, exit,
timedOut, outputDigest, tail}], dropped, changed, wrote}, failedAtBrief:
[{reviewer, attempt, command, exit, timedOut}], commits, left}`.
`commit` checks it against the verdicts (`reviewsDigest`), `after`'s plan (the
commits are after's commits less the removed tickets, and every ticket a review
held is removed) and the patches on disk (each at its exact path with its
digest). The work tree it expects is `after`'s, less the removed paths, plus
`wrote`, and each path it commits must still have the content the review saw.

**Resume.** While it works the record has `stage: "batch-resolving"` and
carries each patch as soon as it is saved, the verification outcome once the
commands ran, and the process id. A `resolve` that died is
finished by the next one: it takes over the lock as any command does (see "The
lock of a command"),
checks each saved patch against its digest, removes again what is not yet
removed, does not run the commands twice, and holds after a recorded failure
what the failure holds. A ticket a recorded failure holds is not compared with
its pinned content, since a command may have changed it.

**Abort after resolve** re-applies nothing: the held tickets stay patches under
`reviews/held/<run id>/`, the removed paths stay removed, and the note names
each with `by: "resolve"`. To take a held ticket back, name its patch as the
`resume` of a ticket of a later batch (see "Resuming left work").

## Periodic review

[ADR 0011](../../../decisions/0011-router-worker-batch-review.md), decision 7.
What no trigger flags is read by Security once and Architect once every
`HARDENING_INTERVAL` committed tickets.

- **Interval.** The number in the instance's `charter.md` line "At counter =
  `N`", or the placeholder's default; before bootstrap, `charter.template.md`.
  The PM can edit the charter, so its value is trusted up to 100: a larger one
  is clamped to 100, and zero, a negative number, anything that is not a whole
  number, or no such line gives the kit's default, 25. The interval used and
  its source (`charter`, `clamped` or `default`) are in the `before` refusal,
  in the brief record and in each periodic line.
- **Count, derived and never stored.** For each reviewer: the tickets in the
  sealed `batches/*/commit.json` records, and, for a batch archived without
  commit by `abort`, the commits the kit had made before it stopped
  (`commits.json` of the same run, each named in the sealed `abandoned.json`),
  whose commit no final periodic line of that reviewer counted. Each commit is
  counted once. A final line is `accepted`, `not-obtained` or
  `nothing-to-review`. A refused attempt counts nothing.
- **Due.** `before` refuses with `PERIODIC_REVIEW_DUE` while any reviewer's count
  is at the interval or above, and names the commands. It checks this after the
  settlement of earlier batches, so a PM settles first.
- **Scope.** `periodic-brief --reviewer R` runs only between batches (no
  `rw-batch.json` or `rw-batch-after.json`) and only when R is due. Its scope is
  R's counted tickets less those R's own triggered review passed in their batch
  (`batches/<run>/reviews.json`). The other reviewer's pass does not remove a
  ticket. A ticket id committed twice is one entry with both commits. The brief
  names each ticket's goal and acceptance, its commits and every path those
  commits changed, as an absolute path to open with Read as it stands now,
  under the reading rule of a batch brief (each file by its kind: a long text
  file with its ranges, media to read once, a binary, misnamed or large file
  and a symbolic link not to open, a deleted path marked). This brief holds no
  diff, so a large file in it is not reviewed at all: a rule resting on it is
  reported not-checked.
  It carries no diff and no verification output; the rules are R's current
  rules, with the ADRs and the review protocol.
- **Review state.** The first brief arms the review state of the write
  boundary with `periodic: true` and the period id (`periodic-<time>`) as its
  run id; the hook bounds both reviewers as in a batch review. While it is open
  no batch, switch or change of limits starts; `settle` of an archived batch
  still runs. It closes when no reviewer is due any more. `abort` ends it; the
  review is then still due.
- **Nothing to review.** When every counted ticket was passed by R's triggered
  reviews, `periodic-brief` records `nothing-to-review` at once and prints the
  line instead of a brief.
- **Judging.** `periodic` applies the evidence rules of a batch review
  (transcript place, wrapper, brief carried unchanged, Reads that evidence
  each text or media file, every rule per ticket, RED only with a failed rule,
  a fix and a control per failed rule). A refused report is briefed and
  dispatched once more, to a new agent as in a batch review; the second
  failure, or `--no-answer` twice, is
  `not-obtained`. Attempts are counted per reviewer over the same pending
  commits, so an `abort` between them, which gives the review a new period id,
  does not reset the count.
- **Every dispatch is judged** by rules B1 to B3 of a batch review, on R's
  latest brief of the open period, whose heading is `# Periodic review brief:
  R, period <id>, attempt <n>`. `periodic-brief` makes no new brief while that
  brief has no judged transcript and no recorded no-answer, except when a path
  it pinned no longer holds what it pinned: `periodic` refuses such a
  judgment and says to brief again, and the new brief is then made with the
  files as they stand; or when the earlier kit made it (no `links` on its
  tickets).
- **Holds nothing.** No commit is touched. Each RED or AMBER ticket of an
  accepted report is a finding, with its commits, failed rules, fix and proposed
  control, for the PM to file as a ticket. Owner answer of 2026-11-20: a review
  not obtained twice is recorded, written to the ledger as reported to the
  owner, and stops no batch.
- **Cost.** `--meter METER.json` (`measure-spawn.mjs --json`) sets the call's
  tokens from the row of the reviewer's wrapper whose file is the judged
  transcript, against `authorizationPerReviewerCall`; an overrun is recorded
  and holds nothing. Without `--meter`, `tokens` and `overrun` are null.

`reviews/periodic.jsonl`, one sealed line per judgment: `{schemaVersion: 1,
stage: "periodic-review", id, reviewer, attempt, briefAttempt, briefDigest,
interval, intervalSource, outcome: "accepted"|"refused"|"not-obtained"|"nothing-to-review",
counted: [sha], scope: [{ticket, runs, shas}], refusals, transcript: {file,
digest, agentType}|null, reportDigest, tokens, authorizedTokens, overrun,
findings: [{ticket, shas, verdict, fails, finding, fix?, control?}], at,
digest}`. A line changed by hand refuses `before` and
the periodic commands. A last line that a write did not finish refuses them
too, and the refusal names the recovery: remove that line, and the review it
was recording becomes due again.
The brief is kept, sealed per attempt, in `rw-periodic-review-<reviewer>.json`:
`{id, reviewer, wrapper, attempt, briefDigest, madeAt, interval, intervalSource, counted,
tickets: [{id, runs, shas, changedPaths, flaggedFiles, content, links}], ruleIds,
adrs, retryReason?}`. The ledger gets one `PERIODIC REVIEW <id> <reviewer>`
line per judgment.

## The lock of a command

The lock on the product repository has two kinds of holder. A batch holds it
across commands, from `before` to `after`; so does a disposable launch. A
command holds it for its own length: `commit`, `resolve`, `left`, `abort`'s
removals, a change of limits and a mode switch. A command's lock names its
process (`commandPid` in the lease file). A command that asks for the lock and
finds a command's lock of this team whose process is gone takes it over, under
the same lock file that serializes releases, so of two commands that find one
dead lock exactly one takes it. A lock held by a command that still runs, by a
batch, or by another team is refused, and the refusal says which, with the
process id for a running command. `before` takes over a dead command's lock
too; the lock it takes is the batch's. A command that died holding the lock
needs no `abort`: running a command again is the way on.

## When the kit will not commit a batch

A batch that `after` closed and `commit` refuses (all commits held, the branch
moved, a hook changed a commit, the records were edited) is not stuck:
`abort` closes the write boundary and releases the lock if `after` did not get
that far, takes out of the work tree each ticket flagged for review that no
review passed (see "Abort"), archives the records under `batches/<run id>/`
with a note, writes "ARCHIVED WITHOUT COMMIT" to `pm-decisions.md`, and
commits nothing. Commits the kit had already made for the batch stay on the
branch and are named. The rest of what the batch changed is still in the
product work tree: `left` then saves each ticket's work in it as a patch and
takes it out (see "Resuming left work"), and the PM or the owner commits by
hand on the working branch, or discards, only what belongs to no ticket. A
flagged ticket that `abort` could not take out is named as left in the work
tree with no review passed; it is never committed by hand. When `abort` saved
its patch before the removal failed, that patch is the complete one and what
is left of the ticket in the tree is discarded; otherwise `left` saves it once
the cause is gone. `abort` refuses while a command of this team that holds the
lock still runs, or while the `after` that claimed the batch does, and names
the process to wait for or stop (see "Abort"). The next "before" then
needs a clean repository or "start as is", as after any batch that left paths
behind, and it names every commit made by hand since (see "What before does,
in order").

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
the return fits the frozen batch and that a ticket's own record is consistent.
The tree it would commit is verified first-hand when nothing else is in it:
`after` sets aside the work of each ticket that did not pass, then runs the
passed tickets' commands on a tree that holds only the planned commits, after
the last ticket, and holds every commit when a command fails. When the tree
holds anything else (a path outside every ticket, a path changed before the
batch, a ticket it could not set aside), it runs nothing and says so
(`VERIFICATION_NOT_RUN`): the planned commits are then verified only by the
checkers. The run says nothing of the intermediate commits (the tree with the
first ticket committed and not the second), nor of each ticket alone: a ticket
that passes only with a later ticket's change is committed first all the same,
and a ticket is judged by the union of the passed tickets' commands on the
final tree, not by its own list alone. That the checker ran is checked first-hand only by count: for each verification
command, the hook must have approved at least as many runs of it by the checker
as there are passed tickets that verify with it. The count does not tell the
tickets apart, so a checker that runs a command twice for one ticket covers for
another that ran it not at all. Nor does the hook see the command's exit code:
that the checker's run passed is the checker's word. The log is a file in the team folder,
and a confirmed command runs files the exec worker may write (a test file), so
such a command can append lines that read as the checker's runs or as worker
calls; neither count can tell them from the hook's. The batch records carry digests that detect an
accidental edit, not a deliberate one: a PM session can rewrite a record and
its digest. What reaches a path, the ledger or a commit message is therefore
checked again when it is read, and the commit plan is derived again from the
tickets. A PM that edits the engine's return can still get a failed ticket
committed.

## Abort

`abort` clears a batch that will not be run, and what a "before" that died
left behind: it closes the write boundary (also from the review state), releases the lock if this team holds
it, removes the batch record and appends one line to `pm-decisions.md`. It
refuses, and changes nothing, while the lock is held by a command of this team
whose process is alive, or while `rw-batch-after.json` is the claim of an
`after` whose process is alive; the refusal names the process to wait for or
stop, and what to do if that id now belongs to another program (release the
lock with `lease-router-worker.mjs release`, or remove the claim file). A
command's lock whose process is gone, and the batch's own lock, it releases. It
checks nothing about the work; that is the "after" command. It never releases
another team's lock. It does not know whether the engine is running: aborting a
batch that is being run takes its lock and its write paths away mid-run.

When the write-boundary file is missing or was changed, abort still releases
the lock and removes the record, and says the boundary was not restored: every
subagent write and shell command is then refused until a mode switch to specialist and back rebuilds
it.

A "before" that finds this team's lock with no batch record, or a boundary
that is not closed, refuses and names `abort`.

Its output's `lockReleased` is `true` when it released this team's lock,
`"already-free"` when no lock was held (`after` releases it when it closes a
batch), and `false` when the lock is held by another team or cannot be read.

**A batch `after` closed** ([ADR 0011](../../../decisions/0011-router-worker-batch-review.md),
amendment of 2026-11-26), in review or not, resolved or not, is archived
instead (see "When the kit will not commit a batch"). The patches `after` set
aside stay where they are; the note and the ledger line name them ("Set aside
by after as patches, out of the work tree"). Before that, `abort`
holds each ticket that `after` recorded as needing a reviewer
(`tickets[].review.required`, kept when a finding holds every commit and the
batch is not put in review) and that has no passed verdict from each of those
reviewers, and each ticket `resolve` already held. The reason is `rejected`,
`review-not-obtained`, `not-reviewed` (a required reviewer has no final
verdict, or the verdicts cannot be read), or the reason `resolve` recorded.
With the lock taken, each held ticket whose changed paths (as `after` recorded
them) still show as changed is saved and removed with `resolve`'s own
functions: a binary patch of those paths against the product's HEAD at
`reviews/held/<run id>/<ticket>.patch`, then each path back to HEAD. The
product's HEAD is the batch's start unless someone, or the kit, committed
since. A patch already at that place is never written over: one with the same
bytes (an `abort` that died after saving it) is used, one with other bytes
leaves the ticket in the tree. A ticket whose paths no longer show as changed
is named with the patch already saved for it, looked up under the batch's own
run id (where `resolve` saves, and the after record carries it) and then under
the archive's id, which differs when `abort` archives under `unreadable-<time>`
because `batches/<run id>` already exists (an `abort` that died inside the
archive); `resolve`'s patch is named and not touched. Unflagged tickets, and
flagged ones every required reviewer passed, stay in the tree.

`abort` takes nothing out, and names every ticket it would hold as left in the
work tree with the reason, in two cases. The after record is not the one
`after` sealed (its digest does not match): which ticket a review needed cannot
be told, so every ticket with changed paths is named, `not-reviewed`, with the
paths it records. `left` refuses such an archive too, so the note and the
ledger line say that no command of the kit can tell which ticket each changed
path belongs to, and that the work is saved by hand before the work tree is
cleaned (in the product, `git add -A`, then `git diff --cached --binary HEAD`
into a file outside the product). They say the same, and name no `left`, when
the batch record is not the one `before` sealed or the after record belongs to
another batch. A `resolve` of this batch is still running: its record is
`batch-resolving` and the process it names is alive. While that `resolve`
holds the lock `abort` refuses; a record whose process id is alive with the
lock free is still taken as running, and nothing is taken out.

When the records cannot be traced (an `after` that died part-way left only its
claim, or a record was changed), the note and the ledger line also list the
patch files already under `left/<run id>/` and `reviews/held/<run id>/`,
"Already saved as patches for this batch": an `after` that died while it set
work aside saved them, and they are not saved again by hand.

`abort` still archives the batch when a ticket cannot be taken out: when the
lock cannot be taken, a Git operation is in progress in the product, the
patch cannot be made or saved, or a patch with other bytes is already there.
It then removes nothing of that ticket, and names it as left in the work tree
with no review passed. A removal that fails part-way, after its patch was
saved, is named the same way, with the patch, and the note says that this
saved patch is the complete one: what is left of that ticket in the tree is
discarded, not saved again. Otherwise it tells the PM to run `left` once the
cause is gone, and names `left` for the rest of the batch's work.

The note `abandoned.json` lists them in `held`, one entry per ticket by where
its work is: `{ticket, reason, state: "patch", patch, by: "abort"|"resolve"}`;
`{ticket, reason, state: "in-tree", paths, problem, patch?}` for a ticket left in
the tree; `{ticket, reason, state: "not-in-tree"}` for one whose paths no longer
show as changed and that has no patch (committed or discarded by hand). The
ledger line names the same tickets, with each patch, in sentences that start
"Held as patches, out of the work tree", "LEFT IN THE WORK TREE with no review
passed" and "Flagged for review, not passed, and no longer in the work tree".
A held patch comes back through the `resume` of a ticket of a later batch (see
"Resuming left work").

## What decides the limits

The ceiling, the attempts, the authorization, the tools and the workers come
from the team's own files: `profiles/team-mode.json`, `agents/roster.md` and
the write-boundary file. `BATCH.json` cannot change any of them; an unknown
field is refused. The limits are checked for validity where they are used.

Only the owner changes them
([ADR 0010](../../../decisions/0010-router-worker-second-mode.md), amendment of
2026-11-20): at the switch or with `team-mode.mjs limits`, by a code typed at a
terminal. Four mechanisms hold that:

- **Only a terminal confirms them.** `changeLimits`, and `switchMode` into
  Router/Worker mode, refuse a call that does not say the code was typed at a
  terminal, or whose process has none (`process.stdin.isTTY`); `node --test`
  is the one exception (`NODE_TEST_CONTEXT`). Only a ledger line that says
  "typed at an interactive terminal" binds limits.

- **The ledger binds them.** The `MODE SWITCH` line into Router/Worker mode and
  each `LIMITS CHANGED` line end with `limits <digest>`. `before` refuses
  (`LIMITS_NOT_BOUND`) when the digest of the profile's limits is not the one
  on the last such line, and names `team-mode.mjs limits`. A team that went
  live before lines carried a digest is refused the same way; the owner binds
  its limits with `team-mode.mjs limits` and `{}`, a request that changes
  nothing, which is accepted only while the limits are unbound. The proposal
  then says so (`unbound`). Bound limits that lack a limit the kit added later
  (`authorizationPerReviewerCall`) are refused with the same code, on every
  batch, since any batch may need a review; `{}` then proposes the missing
  limit at its default as a change.
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
  When the output ceiling stopped the batch, the proposal is for the share used
  most against its limit: `guardianOutputShare` from the engine's
  `guardianTokens`, or `outputAllowancePerTicket` from the rest per ticket. A
  return without `guardianTokens` gets the allowance, with a `note` that the
  figure includes the Guardian's spend.
  Nothing writes a limit from that list.

A PM session that fakes a terminal (`script`, its own pseudo-terminal, or
`process.stdin.isTTY` set by a program that imports the kit) or sets
`NODE_TEST_CONTEXT`, or that forges a ledger line together with the digest of
the limits it wrote, is not detected (see "What these commands trust").

## Start as is

`--start-as-is` lets a batch start on a repository that has uncommitted or
untracked paths. It does not override the default-branch rule or a Git
operation in progress. The paths are recorded in the batch record
(`preexisting`) and one line is appended to `pm-decisions.md`. They are to be
kept out of the tickets' commits by the "after" command.

## Resuming left work

A worker can end without a verdict and leave its work in the product's work
tree: a turn limit, an output ceiling, a halt. Every ticket of a held batch, of
a batch in which no ticket passed, or of a batch the PM aborted, leaves its
work there too, and so does a ticket that did not pass and that `after` could
not set aside; `after` saves the others as `left` would (see "After").
`--start-as-is` keeps that work out of the next batch's commits, so without
this field it could only be committed by hand, unchecked.

**`left --instance <instance-root> [--run <run id>]`**
([ADR 0010](../../../decisions/0010-router-worker-second-mode.md), amendment of
2026-11-26, "the kit saves left work and counts its runs") saves that work. It
works on an archived batch, the newest by `openedAt` unless `--run` names one
(when an archive's batch record cannot be read, which is the newest is not
known, and it asks for `--run`). It refuses, and names the reason, while a batch
is open (`rw-batch.json` or `rw-batch-after.json` in the team root, so
`after` and a review come first, then `commit` or `abort`), while the write
boundary is not closed (a batch or a periodic review not over), when the
archive's batch and after records are not the ones `before` and `after` sealed
(the refusal gives the same recipe to save the work by hand as `abort` does),
while a `resolve` of that batch is still running (its archived record is
`batch-resolving` and the process it names is alive: `abort` releases the lock
such a `resolve` holds), when the lock on the product cannot be taken (it holds the lock for its
length), when the product is not on the batch's branch, or when a Git
operation is in progress. Then, for each ticket of the batch that the kit did
not commit:

- Its work is the paths `after` recorded as its changes that still show as
  changed. It is saved as a binary patch against the product's HEAD at
  `left/<run id>/<ticket>.patch` in the team folder and taken out of the tree,
  with `resolve`'s own functions and `abort`'s rule: nothing is removed before
  the patch is on disk, and a patch already at that place is never written
  over. One with the same bytes (a `left` that died after saving it) is used;
  one with other bytes leaves the ticket whole in the tree. A removal that
  fails after its patch was saved leaves the ticket in the tree with that
  patch, which is the complete one. A later run finds what is left of the
  ticket all in that patch (each file's section of the patch of what is left
  is in it byte for byte), and names it again as the complete one: what is left
  is discarded by hand, and the next run names the patch. The path carries the run id, so a ticket's
  work from two runs never shares a file and a second run finds its own patch;
  it lies outside `reviews/held/`, so a patch there always means a review hold.
- A ticket `resolve` or `abort` already held, or `after` set aside, is named
  with its patch (looked up under the batch's run id and under the archive's
  id), with `by` naming the command that saved it, and not saved again.
  When a ticket has more than one of these patches (a held patch brought back
  to the tree and saved again by `left`), the one written last is named, and
  `also` lists the others.
  One that `abort` saved and could not take out whole is named as left in the
  tree with `abort`'s patch, the complete one; `left` saves nothing of it.
- Each patch is checked as `before` would check it as the ticket's `resume`,
  against the ticket's `paths`. A patch it would refuse (it deletes or renames a
  file, adds an executable or a link, or another reason given) is saved all the
  same; the output says that the next batch must declare the ticket's `moves`
  and `deletes` and the patch be made again from its edits and new files.

Every changed path that is no ticket's work (outside every ticket, already
changed when the batch started as is, or changed by hand since) is named and
left as it is. Such a path is looked up in the after records of the other
archives, newest first: when a ticket there that the kit did not commit
recorded it as its change, the path is named in `claimed` with that ticket and
batch, and `next` gives the `left --run <run id>` that saves it, in place of
the advice to commit or discard it. Only an archive whose records `left --run`
would accept counts, and those records are read once, only when such a path
exists. The output: `{stage:
"left-work-saved", runId, savedAt, tickets: [{ticket, state: "patch", patch,
by: "left"|"after"|"abort"|"resolve", also?, resume, resumeProblem?} | {ticket, state:
"in-tree", paths, problem, patch?}], outside, claimed: [{path, runId,
ticket}], next}`. `resume` is the value to put in the ticket of the
next `BATCH.json`, or null when `before` would refuse the patch as it stands
(`resumeProblem` says why); `next` says it in words. One ledger line, `BATCH
<run> LEFT WORK SAVED by rw-batch.mjs left: <ticket> <patch>, ...; LEFT IN THE
WORK TREE: ...; <n> path(s) of no ticket left as they are (...); <n> path(s)
of tickets of other batches left as they are (...)`, is written
when it saved a patch or could not; a run that finds nothing left writes none,
so it can run any number of times. Exit 2 when a ticket's work is still in the
tree.

A patch `resolve` or `abort` held, or one `after` or `left` saved, is named in the
ticket's `resume`: `"resume": "left/<run id>/<ticket>.patch"` or
`"reviews/held/<run id>/<ticket>.patch"` brings the work back as the ticket's,
to be checked and reviewed again. It is checked like any other: the patch of a
ticket that deleted or renamed a file, or created an executable one, is
refused, and the PM makes it again from its edits and new files and declares
the moves and deletes on the ticket. "before":

- accepts `resume` only as a relative path in the team's folder, outside
  `kit/`, with no `.` or `..` part, naming a regular file (a link is not
  followed);
- reads the patch once and refuses it when it is empty, when Git cannot read
  it, when it deletes, renames, copies or changes the mode of a file, or adds
  anything but a regular non-executable file (a link, an executable, a
  submodule; declare `moves` and `deletes` instead), when it changes more than
  100 paths, a path with a control character or bytes that are not UTF-8, a
  path outside the ticket's `paths` (compared as "after" compares, with case),
  a path the ticket also moves or deletes, a path Git ignores (Git status would
  never show it to "after" or "commit"), a path with assume-unchanged or
  skip-worktree set, or when it does not apply on the product's HEAD;
- applies those same bytes to the work tree after the write boundary opens,
  records the patch's path, digest, paths and the content it left at each path
  in the ticket's entry of the batch record (`resume`), and appends one line to
  `pm-decisions.md` (`BATCH <run> RESUMES <ticket> from <patch>`). If "before"
  then fails, the patch is taken back out; when that fails too, the refusal
  says so. The launch manifest is taken before the patch is applied, so it
  describes the HEAD; the batch record names the patch;
- tells the exec worker in its brief which paths hold the earlier attempt
  (`resumedPaths`), and to finish and verify it, not start over. The checker's
  brief is unchanged: it verifies the work tree as it is.

From then on the resumed work is the ticket's own: `after` counts it in the
ticket's changed paths (a resumed path that still holds what "before" applied
is not taken for a write no worker made, `HOOK_SAW_NO_WORKER`), the checker verifies it, the review triggers and the
ticket's risk flags apply to it, and `commit` commits it with what the worker
added. If the ticket does not pass, `after` sets it aside again as a patch, as
any batch's.

## Refusals (`BATCH_REFUSED`)

- The team is not live in Router/Worker mode, a mode switch was interrupted, or
  a batch is already open.
- A ticket is incomplete, or two tickets claim the same file. The message names
  the tickets and the paths.
- A ticket claims a path under `.git` or `.claude`, or grants only folders
  without `expectedPaths`. A ticket whose grants cover a `sensitivePaths` entry,
  or that carries a `riskFlags` entry, is not refused: `before` records it as
  declared-sensitive and `after` flags it for Security whenever it passes with
  changes.
- The product repository is on a default branch, not on a branch, has a Git
  operation in progress, or has uncommitted changes (the first ten paths are
  listed), or changed while the batch was being prepared.
- The lock is held. If this team holds it with no batch open, the message names
  `abort`.
- A verification command is not among the commands the owner confirmed for
  the team. The message names the commands and the `team-mode.mjs limits` call
  that adds them.
- A ticket's `resume` patch is not a file of the team's folder, or is not a
  patch of edits and new files inside the ticket's `paths` that applies on the
  product's HEAD (see "Resuming left work").
- The batch cannot be frozen: an estimate above the authorization, a roster that does not staff the three workers.
- The launch preflight or the isolation check does not pass.

The limits not being the ones the ledger binds is refused with its own code,
`LIMITS_NOT_BOUND`.

## Not covered

- **Nothing checks that the PM attested the run** at the reconciliation step.
  The Guardian of a batch is told the attestation follows; a PM that leaves
  `--monitoring` out leaves no line, and no command refuses.
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
- That the runtime skips the permission prompt on the hook's decision is taken
  from Claude Code's documentation, which also says a `deny` or `ask` rule in
  the settings still applies, and that no decision approves "actions no mode
  auto-approves".
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
- **A review's Reads are credited from their input, not from what the tool
  returned.** A range larger than the brief prescribes, or a plain `Read` of a
  long file, can be cut by the tool (Claude Code, seen in 2.1.332, returns a
  `Read` over its output token cap as a first page, without an error) and is
  still credited with all the lines its input names. A line longer than the
  Read tool shows is cut without trace, so a file whose single line exceeds
  what the tool returns counts as read. Lines are counted as newline
  characters. A media file is credited after one `Read` however much of it the
  tool showed, a PDF read with `pages` included; the media extensions are the
  kit's list, not read from the tool, and a file is media when its leading
  bytes match (a notebook when it parses as JSON), whether or not the rest of
  it is well formed. A text file with a NUL
  byte past its first 8,000 bytes is still text. A UTF-16 text file has NUL
  bytes and is classed binary: its content is never read and its diff says
  only that binary files differ.
- **A text file over 256 KB is not read.** It is judged from its diff as the
  brief shows it, which over the cap may be its removed lines or only its
  counts; its unchanged part is not read, and a rule resting on it is reported
  not-checked. A ticket whose only flagged file is such a file, with no diff
  shown, can get every rule not-checked, which refuses the report.
- **Dispatches the review does not see**: a transcript deleted or moved before
  judging; one in a session under another configuration folder; one whose
  meta file does not name the wrapper; one whose first user entry does not
  hold the brief's heading as a line; one made after the transcript that
  brought a verdict, which is never judged nor metered; the dispatch of a
  brief made again under one of B1's exceptions (a failed command, a pinned
  path changed); those of a batch aborted before they were judged; and a
  periodic review aborted and briefed again, whose new period id leaves the
  earlier dispatch unjudged (a periodic review gates no commit). Transcripts
  with no `timestamp` are ordered by path. Like the records, this detects a
  careless PM, not a deliberate one.
- **The periodic review reads files as they stand, not each commit's diff.** A
  path a later ticket changed again is read in its later state, and a path
  deleted since is not read. Commits made by hand, outside `commit`, are named
  in the ledger by the next `before` for the owner's spot review, but the
  periodic review does not count or read them.
- **`abort` weighs only the reviewers `after` required.** An elective review
  (`review-brief --ticket`) is not weighed: a ticket that only an elective
  reviewer rejected stays in the work tree after `abort`.
- **The commits made outside the kit are told by the archive's end commit**,
  which a PM session can rewrite with the archive. A branch rebuilt since the
  last archived batch, or one with no archived batch, is not compared; the
  ledger says so for the rebuilt branch. Only the first 100 ids are frozen.
- **Earlier runs are told by id and by `paths`.** The same work filed again
  under a new id whose `paths` overlap none of the earlier grants is not
  counted. Another piece of work on the same files is counted as a run of this
  one, and so is a run that was not committed although the work later landed
  under another id. A batch aborted before `after` is not archived and is not
  counted, nor is an archive whose batch record cannot be read, and an archive
  whose after record cannot be read counts as no earlier run. The archives
  are files a PM session can rewrite.
- **A rejection counts by its id and by the held patch it resumes.** The same
  work filed again under a new id and done again from nothing, or resumed from
  a copy of its held patch edited outside `reviews/held/`, is new work and is
  not counted with the earlier ticket. An escalation still blocks by the
  escalated ticket's id and paths, not by the ids it was counted with: an
  escalated ticket that changed a file most tickets touch blocks every ticket
  on that file until the owner acknowledges it.
- **`left` saves what `after` recorded as each ticket's changes.** A path a
  ticket changed that `after` could not see (a Git-ignored file), or one
  changed by hand since, is named as no ticket's work and left. On an older
  batch (`--run`), it saves only what that batch's `after` recorded. A removal
  that fails part-way leaves part of a ticket in the tree: its patch holds all
  of it, and the PM discards the rest.
- **The brief's verification runs without the lock.** Nothing else starts while
  the batch is in review, but the PM's own session can still change the product.
- **A process id is taken for the command or the `after` it names.** A lock
  or a claim whose process id was given since to another program reads as
  still running: the command and `abort` refuse, and the refusal says how to
  clear it by hand. The lock is a file in the product's Git directory; a
  command on another host that shares it is judged by a process id of this
  host. A claim of an earlier kit names no process, and `abort` does not wait
  for it.
- **`after` sets aside the work of a ticket that did not pass only when it
  would verify.** In a batch another finding holds, or one in which no ticket
  passed, that work stays in the work tree until the PM runs `left`. A ticket
  that did not pass is never flagged, whatever paths it changed: its work is
  reviewed when it comes back as a `resume` and the triggers flag it there.
- **A patch `after` saved and the PM brought back to the tree** is not saved
  again by `left` once the PM edited it: the patch is never written over, so
  `left` leaves that ticket in the tree and says so.
- **The kit runs no command on a tree that holds more than the planned
  commits.** A path outside every ticket, or a batch started as is, is enough:
  `VERIFICATION_NOT_RUN` says so, and the commits rest on the checkers' word.
- **A verification command that writes a file Git does not ignore outside
  every ticket** (a cache) gets `VERIFICATION_NOT_RUN` in every batch: the
  path is in the tree at the first batch and, once that batch is started as
  is, counts as changed before the next. No command of the kit clears it.
  The owner ignores such paths in the product's `.gitignore` to get the
  verification; `next` says so.
- **Git-ignored files a worker wrote are invisible**, inside or outside the
  tickets' paths. ADR 0010 tolerates ignored build output; nothing compares it
  with the state before the batch.
- **Not tried:** commit signing, LFS or clean filters, sparse checkout, linked
  worktrees.
- **The default branch is recognised by name**: every remote's default,
  `init.defaultBranch`, `main`, `master`. A repository with no remote whose
  default branch has another name (`develop`) is not recognised.
- **A faked terminal, a faked test context or a forged ledger line is not
  detected** (above); nor is a forged acknowledgement line that carries the
  escalation's digest.
- **The estimated output** the engine is told is half the ceiling. It is a
  figure the kit sets so that the engine's own checks on the ceiling hold; it
  is not a forecast.
- **The Guardian's estimate** at settlement is the authorization of one ticket.
  ADR 0010 sets the Guardian's share of the output ceiling only.
- **The hook must be loaded** in the PM's session. The command checks that it
  is registered and that its file exists, not that the running session read it.

**Not covered by resolve.**

- A ticket held because a verification command failed is patched from the tree
  as the commands left it: if a command edited that ticket's files, the patch
  carries the command's edit with the worker's.
- A command that deletes or rewrites a path left uncommitted by `after`, or a
  path that was there before the batch (start as is), is not recorded; the next
  `commit` then refuses because the product changed, and the batch is aborted.
- A `resolve` that dies after its ledger line and before its record writes a
  second `RESOLVED` line when it is finished.
