# Router/Worker implementation self-review and handoff

Review date: 2026-11-09. English translation: 2026-11-10.
Author self-review, not independent third-party review. Counts and publication
status below describe the dated checkpoints; later fixes have separate records.

## Conclusion

This iteration added stable-ticket persistence binding, retained checkpoints,
anchored read-only inspection and local-command evidence consistency bound to a
candidate. Integration tests persist intent/start before fixture edits/checks,
then close and reopen to verify history.

**The full Router/Worker feature is unfinished and cannot roll out.** Offline
development/review is supported; real deployment publication, independent model
sessions, actual continuation and usage settlement are not delivered.
`launchable: false` is an interface contract, not an execution sandbox in the old
engine. Do not feed preview engine-plan fields into a live run.

This review reproduced no urgent P0/P1 defect, which is not a guarantee that the
whole implementation has none. One P2 defect was reproduced and fixed. P1 runtime
capability gaps are listed separately; unfinished work is not described as a
failure of the existing specialist mode.

## Scope and identifiable snapshot

- Worktree: the branch's separate `AI.Team-router-worker` checkout.
- Branch: `codex/router-worker-mode`.
- HEAD at initial review, before packaging:
  `8331e0921b8d8546c1ca3691a3dfa5e709b75971`.
- Initial review used then-uncommitted files. Implementation was subsequently
  committed in slices; see the final section and [PR handoff](pr-handoff.md).
  It had not been pushed at that Nov 9 checkpoint; it was pushed afterward.
- Node `v25.6.1`; read-only local Claude CLI probe reported `2.1.319`. No model call.
- Focus: candidate/report/command-record interfaces, retry state machine and
  SQLite/registry boundaries, lost-response/rollback negatives, read-only CLI and
  legacy isolation, plus the complete regression suite. Not a line-by-line
  independent audit of the entire repository.
- The implementation snapshot covered 30 files: `src/router-worker/**`,
  `config/router-worker/**`, `tests/fixtures/router-worker/**`, Router/Worker tests,
  five CLIs including `team-mode.mjs`, and ADR 0008. Sorted `{path,sha256}` entries
  encoded with `JSON.stringify`, then SHA-256:
  `sha256:4ab2e3b80d90128d7c6540bf69a9f7e1dea31b90f870017d407067485a08f012`.
  Documentation was excluded to avoid self-reference. This identifies that dated
  snapshot, not later fixes; it is neither signature nor approval.

## Reproduced and fixed defect

### SR-01 — unsupported Node version leaves registration claims before failing

- Category: correctness / recovery usability.
- Priority: P2, moderate. Status: fixed with regression.
- Location: create/open entries in [retry-registry.mjs](../../../src/router-worker/retry-registry.mjs).
- Before fix: an isolated process simulating Node 22 created a registry, then
  attempted ticket registration. SQLite returned `CAPABILITY_MISSING`, but
  `registry.json`, the ticket claim and ticket directory already existed. Normal
  registration could not automatically complete afterward; leftovers required review.
- Impact: an unsupported runtime contaminated a one-time initialization path.
  No data disclosure, unauthorized execution or paid call was demonstrated, so
  this was not rated a security emergency.
- Fix: check Node 24+ at registry creation/open before claiming any paths.
- Verification: `unsupported runtime capability fails before claiming a registry
  or ticket path` asserts the specific error and empty temporary directory. It
  passed. This exercises the version gate, not a complete Node 22 runtime test.

## Verified additions

| Capability | Evidence | Not established |
|---|---|---|
| Stable ticket binding | Reopen same repo/ticket store; surviving root claim blocks reinitialization after ticket-directory deletion; replacement rejected | Protection against deleting all trusted state or replacing the external anchor |
| Partial rollback detection | Restore an old valid SQLite file in place; newer retained checkpoint causes refusal | Complete anti-rollback, power-loss or network-filesystem safety |
| Lost acknowledgement | DB ahead of checkpoint blocks fresh events; identical replay adds no count and may seal checkpoint | Proof that a lost model stopped or permission to redispatch |
| Concurrency consistency | Two real processes race one version; one append succeeds, one refuses | Product-checkout ownership |
| Read-only inspection | Anchor/claim/binding/checkpoint/journal validated; no missing-file creation or partial success output | Raw-store inspection does not validate registry; inspection is not resume authority |
| Actual command evidence | Frozen checker reads disposable JSON; bad candidate exits 1, clean control 0; recipe/candidate/assignment match | Real Claude independence; sessions/admission remain fixtures |
| Evidence rejection | Fabricated PASS, wrong run/recipe/ticket, missing record and post-check drift refused | Authentic host origin for internally consistent serialized records |

No automatic cleanup, reset, event deletion or stop-clear API exists. SQLite and
checkpoint publication are two steps, not cross-file atomicity. Coverage includes
database-only rollback with retained checkpoints, not rollback of both together.

## Remaining gates before actual use

Priorities refer to future activation, not an incident caused by inactive tools.
P1 must be completed or supported scope explicitly narrowed before use. P2 requires
an explicit policy and retained limitations before a supervised pilot.

| ID / priority | Category | Current fact | Solution and acceptance |
|---|---|---|---|
| G-01 / P1 | Deployment completeness | Inert drafts only; project profiles, Markdown adapters, read closure and governance staffing unfinished. Current retry/coverage/draft sources use charter.template.md; deployed authority must resolve instantiated charter.md | Fix first stack/host, generate isolated staging, pass deployment-mode validator, cover each enabled trigger/duty/evidence and leave original instance unchanged; bind actual instantiated authority, not seed defaults |
| G-02 / P1 | Isolation / authorization | Wrapper names and references do not prove independent sessions/tools; no product ownership or complete ignored/external boundary | Verified host permissions/ownership, disposable canary negatives, zero calls without ownership or when existing execution is unexplained; no Bash-prompt sandbox claim |
| G-03 / P1 | Recovery / correctness | Journal accounts for retries, compiler only first attempt; no real resume-target binding | Compile same-ticket/duty continuation, resume proven original session only; stop for missing session/stale candidate/unknown work; model/skill changes do not reset |
| G-04 / P1 | Budget / lifecycle | No idempotent real harness-delta settlement to tickets; admission is declared | Reuse measurement/reconciliation/lifecycle, deduplicate real call/usage offsets, retain unknown usage; test duplicate close, restart, overrun and late usage after stop |
| G-05 / P1 | Governance integration | Count/Q5/Guardian are required declarations without a real mode execution bridge | Freeze full original run args; inject pre-verifier Q5 stop, missing Guardian, duplicate delivery and stop races; reconcile all calls to lifecycle/count |
| G-06 / P2 | Storage threat model / operations | No deployment policy for external anchor custody or whole-state backup/rollback | Owner chooses trusted-operator boundary or stronger external monotonic records; prohibit automatic continuation after whole-state rollback; do not invent a remote service/permission to hide the gap |
| E-01 / P1 | Evidence / release | No real-model T2–T4 or quality/latency/cost advantage evidence | Complete code first, then separately approve target/samples/calls/budget/stops; minimal smoke first, stop on KO instead of consuming a full batch |

G-01–G-05 require substantive development, **not merely more funds or an approval
click**. Live smoke is a later evidence gate, not a substitute for missing code.
The instantiated-charter detail in G-01 was made explicit during the Nov 10 review
follow-up without changing the gate.

## Legacy impact

At initial review `git diff --exit-code HEAD -- ...` returned 0 for count engine,
all `src/loop/`, bootstrap, original preflight, role renderer and skill packs.
No default specialist entry or active wrapper was changed.

New modules reuse snapshot, gate-record and local-runner utilities from Loop;
they neither modify nor activate the supervisor/live provider. No engine integration
does not prohibit utility reuse, but utility reuse is not a runtime host.

Unchanged source plus passing regressions supports compatibility, not a claim that
all deployments were tested. Kit mode skips deployment checks explicitly.

## Initial regression record

- Registry suite: 14/14 passed.
- Offline-flow suite: 3/3 passed, also covered by the full suite.
- Full suite: 740 total, 738 passed, 0 failed, two skipped, about 51.3 seconds.
  Process-query access enabled existing watchdog tests; no concurrent second suite.
- Both skips were Node < 24 negative capability cases in Node 25, not unresolved
  failures. Registry version gating also had an isolated-child regression.
- Kit validator: KIT-VALID, with pre-instantiation/deployment skips.
- Fixture baseline commits happened only in disposable test repos. No live model,
  product deployment or branch commit/push happened during that initial test step.

## Next development entry

1. Confirm first host/scope: suggested local Claude Code + Node 24+, attended,
   serial, disposable isolated Git copy and non-sensitive Node fixture. This is
   not spending/publication approval.
2. Complete G-01 staging/source adapters without activate. One concrete fixture and
   its complete governance read set per card; expected files must not be generated
   by the implementation under test.
3. Separate G-02 ownership/permissions from G-05 engine stops. Mock missing
   prerequisites must produce zero calls; retain old engine contracts.
4. Separate G-03 continuation and G-04 settlement, each with lost/duplicate/reopen
   negatives. Untrusted/missing session or usage stays unknown.
5. Request minimum live-smoke budget only after offline development; no authorization
   means no run. Default switching, existing-project migration and concurrency pools
   are outside the first release.

Do not estimate completion percentage from test counts. Offline invariants,
deployment, recovery and settlement are distinct milestones.

## PR preparation review — 2026-11-09

The user requested a reviewable **offline-foundation PR**. This did not waive live
gates. Declared limitations were not relabelled defects to manufacture findings;
this pass reproduced no additional blocker to the advertised offline contracts.
The later externally reported editor-environment issue is a separate finding.

- Fetched `origin/main`: still `8331e09`, no baseline lag at that time.
- Installed Node 22.23.4 full suite: 740 total, 553 passed, 187 skipped, no failures,
  about 19.6 seconds. Skipped capabilities were not claimed validated on Node 22.
- Node 24.22.2: 740 total, 738 passed, two skipped, no failures, about 42.6 seconds;
  normal SQLite capability paths executed.
- Fresh disposable clone of implementation `234a7c0`, Node 24.22.2: same totals,
  about 46.0 seconds, no untracked source dependency; clone removed afterward.
- Context ratchet: PM about 18,612/25,000, original worker 9,502/10,000. This checks
  legacy read-set compatibility, not a complete new deployment prompt.
- Warning-level ShellCheck, original skill-pin verification and three-case mock
  probe passed.
- English PR guide and root README entry added without new CI privileges, bot
  writes or active wrappers.
- Six implementation commits cover design/governance, compiler/methods, preflight,
  drafts/candidate, retry state, persistence/local records; final docs separate.
  PM committed only on the working branch. No PR/push occurred during this step.
- Remote matrix/secret scan had not run at this checkpoint. Later PR #5 checks
  were independently read on Nov 10; see the follow-up review response rather
  than treating this historical statement as current CI status.
