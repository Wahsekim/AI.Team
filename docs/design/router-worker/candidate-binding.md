# Offline candidate and report binding

Status: RW-04 preparatory library, not a dispatcher or acceptance gate. It reuses
the existing Loop snapshot reader without enabling the Loop/Graph engine or
altering the legacy count engine. No model, test command, commit or product write
is performed by this library; Git inspection commands are read-only.

## Interface

`src/router-worker/candidate.mjs` exports:

- `observeCandidate({root})`: inspect a canonical absolute Git root twice and
  return an opaque process-local observation token. Throws on an unsupported
  environment, missing root, symlink input, unresolved merge, submodule or drift.
- `candidateObservation(token)`: return detached target identity, snapshot and
  `{id, digest}` reference for preparing a compiler input. This does not approve
  that input; approval must separately bind the actual baseline reference.
- `bindCandidate({input, baseline, candidate, methodBundle})`: compile/validate
  the frozen input, compare the two local observation tokens, check actual changes
  against policy **and** mandate, reject sensitive changes, re-observe the target,
  and return `{binding, summary}` or `{errors}`. The optional method bundle is
  the same verified bundle used by the compiler.
- `assertCandidateCurrent(binding)`: re-observe before any future consumption;
  reject changed target identity or candidate. Success is consistency only.
- `bindCheckReport(binding, report)`: validate report structure, bind ticket/check
  assignment/candidate, account for every frozen verification command exactly
  once as executed or unexecuted, and recheck current candidate. Even a consistent
  PASS remains `evidenceStatus: unverified`, `deliveryAuthorized: false`.
- `checkDispatchId(assignmentId, gateId)`: derive a bounded, deterministic check
  dispatch identifier for the existing local gate record format.
- `bindCheckEvidence(binding, {report, stackRecord, runId, records})`: additionally
  validate complete gate records against the frozen stack recipe, command,
  invocation, candidate, ticket, assignment, run and reported exit code. This
  reads supplied records; it does not execute commands or authenticate their origin.

Typical sequence is observation → separately reviewed compiler input → permitted
external implementation → second observation → binding → independent check →
report binding. The library does not perform the external implementation/check
steps and does not authorize them. Do not run a preview through the live engine.

All successful summaries are `launchable: false`. Tokens cannot be reconstructed
from JSON or worker reports. They are an API provenance constraint inside a
trusted process, not a sandbox or authentication boundary against code running
in that same process. A process restart loses tokens; no recovery is claimed.

## Enforced comparisons

- The input baseline must identify the observed full commit and snapshot digest.
- Before/after must belong to the same canonical path and directory device/inode.
  HEAD must not change between them; workers cannot introduce a new commit as
  ordinary candidate progress.
- New, deleted, renamed, staged/non-staged working-tree files and executable-bit
  changes participate in the inherited snapshot inventory. Renames are checked
  as deletion plus addition, so both paths must be authorized.
- Grants retain compiler semantics: a literal file is exact; only terminal `/**`
  grants a subtree. A bare directory string is not a recursive grant.
- Actual sensitive changes are rejected even if planned paths were non-sensitive.
  Authorized but unplanned changes are disclosed in `unplannedPaths`; this is not
  permission to widen the mandate or silently alter acceptance.
- An unchanged candidate is not claimed as implementation progress. Drift before
  binding or after checking invalidates the earlier binding.
- Report command strings must match the frozen recipe; duplicate, omitted or
  substituted commands are refused. Recorded exits must be integers 0–255.
  These checks do not read transcript files or prove a command actually ran.

## Deliberate limitations

The inherited snapshot policy covers tracked and nonignored untracked working-
tree files. Ignored build output, `.git` metadata/index-only changes, external
files, network effects, runtime permissions and semantic risk completeness are
**not** proven. The summaries explicitly retain these unresolved boundaries and
cannot be used to authorize delivery. The repeated snapshots detect observed
drift but do not provide exclusive ownership or an atomic filesystem snapshot.

Ambient `GIT_*` variables are refused because the reused snapshot reader inherits
its environment. `GIT_PAGER` is the sole exception: these commands have piped
output and do not invoke a pager, covered by a negative execution test. The
library does not mutate process-global environment or silently redirect a repo.

Before RW-04 can dispatch, still needed: owner/runtime authorization, exclusive
target ownership, complete protected/ignored-file policy, independent session and
runner binding, host-produced command transcripts, functional acceptance, retry
state, measured usage, idempotent ledger settlement and original stop/guardian
gates. Report binding must not be relabelled host verification.

## Verification

`node --test tests/router-worker-candidate.test.mjs` uses disposable local Git
repositories with real file changes. Fixtures commit their initial baseline only
inside those temporary test repositories; they do not commit this worktree.
Tests cover positive binding, actual scope/security violations, baseline/HEAD/
root mismatch, renamed/untracked/staged files, metadata-copy forgery, symlinks,
stale candidates, no progress, inherited environment, and incomplete/forged PASS
claims. No Claude or other paid API is invoked.

## Host gate record consistency

For `bindCheckEvidence`, the referenced stack record is exactly
`{id, value: {verificationCommands, gateBindings}}`. Its value digest must equal
`policy.stackRef.digest`. Each gate binding is `{command, gateRef, invocationDigest}`;
every frozen command needs one unique binding. `records` is an array of
`{command, record}` entries, exactly one for each reported executed command.

The adapter reuses the existing gate-record validator to check transcript,
snapshot, oracle and invocation consistency. It refuses a passing report backed
by a failed gate, altered candidate, wrong run/assignment/recipe, missing record,
changed check scope or unresolved child-process cleanup. It re-observes the
candidate before returning. Caller-supplied `runId` and serialized records are not
an authentication source, even when all their hashes are internally consistent.
Output therefore says `consistent-records-origin-unverified`, retains
`deliveryAuthorized: false`, and does not settle a ticket.

`tests/router-worker-offline-flow.test.mjs` exercises the real local runner against
a disposable JSON configuration: a bad candidate exits 1 and a clean control exits
0. A fixed, separately frozen checker reads JSON without evaluating candidate
code. Intent/start events are persisted before fixture author/check work; their
sessions are explicitly simulated. The resulting six events survive reopen.
Negative cases reject a fabricated PASS, foreign run/recipe/ticket, missing record
and post-check drift. This proves an offline first-attempt integration with real
process evidence, not real Claude session separation, permission enforcement or
owner-perspective acceptance. The runner's `local-attended-inherit` network policy
does not provide network isolation. No model or external network call is made by
the fixture.
