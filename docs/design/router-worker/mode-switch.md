# Switching a team between specialist and Router/Worker mode

Status: built and tested offline on a bootstrapped two-root fixture. Not yet
used on a real team. It changes which team is live; it does not run a batch.
[ADR 0010](../../../decisions/0010-router-worker-second-mode.md), decisions 4 to 7.

```sh
# from the instance root
node kit/scripts/team-mode.mjs switch rw REQUEST.json   # first time: REQUEST.json carries the spec
node kit/scripts/team-mode.mjs switch rw                # later: the packed team comes back
node kit/scripts/team-mode.mjs switch specialist
node kit/scripts/team-mode.mjs switch recover
node kit/scripts/team-mode.mjs request --instance . [--model <id>] [--ui] > REQUEST.json
node kit/scripts/team-mode.mjs limits LIMITS.json --instance .
```

`rw` is short for `router-worker`. Without `REQUEST.json` the request is `{}`;
without `--instance` the instance is the current folder; without
`--product-root` the product is the `product_repo_path` of the instance's
`profiles/project.md` (a switch is refused when that is unanswered and no flag
is given). The long form, with `--instance <root>` and `--product-root
<product>`, still works.

`REQUEST.json` is `{"spec"?, "limits"?, "gatePath"?}`: the Router/Worker team spec that
`team-mode.mjs preview` takes (project, the three worker profiles, governance
staffing, workflow states) and any limit the owner wants to change. `{}` is
enough for a switch to specialist, and for a switch back to Router/Worker when
the spec confirmed the first time is still with the packed team. `limits` is
accepted on the first switch into Router/Worker mode only (see below).

Exit 0 switched, 2 refused or proposal only, 1 usage.

## Propose, then confirm at a terminal

The command prints a proposal:

| Field | Content |
|---|---|
| `from`, `to` | the two modes |
| `staffing` | model, effort, turn limit and tools of the three workers and of each staffed governance role; for a packed Router/Worker team, the staffing it was packed with |
| `project`, `workflowsNotEnabled` | on a first switch: the project's name, slug, product repository and UI flag, and every workflow the request does not enable, with its status |
| `limits` | attempts per ticket, output allowance per ticket, the Guardian's share, authorization per ticket, authorization per reviewer call (`authorizationPerReviewerCall`, ADR 0011 decision 23); the ADRs' defaults unless the request changes one; `allowedCommands`, the commands a worker's shell may run in a batch, which `request` proposes from the required gates of `profiles/stack.md`, plus its `codegen_command` when it names one outside them (empty when it gives none; a gate it cannot confirm as written, or beyond the 50 a team may hold, is left out and named in a note); for a packed Router/Worker team, the limits it was packed with |
| `dispatch` | `engine` |
| `gatePath` | `false`: the gate path (main-session dispatch through the gate hook, [ADR 0010](../../../decisions/0010-router-worker-second-mode.md) decisions 14 and 15) is off; see "The gate path" |
| `pack` | the files that go on holiday |
| `install` | the files that are put in place |
| `kept` | files of the new team that are already there and stay as they are (shared governance role files) |
| `digest` | the digest of the proposal |

Run at an interactive terminal, the command then asks for a code (the last
eight characters of the digest) and switches when that code is typed. Anything
else cancels. Run anywhere else (a pipe, a script, a PM session, which runs
commands without a terminal), it prints the proposal, changes nothing and exits
2. There is no flag that confirms (owner decision, 2026-11-17): the switch is
the one moment the owner approves by hand, and an unattended session must not
be able to approve itself. This is a barrier against that case, not a proof of
identity. `switchMode` into Router/Worker mode also refuses a direct call whose
process has no terminal (`process.stdin.isTTY`), except under `node --test`
(`NODE_TEST_CONTEXT`). A program that builds a pseudo-terminal (`script`), sets
`process.stdin.isTTY` itself, or sets `NODE_TEST_CONTEXT` gets past it, and nothing detects that: the same trust
as a forged record. The ledger line says whether the code was typed at a
terminal; only such a line binds limits.

The proposal is computed again when the code is typed; if the team, the kit or
the request changed since, the switch is refused (`SWITCH_NOT_CONFIRMED`). The
digest covers the lists of files and,
for a packed team, the digest of its manifest. It does not cover the content of
files outside those lists.

## What moves

A mode's own files:

| Mode | Its own files |
|---|---|
| specialist | `agents/roster.md`; everything under `.claude/agents/`, subfolders included; for each row of the roster's role table whose role is not the PM or a governance role, the file its "Role file" column names; `profiles/team-mode.json` if there is one |
| Router/Worker | `agents/roster.md`; the three worker role files; the Router/Worker contract and router supplement; everything under `.claude/agents/`, including a wrapper added while the mode was live; `profiles/team-mode.json` |

They are moved to `holiday/<mode>/`, with a `manifest.json` listing each path
and its digest. Nothing else moves: charter, decisions, ledgers, lessons,
memory, profiles, the PM and governance role files stay where they are. A
governance role file is shared: one the switch had to create stays live in both
modes, and one the instance already had is kept as the instance wrote it
(`kept` in the proposal).

The roster is read by its table header ("Role id" or "Role", and "Role file"),
with or without backticks, emphasis or a link around a cell. A role that is not
the PM or a governance role and whose "Role file" cell does not name a file
under `agents/` stops the switch, and so does a roster with no such table:
otherwise that role's file would stay live in the other mode. A profile, a
manifest or a journal that names a file outside these sets, such as the charter
or a ledger, is refused, not obeyed.

A folder under `holiday/` is outside `.claude/agents/`, so the runtime cannot
dispatch a packed wrapper. The deployment validator does not scan `holiday/`
for single-source drift: a packed wrapper keeps its `model:` line, a packed role
file its tables.

## The request, drafted by the kit

`request` prints a `REQUEST.json` drafted from `profiles/project.md`: the
project's name, slug and product repository, one status per workflow from its
"Workflow Status" section, and the ADR's defaults.

| Role | Model | Effort | Turns | Tools |
|---|---|---|---|---|
| exec | `opus` (or `--model`) | high | 120 | read, search, bash, write, edit |
| check | same | medium | 80 | read, search, bash |
| guard | same | high | 40 | read, search |
| architect, coach | same | medium | 40 | read, search, write, edit |
| auditor, security | same | medium | 40 | read, search |

Limits: 1 attempt, 15,000 output tokens per ticket, 6,000 for the Guardian,
200,000 authorized per ticket, 300,000 authorized per reviewer call. The governance rows are the kit's proposal; the
ADR sets only the three workers. The owner sees all of it in the switch's
proposal and may edit the file first. A profile that leaves the name, the slug,
the product repository or a workflow's status unanswered refuses the request and
names what is missing. Only the profile's two YAML blocks (`project:` and
`workflow_status:`) are read, each value double-quoted on one line; a status is
`enabled`, `deferred`, `profile-bound` or `disabled`, alone or followed by
` — reason`, `: reason` or ` (reason)`. A disabled workflow needs the digest of the owner's
decision in its `decisionRef`, added by hand; the command prints a note.

## Changing the limits later

`limits LIMITS.json` (`{"outputAllowancePerTicket": 20000}`, any of the counts,
or `{"allowedCommands": [...]}`, the whole list)
prints the limits before and after, and is confirmed like a switch: a code typed
at an interactive terminal. `changeLimits` called directly refuses the same way. It is refused when the team is not in Router/Worker
mode, when nothing would change, when the authorization per ticket would fall
below the output allowance, when a switch was interrupted, or while a batch
holds the lock; it takes the lock for the write. A change that died after its ledger line and before the
profile's rename leaves `profiles/team-mode.json.tmp`: the next change of limits, once its code is typed at the
terminal, finishes the rename when the last ledger line binds the limits it holds (the owner confirmed them), and
otherwise removes it and applies nothing of it. The proposal names it (`leftover`) and changes nothing; `{}` is
accepted while one is left, to settle it alone. The hook refuses a file-tool write of it as of the limits file. One line is appended to `pm-decisions.md`; it ends with
`limits <digest>`, as the `MODE SWITCH` line into Router/Worker mode does, and the last such line binds the limits
in force: `rw-batch.mjs before` refuses limits it does not bind. Limits no line binds (edited by hand, or a team
that went live before lines carried a digest) are re-confirmed as they stand with `{}`; a request that changes
nothing is refused once they are bound. A team that went live before
`authorizationPerReviewerCall` existed is refused by `rw-batch.mjs before`
until the owner adds it: `{}` proposes it at its default, shown as a change
(`unset -> 300000`), and confirming binds it with the others. The hook refuses any session's file-tool write of
`profiles/team-mode.json`, so the owner's command is the way to change them
([ADR 0010](../../../decisions/0010-router-worker-second-mode.md), amendment of 2026-11-20). The changed limits go
on holiday and come back with the team.

## Into Router/Worker mode

The first time, from a spec:

1. The team is drafted from the spec and a full copy is staged and validated in
   a scratch directory. A draft that does not validate, or an enabled workflow
   duty with no role, refuses the switch before the team is touched.
2. The specialist files are packed.
3. The drafted files are written and made live, and `profiles/team-mode.json`
   records: `mode: router-worker`, `status: live`, `dispatch: engine`, `gatePath: false`, the
   limits, the staffing, the spec, the confirmed proposal and the list of files
   that belong to the mode.
4. The deployment validator runs on the team. If it fails, everything is put
   back and the switch is refused.
5. One line is appended to `pm-decisions.md`.

Every later time, the packed Router/Worker team comes back as it was packed,
edits included: a model changed in the roster, a wrapper that was added. It is
not drafted again. The deployment validator still runs where the team stands,
because the kit may have changed while the team was packed; a kit upgrade is
then handled as for any live team. A request that brings another spec while a
packed team exists is refused: move `holiday/router-worker` away first to draft
a new team. The same holds for `limits`: a packed team comes back with the
limits it was packed with, the proposal shows them, and a request that brings
`limits` is refused. The limits of a live team are changed with the `limits`
command (above).

## Back to specialist mode

The packed specialist team is checked against its manifest first: a file that is
missing or was edited under `holiday/specialist/` refuses the switch. The
Router/Worker files are packed and the specialist files are moved back. They
come back byte for byte, so the deployment validator is not run again.

After a team is unpacked its holiday folder is removed. Anything else found in
that folder is left where it is and reported (`leftInHoliday`).

## The write-limit hook

ADR 0010, decision 12. A switch into Router/Worker mode registers the
write-boundary hook in the team's `.claude/settings.json` and writes
`.claude/rw-write-boundary.json` in its "no batch open" form: the three workers
are named and may write nothing. Any other agent of the team, a governance role
for example, is not judged. A batch's "before" command ([batch.md](batch.md)) replaces
that file with the batch's own write paths.

The three workers are named as the live roster names them. A roster that does
not name a wrapper file for one of them stops the switch.

A switch back to specialist mode unregisters the hook and removes the boundary
file. The team's other settings and hooks are kept in both directions, a hook
that shares an entry with ours included; the file is written again, so key order
and indentation may change, and a file that held nothing but our hook is removed.
The two files are copied to `holiday/.switch-backup-<id>/` before they are
changed, so a switch that fails or dies puts them back byte for byte.

The switch is refused before anything moves when `.claude/settings.json` is a
symbolic link, is not a JSON object with hooks in the documented shape, or when
it or `settings.local.json` disables all hooks (a team may always leave
Router/Worker mode, whatever its hooks).

A worker's wrapper file and the name in its frontmatter must be the same; the
runtime knows the agent by that name.

The runtime reads hooks and agents when a session starts: **start a new PM
session after a switch.**

- A session opened before a switch into Router/Worker mode has no hook: its
  workers are not bounded.
- A session opened before a switch back still runs the hook. With no boundary
  file it refuses every subagent's write and shell command until a new session
  is started. The hook
  stays fail-closed on purpose: any exception to that rule can be reached by
  hiding a file.
- A hook that cannot load (a kit checkout without `src/`, an instance that was
  moved) exits with an error the runtime does not treat as a refusal: the
  writes go ahead. The after-run check of a batch counts the hook's log lines
  and reports a batch the hook never saw.

## The product repository

The team is bound to the product repository its Router/Worker spec names; the
`--product-root` given must be that one, in both directions. On the first
switch it must also be the repository bootstrap recorded in
`profiles/project.md` (`product_repo_path`), when that was answered. The switch is
refused when that repository has uncommitted or untracked changes (the first ten
paths are listed), a Git operation in progress, or a lock held by a batch. The
switch takes that lock itself for its own length, so no batch can start half-way.

## A switch that fails or dies

Before it takes the lock and before the first file moves, the switch writes a
journal (`holiday/.switch-in-progress.json`) naming every file it will pack and
every file it will put in place. The journal is removed last, after the lock is
released and the ledger line is written. If a step fails, the journal is used to
put everything back, and the lock is released. If the process dies, the journal
stays: every further proposal or switch is refused (`SWITCH_INTERRUPTED`) until

```sh
node kit/scripts/team-mode.mjs switch recover
```

rolls the interrupted switch back and appends one line to `pm-decisions.md`.
Only files the journal names are touched, only when each may belong to one of
the two modes, and a file is moved back only where its place is empty.

- A switch that died after its last file moved is rolled back too: the journal
  is the only sign that it did not finish.
- A switch that died before it recorded its lock is recognised by the lock's
  team root and by its time, which is not earlier than the journal's. The batch
  "before" command therefore refuses to start while a journal exists.
- A death inside the lock's own release leaves the guard file
  `<product>/.git/rw-ownership-lease.json.release-lock`. Recover names it and
  stops; the operator removes that file and runs recover again.

A test simulates a death at every write of both restores, and at a sample of
the writes of a first switch, and checks after recover that the tree is as it
was, the lock is free and the same switch can be proposed again.

## The gate path

`gatePath` is a setting of the team, stored in `profiles/team-mode.json` with
the mode ([ADR 0010](../../../decisions/0010-router-worker-second-mode.md),
decisions 14 and 15). Only the switch writes it, always `false`, and it goes on
holiday and comes back with the mode. A request may carry `"gatePath": false`;
any other value is refused, because the gate path is not completed and turning
it on in a standing team is refused. No other command changes it: `limits`
knows only the limits, and `BATCH.json` refuses a field it does not know. A
profile without the key (a team switched before the setting existed) is read as
off. `rw-batch.mjs before` refuses a profile whose `gatePath` is anything but
`false` (a hand edit). The setting is not bound by a ledger line: the hook
refuses a file-tool edit of the profile, and `before` refuses an edit made
another way.

The gate path's own tooling (`launch-router-worker.mjs prepare` with
`"dispatch": "main-session"`, the gate hook) works only in an activated
throwaway copy: arming the hook refuses any team root whose profile is not
`activated-disposable-smoke`, and the hook refuses every call without that
copy's launch record. A standing team cannot reach it.

## Refusals (`SWITCH_REFUSED`)

- The team is already in that mode, or the mode is unknown.
- The deployment is not in the two-root layout. The message points to
  `scripts/migrate-to-instance.sh`.
- The product repository is not the one the team is bound to, or is not at rest
  (above).
- Into Router/Worker mode: the product repository's path holds a character that
  cannot be written inside a quoted shell command (`` " $ ` \ ! `` or a control
  character).
- `holiday/<mode>/` for the mode being left already holds a packed team (a
  manifest, or a file at a path that would be packed): a packed team is never
  overwritten, and the folder is not touched. A stray file such as `.DS_Store`
  does not count.
- The roster does not name a role file for a delivery role (above).
- `limits` are given for a team that is already packed.
- The request's `gatePath` is anything but `false`, or a packed team's profile
  turns the gate path on (see "The gate path").
- A file is in the way of the team being put in place.
- A mode profile or manifest names a file that cannot belong to that mode.

## Not covered

- **A packed specialist team is not upgraded.** After a kit upgrade,
  `pin-kit.sh` lists the seeds to port for the files it finds in the instance;
  files under `holiday/specialist/` are not among them.
- **Turning the gate path on** (`gatePath: true`): refused until the gate path
  is completed (ADR 0010, decision 15).
- **Bootstrap asks for the mode in its documents** (`docs/bootstrap-*.md`,
  `docs/staffing.md`); `bootstrap-team.sh` itself has no mode option. A team is
  bootstrapped as today and then switched.
- **The terminal check is not a proof of identity** (above). It needs a POSIX
  terminal (`/dev/tty`).
