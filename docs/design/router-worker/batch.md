# A batch in a standing Router/Worker team

The PM's runbook for one batch: the commands, their order, and what to do
with what they print. The detail of each step is in
[batch-reference.md](batch-reference.md), under the section this runbook
names. [ADR 0010](../../../decisions/0010-router-worker-second-mode.md),
decisions 8 to 12; [ADR 0011](../../../decisions/0011-router-worker-batch-review.md)
for the review.

Run every command from the team's root. Each prints its result; a `next` in
it says what to do in the case at hand. Do what it says: this runbook does
not repeat it.

```sh
node kit/scripts/rw-batch.mjs before BATCH.json --instance . [--start-as-is]
node kit/scripts/rw-batch.mjs after RESULT.json --instance .
node kit/scripts/rw-batch.mjs settle METER.json --instance . [--run <run id>]
node kit/scripts/rw-batch.mjs settle --not-metered "<reason>" --instance . [--run <run id>]
node kit/scripts/rw-batch.mjs review-brief --reviewer <security|architect> --instance . [--ticket <id> ...]
node kit/scripts/rw-batch.mjs review --reviewer <security|architect> --transcript <agent-*.jsonl> --instance . [REPORT.json]
node kit/scripts/rw-batch.mjs review --no-answer "<reason>" --reviewer <security|architect> --instance .
node kit/scripts/rw-batch.mjs resolve --instance .
node kit/scripts/rw-batch.mjs commit --instance .
node kit/scripts/rw-batch.mjs abort --instance .
node kit/scripts/rw-batch.mjs left --instance . [--run <run id>]
node kit/scripts/rw-batch.mjs periodic-brief --reviewer <security|architect> --instance .
node kit/scripts/rw-batch.mjs periodic --reviewer <security|architect> --transcript <agent-*.jsonl> --instance . [--meter METER.json] [REPORT.json]
node kit/scripts/rw-batch.mjs periodic --no-answer "<reason>" --reviewer <security|architect> --instance .
```

Exit 0 done, 2 refused or (for `after` and `settle`) a batch in review, or (for
`review` and `periodic`) a report refused or a review not obtained, or (for
`left`) a ticket's work still in the work tree, 1 usage. No model, no network.

## The order of a batch

| Step | Who | What |
|---|---|---|
| 1 | PM | `before BATCH.json`: the batch is checked, frozen and opened |
| 2 | PM | runs `run-n-rounds` with the `args` of the batch record |
| 3 | PM | `after RESULT.json`, with the engine's return: the run is checked, the work of each ticket that did not pass is set aside as a patch, the kit runs the passed tickets' verification commands on a tree that holds only the planned commits, the write limits close, the lock is released. See "How long after takes" |
| 4 | PM | `node kit/scripts/reconcile-run.mjs RESULT.json . --monitoring ATTESTATION.json`: lifecycle and message ledgers, as in specialist mode, and the PM's attestation of the run (`docs/engine.md`): who watched, over which interval, and each owner stop or hardware halt it saw. A headless PM attests `"coverage": "partial"` and says in `notes` that no owner channel existed |
| 5 | PM | a flagged batch only: the review steps below, then `resolve` |
| 6 | PM | `commit`: one commit per ticket that passed, or per ticket the resolution kept; the batch is archived. A batch whose commits are all held is archived with `abort` instead; `commit` refuses it |
| 7 | PM | `node kit/scripts/measure-spawn.mjs <session-dir> --json > METER.json`, then `settle METER.json --run <run id>`: usage per ticket. The next `before` is refused until this is done |
| 8 | PM | when the batch left work in the product work tree: `left` (below); the next batch names each patch it prints as a ticket's `resume` |

After the last step the PM writes its next-wake notes in `memory/pm.md`, as in
specialist mode: no command of the batch writes that file, and the validator
warns when it is older than 14 days.

`abort` replaces steps 2 to 7 for a batch that will not be run. `settle`
refuses while a batch is in review; an unflagged batch may settle before
`commit`, and an archived one settles with `--run <run id>`. It must come
before the next batch.

**A PM with no owner present** runs a batch from a headless session started in
the team's root (`claude -p "<instructions>"`), which has the Workflow tool,
the team's hook and its wrappers:

- It does not end its turn while the engine runs: it waits for the workflow's
  completion notice.
- It leaves no background shell running when it finishes: `claude -p` does not
  exit while one is alive.
- It stops only processes it started. A `pkill` by name also ends the owner's
  own, `caffeinate` among them.
- On a Mac it is started with `caffeinate -i`, or the machine can sleep
  mid-run.
- The owner's user settings apply to it too (`docs/claude-integration.md`,
  "Your Own Claude Code Settings").

## What the PM writes in BATCH.json

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

| Field | What to write |
|---|---|
| `id`, `title`, `goal`, `acceptance` | The ticket. `id`: 1 to 40 letters, digits, dots, dashes or underscores, unique in the batch |
| `paths` | What the ticket's worker may write: files, or folders ending in `/**`. Never under `.git` or `.claude`. No two tickets claim one file. At most 100 over the batch |
| `expectedPaths` | The files the worker is expected to touch. Required when a ticket grants only folders |
| `estimate` | Execution, check and rework tokens. Their sum stays within the authorization per ticket |
| `verificationCommands` | For the batch: commands the owner confirmed for the team (`allowedCommands`). Per ticket, optional: the ones that ticket needs |
| `sensitivePaths` | At least one. A ticket whose `paths` cover one is always reviewed by Security |
| `riskFlags` | Optional names (`auth`, `payments`) that make a ticket sensitive |
| `dependsOn` | Optional ids of tickets this one builds on |
| `moves`, `deletes` | Optional tracked files the worker renames or deletes; the worker gets the exact Git command for each |
| `resume` | Optional patch that holds earlier work of this ticket, as `left`, `after`, `abort` or `resolve` printed it |
| `commitMessage` | Optional, one line. Default `<id>: <title>` |
| `nextLifecycleNumber` | The next lifecycle entry number |
| `runId`, `date` | Optional. Default: a new run id, and today |

The PM does not write a ceiling, a number of rounds, a wrapper name or a
budget per ticket: those come from the team. The rules of each field:
[What the PM writes](batch-reference.md#what-the-pm-writes),
[Moves and deletions](batch-reference.md#moves-and-deletions) and
[Resuming left work](batch-reference.md#resuming-left-work).

A ticket's worker runs only the batch's verification commands and the Git
commands of its moves and deletions, each typed exactly as given, and reads
files with its file tools: [The workers' shell](batch-reference.md#the-workers-shell).
A command a ticket needs and the team's list lacks is the owner's to add with
`team-mode.mjs limits`, before the batch.

## When `before` refuses

`before` refuses with `BATCH_REFUSED` and the reason. Most reasons name what to
change in `BATCH.json` or in the product repository. Some name someone else's
step:

| Refusal | What to do |
|---|---|
| uncommitted or untracked paths in the product | commit or discard them, run `left` if they are a ticket's work, or start the batch with `--start-as-is` ([Start as is](batch-reference.md#start-as-is)) |
| an earlier batch not settled | `settle` it, with `--run <run id>`, or mark it `--not-metered` |
| `PERIODIC_REVIEW_DUE` | the periodic review below, then `before` again |
| `LIMITS_NOT_BOUND`, a verification command not confirmed | the owner, with `team-mode.mjs limits` at a terminal |
| `TICKET_ESCALATED` | the owner acknowledges the escalation, or the batch leaves out the blocked tickets |
| this team's lock with no batch open | `abort` |

The list: [Refusals](batch-reference.md#refusals-batch_refused) and
[What decides the limits](batch-reference.md#what-decides-the-limits).

## How long `after` takes

`after` runs the passed tickets' verification commands, up to 15 minutes
each, and runs once more each one that failed. Start it with a timeout as long
as those commands need, or in the background, and wait for it to end. Do not
start a second `after` while the first is alive: it is refused. If the first
one died, run `after` again: it takes over and runs the commands again. Detail:
[After](batch-reference.md#after).

## What `after` found

`status` is `clean` when nothing was found and no ticket is flagged for a
reviewer: go on to `commit`. Otherwise it is `review`, and the record lists
findings, the tickets flagged for a reviewer, and `next`.

| Finding | Commits |
|---|---|
| `WRITE_OUTSIDE_PATHS` | the paths no ticket covers stay uncommitted; the tickets are committed |
| `VERIFICATION_NOT_RUN` | not held: the tree held more than the planned commits, so the kit did not run the commands and the commits rest on the checkers |
| `NESTED_REPOSITORY` | the folder stays uncommitted |
| `PREEXISTING_PATH_CHANGED` | not held; that path is never committed |
| `GUARDIAN_ATTENTION`, `LEDGER_NOT_WRITTEN`, `BOUNDARY_NOT_RESTORED`, `LOCK_RELEASE_FAILED`, `LOCK_NOT_HELD_BY_THIS_BATCH` | not held |
| `HOOK_SAW_NO_WORKER`, `VERIFICATION_FAILED`, `CHECK_RUNS_MISSING`, `HOOKS_CHANGED`, `HOOKS_WRITTEN`, `BOUNDARY_CHANGED`, `PRODUCT_HEAD_MOVED`, `PRODUCT_BRANCH_CHANGED`, `GUARDIAN_NOT_CLEAN` | all held |

**All held**: the kit commits nothing of the batch, and the batch is not put
in review. Run `abort`, then `left`. Only what belongs to no ticket may then
be committed by hand. After `HOOKS_CHANGED` or `HOOKS_WRITTEN`, inspect the
folder Git runs hooks from and remove every hook the batch added or changed
before any commit by hand.

**Not held**: review the flagged tickets if there are any, then `commit`.
Paths left uncommitted are dealt with by `left` once the batch is committed
or archived.

What each finding means: the findings table of
[After](batch-reference.md#after).

## The review

A batch is in review when a ticket that passed is flagged for a reviewer:
[Review triggers](batch-reference.md#review-triggers). Until the review is
over no batch, mode switch or change of limits starts. For each reviewer R
that `after` names:

1. `review-brief --reviewer R` prints R's brief. Save it to a file. When it
   warns on standard error that a verification command failed, and the
   failure is flaky or its cause is gone, brief again before dispatching.
2. Dispatch R's wrapper from the PM's own session as a new agent, with the
   brief unchanged as its prompt. A reviewer started inside an engine
   workflow is refused.
3. `review --reviewer R --transcript <path>`, with the reviewer's transcript,
   `<projects>/<project>/<session>/subagents/agent-<id>.jsonl`. The kit
   judges R's report from it and records the verdict.
4. A dispatch that left no transcript is recorded with
   `review --no-answer "<reason>"`; while a transcript carries the brief, it
   is judged instead.
5. After a refused report or a recorded no-answer, `review-brief --reviewer R`
   makes attempt 2 with the reasons. Dispatch it to a new agent, never by
   resuming or messaging the earlier one. A second failed attempt records the
   review as not obtained.

A failed rule rejects the ticket. `AMBER` does not: the ticket is committed
and the PM files the concern as a backlog ticket. `--ticket <id>` adds an
elective review of a ticket that passed with changes; it binds like a
required one.

Once every reviewer has a final verdict, `resolve`. It saves each ticket a
review rejected, or could not judge, as a patch under `reviews/held/<run id>/`,
takes it out of the work tree, and runs the verification commands again when a
later ticket is still to be committed. Exit 2 when a ticket is held. Then
`commit`, which commits what the resolution kept; or `abort` when every commit
is held.

A ticket rejected, or not obtained, in two batches is escalated to the owner.
"before" then refuses the tickets it blocks until the owner runs
`node kit/scripts/team-mode.mjs acknowledge <escalation id> --instance .` at a
terminal.

Detail: [Review state and brief](batch-reference.md#review-state-and-brief),
[Review verdict, commit gate and escalation](batch-reference.md#review-verdict-commit-gate-and-escalation),
[Resolve](batch-reference.md#resolve).

## Settle

```sh
node kit/scripts/measure-spawn.mjs <session-dir> --json > METER.json
node kit/scripts/rw-batch.mjs settle METER.json --instance . --run <run id>
```

`<session-dir>` is the folder of the session that ran the engine and the
reviewers, under `~/.claude/projects/`. Exit 2 means `review`: read its
findings and `limits`, which lists each limit a ticket or a reviewer call came
near or passed, with a proposal for the owner. Settlement holds and undoes nothing. A batch whose
usage cannot be measured (its transcripts are gone) is marked with
`settle --not-metered "<reason>"` instead. Detail:
[Settle](batch-reference.md#settle).

## Periodic review

When `before` refuses with `PERIODIC_REVIEW_DUE`, a reviewer's count of
committed tickets reached the interval set in the charter. Between batches,
for that reviewer R:

1. `periodic-brief --reviewer R` prints the brief, or records
   `nothing-to-review`.
2. Dispatch R's wrapper with it, as in a batch review.
3. `periodic --reviewer R --transcript <path> --meter METER.json`.
4. A refused report is briefed once more and dispatched to a new agent;
   `periodic --no-answer "<reason>"` for a dispatch with no transcript.

It holds no commit. Each RED or AMBER ticket of an accepted report is a
finding for the PM to file as a ticket. Detail:
[Periodic review](batch-reference.md#periodic-review).

## `left` and `abort`

**`left`** runs after a batch is committed or archived, when work is still in
the product work tree: a held batch, a batch in which no ticket passed, a
ticket `after` could not set aside. It saves each ticket's work as a patch at
`left/<run id>/<ticket>.patch` and takes it out of the tree. For each it
prints the `resume` value to put in that ticket of the next `BATCH.json`, or
why `before` would refuse the patch as it stands. Paths that are no ticket's
work are named and left: commit or discard them by hand. Exit 2 while a
ticket's work is still in the tree. It can run any number of times. Detail:
[Resuming left work](batch-reference.md#resuming-left-work).

**`abort`** commits nothing. On a batch that `after` has not closed, it closes
the write boundary, releases the lock and removes the batch record. On a batch
`after` closed, in review or not, it archives the batch, and takes out of the
work tree, as a patch under `reviews/held/<run id>/`, each ticket a review
needed and did not pass. Then run `left` for the rest. `abort` refuses while a
command of this team or the batch's `after` is still running, and names the
process. It does not know whether the engine is running: aborting a batch
mid-run takes its lock and write paths away. Detail:
[Abort](batch-reference.md#abort) and
[When the kit will not commit a batch](batch-reference.md#when-the-kit-will-not-commit-a-batch).

A command that died holding the lock (a tool timeout, a closed terminal) needs
no `abort`: run it again, and it takes the lock over and goes on.
[The lock of a command](batch-reference.md#the-lock-of-a-command).

## What the kit does not check

Read [What these commands trust](batch-reference.md#what-these-commands-trust)
and [Not covered](batch-reference.md#not-covered) before relying on a
finding's absence.
