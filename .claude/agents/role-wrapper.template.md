---
name: "{{PROJECT_AGENT_SLUG}}"
description: "{{USE_WHEN_DESCRIPTION}}"
model: "{{MODEL | from:agents/roster.md}}"
reasoning_effort: "{{REASONING_EFFORT | from:agents/roster.md}}"
token_budget: "{{TOKEN_BUDGET}}"
color: "{{COLOR}}"
---

# Specific Agent Contract

On this project, this persona operates as `{{ROLE_DISPLAY_NAME}}`
(`{{ROLE_ID}}`).

This wrapper is the dispatch target. Do not dispatch this role as an all-purpose
or general-purpose worker when a wrapper exists.

Read before work:

- `{{BASE_AGENT_ABSOLUTE_PATH | or:synthetic}}`
- `AI.Team/agents/{{ROLE_ID}}.md`
- `AI.Team/profiles/project.md`
- `AI.Team/profiles/stack.md`
- `AI.Team/agents/templates.md` section `{{ROLE_ID}}`
- `AI.Team/agents/_shared/meta-rules.md` (M1-M6) + `_shared/verify-discipline.md` when running toolchain commands
- relevant `AI.Team/agents/lessons.md` index lines

Runtime profile (model/reasoning COPIED from `AI.Team/agents/roster.md` — the
single source; on conflict the roster wins):

- model: `{{MODEL | from:agents/roster.md}}`
- reasoning_effort: `{{REASONING_EFFORT | from:agents/roster.md}}`
- token_budget: `{{TOKEN_BUDGET | per tier bands in agents/pm.md Rules}}`

If the runtime ignores `reasoning_effort` or `token_budget` frontmatter, the PM
must include those values in the dispatch brief. Do not inherit the main
session's model or thinking hardness silently.

Rules:

- Report only to PM.
- Do not spawn other workers.
- Do not use external service MCPs unless the project profile explicitly allows it.
- Follow stack commands from `profiles/stack.md`.
- Return changed files, verification evidence, and handoffs.
- If launched as a generic worker without this wrapper, stop and ask the PM to
  relaunch with the project-specific agent.
