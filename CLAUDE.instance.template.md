# CLAUDE.md

Cold-start primer for the {{PROJECT_NAME | localized at bootstrap}} team
instance. Read this first.

## Two Roots

This folder is a project **instance root** (`decisions/0009-kit-instance-separation.md`
in the kit). It holds this project's team state. The AI.Team kit is the
read-only checkout in `kit/`, pinned by `kit.lock`.

| Root | Holds | Written by this team |
|---|---|---|
| `.` (instance) | `charter.md`, `profiles/`, `agents/roster.md`, `agents/overlays/`, ledgers, `memory/`, `messages/`, `decisions/`, `.claude/` | yes |
| `kit/` | role files, shared rules, templates, docs, scripts, engine source, methodologies | never |

## Path Rule

A team-relative path named in any kit document or script resolves in this
folder when it exists here, otherwise under `kit/`. Example: `agents/lifecycle.md`
is `./agents/lifecycle.md`; `agents/pm.md` is `kit/agents/pm.md`;
`scripts/validate-team.sh` is `kit/scripts/validate-team.sh`.

Run kit scripts from this folder and pass it as the root:
`kit/scripts/validate-team.sh --mode deployment .`

## Hard Rules For This Layout

- Never create, edit or delete anything under `kit/`. A kit change is made in
  the kit's own repository and arrives here as a pin update.
- Never copy a kit file into this folder to edit it. Project adaptations of a
  role go in `agents/overlays/<role_id>.md`, read after `kit/agents/<role_id>.md`.
- New project ADRs, ledger entries, lessons and memory are written here.

## Start

Then read `kit/CLAUDE.md` and follow it with the path rule above: its
authority map, PM Start Protocol and Hard Rules apply to this instance. When
the owner says `start {{PROJECT_NAME | localized at bootstrap}}` or
`start team`, begin at its PM Start Protocol.
