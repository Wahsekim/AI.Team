# Main-session dispatch (owner decision 2026-11-16)

Status: the gate (next-call function and hook) exists and is tested offline. It
is not wired: `prepare` does not arm it yet, there is no `next` command, and
`close` and `settle` do not read its log. Nothing here calls a model.

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

## What the gate does not do

- It cannot make the main session continue. A run the main session abandons
  stays at `wait` or at an undispatched ticket; close will show it.
- The main session itself is not a wrapper: its own Write, Edit and Bash calls
  are judged by neither the write boundary nor this gate.
- Reports are the agents' own claims. The check's pass is grounded only in the
  commands it lists, as in the count engine.
- No usage limit yet: the retry cap bounds calls, nothing bounds tokens during
  the run. A pending call whose agent dies has no hand-back and leaves the run
  at `wait`.
- No Guardian call. The Guardian audits an engine loop; what audits a
  main-session dispatch is not decided.
