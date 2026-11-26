# ADR 0010: Router/Worker as the kit's second mode

Date: 2026-11-16
Status: Accepted (owner decisions given in session on 2026-11-16; ratified by the owner merging the pull request that adds this record)

## Context

[ADR 0008](0008-router-worker-topology.md) accepted the Router/Worker topology
on paper: three workers (execute, check, guard) instead of one role per
speciality, with live activation left gated. Between 2026-11-13 and 2026-11-16
five disposable smoke runs on the test project exercised it with real
agents, each in a throwaway copy of the team and a clone of the product:

| Run | What it showed |
|---|---|
| E-01, E-02 | The count engine runs a Router/Worker batch; a ticket that fails its check halts the batch |
| E-03 | The write-boundary hook fires inside engine-started agents and refuses a write outside the ticket's paths |
| E-04 | The engine's retry with fresh agents works; the retry cost about 34,000 input-side tokens for a one-line fix |
| E-05 | Dispatch by the main session through a gate hook works; the same worker fixed its work and the same checker re-checked it |

Two probes on Claude Code 2.1.323 fixed a limit that no design removes: an
agent started by a workflow cannot be resumed; an agent started with the Agent
tool can. One path therefore cannot offer a background batch, a whole-run
ceiling and "the worker that executed fixes its own work" together.

Until now the working assumption, set on 2026-11-14, was that the mode "stays
in disposable copies". The owner has withdrawn that: it described the tests,
not the goal.

## Decision

### What the mode is

1. **Two modes, one team.** A deployed team works in specialist mode or in
   Router/Worker mode, at the owner's choice. Router/Worker is a feature of the
   kit; the test project is only its test ground.
2. **Same way of working as the specialist team.** The team works under the
   owner's "run N rounds" directive, without the owner attending, in the
   project's real product repository. No sandbox is required: the mode runs
   under the same trust as specialist mode.
3. **Two-root layout only** ([ADR 0009](0009-kit-instance-separation.md)). A
   deployment in the older single-root layout is refused at the switch and
   pointed to the existing migration.

### Choosing and switching

4. **Chosen at bootstrap, or by a switch command** on a deployed team.
5. **The inactive mode goes on holiday.** The switch moves the live mode's own
   files into a dormant folder named `holiday/` and moves the other mode's files
   out of it (or creates them the first time). A mode's own files are its
   roster, its delivery role files, its wrappers and its mode profile. Shared
   history is never packed: charter, decisions, ledgers, lessons, memory, the PM
   and the governance roles. Nothing in `holiday/` is visible to the runtime.
   A packed folder is not edited by hand; after a kit upgrade it is brought up
   to date when it is next unpacked.
6. **A switch is refused** while a batch is open or the product repository has
   uncommitted changes.
7. **One approval, at the switch.** At bootstrap and at the switch the kit
   proposes the staffing and the limits below and the owner confirms or changes
   them. There is no approval per batch.

   | Setting | Proposed default |
   |---|---|
   | Worker that executes | Opus, high effort, 120 turns; read, search, run commands, write, edit |
   | Worker that checks | Opus, medium effort, 80 turns; read, search, run commands; no writing |
   | Guardian | Opus, high effort, 40 turns; read-only |
   | Output allowance per ticket | 15,000 tokens |
   | Guardian's share of the ceiling | 6,000 tokens |
   | Token authorization per ticket, checked at settlement | 200,000 tokens |
   | Attempts per ticket | 1 |

   Models are stored in the roster only, as for specialist roles. Running
   without the owner means nobody answers permission prompts: the workers use
   an allow-list for the project's verification commands.

### Running a batch

8. **The PM prepares the N tickets** from the project's backlog with one kit
   command: goal, acceptance, allowed paths and estimate per ticket. The kit
   checks and freezes; it refuses a batch with an incomplete ticket or with two
   tickets that claim the same file.
9. **The count engine runs the batch**, as in specialist mode. A ticket whose
   check fails stops the batch and goes to the PM. There is no automatic retry.
10. **The whole-run ceiling is computed by the kit**: N times the approved
    output allowance, plus the Guardian's share. The PM does not choose it.
11. **The product repository must be clean when a batch starts**: nothing
    uncommitted, no merge or rebase in progress, not on the default branch.
    The refusal lists the paths. An explicit "start as is" in the directive
    overrides it and is logged; paths already changed are recorded and kept out
    of the per-ticket commits. The team's own files are never counted, and
    Git-ignored build output is tolerated.
12. **Three safeguards stay, in one command before the batch and one after**:
    the lock on the product repository; the write limits (each worker writes
    only its tickets' files, the checker and the Guardian write nothing); and
    the after-run checks (the engine's return matched against what was frozen,
    files changed outside the tickets' paths, usage settled per ticket). The
    hook that enforces the write limits is installed in the team's settings at
    the switch and judges only the three workers.
13. **The PM commits at reconciliation**, one commit per ticket, on a working
    branch, never on the default branch
    ([ADR 0007](0007-pm-only-commits.md)). Workers do not commit.

### The gate path

14. **Kept, switched off.** Dispatch by the main session through the gate hook,
    where the same worker fixes and the same checker re-checks, stays in the
    code behind a flag. The flag is a setting of the team, stored with its mode,
    default off, changed only by the switch command, never per batch.
15. **Not part of this rollout.** Until it is completed, turning the flag on in
    a standing team is refused. Agreed for that later step: one Guardian call
    per batch that checks the claims in the log against the repository; the PM
    commits each ticket as soon as its check passes; ledger entries and
    reconciliation; safe handling of a worker that never reports back; a
    ceiling for the whole batch; a dispatcher that cannot write files itself.

### Removed

16. **The `retry` command and the `--retry-of` option** of the isolation check.
    They assume an engine-started agent can be resumed.
17. **The throwaway-copy tooling**: activation of a copy, the approval file per
    run, the single-use copy. It is removed only after the standing mode works
    and has its own tests.

## What this replaces

| Earlier | Now |
|---|---|
| "The mode stays in disposable copies" (2026-11-14) | Replaced by decisions 1 to 6 |
| "A real product repository only with a Bash sandbox" (2026-11-14) | Replaced by decision 2 |
| Approval file per run, bound to spec and draft | Replaced by decision 7 |
| Retries by the same agents as the default (2026-11-16, earlier that day) | Kept as the disabled gate path, decisions 14 and 15 |
| [ADR 0006](0006-pilot-operating-contract.md) ceilings for Router/Worker runs: owner attending, 60 minutes, half the usage window | Apply to the throwaway-copy tooling only; they end with decision 17 |
| ADR 0008 "live activation remains gated" | The gate is this record together with the proof below |

ADR 0008's topology and retry mapping stand unchanged.

## Proof of readiness

The mode is called rolled out when both have happened:

1. An automated test, in CI, with no model: bootstrap a blank fixture project
   in Router/Worker mode, prepare and run a batch with stand-in agents, run the
   after-run checks, switch to specialist mode and back, and find the same team
   and the same ledgers.
2. One run on the real test team and its real repository, on a working
   branch, with small real tickets, on the owner's go-ahead at that time.

## Order of work

1. This record. 2. Delete the `retry` path. 3. The switch and `holiday/`.
4. Bootstrap asks for the mode and the confirmation of staffing and limits.
5. The "before" command for a standing team. 6. The "after" command, its place
in reconciliation, and the allow-list. 7. The gate flag: present, off, refused
in a standing team. 8. Proof 1. 9. Proof 2. 10. Remove the throwaway-copy
tooling.

Nothing touches the real test team or repository before step 9.

## Consequences

- Specialist mode does not change. A change that would alter it goes back to the
  owner first.
- The engine's ceiling counts output tokens only. An engine batch has no brake
  on input-side usage during the run; the per-ticket authorization is judged
  afterwards, at settlement. The gate path has such a brake and is switched off.
- During an engine batch the changes of all passed tickets are uncommitted
  together. A later ticket's checker sees an earlier ticket's changes. Decision
  8 removes the case where two tickets could not be committed separately.
- A batch can be refused at its start by decision 11 for reasons the owner did
  not expect: a tool rewrote a tracked file, a verification command left a file
  Git does not ignore. The stop comes before any agent runs.
- Without a sandbox, a worker's shell can write outside its ticket's paths. The
  hook bounds its file tools; the after-run check finds other writes afterwards,
  and only inside the product repository.
- The five smoke runs are evidence for the mechanisms, not for the standing
  mode: none of them wrote into a real repository or ran in a standing team.

## Not decided here

- Completing the gate path, and when.
- A second project. The fixture test stands in for it until one exists.

## Amendments

### 2026-11-18: the workers' shell in a batch

Decision 7 says the workers use an allow-list for the project's verification
commands. The owner decided in session on 2026-11-18 how it is confirmed and
what happens to every other command ("您在切换时确认" for the first question,
"按你的建议来" for the second, the recommendation being refusal):

- The list is one of the team's limits (`allowedCommands`). The kit proposes it
  from the required gates of `profiles/stack.md`; the owner confirms it with
  the switch proposal, and changes it later by the same confirmation as the
  other limits.
- "before" refuses a batch that names a verification command the list does not
  hold.
- While a batch is open, the exec worker and the checker run those commands
  without a permission prompt, as written and from the product root. Any other
  shell command of the three workers is refused by the hook, in a batch and
  between batches.

This narrows the consequence stated above: without a sandbox, a worker's
shell starts only the confirmed commands. It does not bound what those
commands do: they write what they write, and they run the files the exec
worker may write, a test file for one. Merging the pull request that adds this
amendment ratifies it.

### 2026-11-18: a batch is settled before the next one opens

The consequence above says the per-ticket authorization "is judged afterwards,
at settlement". Nothing made that settlement happen: a batch could be committed
and the next one opened with no ticket ever set against its authorization. The
owner decided in session on 2026-11-18 ("按你的建议来", the recommendation
being enforcement with a logged way out):

- "before" refuses a batch while an archived batch that ran has no settlement.
- A batch whose usage cannot be measured is marked as not metered by the PM,
  with a reason, in the place of its settlement and on one line of
  `pm-decisions.md`. The kit records the reason and does not judge it; the
  owner reads those lines at the spot review.
- Settlement still reports cost only: it does not hold or undo a commit, and
  "commit" does not wait for it.

Merging the pull request that adds this amendment ratifies it.


### 2026-11-20: who changes the limits

The limits of a Router/Worker team (`attemptsPerTicket`,
`outputAllowancePerTicket`, `guardianOutputShare`, `authorizationPerTicket`,
`allowedCommands`) were confirmed by the owner at the switch or with
`team-mode.mjs limits`, but stored in `profiles/team-mode.json`, a file a PM
session could edit with nothing to detect it. The owner decided in session on
2026-11-20: "only human user, human tells router to change." and "router can
report to human any case like token limit not enough etc... decision is made by
human."

- **The ledger binds the limits.** The `MODE SWITCH` line of a switch into
  Router/Worker mode and every `LIMITS CHANGED` line end with
  `limits <digest>`, the digest of the limits confirmed. "before" refuses a
  batch (`LIMITS_NOT_BOUND`) when the limits in the profile are not the ones
  the last such line binds, and names the owner's command. A team that went
  live before lines carried a digest is refused the same way; the owner binds
  its limits as they stand with `team-mode.mjs limits` and a request that
  changes nothing, which is accepted only while the limits are unbound.
- **Only a terminal confirms them.** `changeLimits`, and `switchMode` into
  Router/Worker mode, refuse unless the caller says the code was typed at a
  terminal and the process has one (`process.stdin.isTTY`), or runs under
  `node --test` (`NODE_TEST_CONTEXT`). A PM session that imports the kit and
  calls them changes nothing. Only a line that says the code was "typed at an
  interactive terminal" binds limits.
- **No session's file tool writes the limits.** The PreToolUse hook refuses a
  Write, Edit, MultiEdit or NotebookEdit of the team's
  `profiles/team-mode.json` from any session, the PM's own included, and names
  `team-mode.mjs limits`, run by the owner. A shell command that writes the
  file is not judged by the hook; the ledger digest is what catches it.
- **The kit reports, the owner decides.** The records of "after" and "settle"
  carry a `limits` list: each limit that stopped or nearly stopped work in the
  batch, what was observed, the current value and a proposal the owner may
  confirm. Nothing in the kit writes a limit from that list.

Not covered: a PM that fakes a terminal (`script`, a pseudo-terminal of its
own, or one line setting `process.stdin.isTTY` in a program that imports the
kit) or sets `NODE_TEST_CONTEXT` gets past the terminal check; the profile
packed under `holiday/` is not guarded and binds at the next switch back,
where the owner sees it in the proposal; and a PM that
forges a ledger line together with the digest of the limits it wrote is not
detected. Nothing detects either. As for the batch records, the digests detect
an accidental or careless edit, not a deliberate one by a session that can
write the team's files; the owner's spot review of `pm-decisions.md` is the
check on that.

Merging the pull request that adds this amendment ratifies it.

### 2026-11-24: a worker moves and deletes the files its ticket declares

Status: Proposed.

On 2026-11-24 a batch on a real team ran a refactor that moves four source
files. The exec worker stopped before writing: in a batch it has its
file tools and the confirmed verification commands only (amendment of
2026-11-18), so it could not rename or delete a tracked file, though "commit"
already commits a staged rename or deletion. Its brief also gave it a narrower
scope than the hook enforces (the planned paths, not the ticket's `paths`) and
opened with the offline-preview line that calls the brief no dispatch
authority.

- A ticket may declare `moves` (`from`, `to`) and `deletes`. "before" accepts
  each only as one plain file path inside the ticket's `paths`, named once;
  each moved or deleted file is tracked at the product's HEAD, a moved file is
  not a symbolic link at HEAD or in the work tree, no moved or deleted path
  has assume-unchanged or skip-worktree set in the index, each path is in
  composed Unicode (NFC), no path the batch moves or deletes lies under
  another (compared without case),
  and each `to` does not exist and lies in a real folder of the product. A
  moved link, or a path one command creates that another command's path lies
  under, could carry a later move out of the grant (an independent review
  reproduced a move into `.git/hooks`).
- From each, "before" derives one exact command:
  `mkdir -p -- "<folder>" && git --literal-pathspecs mv -- "<from>" "<to>"`,
  `<folder>` being the folder of `to` (the `git mv` alone for a `to` at the
  top of the product), so that a folder an earlier `git rm` emptied and
  removed is made again; or
  `git --literal-pathspecs rm -q -- "<path>"`. The exec worker's command list
  in the write boundary holds the batch's declared moves and deletions, all
  tickets together, as its write paths hold all tickets' `paths`; the
  checker's and the Guardian's lists hold none. The hook judges them like the
  verification commands: the exact text, from the product root, inside the
  sandbox if there is one, for that batch only.
- The exec brief states the real grant (`writePaths`, the ticket's `paths`),
  the planned paths and the ticket's own commands. It tells the worker to run
  only those, says the host also accepts the other tickets' moves and
  deletions and that they are not the worker's to run, and says the worker
  runs no other command, Git included. A brief compiled for a standing batch
  no longer opens with the offline-preview line.

This widens the amendment of 2026-11-18 by those commands only. They are not
confirmed by the owner one by one: the PM declares them in the ticket, and the
owner reads them in the batch record (`moves`, `deletes`) and in the briefs.
Merging the pull request that adds this amendment ratifies it.

### 2026-11-25: a ticket resumes the work an earlier batch left

Status: Proposed.

On 2026-11-25 the exec worker of a real batch reached its turn limit during
its last verification pass and returned no report. The checker never ran, and
the work it left passed every gate when the PM ran them. The same had happened
on 2026-11-24 with an output ceiling. The kit had no way to give such work its
independent check and review: `--start-as-is` keeps changes found in the work
tree out of the tickets' commits, and a rerun from a clean tree throws the work
away and spends the same tokens again.

- A ticket may name a `resume` patch in the team's folder. "before" accepts it
  only as a regular file there, outside `kit/`, holding edits and new regular
  files inside the ticket's `paths` that apply on the product's HEAD. It
  applies those exact bytes to the work tree once nothing else can refuse the
  batch, records the patch's path, digest and paths, and logs one line. A
  refusal after that takes the patch back out.
- What the patch changes is the ticket's own work from then on: checked by the
  checker, flagged by the review triggers and the ticket's risk flags, and
  committed with the ticket. The exec brief names the resumed paths and tells
  the worker to finish them, not start over.
- The patch is written by the PM, who is trusted with the team's folder; its
  bytes, digest and paths are in the batch record for the owner to read. It
  grants no write beyond the ticket's `paths` and no command.

Merging the pull request that adds this amendment ratifies it.

### 2026-11-25: what of the Guardian's verdict holds a batch

Status: Proposed.

On 2026-11-25 a batch on a real team passed both tickets' checks and a
Security review, and the kit committed nothing: the Guardian answered
`main-session-action-required` because no observer had watched the run for an
owner stop or a hardware halt (`missedHaltRisk`), and any verdict but `clean`
held every commit with no way in the kit to clear it. A headless batch never
has such an observer, so that rule held every unattended batch whenever the
Guardian said so; an earlier headless batch had been called clean under the
same condition.

- A batch's commits are all held when the Guardian did not answer, asked to
  halt and investigate, or reports a problem in the run itself: a runaway, a
  budget gate that did not behave, or a failed check at risk of being
  dropped (`GUARDIAN_NOT_CLEAN`, as before).
- Any other verdict that is not `clean`, a missed halt risk included, is
  recorded as `GUARDIAN_ATTENTION` and holds nothing. The tickets are still
  committed only when their own check passed and their review, if any, passed.

Merging the pull request that adds this amendment ratifies it.

### 2026-11-25: a ticket names the verification commands its workers run

Status: Proposed.

The verification commands of a batch applied to every ticket, so on
2026-11-25 a ticket that changed one diagram file had its checker run the
product's full test suite. A ticket may now name `verificationCommands`, one
or more of the batch's own; its briefs list only those. The engine still
refuses a pass with no command run, so the list is never empty. The hook keeps
accepting the batch's whole list, and the kit's own re-verification at review
time runs the whole list.

Merging the pull request that adds this amendment ratifies it.

### 2026-11-26: the Guardian of a batch can call it clean

Status: Accepted.

In four of four real batches the Guardian answered
`main-session-action-required` with `missedHaltRisk`, because the engine asked
it whether an observer had watched a run that has none by design; one Guardian
also called the budget gate wrong because the computed ceiling was far above
the spend. The owner decided in session on 2026-11-26, accepting the
recommendation of that day's review of the kit.

The engine tells the Guardian of a batch that no observer watches the run by
design and that the PM attests an owner stop or a hardware halt after the run
(`reconcile-run.mjs --monitoring`), so `missedHaltRisk` is true only when the
run data shows a halt signal the loop did not honour. It also tells it that the
ceiling comes from the owner's limits, so `budgetGateCorrect` judges only
whether the gate tripped when the spend crossed the stop line. What `clean`
requires does not change, and specialist mode does not change. The engine's
blockers name the Guardian exactly when the batch's commits are held for it,
and a batch frozen before this amendment keeps the blockers it was closed
with, so it still settles.

### 2026-11-26: after counts the checker's runs and holds a batch the hook did not see

Status: Accepted.

A batch whose session never loaded the write-boundary hook was still committed:
`HOOK_SAW_NO_WORKER` held nothing, and one call by a governance role hid it.
A ticket also passed on the checker's own report. The owner decided in session
on 2026-11-26, accepting the recommendation of that day's review of the kit.

`HOOK_SAW_NO_WORKER` counts only the calls of the batch's three workers and
holds every commit; a hook that ran but could not append to its log leaves the
same empty log and is held the same. The hook logs, for each approved shell
call of the checker, the verification command it matched. `after` holds every
commit (`CHECK_RUNS_MISSING`) when, for a verification command, the checker's
approved runs since the batch opened are fewer than the passed tickets that
verify with it, so the checker's brief of a standing batch tells it to run every
command it lists and omit none. The count does not tell tickets apart, so a checker that runs a
command twice for one ticket covers for another that ran it not at all, and
whether a run passed stays the checker's word; a batch opened before this
amendment, whose record lacks `hookLogsCommands`, is not counted. The log is a
file in the team folder, and a confirmed command that runs a file the exec
worker may write (a test file) can append lines that read as the checker's runs
or as worker calls: `after` cannot tell them from the hook's.

### 2026-11-26: the budget gate of a batch is judged from the engine's trace

Status: Accepted.

The amendment of 2026-11-25 holds a batch for a budget gate that did not
behave, and the kit compared the engine's `tripped` with its final spend. Both
come from the same expression at the same moment, so the check could not see a
call dispatched after the stop line. The owner decided in session on
2026-11-26, accepting the recommendation of that day's review of the kit.

For a run with `standingBatch`, the engine's return lists each gate decision
before a worker, retry or checker call, with the spend at that moment and
whether it dispatched (`budgetStatus.gateTrace`). `after` and the blockers hold
the batch (`GUARDIAN_NOT_CLEAN`, `budgetGate: inconsistent`) when that trace is
missing or malformed, when a call was dispatched at or above 80% of the ceiling
or declined below it, or when its dispatched calls differ from the exec and
checker calls the return reports. The check still trusts the engine's return,
as `after` does everywhere: a hand-edited return can carry any trace. A batch
frozen without `standingBatch` keeps the earlier rule and still settles. A batch
frozen with `standingBatch` and closed before this amendment has no trace, so it
is held and its account no longer matches at settlement; no such batch exists
outside the kit's tests. Specialist mode does not change.
