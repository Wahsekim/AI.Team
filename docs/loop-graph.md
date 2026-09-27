# Goal/Graph supervisor — implementation checkpoint

Status: **simulation-only supervisor with a separate real local-gate primitive**,
not the complete Loop/Graph MVP.
Baseline: `e12a27b4d7008a0a6d89ef15886a56fbf91dae77`. Implementation: 2026-09-16.
Checkpoint updated 2026-09-17: 287 tests pass on local macOS/Node 24, including
all 260 legacy tests. This is local verification, not a completed remote CI run.
The existing Claude team, bootstrap, watchdog, and count-directed engine remain
unchanged. No new live provider adapter is enabled.

## Run locally

Use Node 24 or later for SQLite. Existing functionality remains on the project's
Node 22/24 matrix; pure new-core tests run on both, SQLite tests skip on 22.

```bash
node scripts/team-run.mjs demo .team-loop demo-1
node scripts/team-run.mjs status .team-loop demo-1
node scripts/team-run.mjs events .team-loop demo-1
node scripts/team-run.mjs audit .team-loop demo-1
node scripts/team-run.mjs show .team-loop demo-1      # readable text summary (not JSON)
node --test tests/loop-core.test.mjs
node --test tests/*.test.mjs
```

Use a new run ID for each demo. Reusing one is a conflict, not a reset.
stdout contains one JSON reply; diagnostics/runtime warnings may use stderr.
Exit 0 means the control command succeeded; inspect `value.state.status` for
the demo outcome. Exit 2 is input/runtime failure, 3 stale state, 7 missing
capability. Events are paginated at 100 by the CLI; the library supports explicit
cursor and limit. CLI stop requests closeout but does not itself run a worker or
complete closeout. CLI intentionally has no external receipt injection command.

The example is hard-coded fake agent/gate execution. Its CLI writes a real,
clearly labelled simulation Markdown result as `<run-id>.projection-1.md` in
the state directory before acknowledging closeout. Pure reducer tests can
still use a simulated projection acknowledgement.
It does not test a real product, execute a verification command, or update
`pm-decisions.md`, `agents/lifecycle.md`, or `memory/pm.md`. It is suitable for
developing and testing orchestration logic only.

## Implemented surfaces

| Module | Current responsibility |
| --- | --- |
| `contracts.mjs` | bounded strict JSON parser including duplicate keys; canonical digests; closed RunSpec schema; DAG, criteria, gates and limits checks; safe relative path syntax |
| `artifacts.mjs` | digest-bound artifact bundle, minimal mock-role manifest, role/scope/gate references |
| `scheduler.mjs` | dependency/priority ordering; separate budget dimensions; quota freshness and unknown-usage admission |
| `reducer.mjs` | deterministic host transitions; bounded attempts; task gates and final-candidate gates; stop, unknown effect, closeout states |
| `store.mjs` | SQLite transactions for state/event/request/outbox; compare-and-swap versions; idempotency; replay audit |
| `demo.mjs` | fake fail → repair → pass → final verification; optional host projection callback |
| `scripts/team-run.mjs` | demo/status/events/audit/stop JSON entry point; `show` text projection |
| `display.mjs` | presentation-only task metadata: `validateTaskDisplay`, the shared `formatTaskLabel` (mirrored in the legacy engine), `renderRunSummary` |
| `snapshots.mjs` | real Git tracked/nonignored untracked inventory, deleted files, asset/mode hashes, conservative symlink rejection and path-based scope check |
| `gates.mjs` | host-bound POSIX local command execution, shell:false, explicit env, timeout/cancellation/output cap, before/after candidate and oracle checks |
| `evidence.mjs` | versioned SQLite archive for complete host-local gate records; candidate/invocation/oracle/transcript binding, immutable per-dispatch receipts and read-time integrity checks |
| `host-gates.mjs` | explicit host-only bridge: durable intent, one gate execution, archive-before-settle, candidate/oracle recheck and digest-bound reducer receipts |
| `host-fixtures.mjs` | fixture-only build dispatch bridge: pending claim, owned cancellation, unchanged candidate checks and explicit durable-result reconciliation |
| `fixture-driver.mjs` | bounded single-host step/stop/close orchestration for fixture builds, real local gates and simulation projections |
| `process-runner.mjs` | bounded POSIX process handles with inspect/cancel/completion; cancellation never uses an unowned persisted PID |
| `adapters/fixture-process.mjs` | local fake-agent process adapter with durable dispatch reservations, structured-result validation, owned cancellation and UNKNOWN on unowned unfinished work |
| `projector.mjs` | immutable simulation Markdown; atomic no-replace publication, repeated application and manual-edit conflict detection |

RunSpec follows the design's fields. `approvedSpecDigest` is the canonical digest
of the spec **without** that field. Artifact references hash the whole referenced
JSON value, including a JSON string for a brief. These hashes detect mismatches;
they do not authenticate a human approval. The local caller remains trusted.
`openStore().create()` requires `{simulation:true}` and refuses other execution.
An immutable artifact bundle is stored with the spec. The temporary mock manifest
is not yet the proposed production permission manifest shared with bootstrap.

## Durable local gate records (2026-09-26)

`runLocalGate(config)` now returns a complete record: `evidence`, `transcript`,
`scopeAttestation`, `snapshot`, `gate`, `invocation`, and `oracle`. The evidence
schema is version 2 (independent of the RunSpec version). Invocation binds argv,
logical cwd, executable/oracle references, output cap and the digest of the
explicit environment frozen before execution. Environment values are not copied
into the record; command output can still contain sensitive data.

Trusted host callers may persist a result using
`const archive = await openEvidenceArchive(path)` from `src/loop/evidence.mjs`,
then `const reference = archive.put(record)`. Always close the archive in a
`finally` block. `archive.get(runId, dispatchId, reference)` verifies the stored
record and optional expected reference before returning it. Identical puts are
idempotent; a different record for the same run/dispatch is rejected. Use a new
dispatch ID for a new execution attempt. The archive requires Node 24+ and a
local filesystem; it is separate from the simulation control database.

The optional `host-gates.mjs` library bridge can now consume a real gate record
inside a **simulation run with mock build agents**; the demo CLI remains fake.
`executeStoredGate({store, archive, runId, dispatchId, config})` resolves the
approved gate from the immutable run bundle, reserves a durable intent, claims
the scheduler effect and starts the local gate only after the journal says
STARTED. It atomically archives the record and marks it RECORDED before
`settleRecordedGate` checks the current candidate and all oracle files (including
ignored oracles), then submits a replayable `settle-evidence` event. Local gate
receipts account for zero model tokens/cost; they are not provider usage.

After a crash, PENDING journal entries have not launched through this bridge;
STARTED/UNKNOWN must never auto-run again. RECORDED can be ingested without
rerunning the command. Changed candidates/oracles or uncertain cleanup route to
RECOVERY_REQUIRED, not automatic repair on a possibly modified tree. Deadline
and quota admission are rechecked even in the claim-before-journal-start gap.
The two databases do not form one transaction: the ordering deliberately permits
an archived-but-unsettled receipt and blocks unknown execution instead of
claiming exactly-once effects. The intended deployment is one trusted host; no
cross-process scheduler fencing or live process-handle recovery is supplied.

There is still no live provider. A crash before archival can lose a result;
do not automatically rerun an unknown effect. Hard stop during a running gate
still needs its host caller to abort the supplied signal; the bridge does not
poll the control database or start a watcher. Snapshots retain file inventories/digests, not frozen source
bytes. Hashes detect mismatches, not fabricated records from a malicious writer;
the archive API is host-only, not an endpoint for agent-produced JSON. Same-UID
writers remain trusted, and there is no new OS sandbox or retention automation.
The existing simulation CLI and old ledgers are unchanged.

## Fixture process adapter (not a live provider)

`openFixtureAdapter({filename, runId, workspace})` exposes `probeCapabilities`,
`start(dispatchId, request)`, `inspect(handle)`, `cancel(handle)`,
`collectResult(handle)` and asynchronous `close()`. Requests have exactly
`{scenario, delayMs, timeoutMs}`. Supported scenarios are `pass`, `fail`,
`partial`, `crash`, `hang`; delay is 0..1000 ms and timeout is 1..4000 ms.
Only the built-in `fixture-worker.mjs` runs, with empty environment and capped
output. It invokes no model, performs no product edits, and reports simulation
usage only. Its own five-second guard bounds orphan lifetime in tests.

The SQLite journal reserves a dispatch before spawn, then records PID and the
completed result. Repeating the same dispatch/request returns the same handle;
a changed request conflicts. A different adapter instance can collect a durable
completed result but treats unfinished work as UNKNOWN, even if no PID was
saved. It never respawns that dispatch or signals a PID it does not own. Closing
an adapter cancels and collects its owned processes before closing its database.
This conservative behavior is not automatic crash recovery or proof of provider
cancellation. Tests now kill an actual fixture host with SIGKILL at four precise
boundaries: reservation committed, spawned before PID save, result ready before
save, and result stored before acknowledgement. The first three reopen UNKNOWN;
the last collects the saved result. None respawns the dispatch or signals an
unowned PID. The fixture-only synchronous `onBoundary` hook is used to hold the
host at those boundaries; ordinary callers need not provide it. Leases/fencing
and authenticated recovery are still required. The library bridge below now connects
the fixture to simulation build dispatches; the CLI is still the fake demo, and
the run manifest still permits only `mock` roles.

### Fixture-to-control bridge (2026-09-27)

`executeStoredFixture({store, adapter, runId, dispatchId, root, request, signal,
quota, now})` executes one pending simulation build. The run must use a real
initial product snapshot; the fixture does not modify it or invent a new candidate.
The adapter must belong to the same run. Request validation, existing-journal
checks and snapshot matching precede claim; claim rechecks admission. Result
collection precedes control settlement. Invalid/partial/crashed fixture output
cannot pass. A successful build still needs its task and final-candidate gates.

`settleRecordedFixture({store, adapter, runId, dispatchId, root, now})` explicitly
reconciles a durable completed result without spawning. STARTED work is never
automatically executed again, including a claim-before-journal gap. Missing or
unfinished results require operator investigation; a saved PID is not cancellation
authority. Candidate drift or uncertain cleanup enters RECOVERY_REQUIRED. This
function does not clear an existing recovery stop or implement automatic resume.

To cancel current work, the trusted host must first persist `stop` and then abort
the signal it supplied. The bridge collects the owned cancellation result without
reviving acceptance. A control-database stop alone is not a process signal; no
watcher or CLI cancellation integration is added here. The optional driver below
owns stop/abort ordering for calls made through that driver.
`adapter.lookup(dispatchId)` is read-only and does not create a reservation.

Integration tests exercise an actual fixture subprocess, real disposable local
gates, journaled receipts and immutable simulation projection end to end. This is
offline orchestration evidence, not a successful real-agent product deployment.

### Single-host fixture driver

`createFixtureDriver({store, adapter, archive, runId, root,
projectionDirectory, gateConfigs, request?, quota?, now?})` connects the three
effect types without a daemon. `gateConfigs` maps each manifest gate ID to its
explicit trusted local-gate configuration. It is cloned, as is the fixture
request; no provider command is inferred from a brief. The existing projection
directory must be outside the product root. Storage lifetimes remain caller-owned.

- `await driver.step()` admits/executes at most one effect and returns current
  status. Concurrent steps are rejected. Terminal observations are read-only.
- `driver.stop({mode, reason})` commits stop before aborting the active owned
  signal for hard mode. Graceful mode allows the bounded current process to
  finish, but late success cannot revive acceptance. Call another step to
  publish closeout when the run does not require recovery.
- `await driver.close()` hard-stops and drains an active step, rejects future
  steps, and releases its in-memory ownership guard. Only then close the
  adapter, archive and control store; close propagates an active step's error.
- Previously STARTED/UNKNOWN dispatches enter RECOVERY_REQUIRED and are not
  automatically replayed. An already-written projection may be safely replayed
  after a lost ACK; manual file edits are preserved and require recovery.

There is no unbounded `run()` loop: the host decides its step count and stop
policy. Quota samples are supplied by the host callback at admission, not read
from model text. The ownership guard covers one store object/run in this process
only; separate store objects/processes require external exclusion. A stop written
by another CLI is not actively polled and cannot promise prompt cancellation.
No real provider, cross-process lease/fencing or automatic recovery is enabled.
The CLI `demo` remains unchanged; this driver is currently a library surface.

## Task display contract (schemaVersion 2)

Review 2026-09-25 (F-06): operators could not tell what a task was about
without opening its brief. `schemaVersion: 2` adds exactly one required
TaskSpec field, `display: { ticket, title, workKind, layers }`, validated by
`validateTaskDisplay` (bounded lengths, closed `workKind` enum, at most 8
identifier-shaped layers, no control characters). Rules:

- IDs remain identity; `title` is presentation. Nothing routes, grants
  permissions, or infers dependencies from display text.
- Display never affects scheduling, authority, or acceptance: the reducer and
  scheduler do not read it (`tests/loop-display.test.mjs` proves two specs that
  differ only in display produce identical state and effects).
- Display is bound to the immutable, digested plan; later tracker edits cannot
  relabel historical work.
- `schemaVersion: 1` is unchanged and closed (a v1 task carrying `display` is
  rejected); persisted v1 runs replay unchanged. `demo` now writes v2 specs.
- Missing metadata renders as the explicit fallback `(no title)`; nothing is
  guessed from a role or brief.
- Simulation is labelled in both outputs: `simulation: true` in every JSON
  reply, and `SIMULATION — not evidence of a real product build` as the first
  line of `show`.

`show` prints, per task, `ticket  title  STATUS`, then
`workKind · layers  role <id>  attempts n/max`, then the gate line. The label
formatter (`ticket · title · phase`, title-only truncation, escapes and
control characters stripped) is the same one the legacy engine uses for
worker/verifier/guardian dispatch labels.

## State and durability rules

The serial scheduler admits at most one unacknowledged dispatch. A build intent
increments attempts and model-call admission count before a fake execution can
be claimed. Verification failure consumes an attempt through the subsequent
repair; the final aggregate gate checks the latest candidate again.

Successful path: `READY → RUNNING → FINALIZING → COMPLETED`.
Stop/limit: `QUIESCING → FINALIZING → STOPPED` (or `FAILED` on exhausted attempts
or failed final verification). A stop prevents any further dispatch claim.
Dispatch claim rechecks deadline and budget admission. When quota enforcement
is configured, pass a fresh `quota` sample to both tick and claim; a missing or
stale sample prevents dispatch. Projection closeout remains allowed after the
deadline. Interrupted STARTED effects become UNKNOWN in `RECOVERY_REQUIRED`; they are
never automatically replayed. The internal `abandon` operation requires explicit
operator process-exit confirmation, preserves attempts, sets unknown usage to
null, and closes the run rather than resuming it. It is not a verified process
inspection implementation. Start a new run for new work.

Host-only `claim`, `settle`, and `projected` actions are library calls, not
authenticated public APIs. Never forward model-produced JSON into them. There
is no OS security boundary against another same-UID process. Unsupported
isolation, live roles, human-only gates and non-goal mode fail closed.

Transactions use `BEGIN IMMEDIATE`, foreign keys, FULL synchronization and a
bounded busy timeout. A version race fails before changes; a repeated identical
command returns its recorded reply, while reusing the key for another command
fails. This includes request ID and expected version: retry the original
envelope, not a newly generated request. SQLite state is the authority, not
Markdown. Local POSIX filesystems only; network filesystems are unvalidated.
No external-effect exactly-once guarantee, lease/fencing protocol, process
cancellation, real approval authentication or scheduler daemon is claimed.

## Design disposition and next development slices

| Design work package | Disposition / remaining work |
| --- | --- |
| W1 contracts | PARTIALLY_ACCEPTED / implemented RunSpec + mock bundle; production manifest, GateSpec/Evidence/Decision schemas and authenticated binding remain |
| W2 reducer/scheduler | PARTIALLY_ACCEPTED / serial dependency execution and final candidate gates; reviewer dispositions, WAITING decisions and independent-branch continuation remain |
| W3 store/outbox | PARTIALLY_ACCEPTED / transactional intent/CAS/idempotency/replay; real process handles, leases/epochs, process-exit reconciliation and crash-boundary harness remain |
| W4 snapshot/gate | PARTIALLY_ACCEPTED / real inventory, bounded runner, durable records and host-only gate ingestion into simulation runs implemented; frozen source inputs, production authorization and isolated-mode integration remain |
| W5 Claude adapter | PARTIALLY_ACCEPTED / fake-process adapter, simulation build bridge, single-host driver and four actual killed-host boundary tests implemented; CLI integration, safe automatic recovery and real Claude adapter remain; real smoke needs an explicit owner cost cap and permission policy |
| W6 projection bridge | PARTIALLY_ACCEPTED / immutable standalone simulation Markdown with conflict detection and lost-ACK reapplication; legacy writer coordination and production projection remain |
| W7 decisions/stop/watch/recovery | PARTIALLY_ACCEPTED / core stop and unknown-effect states; authenticated decisions, cancellation, watcher supervision and automatic safe recovery remain |
| W8 pilot | DEFERRED / requires real smoke, failure/recovery exercise and owner review |

`maxGateRunsPerCandidate` is enforced per task/gate/candidate digest across
rebuild attempts; an unchanged rebuild does not reset it. Exhaustion fails the
run. There is no independent infrastructure-only retry loop yet. All dispatches
are serial. No claims of parallel readonly reviewers yet.

Important acceptance boundaries: current tests exercise portions of AC01/02,
03/04, 05/06/07 (assets, path scopes and symlink rejection), 09/10/11 (local gates), 12 (mock final gate),
15/16/17/18 (stored intent), 19 (explicit interruption), 23/25 and 31. They do
not establish hostile-process isolation, durable evidence provenance, supervisor-integrated cancellation,
legacy projection crash safety, watcher recovery or any real-Claude outcome. Do not
declare the design's full acceptance suite or autonomous readiness achieved.

Next sequence: (1) independent review of the evidence bridge and process fixture;
(2) killed-host crash-boundary tests and worker-dispatch integration;
(3) stop-to-process cancellation and supervised recovery;
(4) production/legacy projection coordination; (5) owner-approved live runtime integration.
Keep the new path opt-in until these gates pass. Do not couple it into the old
count engine or treat old ledgers as new evidence.

## Local gate primitive: authority and limits

`snapshotRepository({root, repoId})` requires a real Git root with a HEAD commit.
It hashes tracked plus nonignored untracked files, without extension exemptions;
tracked deletions are tombstones and executable bits are part of the digest.
Gitignored untracked dependencies/build outputs are outside that inventory, so
this is not yet a complete dependency-environment attestation. Submodules,
unmerged indexes and any symlink component fail closed. Limits default to
32 MiB/file and 128 MiB total; larger repositories need an explicit policy.
`assertWriteScope(before, after, allowedPaths)` checks observed diffs, not an
agent's claimed file list. It detects scope violations after changes; it does
not undo them or prevent writes.

`runLocalGate(options)` is a host library API, deliberately not a worker-facing
CLI. The trusted caller supplies a validated GateSpec plus:

- `repoRoots`: approved `team`/`product` absolute roots;
- `executables`: approved executable ID to absolute path (bytes must match the
  executable ref digest; no shell command parsing);
- `envProfiles`: named explicit string maps; parent environment is not inherited;
- `oracleBundles`: named arrays of `{path, digest}`; bundle uses canonical JSON
  digest, each file uses its byte digest;
- `expectedCandidate`: canonical digest of the whole returned snapshot object;
- `runId`, `taskId`, `dispatchId`, optional AbortSignal and bounded output limit.

Gate `specDigest` excludes its own field. Gate cwd is a nonempty relative path
inside the selected root, with no symlinks. Only the explicit policy
`local-attended-inherit` is supported: network access is inherited, **not denied**.
Requests for network isolation fail instead of pretending it exists.

Evidence is returned with a host producer label, transcript and scope
attestation; the optional archive persists and checks it, but does not
authenticate a producer across trust boundaries. Pass
requires an allowed real exit code and unchanged before/after candidate and
oracle digests. A changed oracle, signal, output flood or cancellation cannot
pass; timeout is classified separately. Output is bounded (default 1 MiB) but
not redacted; callers must apply retention and secret handling before storing it.

POSIX process groups are used for timeout/cancellation. This is cooperative
attended execution, not containment of a malicious executable that escapes its
process group, tampers and restores files between snapshots, or writes outside
the observed repo. The optional host-gates bridge ingests archived evidence;
the demo CLI continues to use only mock gates. Tests execute real local Node child
processes exclusively in disposable fixture repositories; no Claude/API spend.

The host wait has a final drain deadline 1 second beyond the gate timeout. If
process pipes still cannot close, evidence is `error` with `cleanup_unknown` and
`recoveryRequired: true`. Escaped descendants may still be alive; the host must
reconcile them before resuming mutation. A timeout is not proof of process exit.

## Projection checkpoint

The CLI projects only into its selected state directory, never legacy ledgers.
`publishProjection` deterministically renders the stored outbox payload, writes
a temporary file, fsyncs it, and atomically links it to a previously absent
target. A repeated identical projection verifies the existing bytes; different
content or a symlink yields `PROJECTION_CONFLICT`, with no overwrite. The
directory is fsynced before acknowledging success. Same local POSIX filesystem
is required; no NFS or Windows guarantee is made. Orphan temporary files after
process death need later retention cleanup.

The demo driver can reapply a STARTED projection after file creation but before
SQLite acknowledgement. Projection failure moves the run to RECOVERY_REQUIRED.
This does not replay STARTED model effects. There is no CLI resume/recovery
command yet; the recovery boundary is currently tested through the host library.
Do not upgrade reducer/projector code for an active database: version migration
and cross-version replay compatibility are not implemented.
