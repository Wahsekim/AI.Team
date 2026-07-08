# Kanban Methodology

Default workflow.

## Columns (logical states)

```text
Backlog -> Ready -> In Progress -> In Review -> Needs Decision -> Done
```

These are LOGICAL states. How they map onto the tracker depends on the
tracker adapter below. Projects may rename states in `profiles/project.md`.

## Tracker Adapters

Record the choice in `profiles/project.md` -> `operating_mode.tracker_adapter`.

### `columns` — board with real columns (Jira, Linear, GitHub Projects boards)

- States map 1:1 to columns; "transition" = move the card.
- Ticket id form: `KEY-N` per the configured key prefix.

### `labels` — flat issue trackers with no columns (GitHub Issues, GitLab issues)

- States map to STATUS LABELS: `status/backlog`, `status/ready`,
  `status/in-progress`, `status/needs-decision`, `status/in-review`;
  Done = the tracker's closed state (no label needed).
- **Bootstrap creates the labels first** (e.g.
  `gh label create "status/ready" ...` for each state) — record the exact
  mapping in `profiles/project.md` -> `status_mapping`.
- **Pre-remote holding convention**: if the tracker is not reachable yet (no
  remote created, or git/network barred for the session), do NOT improvise —
  hold the backlog as a dated list in `memory/pm.md` -> "Pending tracker sync",
  record an owner handoff line ("create remote + run label bootstrap"), and
  batch-sync verbatim at first tracker availability. Label creation then runs
  as the first tracker operation.
- "Transition" = swap the status label (e.g.
  `gh issue edit <N> --add-label status/in-progress --remove-label status/ready`);
  "pull top of Ready" = oldest/highest-priority open issue labeled
  `status/ready`.
- **Ticket id form is the tracker's native `#N`** — use it as the ONE
  canonical id in lifecycle, pm-decisions, and briefs; a key prefix does not
  map onto `#N` trackers, so omit it (a display prefix may appear in titles
  only, never as a second id).

### `file-ledger` — no external tracker

- States are sections in a local ticket ledger file; ticket id `TASK-N`.

## Rules

- Pull from Ready.
- Keep work small and independently verifiable.
- WIP stays low.
- Ambiguous product choices go to Needs Decision.
- Done requires verification and documentation checks.
- Cleanup/hardening work enters the same flow as feature work.

## PM Cycle

1. Check blocked work and empty-loop hook.
2. Pull top Ready item (per the adapter's "Ready" definition).
3. Refine if not dispatchable.
4. Dispatch exactly scoped worker.
5. Verify.
6. Close or escalate.
