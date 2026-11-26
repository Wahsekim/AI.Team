# ADR 0011: Security and architecture review of a Router/Worker batch

Date: 2026-11-17
Status: Accepted (owner decisions given in session on 2026-11-17; ratified by the owner merging the pull request that adds this record)

## Context

[ADR 0010](0010-router-worker-second-mode.md) makes Router/Worker the kit's
second mode. In that mode three workers execute, check and guard every ticket:

| Agent | What it looks at |
|---|---|
| Checker | The ticket's acceptance criteria and verification commands |
| Guardian | The run: runaway, budget, process |
| Write-limit hook, after-run check | Files written outside the ticket's paths |

None of them looks for a security flaw or a broken architecture rule inside a
file the worker was allowed to edit. The roles that can, Security and Architect,
exist in both modes, but today the PM decides whether to dispatch them, and
nothing checks what a reviewer actually read. The owner's two objections, which
this record answers:

- Whether a review happens depends on one agent's judgment.
- A reviewer that reports no finding has not shown there is no problem.

One placeholder in the kit follows from the same gap: a ticket that carries a
risk flag or plans to edit a sensitive path is refused at the start of a batch
("a security-specific check is required but is not implemented").

## Decision

"Batch" below is one "run N rounds": N tickets.

### Scope

1. **Reviewers are Security and Architect.** The mechanism must allow another
   reviewer to be added later by adding a role and its triggers. No role is
   created now.
2. **Router/Worker mode only.** Specialist mode keeps its rules. Whether to
   port this is decided separately, after the real run of ADR 0010.

### When a review runs

3. **The kit decides, not the PM.** At the end of a batch the "after" command
   compares the batch's changes with a written trigger list and flags, per
   ticket, which reviewer is required. The PM cannot commit a flagged ticket
   without a recorded review. The PM may dispatch a reviewer on its own
   initiative in addition; it can never skip one the kit requires.
4. **Once per batch, before the commits.** At most one Security call and one
   Architect call cover all the flagged tickets of the batch. A batch with no
   flagged ticket dispatches no reviewer.
5. **Tools first.** Where a tool can decide (a secret scanner, a dependency
   scanner, an architecture rule written as a test), it runs as a verification
   command on every ticket. The reviewers cover what tools cannot judge.
6. **A ticket that declares itself sensitive is allowed into a batch.** A risk
   flag or a planned sensitive path no longer refuses the ticket. Such a ticket
   is always flagged for Security, whatever its changes look like, and is never
   committed without a passed review. The refusal is lifted when the review
   exists, not before.
7. **A periodic review** runs every 25 committed tickets (the kit's existing
   hardening interval, adjustable in the charter). It reads what was committed
   since the last one and was not covered by a triggered review: Security once,
   Architect once, under the same evidence rules. The kit enforces it: the
   "before" command refuses the next batch until the review is recorded. It
   blocks no commit; its findings become tickets.

### The trigger list

8. **Two parts.** General triggers shipped by the kit (a dependency manifest; a
   path containing auth, session, token, crypto or secret; a database migration;
   a CI or deployment file; lint and test configuration) and the project's own
   paths and boundaries.
9. **In the team's folder**, not in the product repository. Security and
   Architect propose the project part at bootstrap; the owner confirms it.
10. **Frozen into each batch** when the batch starts. A change between batches
    is written to the PM's ledger and shown at the start of the next batch.
    Adding a trigger needs no approval. Removing one is logged as a removal and
    flagged for the owner's spot review.

### What a reviewer is given and returns

11. **Given:** the ticket (goal, acceptance), the changes and the full flagged
    files, its checklist (the kit's general rules, the project's rules and
    ADRs), and the output of the verification commands. **Not given:** the
    worker's report, the checker's verdict, or another reviewer's opinion. On a
    re-review it gets its own earlier finding.
12. **No write to the product.** During a batch review both reviewers are under
    the write limit, with nothing writable in the product repository. The
    Architect may still write an ADR draft in the team's folder.
13. **The report shows the work.** Per flagged file: read or not. Per rule of
    the checklist: pass, fail or not checked, with the file and line. The
    existing Security verdict shape (green, amber, red per item) is kept. The
    kit derives the verdict:

    | Rule | Effect |
    |---|---|
    | Any "fail" | The ticket is rejected |
    | A flagged file not listed as read | The report is refused |
    | Every rule "not checked" | The report is refused |
    | Single "not checked" items | Allowed, recorded in the ledger |
    | The reviewer's session transcript does not show a flagged file was opened | The report is refused |

### After the verdict

14. **A rejected ticket is not committed.** Its changes are saved as a patch
    file in the team's folder and removed from the working tree. There is no
    automatic rework: the PM puts the ticket back in the backlog with the
    finding attached.
15. **The tickets after it in the batch** are committed only if the
    verification commands still pass once the rejected ticket's changes are
    removed. Otherwise they are all held and saved as patches.
16. **A ticket rejected a second time goes to the owner**, with both findings
    and both attempts. It is not re-queued a third time.
17. **A review that cannot be obtained** (a refused report, no answer) is not a
    rejection. The reviewer is dispatched once more with the reason. If that
    fails too, the flagged tickets are held as patches and logged as "review
    not obtained"; the unflagged tickets are committed. If the same happens
    again in a later batch, it goes to the owner. Flagged tickets are never
    committed with a warning.

### Preventing the same class of problem

18. **A hard control is preferred to a text rule.** When a finding belongs to a
    class that can recur and a tool can detect it, the fix for the class is a
    lint rule, a test or a scanner rule, not a sentence in a role file.
19. **The reviewer finds and proposes.** Its report carries the finding, the
    recommended fix and the proposed control: what the tool must detect, and
    one variation of the same problem. The PM creates the tickets ("fix",
    "add control"); a worker builds the control like any other change.
20. **Three kinds of evidence** before a control may block: it fires on the
    original violation; it fires on the variation; it is silent on the existing
    codebase (each hit is a real violation to fix or proof the control is too
    wide). The checker verifies them as acceptance criteria of the ticket. This
    is a written rule; the kit does not enforce it mechanically yet.
21. **The control is reviewed like code**, because lint and test configuration
    are on the trigger list. The Auditor measures it periodically: how often it
    fired, whether the hits were real, whether the class returned.
22. **The Coach leaves the critical path.** It receives the findings afterwards
    for the lessons index, and writes the text rule and the checklist item when
    the reviewer states that no tool can detect the class.

### Cost

23. **300,000 authorized per reviewer call**, in the unit of a ticket's
    authorization (owner, 2026-11-17). It is set with the other limits at the
    switch and changed with the `limits` command. It is checked at settlement
    from the measured usage, not during the call; the reviewer's turn limit is
    the brake during the call. An overrun is recorded and does not hold the
    tickets. Each batch result states the review cost apart from the ticket
    cost.

## What this changes in ADR 0010

| ADR 0010 | Change |
|---|---|
| Decision 12, after-run checks | Gain the review step: flagging, the reviewers' reports, the hold and patch rule |
| Decision 13, the PM commits at reconciliation | A flagged ticket is committed only after a passed review |
| Decision 7, limits confirmed at the switch | One more limit: the authorization per reviewer call |
| Order of work, step 6 | Split: 6a, the "after" command and reconciliation; 6b, the review |
| Proof 1 | Must include a flagged ticket that passes, one that is rejected, and one whose review cannot be obtained |
| Proof 2 | The real batch must include at least one ticket a trigger flags |

## Consequences

- A review shows which checks were run on which files. It does not prove the
  code is free of problems, and a reviewer can read a flawed file and pass it.
- Detection before the commit is only as good as the trigger list. The periodic
  review is the backstop, and it finds a problem after it was committed.
- An unattended PM session can shorten the trigger list between batches. The
  change is logged and shown; nothing blocks it.
- An unattended run of several batches pauses once every 25 tickets for the
  periodic review. The PM can run it without the owner.
- A reviewer that cannot produce a valid report stalls every flagged ticket
  until the owner looks at it.
- Between a worker's edit of sensitive code and the review, that code exists
  uncommitted on the working branch. Later tickets of the batch may build on
  it; decision 15 covers that case.
- A reviewer sees one batch. A class that appeared several batches ago in
  another module may get a control that is too narrow; the Auditor's periodic
  pass is where that is caught.
- The write-limit file gains a third state (review in progress) beside "batch
  open" and "no batch open".

## Not decided here

- Porting any of this to specialist mode.
- Reviewers other than Security and Architect.
- Enforcing the three kinds of evidence in the kit. If wanted, it comes after
  the real run.

## Amendment of 2026-11-25: generated files of a declared-sensitive ticket

Status: Proposed.

On 2026-11-25 a ticket declared sensitive changed 47 files, among them
generated code and translation tables, and Security had to read every one: its
review cost more than the ticket's work and check together. The project part
of the trigger list may now name `generated` patterns. Decision 6 then flags a
declared-sensitive ticket on its other changed paths, or on all of them when
it changed generated files only; triggers are unchanged. Adding a pattern is
logged for the owner's spot review, as a removed trigger is.

Merging the pull request that adds this amendment ratifies it.

## Amendment of 2026-11-26: abort holds flagged tickets, and before names hand commits

Status: Accepted. The owner decided in session on 2026-11-26, accepting the
recommendation of that day's review of the kit.

Decision 3 bound the commits the kit makes. It left open the way out of a batch
the kit will not commit: a finding that holds every commit drops the batch's
reviews, and `abort` of a closed batch, also one in review, sent everything it
left in the work tree to a commit by hand, flagged tickets included. Two rules
close that gap.

`abort` of a batch that `after` closed holds each ticket `after` flagged for a
reviewer that has no passed verdict from each of its reviewers (rejected,
review not obtained, or never reviewed), as `resolve` holds a rejected one: its
changes are saved as a patch under `reviews/held/<run id>/` and taken out of
the work tree, and a later batch takes the patch back as a ticket's `resume`,
where it is checked and reviewed again. A ticket `abort` cannot take out is
left in place and named in the ledger as not passed by a review; `abort` still
archives the batch.

`before` names, in the ledger and for the owner's spot review, every commit made
on the branch since the end of the newest batch archived on it, and freezes
their ids in the batch record. It refuses nothing on that account, and the
periodic review of decision 7 still counts only the commits the kit made.

## Amendment of 2026-11-26: what counts as the reviewer's evidence

Status: Accepted. The owner decided in session on 2026-11-26, accepting the
recommendation of that day's review of the kit.

Three rules make decisions 3, 4 and 13 hold in practice.

A flagged file is read as its kind allows, and the brief and the judging
decide that kind in one place. Text is read when the reviewer's successful
Reads of it, taken together, cover every line of it: a file longer than one
Read returns is read in the ranges the brief gives, each with a limit sized
to about 40 KB of the file, and one Read of its first part no longer counts
for the whole. A text file over 256 KB, such as a large lock file, is more
than the Read tool takes whole: it is not read, and the reviewer judges it
from its diff as the brief shows it, reporting a rule the diff does not let it
judge as not checked for that file (decision 13 allows a single not-checked
rule and records it). This gives up the reading of such a file's unchanged
part, which ranged Reads would cost some 300,000 tokens for a megabyte. An
image, a PDF or a notebook is read by one Read when its leading bytes are that
format's. A binary file, a symbolic link and a file named as media whose bytes
are another format (a Git LFS pointer) are not read; the brief names them, a
link with its target.

Every dispatch with the reviewer's latest brief is judged, so the PM cannot
choose which report counts, and a healthy review is not refused for it. No new
brief is made while the latest one has no verdict, unless a verification
command of it failed, a file it pinned changed, or the earlier kit made it.
Of two dispatches with the latest brief, the earlier is judged first, which
uses the attempt; a file given that does not carry the latest brief is not
judged while a transcript carries it. "No answer" is refused while a
transcript carries the latest brief: a reviewer that stopped without a report
is judged from its transcript. Dispatches with an earlier brief are not waited
for. A reviewer is dispatched again as a new agent, never resumed: a resumed
reviewer's transcript begins with its first brief and cannot carry the next.

A brief whose diff is over its cap still shows, per changed path in ticket
order, the whole diff or else the removed lines while the section fits, every
label and sentence counted, and otherwise names the path with its counts of
added and removed lines; the paths left once not even that fits are named
while the cap allows and the rest counted. A path whose added lines are not shown is to be
opened with the Read tool, and a rule resting on removed lines not shown is
reported as not checked rather than guessed.

Left open: a Read is credited from its input, so a range the tool cut still
counts; a transcript deleted, or in a session under another configuration
folder, is not seen; a periodic review aborted and briefed again leaves its
earlier dispatch unjudged.

## Amendment of 2026-11-26: a rejection counts by its paths too

Status: Accepted. The owner decided in session on 2026-11-26, accepting the
recommendation of that day's review of the kit.

Decision 16 sends a ticket rejected a second time to the owner, and the kit
counted rejections by ticket id only. A rejected ticket filed again under a new
id, on the same paths and with its held patch as `resume`, started its count
again each time. Each adverse outcome the kit records now carries the paths
the ticket changed. A ticket's adverse outcomes are those under its id and
those under any id whose recorded paths overlap the paths it changed, compared
as two tickets claiming one file are; an outcome recorded before outcomes
carried paths counts by its id only. A second time is still a second batch,
and how verdicts are judged does not change. Escalations already written keep
blocking, and are lifted, as before.

The comparison is by path alone. Two unrelated tickets rejected in two
batches on one shared file count as the same work, so the second one is
escalated, and that open escalation blocks every ticket whose paths overlap
that file until the owner acknowledges it.
