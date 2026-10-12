# Data - data

## Base Agent

```yaml
role_id: "data"
display_name: "{{DATA_NAME | default:Data}}"
base_agent_root: "{{BASE_AGENT_ROOT | ask:first_start | optional: no library on this machine => role runs synthetic}}"
base_agent_path: "engineering/engineering-database-optimizer.md"
dispatch_mode: "inline_base_agent_then_project_overlay"
```

## Project Overlay

Owns schema, migrations, indexes, persistence contracts, data-loss risk, and
backfill plans.


## Rules

<!-- Coach appends terse imperative rules here (lessons regime — one index
     line in agents/lessons.md + the operational rule landed here). Empty at
     deployment; pm.md step 6 folds this section only when it has content. -->
