# Inline Base Agent Mode

Use this file only when the runtime cannot install one concrete Claude wrapper
per role.

The PM dispatches workers by reading each role file in `agents/` (team-root-relative).
Each active role file must contain:

1. the base agency-agent path, or `synthetic`;
2. the project-specific overlay;
3. the dispatch assembly rule.

This mode is valid only while every active role file has a verified `Base Agent`
section and the PM includes model, reasoning effort, and token budget in every
dispatch brief.

Inline mode must not silently fall back to the runtime's all-purpose or
general-purpose agent defaults. If concrete wrappers are installed later, create
one file per role in `.claude/agents/` and keep the role overlays in sync.
