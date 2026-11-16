# Switching a team between specialist and Router/Worker mode

Status: built and tested offline on a bootstrapped two-root fixture. Not yet
used on a real team. It changes which team is live; it does not run a batch.
[ADR 0010](../../../decisions/0010-router-worker-second-mode.md), decisions 4 to 7.

```sh
node kit/scripts/team-mode.mjs switch router-worker REQUEST.json --instance . --product-root <product>
node kit/scripts/team-mode.mjs switch router-worker REQUEST.json --instance . --product-root <product> --confirm <digest>
node kit/scripts/team-mode.mjs switch specialist    REQUEST.json --instance . --product-root <product> [--confirm <digest>]
```

`REQUEST.json` is `{"spec"?, "limits"?}`: the Router/Worker team spec that
`team-mode.mjs preview` takes (project, the three worker profiles, governance
staffing, workflow states) and any limit the owner wants to change. `{}` is
enough for a switch to specialist, and for a switch back to Router/Worker when
the spec confirmed the first time is still with the packed team.

Exit 0 switched, 2 refused or proposal only, 1 usage.

## Two steps: propose, then confirm

Without `--confirm` the command prints a proposal and changes nothing:

| Field | Content |
|---|---|
| `from`, `to` | the two modes |
| `staffing` | model, effort, turn limit and tools of the three workers and of each staffed governance role |
| `limits` | attempts per ticket, output allowance per ticket, the Guardian's share, authorization per ticket; the ADR's defaults unless the request changes one |
| `dispatch` | `engine` |
| `pack` | the files that go on holiday |
| `install` | the files that are put in place |
| `digest` | the digest of the proposal |

The owner confirms by running the same command with `--confirm <digest>`. A
digest that is not the current proposal is refused (`SWITCH_NOT_CONFIRMED`): the
team, the kit or the request changed since the proposal was read.

## What moves

A mode's own files:

| Mode | Its own files |
|---|---|
| specialist | `agents/roster.md`; every wrapper under `.claude/agents/`; the role file of each roster role that is not the PM or a governance role; `profiles/team-mode.json` if there is one |
| Router/Worker | the files the switch wrote: roster, the three worker role files, the Router/Worker contract and router supplement, all wrappers, `profiles/team-mode.json` |

They are moved to `holiday/<mode>/`, with a `manifest.json` listing each path
and its digest. Nothing else moves: charter, decisions, ledgers, lessons,
memory, profiles, the PM and governance role files stay where they are. A
governance role file the instance already has is kept as the instance wrote it.

A folder under `holiday/` is outside `.claude/agents/`, so the runtime cannot
dispatch a packed wrapper.

## Into Router/Worker mode

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

## Back to specialist mode

The packed specialist team is checked against its manifest first: a file that is
missing or was edited under `holiday/specialist/` refuses the switch. The
Router/Worker files are packed, with the spec and limits in their manifest, and
the specialist files are moved back. They come back byte for byte, so the
deployment validator is not run again: the team is the one that was packed.

Switching to Router/Worker again drafts the team afresh from the kept spec with
the kit as it is then, so an upgraded kit is taken into account; the proposal
shows the staffing again for confirmation.

## Refusals (`SWITCH_REFUSED`)

- The team is already in that mode, or the mode is unknown.
- The deployment is not in the two-root layout. The message points to
  `scripts/migrate-to-instance.sh`.
- The product root is not the top of a Git repository, has uncommitted or
  untracked changes (the first ten paths are listed), or carries a lock: a batch
  is open.
- The spec names another product root than the one given.
- `holiday/<mode>/` for the mode being left already exists: a packed team is
  never overwritten.

## Not covered

- **The write-limit hook is not installed by the switch yet.** Today's hook
  refuses every agent's write when no batch boundary exists, which would block
  the governance roles between batches. It comes with the batch commands.
- **A packed specialist team is not upgraded.** After a kit upgrade,
  `pin-kit.sh` lists the seeds to port for the files it finds in the instance;
  files under `holiday/specialist/` are not among them.
- **Bootstrap does not offer the mode yet**, and the gate flag
  (`dispatch: main-session`) cannot be set: both are later steps.
- The ledger line is written by the command with the host's UTC date. It records
  that the owner confirmed the proposal by its digest; it cannot know who typed
  the command.
