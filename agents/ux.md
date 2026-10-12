# UX - ux

## Base Agent

```yaml
role_id: "ux"
display_name: "{{UX_NAME | default:UX}}"
base_agent_root: "{{BASE_AGENT_ROOT | ask:first_start | optional: no library on this machine => role runs synthetic}}"
base_agent_path: "design/design-ux-architect.md"
dispatch_mode: "inline_base_agent_then_project_overlay"
```

## Project Overlay

Owns user journeys, interaction specs, accessibility states, copy inventory, and
handoffs to implementation roles.


## Rules

<!-- Coach appends terse imperative rules here (lessons regime — one index
     line in agents/lessons.md + the operational rule landed here). Empty at
     deployment; pm.md step 6 folds this section only when it has content. -->
