# Claude Integration

This template preserves the useful Claude-facing structure from the source team workspace:

- root `CLAUDE.md` as the cold-start index;
- `.claude/agents/` project-scoped wrappers;
- `.claude/workflows/run-n-rounds.js` — the count-directed loop engine
  (contract: `docs/engine.md`);
- agent overlays and brief templates;
- watchdog hooks for unattended sessions;
- process logs that survive context resets.

## Root `CLAUDE.md`

The root `CLAUDE.md` should stay short enough for cold starts:

1. what the repo is;
2. where the team folder lives;
3. where the product folder lives;
4. start/stop protocol;
5. hard rules that should not require searching.

Detailed behavior belongs in `agents/pm.md`, `charter.md` (instantiated from
its template at bootstrap), and profiles.

## Project-Scoped Agent Wrappers

Use `.claude/agents/role-wrapper.template.md` to create wrappers for the local
Claude agent registry.

The wrapper should:

- name the project-specific agent, not a generic all-purpose worker;
- point to this project's role overlay or template;
- point to `profiles/project.md` and `profiles/stack.md`;
- set or document model, reasoning effort, and token budget;
- say workers report to PM only;
- avoid hardcoding stack commands outside `profiles/stack.md`.

Project wrappers are the preferred deployment mode. Inline base-agent dispatch
is a fallback only when the runtime cannot install wrappers and
`agents/roster.md` explicitly declares that mode. Do not leave both missing. The
PM must have either:

- concrete `.claude/agents/*.md` wrappers for every spawnable active role, or
- role files with verified base-agent paths and an inline-dispatch instruction.

Do not dispatch active roles as all-purpose or general-purpose agents when a
specific wrapper exists. That loses the role model, reasoning profile, and
specialist persona.

## Watchdog

`scripts/watchdog/` contains the source project's hang-detection scripts copied forward.
Use `scripts/watchdog/INSTALL.template.md` and replace placeholders before
installing.

The watchdog does not solve every runtime issue. It preserves one important
capability: if an unattended tool call hangs for too long, the owner gets a
heartbeat-based signal instead of discovering it hours later.

## Existing `CLAUDE.md` In Product Repos

For existing projects, do not overwrite the product's `CLAUDE.md`. Add a short
section pointing to this team folder instead:

```md
## AI Team

Team process lives in `AI.Team/`. Start with `AI.Team/CLAUDE.md`.
Product code rules in this file remain authoritative for code work.
```
