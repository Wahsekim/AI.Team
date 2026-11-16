# Switching a team between specialist and Router/Worker mode

Status: built and tested offline on a bootstrapped two-root fixture. Not yet
used on a real team. It changes which team is live; it does not run a batch.
[ADR 0010](../../../decisions/0010-router-worker-second-mode.md), decisions 4 to 7.

```sh
node kit/scripts/team-mode.mjs switch router-worker REQUEST.json --instance . --product-root <product>
node kit/scripts/team-mode.mjs switch router-worker REQUEST.json --instance . --product-root <product> --confirm <digest>
node kit/scripts/team-mode.mjs switch specialist    REQUEST.json --instance . --product-root <product> [--confirm <digest>]
node kit/scripts/team-mode.mjs switch recover --instance .
```

`REQUEST.json` is `{"spec"?, "limits"?}`: the Router/Worker team spec that
`team-mode.mjs preview` takes (project, the three worker profiles, governance
staffing, workflow states) and any limit the owner wants to change. `{}` is
enough for a switch to specialist, and for a switch back to Router/Worker when
the spec confirmed the first time is still with the packed team. `limits` is
accepted on the first switch into Router/Worker mode only (see below).

Exit 0 switched, 2 refused or proposal only, 1 usage.

## Two steps: propose, then confirm

Without `--confirm` the command prints a proposal and changes nothing:

| Field | Content |
|---|---|
| `from`, `to` | the two modes |
| `staffing` | model, effort, turn limit and tools of the three workers and of each staffed governance role; for a packed Router/Worker team, the staffing it was packed with |
| `limits` | attempts per ticket, output allowance per ticket, the Guardian's share, authorization per ticket; the ADR's defaults unless the request changes one; for a packed Router/Worker team, the limits it was packed with |
| `dispatch` | `engine` |
| `pack` | the files that go on holiday |
| `install` | the files that are put in place |
| `kept` | files of the new team that are already there and stay as they are (shared governance role files) |
| `digest` | the digest of the proposal |

The owner confirms by running the same command with `--confirm <digest>`. The
proposal is computed again at that moment; a digest that is not the current
proposal is refused (`SWITCH_NOT_CONFIRMED`): the team, the kit or the request
changed since the proposal was read. The digest covers the lists of files and,
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
dispatch a packed wrapper.

## Into Router/Worker mode

The first time, from a spec:

1. The team is drafted from the spec and a full copy is staged and validated in
   a scratch directory. A draft that does not validate, or an enabled workflow
   duty with no role, refuses the switch before the team is touched.
2. The specialist files are packed.
3. The drafted files are written and made live, and `profiles/team-mode.json`
   records: `mode: router-worker`, `status: live`, `dispatch: engine`, the
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
`limits` is refused. There is no command yet to change the limits of a team
that exists; that is an open point for the bootstrap step.

## Back to specialist mode

The packed specialist team is checked against its manifest first: a file that is
missing or was edited under `holiday/specialist/` refuses the switch. The
Router/Worker files are packed and the specialist files are moved back. They
come back byte for byte, so the deployment validator is not run again.

After a team is unpacked its holiday folder is removed. Anything else found in
that folder is left where it is and reported (`leftInHoliday`).

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
node kit/scripts/team-mode.mjs switch recover --instance .
```

rolls the interrupted switch back and appends one line to `pm-decisions.md`.
Only files the journal names are touched, only when each may belong to one of
the two modes, and a file is moved back only where its place is empty.

- A switch that died after its last file moved is rolled back too: the journal
  is the only sign that it did not finish.
- A switch that died before it recorded its lock is recognised by the lock's
  team root and by its time, which is not earlier than the journal's. The batch
  "before" command must therefore refuse to start while a journal exists; that
  command is not built yet.
- A death inside the lock's own release leaves the guard file
  `<product>/.git/rw-ownership-lease.json.release-lock`. Recover names it and
  stops; the operator removes that file and runs recover again.

A test simulates a death at every write of both restores, and at a sample of
the writes of a first switch, and checks after recover that the tree is as it
was, the lock is free and the same switch can be proposed again.

## Refusals (`SWITCH_REFUSED`)

- The team is already in that mode, or the mode is unknown.
- The deployment is not in the two-root layout. The message points to
  `scripts/migrate-to-instance.sh`.
- The product repository is not the one the team is bound to, or is not at rest
  (above).
- `holiday/<mode>/` for the mode being left already holds a packed team (a
  manifest, or a file at a path that would be packed): a packed team is never
  overwritten, and the folder is not touched. A stray file such as `.DS_Store`
  does not count.
- The roster does not name a role file for a delivery role (above).
- `limits` are given for a team that is already packed.
- A file is in the way of the team being put in place.
- A mode profile or manifest names a file that cannot belong to that mode.

## Not covered

- **The write-limit hook is not installed by the switch yet.** Today's hook
  refuses every agent's write when no batch boundary exists, which would block
  the governance roles between batches. It comes with the batch commands.
- **A packed specialist team is not upgraded.** After a kit upgrade,
  `pin-kit.sh` lists the seeds to port for the files it finds in the instance;
  files under `holiday/specialist/` are not among them.
- **Bootstrap does not offer the mode yet**, and the gate flag
  (`dispatch: main-session`) cannot be set: both are later steps.
- **Nothing ties the confirmation to the owner.** The digest is printed by the
  proposal and accepted on the command line, so any session that can run the
  command can do both steps, an unattended PM session included. The ledger line
  says a proposal was confirmed by its digest and does not say by whom. Whether
  the confirmation should need something only the owner can do is an open owner
  decision.
