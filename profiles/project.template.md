# Project Profile Template

Create `profiles/project.md` from this file during first start. This is the
project-specific layer. Do not put stack conventions here; use `profiles/stack.md`.

## Identity

```yaml
project:
  name: "{{PROJECT_NAME | ask:first_start}}"
  slug: "{{PROJECT_SLUG | derive:lowercase-kebab of PROJECT_NAME | used_in:.claude/agents/<slug>-<role>.md wrapper names}}"
  owner_label: "{{OWNER_LABEL | ask:first_start | default:Owner}}"
  pm_role_id: "pm"
  pm_display_name: "{{PM_NAME | ask:first_start | default:PM}}"
  start_phrase: "start {{PROJECT_NAME}}"
  stop_phrase: "stop {{PROJECT_NAME}}"
  product_repo_path: "{{PRODUCT_REPO_PATH | ask:first_start | e.g. ../<slug> or ./product | note:if it does not exist yet, bootstrap creates it — empty repo/git init is PM team-ops; the runnable skeleton is a worker ticket}}"
```

## Operating Mode

```yaml
operating_mode:
  project_state: "{{PROJECT_STATE | ask:first_start | options:blank,existing}}"
  workflow_method: "{{WORKFLOW_METHOD | default:kanban}}"
  issue_tracker: "{{ISSUE_TRACKER | ask:first_start | default:file-ledger}}"
  # Tracker adapter (methodologies/kanban.md -> Tracker Adapters):
  tracker_adapter: "{{TRACKER_ADAPTER | options:columns,labels,file-ledger | note:columns = board with real columns; labels = flat trackers like GitHub Issues (status/* labels)}}"
  ticket_id_form: "{{TICKET_ID_FORM | e.g. KEY-N for column boards, #N for GitHub Issues | note:ONE canonical form — used in lifecycle, pm-decisions, briefs; never double-book two forms}}"
  issue_key_prefix: "{{ISSUE_KEY_PREFIX | ask:first_start | default:TASK | note:omit for #N trackers — ticket_id_form governs}}"
  status_mapping: "{{STATUS_MAPPING | labels adapter: map Backlog/Ready/In Progress/Needs Decision/In Review/Done to status/* labels; create them at bootstrap}}"
  human_decision_column: "{{HUMAN_DECISION_COLUMN | default:Needs Decision}}"
```

## Token Policy

```yaml
token_policy:
  estimate_before_spawn: true
  caps_and_halt_thresholds: "charter -> Canonical Budget/Halt Table (single source — do not restate values here)"
  variance_trigger: "charter -> Cost Discipline (coaching fires are batched)"
  split_required_above_hard_cap: true
  repeated_variance_preflag_count: 3
```

## Languages And Docs

```yaml
language_policy:
  product_locales: "{{PRODUCT_LOCALES | ask:first_start | default:en}}"
  internal_docs_language: "{{INTERNAL_DOCS_LANGUAGE | default:en}}"
  issue_tracker_language: "{{ISSUE_TRACKER_LANGUAGE | ask:first_start | default:owner-preference}}"
  user_docs_required: true
```

## Product Constraints

```yaml
constraints:
  deployment_context: "{{DEPLOYMENT_CONTEXT | ask:first_start | default:unknown}}"
  user_model: "{{USER_MODEL | ask:first_start | default:unknown}}"
  data_policy: "{{DATA_POLICY | ask:first_start | default:unknown}}"
  security_baseline: "{{SECURITY_BASELINE | ask:first_start | default:auth-if-user-data}}"
  git_policy: "{{GIT_POLICY | default:no commit or push unless owner asks}}"
```

## Documentation Completeness

Paths are relative to `product_repo_path` unless absolute. If the product repo
does not exist yet, these paths are PROSPECTIVE — bootstrap creates them.

```yaml
doc_surfaces:
  product_readme: "{{PRODUCT_README_PATH | default:README.md}}"
  user_manual: "{{USER_MANUAL_PATH | default:docs/USAGE.md}}"
  technical_doc: "{{TECHNICAL_DOC_PATH | default:docs/technical.md}}"
  functional_doc: "{{FUNCTIONAL_DOC_PATH | default:docs/functional.md}}"
  decisions_index: "{{DECISIONS_INDEX_PATH | default:AI.Team/decisions/README.md}}"
  team_process_index: "{{TEAM_PROCESS_INDEX_PATH | default:AI.Team/docs/process-index.md}}"
```

## Workflow Status

Recorded at bootstrap from `docs/workflow-catalog.md`. **This section
GOVERNS:** a workflow marked deferred/disabled here suspends every
charter/pm.md rule that depends on it (e.g. the hardening counter runs only
while WF-18 is enabled). On conflict between this section and a standing rule
elsewhere, this section wins — flip the status here (owner-acked) rather than
ignoring the rule. Only cite ADR numbers that exist in `decisions/`.

```yaml
workflow_status:
  # one line per WF-NN: enabled | deferred | profile-bound | disabled (+ short reason)
  WF-00: "enabled"
  # ... fill for every WF in docs/workflow-catalog.md ...
  WF-18: "{{WF18_STATUS | default:enabled}}"
  WF-31: "{{WF31_STATUS | default:profile-bound — needs workflow runtime}}"
```

## Lazy Resolution State

```yaml
lazy_state:
  stack_profile: "unresolved"
  code_conventions: "ask_on_first_stack_touch"
  methodology_packs: "ask_on_first_use"
  external_docs_policy: "ask_before_web_search"
```
