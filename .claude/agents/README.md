# Project-Scoped Agent Wrappers

**Registry rule (review 2026-09-25, F-02):** Claude Code registers EVERY
frontmatter-bearing `.md` in this directory as a live agent type — a seed named
`{{PROJECT_AGENT_SLUG}}` was observed in the runtime agent list. Only live
wrappers (plus this README and an instantiated `INLINE_BASE_AGENT_MODE.md`,
which carry no frontmatter) may live here; seeds stay in `agents/_seeds/`.
`scripts/validate-team.sh` and `scripts/check-claude-compat.sh` FAIL on any
`*.template.md` or placeholder `name:` found here.

Create one local Claude agent wrapper file per spawnable role, **at bootstrap**
(bootstrap docs step "Instantiate the dispatch path" — a blocking item: with
neither wrappers nor `INLINE_BASE_AGENT_MODE.md` instantiated, dispatch is
impossible by the kit's own rules).

Use `agents/_seeds/role-wrapper.template.md`; name each file `<project-slug>-<role>.md` and
list exactly these files in the roster's wrapper column — never
planned-but-uncreated paths.

Do not leave active roles to the runtime's all-purpose or general-purpose agent
when the runtime supports project wrappers. A deployed team is dispatchable only
when each spawnable role has a concrete wrapper with:

- role-specific name;
- role-specific description;
- model (frontmatter `model` — runtime-enforced);
- reasoning effort (frontmatter `effort` — runtime-enforced);
- turn cap (frontmatter `maxTurns` — runtime-enforced);
- advisory token budget (brief-level only — NO runtime frontmatter field
  hard-caps tokens per agent; never present it as a mechanical control);
- base-agent or synthetic source;
- pointer to `agents/<role_id>.md` (team-root-relative — wrappers run with the
  main session's cwd, which is the team root per README "How to Deploy").

If the runtime cannot install wrappers, copy
`agents/_seeds/INLINE_BASE_AGENT_MODE.template.md` to `INLINE_BASE_AGENT_MODE.md`
here. Inline mode
is a fallback, not the preferred deployment mode, and the PM must still put the
role's model, reasoning effort, and token budget into each dispatch brief.

The wrapper's job is to connect a generic agent persona to this project:

- read `profiles/project.md`;
- read `profiles/stack.md`;
- read the relevant role brief template;
- report to PM only;
- avoid hardcoded project facts in the wrapper itself.
