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
   an allow-list for the project's verification commands. Changed by the
   amendments of 2026-11-18: the workers' shell in a batch, 2026-11-20: who
   changes the limits, and 2026-11-24: a worker moves and deletes the files
   its ticket declares.

### Running a batch

8. **The PM prepares the N tickets** from the project's backlog with one kit
   command: goal, acceptance, allowed paths and estimate per ticket. The kit
   checks and freezes; it refuses a batch with an incomplete ticket or with two
   tickets that claim the same file. Ticket fields and refusals are added by
   the amendments of 2026-11-24, 2026-11-25 and 2026-11-27.
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
    the switch and judges only the three workers. Changed by the amendments
    of 2026-11-18 and 2026-11-24 on the workers' shell, of 2026-11-25 and
    2026-11-26 on what `after` checks, what holds a commit and a command's
    lock, and of 2026-11-27 on the lock at the close, what a commit holds and
    packages.
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

Each amendment states its decision as it stands; the full earlier text is in
Git history. "Detail" names a section of
[batch-reference.md](../docs/design/router-worker/batch-reference.md), which
holds the rules in full, unless it names another file. The amendments of
2026-11-18 to 2026-11-25 are ratified by merging the pull request that adds
each. The owner decided those of 2026-11-18 and 2026-11-20 in session, and
those of 2026-11-26 in session by accepting the recommendation of that day's
review of the kit.

### 2026-11-18: the workers' shell in a batch

The allow-list of decision 7 is the team limit `allowedCommands`, proposed
from the required gates of `profiles/stack.md` and confirmed by the owner like
the other limits. `before` refuses a batch that names a verification command
the list does not hold. While a batch is open, the exec worker and the checker
run those commands, exactly as confirmed and from the product root, without a
permission prompt. The hook refuses every other shell command of the three
workers, in a batch and between batches; the amendment of 2026-11-24 adds the
exec worker's declared moves and deletions. This narrows the consequence on a
worker's shell: it starts only confirmed commands. What those commands write
or run is not bounded. Detail: "The workers' shell".

### 2026-11-18: a batch is settled before the next one opens

`before` refuses a batch while an archived batch that ran has no settlement.
The PM marks a batch whose usage cannot be measured as not metered, with a
reason the kit records and does not judge. Settlement still reports cost only:
it holds and undoes no commit, and `commit` does not wait for it. Detail:
"Settle".

### 2026-11-20: who changes the limits

Only the owner changes the limits (`attemptsPerTicket`,
`outputAllowancePerTicket`, `guardianOutputShare`, `authorizationPerTicket`,
`allowedCommands`, in `profiles/team-mode.json`), by a code typed at a
terminal. The kit
reports a limit that stopped or nearly stopped work, with a proposal, and
nothing in the kit writes a limit. The last `MODE SWITCH` or `LIMITS CHANGED`
line binds the limits by digest, and `before` refuses limits it does not bind
(`LIMITS_NOT_BOUND`). The hook refuses a file-tool write of
`profiles/team-mode.json` from any session, the PM's included. A PM session
that imports the kit and calls `changeLimits`, or `switchMode` into
Router/Worker mode, changes nothing.

Not covered: a faked terminal or test context, and a forged ledger line with
the digest of the limits it wrote. The profile packed under `holiday/` is not
guarded; it binds at the next switch back, where the owner sees it in the
proposal. The digests of the batch records detect an accidental edit, not a
deliberate one; the
owner's spot review of `pm-decisions.md` is the check on that. Detail: "What
decides the limits";
[mode-switch.md](../docs/design/router-worker/mode-switch.md), "Changing the
limits later".

### 2026-11-24: a worker moves and deletes the files its ticket declares

Status: Proposed.

A ticket may declare `moves` and `deletes` of tracked files inside its
`paths`. `before` checks each path and derives one exact Git command per move
or deletion. The exec worker's shell accepts the commands of all the batch's
tickets, for that batch only; no other worker's shell accepts them. This
widens the amendment of 2026-11-18 by those commands only. The owner does not
confirm them one by one: the PM declares them in the ticket, and the owner
reads them in the batch record (`moves`, `deletes`) and in the briefs. A brief
of a standing batch does not open with the offline-preview line. Detail:
"Moves and deletions".

### 2026-11-25: a ticket resumes the work an earlier batch left

Status: Proposed.

A ticket may name a `resume` patch in the team's folder that holds work an
earlier batch left. `before` applies it to the work tree, and from then on it
is the ticket's own work: checked, reviewed and committed with it. The PM,
trusted with the team's folder, writes the patch; the owner reads its bytes,
digest and paths in the batch record. It grants no write beyond the ticket's
`paths` and no command. Detail: "Resuming left work".

### 2026-11-25: what of the Guardian's verdict holds a batch

Status: Proposed.

A batch's commits are all held for the Guardian (`GUARDIAN_NOT_CLEAN`) when
it did not answer, asked to halt and investigate, or reports a problem in the
run itself: a runaway, a budget gate that did not behave, or a failed check at
risk of being dropped. Any other verdict of its that is not `clean`, a missed
halt risk included, is recorded as `GUARDIAN_ATTENTION` and holds nothing,
since a headless batch never has an observer. The tickets are still committed
only when their own check passed and their review, if any, passed. Detail:
"After".

### 2026-11-25: a ticket names the verification commands its workers run

Status: Proposed.

A ticket may name `verificationCommands`, one or more of the batch's; its
briefs list only those. The hook and the review's re-verification keep the
batch's whole list. What `after` runs is set by the amendment of 2026-11-26,
"after verifies the tree it would commit". Detail: "What the PM writes".

### 2026-11-26: the Guardian of a batch can call it clean

Status: Accepted.

The engine tells the Guardian of a batch that no observer watches the run by
design, that the PM attests an owner stop or a hardware halt after it, and
that the ceiling comes from the owner's limits. Neither is then a finding.
What `clean` requires does not change, and specialist mode does not change.
The engine's blockers name the Guardian exactly when the batch's commits are
held for it; a batch frozen before this amendment keeps the blockers it was
closed with. Detail: [engine.md](../docs/engine.md), `standingBatch`;
[run-args.md](../docs/design/router-worker/run-args.md), "Call accounting".

### 2026-11-26: after counts the checker's runs and holds a batch the hook did not see

Status: Accepted.

`after` holds every commit when files changed and the hook logged no call of
the batch's three workers (`HOOK_SAW_NO_WORKER`), or when the checker's approved runs of a
verification command are fewer than the passed tickets that verify with it
(`CHECK_RUNS_MISSING`). The count does not tell tickets apart, and whether a
run passed stays the checker's word. Detail: "After"; "What these commands
trust".

### 2026-11-26: the budget gate of a batch is judged from the engine's trace

Status: Accepted.

For a standing batch the engine's return lists its gate decisions
(`budgetStatus.gateTrace`). `after` holds the batch (`GUARDIAN_NOT_CLEAN`,
`budgetGate: inconsistent`) when the trace is missing or malformed, or shows a
call dispatched at or above 80% of the ceiling, one declined below it, or
dispatched calls that differ from the exec and checker calls the return
reports. This refines the hold of 2026-11-25 for a budget gate that did not
behave. Comparing `tripped` with the final spend
could not see a late dispatch, since both come from one expression. The check
trusts the engine's return. A batch frozen without `standingBatch` keeps the
earlier rule. One frozen with it and closed before this amendment has no
trace, so it is held and its account no longer matches at settlement.
Specialist mode does not change. Detail: "After"; engine.md.

### 2026-11-26: the kit saves left work and counts its runs

Status: Accepted. Superseded in part by the amendment of 2026-11-27 below: the count now refuses, and runs are no longer matched by overlapping paths.

`rw-batch.mjs left` saves the work each ticket of an archived batch left in
the work tree as one patch per ticket, then takes it out. It removes nothing
before the patch is saved and never writes over a saved patch. The count of
earlier runs is now the amendment of 2026-11-27, "a ticket that ran before is
replanned". Detail: "Resuming left work".

### 2026-11-26: after verifies the tree it would commit

Status: Accepted.

`after` sets aside, as patches, the work of each ticket that did not pass.
When the tree then holds only the passed tickets' paths, it runs their
verification commands on it, so what is committed is what a check saw. A
command that fails twice holds every commit (`VERIFICATION_FAILED`). A tree
that holds anything else is not verified (`VERIFICATION_NOT_RUN`, which holds
nothing), and `next` says so. This narrows the amendment of 2026-11-25 on
per-ticket commands for `after` alone. The run does not verify the
intermediate commits or each ticket alone. A write grant and a snapshot per
ticket are not adopted, since the hook has no ticket identity. Detail:
"After".

### 2026-11-26: a dead command's lock, one spelling of a path, and the order of two writes

Status: Accepted.

The next command of the team takes over a command's lock whose process is
gone; no other lock is taken over. Whether a path lies inside a ticket's grant
is judged with case, as `after` and the hook judge it; whether two tickets
claim one file is judged without case. `abort` refuses while a command of the
team that holds the lock, or the `after` that claimed the batch, still runs.
`before` appends its ledger lines before it writes the batch record. The next confirmed change of limits
finishes or removes a change that died before its rename. Detail: "The lock
of a command"; "Abort"; "What "before" does, in order"; mode-switch.md,
"Changing the limits later".

### 2026-11-27: a ticket that ran before is replanned, and runs at most three times

Status: Accepted.

The owner decided in session on 2026-11-27 that after a failed run the router
re-examines whether the task can be done and why it failed before it
dispatches again, and reports to the user; and that a ticket gets at most two
retries, as in the specialist team.

`before` refuses a ticket that ran before and was not committed until it
carries a new `replan`, which the ledger line gives the owner as the report.
Earlier runs are linked by id, `continues` and resumed patch, never by shared
files. "Two retries" is read as ADR 0008 reads it: the initial run plus two.
Every run without a commit counts. A ticket with three is refused
(`TICKET_ATTEMPTS_EXHAUSTED`) and escalated until the owner acknowledges it.
The cap is a constant of the kit, not a team limit; `attemptsPerTicket` is
unchanged. This supersedes the amendment of 2026-11-26, "the kit saves left
work and counts its runs", where it says the count refuses nothing and where
it matches runs by overlapping paths. Detail: "What "before" does, in order",
the paragraphs "Earlier runs of a ticket" and "At most two retries".

### 2026-11-27: packages of one repository

Status: Accepted.

At the owner's request, a team may list the packages of its one repository in
`profiles/packages.json`; without the file nothing changes. A ticket that
names its `package` is scoped to the package's folder, verifies with its
commands unless it has its own, and gets its conventions inlined in its exec
and check briefs. `after` logs a change to another package's interface files
for the PM to file follow-up tickets; it holds nothing. The kit does not stop
a worker from reading another package's files. Detail: "Packages of one
repository".

### 2026-11-27: three findings of the review of main

Status: Accepted (they correct the kit against rules this record already
holds; no owner decision changes).

- Earlier runs follow the links the archives froze for the ticket's own id
  too, since the kit last committed it.
- `after` pins what Git would record for each path, and `commit` and
  `resolve` refuse a commit that differs. A path Git refuses to stage holds
  every commit (`ENTRIES_NOT_READ`), and the close is still written.
- `after` reads the lock before it changes anything. It takes the lock again
  when it is free or was left by a command of the team that ended, and records
  `LOCK_TAKEN_AGAIN` unless it resumes a close that died; held by anyone else,
  it refuses and changes nothing.

Detail: "What "before" does, in order"; "After"; "Commit".

### 2026-11-27: what a batch reports about itself

Status: Accepted (reports and opt-in switches; no rule of this record changes).

The owner declined to shorten the output a reviewer is given for a command
that passed: a tool can exit 0 and still warn, and no check or reviewer input
is weakened to save tokens. The kit adds `before --receipt`, the
`verification` statement of `commit.json` with `commit --verified-only`, the
record of check runs as counted by batch (they prove no single ticket's
check), and the PM's attestation status in `settle` and `rw-batch.mjs
monitoring`. Without `--verified-only` the rule of
2026-11-26 stands. `tests/router-worker-dispatch-size.test.mjs` holds the
bytes of one dispatch under ceilings. Detail: "What "before" does, in order";
"The workers' shell"; "Commit"; "Settle".
