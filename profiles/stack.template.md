# Stack Profile Template

Create `profiles/stack.md` from this file. This is the only place for
stack-specific commands, conventions, file paths, and libraries.

Do not add pointers to `profiles/stack-profiles/<name>.md` example adapters
unless that file actually exists — dangling self-references break cold reads.

## Lazy Discovery Protocol

When `profiles/stack.md` is missing or `status: unresolved`:

1. Inspect local repo files first:
   - package manifests (`package.json`, `pyproject.toml`, `*.csproj`, `go.mod`,
     `Cargo.toml`, `pom.xml`, `build.gradle`, etc.).
   - test folders and CI config.
   - existing `README`, `CLAUDE.md`, `AGENTS.md`, style configs, linters.
2. Produce a proposed stack profile.
3. Ask the owner whether to search current stack code conventions online.
4. If approved, search official docs, framework docs, package registries, and
   primary sources. Cite sources in the generated profile.
5. Mark profile `locked` once the owner or Architect accepts it.

## Profile

Single-toolchain projects fill the flat block. Multi-toolchain projects
(monorepo: e.g. Python backend + Node frontend) fill `packages:` instead — one
entry per toolchain, each with its own commands and working directory; the flat
fields then hold only truly repo-wide commands (or are omitted).

```yaml
stack:
  status: "{{STACK_STATUS | default:unresolved}}"
  name: "{{STACK_NAME | auto_detect_then_confirm}}"
  layout: "{{LAYOUT | options:single,monorepo | auto_detect}}"
  # --- single-toolchain form ---
  runtime: "{{RUNTIME | auto_detect}}"
  framework: "{{FRAMEWORK | auto_detect}}"
  package_manager: "{{PACKAGE_MANAGER | auto_detect}}"
  build_command: "{{BUILD_COMMAND | auto_detect}}"
  test_command: "{{TEST_COMMAND | auto_detect}}"
  e2e_command: "{{E2E_COMMAND | auto_detect | optional}}"
  dev_server_command: "{{DEV_SERVER_COMMAND | auto_detect | optional}}"
  lint_command: "{{LINT_COMMAND | auto_detect | optional}}"
  typecheck_command: "{{TYPECHECK_COMMAND | auto_detect | optional}}"
  format_command: "{{FORMAT_COMMAND | auto_detect | optional}}"
  # --- monorepo form (one entry per toolchain; commands run from dir) ---
  packages:
    - name: "{{PKG_NAME | e.g. backend}}"
      dir: "{{PKG_DIR | e.g. backend/}}"
      runtime: "{{PKG_RUNTIME}}"
      build_command: "{{PKG_BUILD | optional}}"
      test_command: "{{PKG_TEST}}"
      lint_command: "{{PKG_LINT | optional}}"
      typecheck_command: "{{PKG_TYPECHECK | optional}}"
      dev_server_command: "{{PKG_DEV_SERVER | optional}}"
  ci: "{{CI_PROVIDER_AND_WORKFLOW_PATHS | optional | note:CI results are only observable post-push; see Verification Gates}}"
```

## Architecture Adapter

Translate universal principles into stack-specific rules.

| Universal principle | Stack adapter |
|---|---|
| Framework entry points stay thin | `{{ENTRYPOINT_THIN_RULE}}` |
| Application/domain logic is testable outside framework glue | `{{APPLICATION_LAYER_RULE}}` |
| Production and test composition roots stay equivalent | `{{TEST_HOST_PARITY_RULE}}` |
| User-visible copy follows locale policy | `{{I18N_RULE}}` |
| Schema changes use the project migration tool | `{{MIGRATION_RULE}}` |
| UI changes require rendered verification | `{{UI_VERIFICATION_RULE}}` |
| External APIs require primary-source docs | `{{EXTERNAL_LIBRARY_RULE}}` |

## Brief Adapter Blocks (single source for templates.md placeholders)

`agents/templates.md` briefs reference `{{STACK_BACKEND_RULES}}`,
`{{STACK_FRONTEND_RULES}}`, and `{{STACK_DATA_RULES}}`. Those blocks are
DEFINED HERE, once, at stack lock — 3-6 terse bullets each, derived from the
Architecture Adapter table. The PM copies them verbatim into briefs; never
re-derive them per dispatch.

```md
### STACK_BACKEND_RULES
- {{BACKEND_RULE_1 | e.g. route handlers orchestrate only; logic in services}}
- {{BACKEND_RULE_2 | e.g. test app builds via the same factory as production}}
- {{BACKEND_RULE_3 | test/lint/typecheck commands for the backend package}}

### STACK_FRONTEND_RULES
- {{FRONTEND_RULE_1 | e.g. component/state conventions}}
- {{FRONTEND_RULE_2 | e.g. locale policy or "single locale — n/a"}}
- {{FRONTEND_RULE_3 | build/lint/rendered-verify commands for the frontend package}}

### STACK_DATA_RULES
- {{DATA_RULE_1 | e.g. migration tool + autogenerate/review policy}}
- {{DATA_RULE_2 | e.g. no schema create in prod paths}}
- {{DATA_RULE_3 | verification commands for schema changes}}
```

## Verification Gates

```yaml
verification:
  code_shipping:
    required:
      - "{{BUILD_COMMAND | or per-package commands}}"
      - "{{TEST_COMMAND | or per-package commands}}"
    conditional:
      ui_change: "{{UI_VERIFY_COMMAND | optional}}"
      schema_change: "{{MIGRATION_VERIFY_COMMAND | optional}}"
      security_change: "{{SECURITY_REVIEW_CHECKLIST | optional}}"
  docs_only:
    required:
      - "link/check referenced files"
```

**Partially-applicable gates rule:** run the gates whose surfaces EXIST for
the ticket; gates whose surface does not exist yet (e.g. frontend gates on a
backend-only ticket, or any gate on the bootstrap ticket that creates the
surface) are marked `N/A — <reason>` in the verification report. An N/A needs
a reason, never silence. Monorepos gate per package: a ticket touching only
one package runs that package's gates plus any repo-wide gates.

**CI note:** CI results are observable only post-push, and pushing needs owner
approval (git policy). Workers verify LOCALLY with the commands above; when a
ticket adds/changes CI config, the worker validates the workflow file
statically, notes `CI first-run pending owner push` in Handoffs, and the PM
surfaces it — CI green is owner-observed, never worker-claimed.

## Convention Resolution

```yaml
code_conventions:
  status: "unresolved"
  local_sources:
    - ".editorconfig"
    - "lint config"
    - "format config"
    - "existing code style"
  web_resolution:
    ask_before_search: true
    preferred_sources:
      - "official framework docs"
      - "official package registry"
      - "maintainer repository"
      - "language style guide"
```
