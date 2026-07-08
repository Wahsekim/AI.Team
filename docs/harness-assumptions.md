# Harness Assumptions (runtime contract)

What this kit assumes from the agent runtime, what happens when an assumption
does not hold, and the recommended deployment hooks. The kit's defenses are
HARNESS-level by design (`docs/failure-classes.md`) — so the harness itself is
a dependency worth stating explicitly.

**Tested against:** Claude Code 2.1.x (July 2026). Other runtimes/versions:
walk this table before bootstrap and record deviations in
`profiles/project.md`.

## Required primitives

| Primitive | Used by | Assumed semantics |
|---|---|---|
| **Workflow tool** (`.claude/workflows/*.js`) | `run-n-rounds.js`, engine mode (`docs/engine.md`) | executes a JS script with `agent()`, `phase()`, `log()`, `budget`; NO clock (`Date.now()` unavailable) and NO file/tracker IO in the script body — everything sequence/date-dependent arrives via args |
| **Budget API** | engine Q5 gate | `budget.spent()` is **TURN-CUMULATIVE** (includes pre-existing session spend). Any gate MUST be launch-spend-relative: capture a `spent0` baseline at script start and measure `spent() - spent0`. Gating on the raw value kills a loop at iteration 0 (source-project DOA bug, fixed in the shipped engine) |
| **Subagent registry** (`.claude/agents/*.md`) | role wrappers, PM dispatch | frontmatter `name`/`model`/`description` honored; wrapper name usable as `agentType` in Agent-tool and Workflow `agent()` calls |
| **Background Agent tool** | PM dispatch, parallel batches | dispatches run detached and notify on completion; foreground (synchronous) mode available when the PM must gate on the result |
| **Hooks** (`settings.json`) | Stop-hook validation, git guardrails, watchdog | Stop/session-end hooks can run a shell command; permission rules can deny command patterns |
| **Per-spawn token measurement** | M4, lifecycle closes, engine token attribution | the harness reports actual per-spawn spend (self-report is never the source — M4) |

## Degradation table (assumption missing → sanctioned fallback)

| Missing | Fallback | Where documented |
|---|---|---|
| Workflow tool | count-directed loops run HAND-RUN: the PM executes cycle after cycle under the charter halt rules, logging the Q-gate line at every cycle close | `agents/pm.md` One-Cycle Workflow; charter loop mode 2 |
| Subagent registry / wrappers uninstallable | documented inline base-agent mode: instantiate `.claude/agents/INLINE_BASE_AGENT_MODE.md`, note it in the roster, dispatch `general-purpose` + inlined persona | bootstrap docs step "dispatch path"; `agents/roster.md` |
| Background dispatch | serial foreground dispatch; parallel-batch window in the charter table becomes moot | charter budget table |
| Hooks | run `scripts/validate-team.sh` manually at wake step 0 and before session close; git policy enforced by rule only | `agents/pm.md` wake step 0 |
| Per-spawn token measurement | estimates + self-report DUAL-RECORDED with an explicit "unmeasured" flag in lifecycle Notes; variance-based coaching triggers suspended (they would train on fiction) | M4, `agents/lifecycle.md` |
| Workflow-spawned session continuation | fresh scoped fix spawn inlining the verifier failure report; log `Session: resumed-fresh` | `docs/engine.md` fix-retest drain rule |

## Agent stalls — checkpoint-to-disk protocol

Long-running subagents STALL in practice: this kit's own adversarial
validation hit **3 stalls** during multi-deliverable agent runs. Treat stalls
as expected weather, not exceptional failure:

1. **Findings/state are written to files incrementally, never held only in
   context.** A worker on a multi-part task writes each completed part to its
   output surface BEFORE starting the next (the "work file by file" brief
   pattern). A stalled agent then costs only the in-flight part.
2. Briefs for >2-part tasks include the line: *"Write each deliverable
   completely before starting the next; keep individual writes moderate."*
3. The PM's stall response (`agents/pm.md` -> Stall response) prioritizes
   stall analysis on the next cycle; recovered work resumes FROM THE FILES,
   not from a re-brief of the whole task.
4. Unattended sessions run the watchdog (`scripts/watchdog/` —
   heartbeat + hang detection); see `scripts/watchdog/INSTALL.template.md`.

## Recommended deployment hooks/settings

Merge into the deployment's `.claude/settings.json` (adjust paths; the
Stop-hook is the mechanical wake/close control for FC-8 — see
`docs/failure-classes.md`):

```json
{
  "hooks": {
    "Stop": [
      {
        "hooks": [
          {
            "type": "command",
            "command": "bash AI.Team/scripts/validate-team.sh AI.Team || echo 'validate-team FAIL — investigate before next dispatch (agents/pm.md wake step 0)'"
          },
          {
            "type": "command",
            "command": "echo 'Session-end reminder: lifecycle closed? memory/pm.md delta block written? coaching queue drained?'"
          }
        ]
      }
    ]
  },
  "permissions": {
    "deny": [
      "Bash(git push:*)",
      "Bash(git commit:*)"
    ]
  }
}
```

- Keep the git denials wherever owner policy is local-git-only or
  no-commit-without-ask (charter `GIT_POLICY`); drop them only on explicit
  owner instruction.
- Watchdog for long unattended runs: `scripts/watchdog/` (start/stop scripts,
  heartbeat, install notes).
- The Stop-hook does not replace wake step 0: the PM still runs
  `scripts/validate-team.sh` at wake and investigates any FAIL before
  dispatching.

## Update rule

New harness version or new runtime → re-verify the Required primitives table
(especially budget semantics and session continuation), chaos-gate the engine
once (`docs/engine.md` -> Keeping the engine honest), and update the
tested-against line with the date.
