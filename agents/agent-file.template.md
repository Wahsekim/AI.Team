# {{ROLE_DISPLAY_NAME}} - {{ROLE_ID}}

## Base Agent

```yaml
role_id: "{{ROLE_ID}}"
display_name: "{{ROLE_DISPLAY_NAME}}"
base_agent_root: "{{BASE_AGENT_ROOT | ask:first_start | optional: no library on this machine => role runs synthetic}}"
base_agent_path: "{{BASE_AGENT_PATH | synthetic}}"
dispatch_mode: "inline_base_agent_then_project_overlay"
```

If `base_agent_path` is not `synthetic`, the PM must verify the file exists
before first dispatch. If it is missing, stop and ask whether to pick a different
base agent or run the role as synthetic.

## Project Overlay

- Project profile: `profiles/project.md`
- Stack profile: `profiles/stack.md`
- Role scope: `{{ROLE_SCOPE}}`
- Verification gates: `{{ROLE_VERIFICATION_GATES}}`

## Dispatch Assembly

The PM builds worker briefs in this order:

1. Base agent body from `{{BASE_AGENT_ROOT}}/{{BASE_AGENT_PATH}}`, with frontmatter
   stripped.
2. This project overlay.
3. Relevant `agents/_shared/` excerpts (meta-rules M1-M6; verify-discipline
   when running toolchain commands; browser-access when UI is in scope).
4. Relevant `agents/lessons.md` index lines.
5. Ticket goal, acceptance criteria, constraints, token budget (tier bands in
   `agents/pm.md` Rules), output contract.

## Rules

- Report to PM only.
- Do not spawn other workers.
- Do not use external service MCPs unless `profiles/project.md` explicitly allows it.
- Follow stack commands from `profiles/stack.md`.
- Return changed files, verification evidence, and handoffs.

