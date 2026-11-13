# Runtime write boundary (file tools)

Status: implemented and tested offline. Not yet observed in a live run.

Until now nothing stopped a worker from writing outside its mandate while it
ran. The brief said where it may write, and the candidate was compared with the
mandate after the run. In the E-02 smoke run the execution worker left `lib/`
alone because the ticket told it to, not because anything refused the write.

This step adds a Claude Code `PreToolUse` hook that refuses such a write before
it happens.

```sh
node kit/scripts/arm-boundary-router-worker.mjs RUN.json --team-root <activated copy> --product-root <product-root>
```

`RUN.json` is the request of `freeze-run-router-worker.mjs`. Exit 0 prints the
record, 2 is a refusal, 1 is usage. Run it after activation and before launch.

## What arming writes

Only in an activated disposable copy (`profiles/team-mode.json` status
`activated-disposable-smoke`); a standing instance is refused.

- `.claude/rw-write-boundary.json`: the product root and, per wrapper of the
  run's policy, the paths its file tools may write. The execution wrapper gets
  the union of the tickets' `mandate.allowedWritePaths`; the check and Guardian
  wrappers get none. The file carries its own digest.
- `.claude/settings.json`: one `PreToolUse` entry with matcher
  `Write|Edit|NotebookEdit|MultiEdit|Bash` that runs
  `kit/scripts/hooks/rw-write-boundary.mjs`. Existing settings are kept; arming
  twice adds one entry.

## What the hook decides

The hook reads the call from standard input. Claude Code runs project hooks
inside subagents and names the subagent in `agent_type`.

| Call | Decision |
|---|---|
| not a write tool, or no `agent_type` (the main session) | allowed |
| a subagent, and the boundary file is missing, unreadable or does not match its digest | denied |
| a subagent that is not a wrapper of the run (governance roles) | allowed |
| a wrapper of the run, target inside the product and inside its paths | allowed |
| a wrapper of the run, any other target | denied (exit 2, reason on stderr) |

A target is resolved against the call's working directory. A path that does not
exist yet is judged by its nearest existing ancestor after symlinks are
resolved, so a link inside an allowed directory does not widen it. The reason
names the wrapper and the product-relative path, never a host path.

## The call log

The hook appends one line per call to `.claude/rw-write-boundary.log.jsonl` in
the activated copy: time, tool name, the agent name the runtime passed (or
`null`), whether the call was judged against the boundary, and the decision. It
holds no path and no command. Bash is matched only so that its calls are logged;
a Bash call is never judged and never refused. A log that cannot be written does
not change the decision.

The log tells apart three ways a forbidden write can get through:

| Log after the run | Reading |
|---|---|
| no lines at all | the hook did not load in that session |
| lines for the write tools, all with agent name `null` | the hook ran but the runtime did not name the agent, so every call was treated as the main session |
| a Bash line for the wrapper and no refused write | the write went through the shell, which the hook does not bound |

`launch-router-worker.mjs close` puts the counts in the close record (`hookLog`).

## Limits

- **Bash is not covered.** A wrapper with Bash can still write anywhere through
  the shell. `BASH_NOT_SANDBOXED` stays an accepted unknown; closing it needs
  the Claude Code sandbox (`sandbox.filesystem`), which also has to admit the
  build tool's own caches.
- **Not observed live.** The documentation says project hooks run inside
  subagents and that workflow agents get the same permission checks; that the
  hook fires for an agent started by the count engine, with `agent_type` set to
  the wrapper name, has to be shown by a run that tries a forbidden write.
- **Permission modes.** A hook that exits 2 is documented to stop the call
  before permission rules are evaluated. Its effect under a non-default
  permission mode is not documented; the isolation gate already refuses such
  modes.
- **Per run, not per ticket.** The execution wrapper gets the union of the
  run's mandates, because the hook cannot tell which ticket a call belongs to.
- **The isolation gate checks that the boundary is in place, not that it works.**
  It reports `WRITE_BOUNDARY_NOT_ARMED` (blocked) when the boundary file is
  missing or changed, was armed for another product root, names other wrappers
  than the roster, when the hook is not registered or its file is missing, or
  when `disableAllHooks` is set in the team root. Arm before observing the gate;
  the [launch host](launch-host.md) does both in order.
