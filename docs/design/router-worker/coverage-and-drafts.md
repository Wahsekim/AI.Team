# Coverage and inert deployment drafts

Status: implemented offline planning tools; no team activation. Owner accepted
ADR 0008's topology equivalence and duty retry mapping on 2026-11-09. This does
not approve a concrete deployment, real runtime, paid run or publication.

## Coverage baseline

`config/router-worker/coverage.json` maps all 32 existing workflows to
responsibilities and inventories H1–H8, M1–M6 and Q1–Q5. The loader compares the
inventory to the actual workflow, charter and meta-rule sources and binds their
digests. Added/removed source IDs require review rather than being ignored.

This is a complete **source inventory**, not a completed deployment equivalence
proof. The report requires an explicit status/reason for every workflow. Disabled
entries need a decision reference; the reference does not prove human consent.
Workflow status cannot waive standing charter or meta-rules. Enabled entries
remain `pending-deployment-and-runtime-evidence`; WF-16 parallel dispatch is explicitly
unsupported in the first serial release.

The duty vocabulary is PM, exec, check, guard, design, Coach, Auditor
and Security. UI/API/data work may share the exec instance, but domain knowledge,
real UI verification and sensitive-change checks remain required when triggered.
No automatic runtime staffing or owner-ratification inference exists.

## Draft commands

From the kit root:

```sh
node scripts/team-mode.mjs preview SPEC.json
node scripts/team-mode.mjs draft SPEC.json /absolute/new-artifact.rw-draft.json
node scripts/team-mode.mjs verify SPEC.json /absolute/new-artifact.rw-draft.json
```

The separate entry requires explicit `mode: router-worker`. The original
`scripts/bootstrap-team.sh` remains the specialist/default path unchanged.
There is no `activate` subcommand and no hot switch.

The spec contains exactly:

- `schemaVersion: 1`, `mode: router-worker`.
- `project: {name, slug, productRoot, ui}`. Product root is a normalized absolute
  path used as text only; no product files are read or written.
- `profiles: {exec, check, guard}`; each profile supplies `model`, `effort`,
  `maxTurns`, `tools`. Values are explicitly supplied, not recommended defaults.
  Only local tools are accepted. Delegation tools are excluded, check/guard
  cannot have Write/Edit, and this draft's guardian cannot have Bash. Check Bash
  still requires a future isolated runner; declaring it is not a sandbox.
- `workflowStates`: all WF-00 through WF-31, each with `status`, `reason`,
  `decisionRef`. The test fixture is an example, never an owner-approved plan.

## Mechanical reuse and output

The generator snapshots the existing bootstrap script and mandatory seeds into
a disposable scratch directory, then runs that **unmodified** script's mechanical
instantiation with a minimal fixed environment. Live compatibility/validator
scripts are deliberately absent in that scratch copy; their absence is recorded
as `gateStatus: not-run-in-draft`, never a pass. Pending interview placeholders
remain unresolved. Source digests identify the exact script and seeds used.
Sources and the coverage inventory are re-read before return; detected drift
rejects the artifact. This is a consistency check, not a source-directory lock.

The generator overlays proposed worker role files, three wrappers, a roster,
common protocol, Router supplement and non-launchable team-mode metadata onto
the resulting in-memory file map. These are intended paths inside a future fresh
base-kit copy, not files installed in the current repository. Original PM and
governance role sources remain base-kit dependencies and are hash inventoried.
The artifact is an **overlay draft**, not a standalone deployable kit.

The only persistent output is a JSON artifact with `kind: inert-overlay-draft`,
`launchable: false` and a self-excluding content digest. Wrapper Markdown appears
as JSON string data. No `.claude/agents` directory is created or modified. Model
values in the future overlay are copied into roster/wrappers; the draft does not
create a competing deployed model profile.

Wrapper paths are explicitly team-root-relative, matching the existing deployment
launch convention; the product root is separate. UI exec/check wrappers reference
the instantiated browser discipline and retain real M5 evidence requirements.
Guard explicitly references the existing Chaos source. Listing only local tools
does not yet demonstrate a configured browser runtime, so UI readiness remains
unproven until project-specific runtime validation.

Draft publication uses an exclusive same-directory hard-link from a completed
temporary payload. Existing files/symlinks are not overwritten. The output parent
must exist and be canonical; runtime registry paths are refused. The operation
is a local artifact publish, not deployment, git publication or a paid call.

## Independent checks and remaining gates

Tests compare mechanical instantiated files with a separately invoked original
bootstrap, and independently assert roster roles, model/permission framing,
no delegation, pending governance coverage, no runtime registry writes and
never-overwrite behavior. Same-generator equality is used for determinism only,
not as the sole correctness oracle.

`verify` checks the supplied spec, artifact digest, roster/wrapper identity and
model bindings, non-delegation/read-only tool denials, required UI/guardian
references, non-launchable mode, and regeneration against current source files.
Rehashing an altered artifact does not bypass these checks. Success reports
`stage: draft-consistency-checked`, never `STATIC_VALIDATED` or `BOOTSTRAPPED`.
It performs no model call, registry materialization or product write. The
regeneration step uses disposable scratch files and the same mechanical bootstrap.

Before materialization into a real team, still required:

1. Concrete deployment responsibility coverage and complete enabled governance staffing.
2. An actual stack/project interview; no unresolved operational placeholders.
3. JSON source adapters and declared read graph independently bound to the real
   generated Markdown sources, plus runtime-injected and Guardian context.
4. Original deployment/compatibility gates and additional Router/Worker runtime
   isolation, candidate, budget, retry, ledger and stop checks.
5. Owner-authorized live smoke and functional/pairing evidence.

Generating this artifact therefore does not complete RW-03 or establish
`STATIC_VALIDATED` for a deployed team.
