# Project-Scoped Agent Wrappers

Create one local Claude agent wrapper file per spawnable role, **at bootstrap**
(bootstrap docs step "Instantiate the dispatch path" — a blocking item: with
neither wrappers nor `INLINE_BASE_AGENT_MODE.md` instantiated, dispatch is
impossible by the kit's own rules).

Use `role-wrapper.template.md`; name each file `<project-slug>-<role>.md` and
list exactly these files in the roster's wrapper column — never
planned-but-uncreated paths.

Do not leave active roles to the runtime's all-purpose or general-purpose agent
when the runtime supports project wrappers. A deployed team is dispatchable only
when each spawnable role has a concrete wrapper with:

- role-specific name;
- role-specific description;
- model;
- reasoning effort;
- token budget;
- base-agent or synthetic source;
- pointer to `AI.Team/agents/<role_id>.md`.

If the runtime cannot install wrappers, copy
`INLINE_BASE_AGENT_MODE.template.md` to `INLINE_BASE_AGENT_MODE.md`. Inline mode
is a fallback, not the preferred deployment mode, and the PM must still put the
role's model, reasoning effort, and token budget into each dispatch brief.

The wrapper's job is to connect a generic agent persona to this project:

- read `AI.Team/profiles/project.md`;
- read `AI.Team/profiles/stack.md`;
- read the relevant role brief template;
- report to PM only;
- avoid hardcoded project facts in the wrapper itself.
