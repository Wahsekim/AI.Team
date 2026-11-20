# ADR 0010: Router/Worker as the kit's second mode

Date: 2026-11-16
Status: Accepted (owner decisions given in session on 2026-11-16; ratified by the owner merging the pull request that adds this record)

## Context

[ADR 0008](0008-router-worker-topology.md) accepted the Router/Worker topology
on paper: three workers (execute, check, guard) instead of one role per
speciality, with live activation left gated. Between 2026-11-13 and 2026-11-16
five disposable smoke runs on the UHF test project exercised it with real
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
   kit; UHF is only its test ground.
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
2. One run on the real UHF team and the real UHF repository, on a working
   branch, with small real tickets, on the owner's go-ahead at that time.

## Order of work

1. This record. 2. Delete the `retry` path. 3. The switch and `holiday/`.
4. Bootstrap asks for the mode and the confirmation of staffing and limits.
5. The "before" command for a standing team. 6. The "after" command, its place
in reconciliation, and the allow-list. 7. The gate flag: present, off, refused
in a standing team. 8. Proof 1. 9. Proof 2. 10. Remove the throwaway-copy
tooling.

Nothing touches the real UHF team or repository before step 9.

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

