# A batch in a standing Router/Worker team

Status: "before", "after", "commit" and "abort" are built and tested offline
on a bootstrapped fixture, with the real engine run on mock agents; so is
"settle". Of the review of ADR 0011 the trigger list, the flags, the review
state, the reviewer's brief, the judging of its report, the commit gate and the
escalation to the owner are built ("Review triggers", "Review state and brief",
"Review verdict, commit gate and escalation"), and so are "Resolve" (held
tickets saved as patches, the rest verified again), sensitive tickets and the
cost of each reviewer call, set at "settle", and the periodic review
("Periodic review"). Not yet used
on a real team.
[ADR 0010](../../../decisions/0010-router-worker-second-mode.md), decisions 8 to 12.

```sh
node kit/scripts/rw-batch.mjs before BATCH.json --instance . [--start-as-is]
node kit/scripts/rw-batch.mjs after RESULT.json --instance .
node kit/scripts/rw-batch.mjs settle METER.json --instance . [--run <run id>]
node kit/scripts/rw-batch.mjs review-brief --reviewer <security|architect> --instance . [--ticket <id> ...]
node kit/scripts/rw-batch.mjs review --reviewer <security|architect> --transcript <agent-*.jsonl> --instance . [REPORT.json]
node kit/scripts/rw-batch.mjs review --no-answer "<reason>" --reviewer <security|architect> --instance .
node kit/scripts/rw-batch.mjs commit --instance .
node kit/scripts/rw-batch.mjs abort --instance .
node kit/scripts/rw-batch.mjs periodic-brief --reviewer <security|architect> --instance .
node kit/scripts/rw-batch.mjs periodic --reviewer <security|architect> --transcript <agent-*.jsonl> --instance . [--meter METER.json] [REPORT.json]
node kit/scripts/rw-batch.mjs periodic --no-answer "<reason>" --reviewer <security|architect> --instance .
```

Exit 0 done, 2 refused or (for `after` and `settle`) a batch in review, or (for
`review` and `periodic`) a report refused or a review not obtained, 1 usage. No model,
no network.

## The order of a batch

| Step | Who | What |
|---|---|---|
| 1 | PM | `before BATCH.json`: the batch is checked, frozen and opened |
| 2 | PM | runs `run-n-rounds` with the `args` of the batch record |
| 3 | PM | `after RESULT.json`, with the engine's return: the run is checked, the write limits close, the lock is released |
| 4 | PM | `scripts/reconcile-run.mjs RESULT.json .`: lifecycle and message ledgers, as in specialist mode |
| 5 | PM | `scripts/measure-spawn.mjs <session-dir> --json > METER.json`, then `settle METER.json`: usage per ticket. The next `before` is refused until this is done |
| 6 | PM | a flagged batch only: `review-brief`, the reviewer's dispatch and `review` per reviewer, then `resolve` (see "Resolve") |
| 7 | PM | `commit`: one commit per ticket that passed, or per ticket the resolution kept; the batch is archived |

`abort` replaces steps 2 to 7 for a batch that will not be run. `settle` may
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
| `sensitivePaths` | Paths whose tickets Security always reviews ([ADR 0011](../../../decisions/0011-router-worker-batch-review.md), decision 6). They are judged against `paths`, which is what bounds the worker, not against the plan: a ticket whose grant covers a sensitive path, or lies under one, is declared sensitive (`sensitivePath:<entry>`). An entry written as a bare folder (`src/auth`) guards everything under it. At least one entry |
| `riskFlags` (optional) | 1 to 10 plain names (`auth`, `payments`), each named once. Each declares the ticket sensitive (`riskFlag:<name>`). What a ticket declares is frozen in the record as its `declared` list. A declared-sensitive ticket that passed and changed something is flagged for Security on every changed path, even when no trigger matches, and is not committed without a passed Security verdict; one that changed nothing is not committed, so it is not flagged |
| `commitMessage` (optional) | The message of the ticket's commit, one line; by default `<id>: <title>` |
| `dependsOn` (optional) | Ids of tickets this one builds on: an earlier ticket of the batch, or a ticket of an archived batch. Frozen in the record (`[]` when absent); an escalated ticket blocks every ticket that depends on it, directly or through others (see "Review verdict, commit gate and escalation") |
| `moves` (optional) | Tracked files the worker renames: `[{ "from": "src/a.js", "to": "lib/a.js" }]`. Each gives the exec worker one exact command, `git --literal-pathspecs mv -- "<from>" "<to>"`, prefixed with `mkdir -p -- "<folder>" && ` when the folder of `to` does not exist yet (Git does not create it). Frozen in the record (`[]` when absent). See "Moves and deletions" |
| `deletes` (optional) | Tracked files the worker deletes: `["src/old.js"]`. Each gives the exec worker one exact command, `git --literal-pathspecs rm -q -- "<path>"`. Frozen in the record (`[]` when absent) |
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
   escalation"; refused with `TICKET_ESCALATED`). Every verification command of the batch is one of the commands the
   owner confirmed for the team (`allowedCommands` in its limits).
2. **The tickets**: each is complete, and no two tickets claim the same file. A
   folder grant claims every file under it; paths are compared without case.
   Each file a ticket moves or deletes is one plain path inside its `paths`
   (see "Moves and deletions").
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
   may run the batch's verification commands, and the exec worker the Git
   commands of the tickets' moves and deletions; see "The workers' shell".
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
   findings: a lock must not outlive its batch. When a ticket is flagged for a
   reviewer the boundary goes to the review state instead of closed (see
   "Review state and brief").
5. **The commit plan**: one commit for each ticket that passed and changed
   something, of that ticket's own paths. A ticket that did not pass, or was not
   run because the batch halted, is not in the plan. A ticket passed when the
   engine's record says it is done and nothing else in that record says
   otherwise (a failed verification, a pending fix or recovery).
6. **The record** `rw-batch-after.json` and one line in `pm-decisions.md`.
   `status` is `clean` when there is no finding, the engine reports no
   blocker and no ticket is flagged for a reviewer, otherwise `review`. `next` says what the PM must do when something
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
| exec worker, the same with a Git command of a ticket's `moves` or `deletes` (see "Moves and deletions") | approved; the checker and the Guardian are refused it |
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
`ls`, `cat` or `git` in a batch, apart from the exact Git commands of its
tickets' moves and deletions. A command a ticket needs and the list lacks is
the owner's to add, before the batch.

### Moves and deletions

With its file tools a worker can write a file but not rename or delete one
([ADR 0010](../../../decisions/0010-router-worker-second-mode.md), amendment of
2026-11-24). A ticket that needs it declares the files in `moves` and
`deletes`, and "before" checks them:

- each `from`, `to` and deleted path is one plain file path: no folder grant,
  no `.` or `..` part, none of `` " $ ` \ ! * ? [ ] { } : ``, no control,
  bidirectional or zero-width character, not under `.git` or `.claude`; it
  lies inside the ticket's `paths`, and no path is named twice in the
  ticket's moves and deletes (compared without case);
- each `from` and each deleted path is a file tracked at the product's HEAD;
  a `from` is not a symbolic link, since a later path could reach through a
  moved link out of the grant (a deleted path may be one: `git rm` removes the
  link itself and never follows it);
- no path the batch moves or deletes lies under another such path, over all
  its tickets: the commands run one after another, and the first could
  redirect the second;
- each `to` does not exist, and the nearest folder of it that exists is a real
  folder of the product, not a link;
- at most 100 moves and deletions over the whole batch.

No move lands in a submodule: a product whose index holds one opens no batch
at all (`SUBMODULE_PRESENT`, step 6).

From each it derives one exact command, given to the exec worker's shell for
that batch only, and to no other worker:

| Declared | Command |
|---|---|
| a move whose folder exists | `git --literal-pathspecs mv -- "<from>" "<to>"` |
| a move into a folder that does not exist yet | `mkdir -p -- "<folder>" && git --literal-pathspecs mv -- "<from>" "<to>"` |
| a deletion | `git --literal-pathspecs rm -q -- "<path>"` |

Git takes each path as written, never as a pattern, as `commit` does.

The exec brief lists the ticket's own commands as `gitCommands`, beside its
`writePaths` (the ticket's `paths`) and `plannedPaths`, and says that the worker
runs no other command, Git included. A worker that runs another `git mv`, the
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
authorization: the largest usage observed, the tickets, and a proposal; empty
otherwise. `status` is `clear`
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
  A commit made just before the command died, and so never recorded, is taken
  up when it is the next planned one: its parent is the expected commit and it
  holds exactly that ticket's paths. A commit made by hand that fits the same
  description is taken up too; the kit compares paths, not content.
- A commit is made with the repository's identity, or the one given in
  `GIT_AUTHOR_*` and `GIT_COMMITTER_*`. Every other `GIT_*` variable is ignored.
- A `commit` that died after archiving the batch is finished by the next call.
- What is not committed stays in the work tree and is listed (`left`): a ticket
  that did not pass, a path outside every ticket, a path a verification command
  wrote during `resolve`. A ticket `resolve` held is a patch, not a change in the
  work tree. The next "before" then
  refuses until the PM commits or discards those paths, or starts as is.

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
  `REVIEW TRIGGERS ADDED: ...` and `REVIEW TRIGGERS REMOVED (owner spot review): ...`.
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
  attempt: run, reviewer, wrapper, attempt, `briefDigest`, the tickets with
  their goal, acceptance, changed and flagged paths and content digests, the
  rule ids, the ADRs, each verification command's exit and output digest). The
  brief holds, for each ticket R must review: the goal and acceptance, the
  reason it was flagged, and the flagged files as absolute paths to open with
  the Read tool; the diff of those tickets from the batch's start, untracked
  files included (inline up to 60,000 characters, otherwise the reviewer opens
  each changed path); R's rules as `id: text`; the ADRs as absolute paths; the
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
  was edited.
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
  digest); and it holds a `Read` tool call of the absolute path of every
  flagged file that exists. A `Read` counts only when the `tool_result` with
  its `tool_use_id` is in the transcript and is not an error, and it has no
  `limit` and no `offset` past 1; a partial `Read` is ignored, so it counts
  only next to a full `Read` of the same path. The Read tool's own default
  cut of a long file is not detected. The report is the last fenced `json` block of the
  last assistant message; a `REPORT.json` given must be equal to it.
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
  `REVIEW_ITEM_CONFLICT`, `REVIEW_RULE_MISSING`,
  `REVIEW_ALL_NOT_CHECKED`, `REVIEW_ITEM_MISSING`, `REVIEW_VERDICT_MISMATCH`,
  `REVIEW_CONTROL_MISSING`, `REVIEW_NO_ANSWER`. A transcript that cannot be
  read, one already judged, or a flagged file changed since the brief is
  refused without recording an attempt.
- **One more attempt.** After a refused report the next `review` needs a new
  brief: `review-brief` makes attempt 2 with the refusal reasons in the brief
  (`retryReason`). A second refused report, or `review --no-answer` on the
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
  after that line and before its verdict, then passed on a new attempt, is
  refused the same way; the batch is aborted.
- **Across batches.** Each final outcome that is not a pass is appended to
  `reviews/tickets.jsonl` as `{ticket, runId, reviewer, outcome:
  "rejected"|"not-obtained", finding, at}`, once per ticket, run and reviewer.
  A ticket id (compared without case) with two such outcomes in two distinct
  batches is escalated, whether they are two rejections, two reviews not
  obtained, or one of each (PM decision of 2026-11-22): `{id:
  "ESC-<ticket>-<run>", kind: "second-rejection"|"review-not-obtained-again"|"repeated-adverse",
  ticket, reviewer, runIds, paths, findings, at}` (`paths`: the paths the ticket
  changed in that batch, which are the paths of its held patch) in
  `reviews/escalations.jsonl`, an `ESCALATED` ledger line, and the verdict's
  `escalated` list. Two reviewers rejecting the same ticket in one batch count
  once.
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
(`tickets[].content`). Then:

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
   ticket's path, the holding starts at that ticket. Other paths the commands
   wrote are recorded as `wrote` and left uncommitted.
4. The review state closes, a `BATCH <run> RESOLVED` line goes to
   `pm-decisions.md`, the lock is released.

Exit 0 when nothing is held, 2 when a ticket is held. A second `resolve` returns
the same record.

**Resolution record** `rw-batch-resolution.json` (archived as
`resolution.json`): `{stage: "batch-resolved", runId, batchDigest, afterDigest,
reviewsDigest, resolvedAt, removed: [{ticket, reason:
"rejected"|"review-not-obtained"|"verification-failed-after-removal", patch,
patchDigest, paths}], verification: {ran, failed, commands: [{command, exit,
timedOut, outputDigest, tail}], dropped, changed, wrote}, commits, left}`.
`commit` checks it against the verdicts (`reviewsDigest`), `after`'s plan (the
commits are after's commits less the removed tickets, and every ticket a review
held is removed) and the patches on disk (each at its exact path with its
digest). The work tree it expects is `after`'s, less the removed paths, plus
`wrote`, and each path it commits must still have the content the review saw.

**Resume.** While it works the record has `stage: "batch-resolving"` and
carries each patch as soon as it is saved, the verification outcome once the
commands ran, the lock's digest and the process id. A `resolve` that died is
finished by the next one: it takes over the lock when that process is gone,
checks each saved patch against its digest, removes again what is not yet
removed, does not run the commands twice, and holds after a recorded failure
what the failure holds. A ticket a recorded failure holds is not compared with
its pinned content, since a command may have changed it.

**Abort after resolve** re-applies nothing: the held tickets stay patches under
`reviews/held/<run id>/`, the removed paths stay removed, and the note says so.
To take a held ticket back, `git apply reviews/held/<run id>/<ticket>.patch`
from the product root on the batch's start commit.

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
  commits changed, as an absolute path to open with Read as it stands now (a
  deleted one is marked). It carries no diff and no verification output; the
  rules are R's current rules, with the ADRs and the review protocol.
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
  (transcript place, wrapper, brief carried unchanged, a whole Read of each
  file, every rule per ticket, RED only with a failed rule, a fix and a control
  per failed rule). A refused report is briefed and dispatched once more; the
  second failure, or `--no-answer` twice, is `not-obtained`. Attempts are
  counted per reviewer over the same pending commits, so an `abort` between
  them, which gives the review a new period id, does not reset the count.
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
tickets: [{id, runs, shas, changedPaths, flaggedFiles, content}], ruleIds,
adrs, retryReason?}`. The ledger gets one `PERIODIC REVIEW <id> <reviewer>`
line per judgment.

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
left behind: it closes the write boundary (also from the review state), releases the lock if this team holds
it, removes the batch record and appends one line to `pm-decisions.md`. It
checks nothing about the work; that is the "after" command. It never releases
another team's lock. It does not know whether the engine is running: aborting a
batch that is being run takes its lock and its write paths away mid-run.

When the write-boundary file is missing or was changed, abort still releases
the lock and removes the record, and says the boundary was not restored: every
subagent write and shell command is then refused until a mode switch to specialist and back rebuilds
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
- The batch cannot be frozen: an estimate above the authorization, a roster that does not staff the three workers.
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
- **The periodic review reads files as they stand, not each commit's diff.** A
  path a later ticket changed again is read in its later state, and a path
  deleted since is not read. Commits made by hand, outside `commit`, are not
  counted.
- **The brief's verification runs without the lock.** Nothing else starts while
  the batch is in review, but the PM's own session can still change the product.
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
- **Nothing has run with real agents** from a batch record.

**Not covered by resolve.**

- A ticket held because a verification command failed is patched from the tree
  as the commands left it: if a command edited that ticket's files, the patch
  carries the command's edit with the worker's.
- A command that deletes or rewrites a path left uncommitted by `after`, or a
  path that was there before the batch (start as is), is not recorded; the next
  `commit` then refuses because the product changed, and the batch is aborted.
- A `resolve` that dies after its ledger line and before its record writes a
  second `RESOLVED` line when it is finished.
