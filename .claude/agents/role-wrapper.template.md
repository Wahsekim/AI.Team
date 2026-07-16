---
name: "{{PROJECT_AGENT_SLUG}}"
description: "{{USE_WHEN_DESCRIPTION}}"
model: "{{MODEL | from:agents/roster.md}}"
effort: "{{REASONING_EFFORT | from:agents/roster.md}}"
maxTurns: {{MAX_TURNS | per tier bands in agents/pm.md Rules}}
color: "{{COLOR}}"
---

# Specific Agent Contract

On this project, this persona operates as `{{ROLE_DISPLAY_NAME}}`
(`{{ROLE_ID}}`).

This wrapper is the dispatch target. Do not dispatch this role as an all-purpose
or general-purpose worker when a wrapper exists.

Read before work (paths are relative to the team root — the directory Claude
Code was started in, per README "How to Deploy"):

- `{{BASE_AGENT_ABSOLUTE_PATH | or:synthetic}}`
- `agents/{{ROLE_ID}}.md`
- `profiles/project.md`
- `profiles/stack.md`
- `agents/templates.md` section `{{ROLE_ID}}`
- `agents/_shared/meta-rules.md` (M1-M6) + `_shared/verify-discipline.md` when running toolchain commands
- relevant `agents/lessons.md` index lines

Runtime profile (model/effort COPIED from `agents/roster.md` — the single
source; on conflict the roster wins):

- model: `{{MODEL | from:agents/roster.md}}` (frontmatter-enforced)
- effort: `{{REASONING_EFFORT | from:agents/roster.md}}` (frontmatter-enforced)
- maxTurns: `{{MAX_TURNS}}` (frontmatter-enforced hard turn cap)
- token budget: `{{TOKEN_BUDGET | per tier bands in agents/pm.md Rules}}` —
  ADVISORY ONLY. No runtime frontmatter field hard-caps tokens per agent; the
  PM states this budget in the dispatch brief, monitors harness-measured spend
  at close (M4), and relies on `maxTurns` + the engine's Q5 gate for the
  mechanical bounds.

Rules:

- Report only to PM.
- Do not spawn other workers.
- Do not use external service MCPs unless the project profile explicitly allows it.
- Follow stack commands from `profiles/stack.md`.
- Return changed files, verification evidence, and handoffs.
- If launched as a generic worker without this wrapper, stop and ask the PM to
  relaunch with the project-specific agent.
