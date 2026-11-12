# Agent Lifecycle Log

Append-only record of every worker dispatch. PM owns this file.
Rotation: slim-active + archive — the standing rule in
`docs/process-index.md` -> Rotation Regime.

## Format

```md
## [NNN] {{ROLE_DISPLAY_NAME}} ({{ROLE_ID}}) - {{UTC_TIMESTAMP}}
- Ticket: {{TICKET_ID | none}}
- Spawned by: {{PM_NAME}}
- Brief: {{ONE_LINE_SCOPE}}
- Model: {{MODEL | per agents/roster.md}}
- Reasoning: {{REASONING | per agents/roster.md}}
- Estimated tokens: {{INTEGER}}
- Sub-decision count: {{INTEGER}}
- Status: spawned | running | completed | failed | aborted
- Completed: {{UTC_TIMESTAMP}}
- Tokens: {{INTEGER}}                     # harness-measured; dual-record self-report >30% divergence (M4)
- Lessons: {{LNN, ... | none}}            # optional; lessons applied in this dispatch (scripts/lessons-stats.sh counts them)
- Variance: {{+/-N%}}
- PM overhead: ~{{INTEGER}} tok (est)
- Outcome: {{ONE_LINE_RESULT}}
- Progress: yes | no
- Handoffs:
    - {{ROLE_ID}} needs {{THING}} for {{TICKET_ID}}
- Retry-of: {{NNN | none}}
- Diverged-from: {{NNN | none}} - {{WHAT_CHANGED_ON_RETRY}}
- Round-trip: {{N | none}}
- Notes: {{OPTIONAL - coaching trigger queued, escalation, Q-gate line}}
```

## Counter

Next NNN to assign: **001**

## Counter and header rules

1. `NNN` is a monotonic 3-digit counter, never reused, even after failures.
2. **One `## [NNN]` header per entry, EVER.** Duplicate `[NNN]` numbers and
   second `## [NNN] close`-style headers are BANNED — close info updates the
   original block in place; the header is immutable. (The source project's
   pre-rotation log accumulated duplicate headers; do not repeat.)
3. A re-spawn for the same ticket gets a NEW NNN with `Retry-of: <prior NNN>`.
4. All timestamps UTC, ISO 8601.
5. If a worker dies before closing, the PM fills the close fields with
   `Notes: closed by PM (worker died)`.

## Engine-mode compressed format

For `run-n-rounds` engine loops, the PM pastes the engine's emitted block
VERBATIM (see `docs/engine.md` — manual re-derivation banned). The emitted
block already satisfies this format: it starts with the `### BATCH` header
(which carries the run's `runId` — if a BATCH header with that runId is
already in this file, the run was already reconciled: never paste twice),
each numbered entry carries SEPARATE worker/verifier token figures
(`~N tok worker / ~N tok verifier` — the engine's harness deltas, never the
aggregate divided by N), the verifier verdict is in each entry line, and the
guardian verdict arrives as its own numbered entry at the end of the block.
Compressed one-line entries are valid closes in this mode.

## Harness Rules

1. Estimate before dispatch.
2. Close every entry.
3. Variance above the charter's coaching threshold (charter -> Cost
   Discipline — single source, not restated here) queues a Coach trigger
   (batched — drained in one Coach dispatch).
4. Stop on the empty-loop pattern.
5. Retries must diverge (`Diverged-from` filled).
6. Workers cannot spawn workers.
7. Progress must be observable.
8. Any halt of a count-directed loop outside the charter halt list triggers a
   chaos-role halt-investigation BEFORE the halt.
9. `Tokens:` comes from a harness meter, never the worker. When the Agent-tool
   result gives no figure, measure the transcript:
   `node scripts/measure-spawn.mjs <session-dir> --agent <agentId>` (the
   `agentId` is in the Agent-tool result) and write its `harness_eq` column
   (input + cache-creation tokens — the same scale as the Agent-tool
   `subagent_tokens` figure every band and estimate is calibrated on). Never
   write `total`: it adds cache reads and runs 10-50x higher. `Tokens:` is an
   effort scale, not spend: it omits output tokens (the priciest class), so
   writing workers are under-counted relative to reading ones. Cost questions
   use the script's four-class view with a filled `scripts/lib/model-pricing.json`.
   Measure only after the agent has finished (the script warns otherwise).
   When an engine delta AND a transcript measurement both exist and diverge
   past the M4 threshold, dual-record both in Notes exactly as M4 does for
   self-report (extends M4, does not replace it).

## Rotation

When the active file exceeds ~400 lines of entries: move closed entries to
`agents/archive/lifecycle-<from>_<to>.md` (byte-identical, immutable), keep the
counter line, and keep a one-line-per-entry recent-history summary for
continuity. Reconcile any counters derived from this log (hardening counter)
at rotation time.

---

<!-- Entries below. -->

