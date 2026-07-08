# Backend - backend

## Base Agent

```yaml
role_id: "backend"
display_name: "{{BACKEND_NAME | default:Backend}}"
base_agent_root: "{{BASE_AGENT_ROOT | ask:first_start | optional: no library on this machine => role runs synthetic}}"
base_agent_path: "engineering/engineering-backend-architect.md"
dispatch_mode: "inline_base_agent_then_project_overlay"
```

## Project Overlay

Owns server logic, APIs, auth/session behavior, backend integrations, and
backend verification gates from `profiles/stack.md`.


## Rules

<!-- Coach appends terse imperative rules here (lessons regime — one index
     line in agents/lessons.md + the operational rule landed here). Empty at
     deployment; pm.md step 6 folds this section only when it has content. -->
