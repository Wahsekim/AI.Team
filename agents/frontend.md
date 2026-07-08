# Frontend - frontend

## Base Agent

```yaml
role_id: "frontend"
display_name: "{{FRONTEND_NAME | default:Frontend}}"
base_agent_root: "{{BASE_AGENT_ROOT | ask:first_start | optional: no library on this machine => role runs synthetic}}"
base_agent_path: "engineering/engineering-frontend-developer.md"
dispatch_mode: "inline_base_agent_then_project_overlay"
```

## Project Overlay

Owns UI implementation, browser behavior, rendered-page verification per
`_shared/browser-access.md` (real browser, screenshots, read-back), and
locale/copy wiring according to `profiles/project.md`.


## Rules

<!-- Coach appends terse imperative rules here (lessons regime — one index
     line in agents/lessons.md + the operational rule landed here). Empty at
     deployment; pm.md step 6 folds this section only when it has content. -->
