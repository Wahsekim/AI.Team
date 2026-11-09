# PR handoff: Router/Worker offline foundation

Suggested title: `feat(router-worker): add non-launchable offline foundations`

Base: `main`. Head: `codex/router-worker-mode`.

Prepared locally on 2026-11-09. Upstream was fetched and remains `8331e09`.
No remote branch update or PR creation has been performed.

## Review scope

This PR is an additive **offline-foundation milestone**, not the full Router/Worker
rollout. It makes the proposed contracts executable and testable without replacing
specialist deployment or calling a model. Approval of this PR does not authorize
deployment, spending, migration, publishing or a default-mode change.

Included:

- ADR 0008 records the owner's accepted duty mapping and stable ticket/duty retry
  counting; all remaining governance and runtime gates stay in place.
- A deterministic compiler with closed schemas, authority intersection, declared
  budget checks, human-readable ticket titles, reports and non-launchable manifests.
- One loader-verified, pinned `pstack-blast-radius` check method. No new upstream
  download, execution methods, automatic selection or changes to legacy packs.
- Local source-reference/context preflight, the full workflow/rule ID inventory,
  and inert JSON drafts using the unchanged bootstrap's mechanical instantiation.
- Observed Git candidate binding and check-record consistency against frozen
  commands/invocations. Serialized report/evidence consistency is not authenticity.
- Pure retry accounting, Node 24+ SQLite persistence, stable repo/ticket registry,
  retained checkpoints and two read-only inspectors.
- First-attempt integration fixtures with real local checker exits and persisted
  simulated sessions, including failed candidate and passing control.

Excluded: install/activate, actual Claude sessions, real session continuation,
product locks or OS sandbox, runtime source adapters, complete deployed governance
staffing, real usage/lifecycle settlement, migration, concurrency and paid trials.
See [remaining rollout gates](self-review-2026-11-09.zh-CN.md) G-01–G-06/E-01.
These remain real implementation/evidence work, not merely permission to spend.

## Reviewer map

Review in this order; each layer has focused tests and a contract:

| Layer | Implementation / tests | Contract |
|---|---|---|
| Input and methods | `compile.mjs`, `methods.mjs`, `adapters/blast-radius.mjs`; compile/method tests | [Implementation status](implementation-status.md) |
| Source preflight | `preflight.mjs`; preflight tests | [Preflight](preflight-contract.md) |
| Draft topology | `coverage.mjs`, `draft.mjs`; draft tests | [Coverage/drafts](coverage-and-drafts.md) |
| Candidate and records | `candidate.mjs`; candidate/offline-flow tests | [Candidate binding](candidate-binding.md) |
| Retry transitions | `retries.mjs`; retry tests | [Retry accounting](retry-accounting.md) |
| Durable storage | `retry-store.mjs`, `retry-registry.mjs`; store/registry tests | [Persistence](retry-persistence.md), [registry](retry-registry.md) |

Implementation names above are relative to `src/router-worker/`; tests are
`tests/router-worker-*.test.mjs`. The CLI entry points live under `scripts/`.
The historical [external design review](review-2026-11-06.zh-CN.md) is preserved
as received, not rewritten into a current approval. The author's
[self-review](self-review-2026-11-09.zh-CN.md) is explicitly not independent review.

Important review boundaries:

1. `launchable: false` is a consumer contract, not enforcement in the old engine.
   The old engine may structurally accept a preview plan. No live launch adapter
   is provided; never copy previews into a real run.
2. Drafts contain proposed wrapper text as JSON strings. They never install files
   under the active `.claude/agents` registry. Governance placeholders stay pending.
3. Snapshot coverage is tracked/nonignored working-tree files, not Git metadata,
   ignored outputs or external effects. Repeated reads are not an ownership lock.
4. Anchor/checkpoint checks detect stated partial replacements/rollbacks. They
   cannot detect rollback of the whole trusted state, authenticate host events or
   prove an interrupted process stopped. There is no automatic reset/stop-clear.
5. A real local command in a fixture is not a real-model E2E, permission proof or
   evidence that Router/Worker is cheaper or more effective than specialists.

## Reproduce locally

From the repository root, with no model credentials or external service access:

```sh
node --test tests/router-worker-*.test.mjs
node --test tests/*.test.mjs
node docs/design/router-worker/probe.mjs
bash scripts/validate-team.sh .
bash scripts/measure-context.sh .
shellcheck -S warning scripts/*.sh scripts/watchdog/*.sh
```

Watchdog tests require local process visibility (`ps`); do not run two complete
suites concurrently because existing watchdog fixtures share process labels.
Tests create disposable local Git fixtures; they do not commit the product or
call a model. SQLite suites require Node 24+; on Node 22 the capability-dependent
tests skip and the explicit unsupported-capability paths are tested instead.

To inspect a synthetic compiler output without writing a file:

```sh
node --input-type=module -e 'import {inputFixture} from "./tests/fixtures/router-worker/input.mjs"; import {compile} from "./src/router-worker/compile.mjs"; console.log(JSON.stringify(compile(inputFixture()), null, 2));'
```

This is fixture data, not owner approval. Real preflight requires a separate
reviewed source/approval anchor. See the per-layer contracts for full CLI inputs;
there is intentionally no one-command live deployment example.

## Recorded local checks

| Check | Result |
|---|---|
| Full suite, macOS / Node 22.23.4 | 740 total: 553 pass, 187 skip, 0 fail; capability-dependent tests are not claimed as passing |
| Full suite, macOS / Node 24.22.2 | 740 total: 738 pass, 2 skip, 0 fail |
| Fresh local clone of `234a7c0`, Node 24.22.2 | 740 total: 738 pass, 2 skip, 0 fail; no untracked source dependencies |
| Full suite, macOS / Node 25.6.1 | Earlier same-source run: 740 total, 738 pass, 2 skip, 0 fail |
| Kit validator | KIT-VALID; not deployment validation |
| Existing context ratchet | PM 18,612/25,000; worker 9,502/10,000 |
| ShellCheck | Warning-level check passed |
| Legacy skill pins and mock engine probe | Passed; no upstream pack or original engine changes |

No paid/live model test was run. No new source or test changed between the Node
22/24 checks and the implementation commits; subsequent changes are documentation.

Implementation review slices:

1. `d8e39ff` — topology design, original review, skill assessment and ADR.
2. `0579405` — compiler and pinned check method.
3. `9783cda` — offline source/context preflight.
4. `0105c6a` — inert drafts and candidate/check-record binding.
5. `20d3712` — pure retry/session-accounting transitions.
6. `234a7c0` — persistence, anchored registry and real local checker fixtures.

The following documentation commit adds this handoff, README discovery and the
consolidated implementation/self-review records. Every slice is authored by the
main PM session on the working branch; no bot/worker commit policy was added.

## PR acceptance vs rollout acceptance

This offline PR is ready for review when:

- The intended files are committed in reviewable slices on the working branch.
- Node 22/24 local tests, kit checks and context ratchets pass within their stated
  capability boundaries, and no original runtime/default path was changed.
- No known unaddressed defect blocks the advertised offline contracts.
- Documentation exposes remaining runtime gaps rather than reporting them passed.

Before merge, the existing GitHub `ci-required` check must pass, including its
Linux/macOS matrix and full-history secret scan, and a human/independent review
must resolve any new findings. Local macOS tests are not evidence that remote CI
or the secret-scan job has run. CI retains read-only permissions; this PR adds no
workflow that commits, pushes or opens PRs.

Real rollout additionally needs the G-01–G-06/E-01 gates above. Merging this PR
does not make those gates complete. The follow-up sequence is staged generation,
host permission/ownership and count/Guardian integration, continuation, measured
settlement, then separately authorized smoke/pilot evidence.
