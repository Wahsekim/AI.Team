# Main-session dispatch (owner decision 2026-11-16)

Status: built and tested offline end to end: `prepare` arms the gate, `next`
names the admitted call, `close` and `settle` read the dispatch log. Not yet
run with real agents; the hook mechanics were observed in headless probes only.
Nothing here calls a model.

## Why

Within the retry cap the same exec agent fixes its own work and the same check
agent verifies again (owner, after the fourth smoke run showed a retry by fresh
agents re-reading the project for a one-line fix). The count engine cannot do
that: an agent it starts cannot be resumed. An agent started with the Agent tool
can be resumed with SendMessage, context intact
([launch host, Retries](launch-host.md)). So a run with retries is dispatched by
the copy's main session, which is a model. The gate takes the decisions away
from it.

## The run is a function of two files

- the launch record (`rw-launch.json`, `dispatch: "main-session"`): the frozen
  plan with each ticket's exec and check wrapper and brief, and
  `maxAttemptsPerTicket`;
- the dispatch log (`.claude/rw-dispatch.jsonl`), written only by the hook: one
  `dispatched` line per admitted call and one `returned` line per agent
  hand-back.

`nextCall` reads both and renders the one call that may come next:

| State | Next call |
|---|---|
| ticket not started | Agent, exec wrapper, frozen brief plus the exec report contract |
| exec reported clean work | Agent, check wrapper, frozen check brief plus the check report contract |
| check failed, attempts left | SendMessage to the SAME exec agent: attempt number and the check's report as one line of data |
| exec reported again | SendMessage to the SAME check agent: verify the current state again with every command |
| check passed | the next ticket |
| a call is out | `wait` |
| ticket stopped, or plan finished | `done`, with each ticket's status and attempts |

A ticket stops, and with it the run, on: an exec report that is not the contract
JSON, a blocked exec, an exec without progress, a check report that is not the
contract JSON or claims a pass without a command that ran with exit code 0, and
a check that still fails on the last attempt. Later tickets are not dispatched.

The agent ids used for a resume are the ones the hook saw in the hand-back of
the admitted call; the main session never supplies an id.

## The hook

`scripts/hooks/rw-dispatch-gate.mjs` is a `PreToolUse` hook for `Agent`, `Task`,
`SendMessage`, `Workflow` and `SubagentHandback`.

- A main-session `Agent` or `SendMessage` call is admitted only when its agent
  type or recipient and its full prompt or message equal what `nextCall`
  renders. Anything else is refused: a changed brief, another agent type, a call
  out of order, a second call while one is pending, a fresh agent where a resume
  is due, an edited check report.
- `Workflow` is refused: no engine run inside a main-session dispatch.
- An agent's hand-back is recorded when the agent is one of the run's wrappers.
- Without an intact main-session launch record every dispatch is refused.
- A call that cannot be recorded is refused, so it cannot be admitted twice.

Observed on Claude Code 2.1.323 with a headless probe: `PreToolUse` fires for
the main session's `Agent` (input `subagent_type`, `prompt`) and `SendMessage`
(input `to`, `message`) and a refusal stops the call; the hand-back event
carries `agent_type`, `agent_id` and the final message; a resumed agent's tool
calls carry the same `agent_type` and `agent_id`, so the
[write boundary](write-boundary.md) keeps judging it; resumed turns are appended
to the agent's one transcript.

## Preparing and driving a run

`RUN.json` carries `"dispatch": "main-session"` in `run` (default `engine`).
`maxAttemptsPerTicket` then defaults to 2: the first try and one retry by the
same agents. `launch-router-worker.mjs prepare` freezes the run as for an
engine run, registers the gate hook in the copy's `.claude/settings.json`
(matcher `Agent|Task|SendMessage|Workflow|SubagentHandback`) and passes the
isolation gate only when that hook is in place (`DISPATCH_GATE_NOT_ARMED`
otherwise). The launch record carries `dispatch`.

The main session, opened after prepare, repeats one step:

```sh
node kit/scripts/launch-router-worker.mjs next --team-root <activated copy>
```

- `action: "agent"`: call the Agent tool with `subagent_type` as printed and
  the prompt `rw:next`.
- `action: "message"`: call SendMessage with the message `rw:next`.
- `action: "wait"`: wait for the pending agent's report.
- `action: "done"`: stop; the output lists each ticket's status and attempts.

The gate replaces the placeholder with the exact frozen text, sets the agent
type or the recipient itself and makes the call run in the foreground, so the
main session never handles a brief or a check report. `next` prints no brief
text. A call with any other text is admitted only if it is exactly the one the
gate would have written.

## Limits during the run

Two things bound a main-session run, and the gate enforces both:

- **Calls**: at most `maxAttemptsPerTicket` attempts per ticket, each one exec
  call and one check call.
- **Usage per ticket**: every hand-back is recorded with the agent's usage so
  far (input + cache_creation, read from its transcript with
  `measure-spawn.mjs`). When the exec and check agents of a ticket together
  reach the ticket's authorization, the ticket stops as
  `authorization-exhausted` and no further call is admitted. A reading that
  cannot be taken stops it as `usage-unknown`. A ticket that already passed is
  not undone; settlement reports its overrun.

The reading is taken when the agent hands back, before the runtime has written
that last turn, so it lags by one turn (an agent that answers in a single turn
reads 0). The limit is checked between calls: one call can overshoot it. The
exact figures are those of `settle`.

The output ceiling and the output estimate in `RUN.json` are NOT enforced in a
main-session run: only the count engine meters output tokens. They are still
required by run freezing, and the run record says so with `budget.enforced:
false`. Main-session and governance usage are bounded by nothing.

## Closing and settling

```sh
node kit/scripts/launch-router-worker.mjs close --team-root <activated copy>
node kit/scripts/measure-spawn.mjs <session-dir> --json > METER.json
node kit/scripts/launch-router-worker.mjs settle METER.json --team-root <activated copy>
```

There is no engine return. `close` takes the calls from the dispatch log:
`account.source` is `dispatch-log`, `calls` counts tickets, exec and check calls
(`guard` is 0), `attempts` and `tickets` give each dispatched ticket's attempts
and status, and `blockers` names every ticket that did not pass. A run the main
session left before its end is still closed and its lease released, with the
finding `RUN_NOT_FINISHED` and the call that was due. The product checks
(changed paths against the write boundary, moved head, candidate snapshot, hook
log) are those of an engine run.

`settle` binds each agent by the id the gate recorded, not by order, and refuses
a meter that lacks one of them. An agent has one transcript for all its
attempts, so the read after the run is charged to its first call and its later
calls add nothing: usage is known per ticket and duty, not per attempt. The
journal records a retry as a continuation in the same session. The frozen brief
is looked for in each agent's transcript, where the Agent tool puts the prompt
unchanged. The run settlement has no Guardian term.

## What the gate does not do

- It cannot make the main session continue. A run the main session abandons
  stays at `wait` or at an undispatched ticket; close will show it.
- The main session itself is not a wrapper: its own Write, Edit and Bash calls
  are judged by neither the write boundary nor this gate.
- Reports are the agents' own claims. The check's pass is grounded only in the
  commands it lists, as in the count engine.
- Prompt rewriting relies on the runtime honouring a hook's `updatedInput`,
  observed on Claude Code 2.1.323 for `Agent` and `SendMessage`. On a runtime
  that ignores it the agent would receive the literal placeholder; its report
  would not be the contract JSON and the ticket would stop.
- A pending call whose agent dies has no hand-back and leaves the run at
  `wait`.
- No Guardian call. The Guardian audits an engine loop; what audits a
  main-session dispatch is not decided.
