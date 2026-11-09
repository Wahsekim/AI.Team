# Retry journal persistence

Status: local offline persistence and read-only inspection. No model dispatch,
runtime session resume, product lock, automated recovery or ledger settlement.
Uses Node 24+ built-in SQLite; older Node versions fail with `CAPABILITY_MISSING`.
No package installation or network connection is involved.

## API

`src/router-worker/retry-store.mjs` exports two asynchronous open/create functions;
the returned handle's operations are synchronous and transaction-bounded.

```js
import { loadRetryRules } from '../../../src/router-worker/retries.mjs';
import { createRetryStore, openRetryStore } from '../../../src/router-worker/retry-store.mjs';

const config = {
  filename: '/absolute/existing/private-directory/US-08.rw-retries.sqlite',
  ticketId: 'US-08',
  rules: loadRetryRules(),
};
// Explicit creation only, once. Existing paths always fail; never use this to reset counts.
await createRetryStore(config);
const store = await openRetryStore(config);
try {
  const snapshot = store.read(); // {journal, state, storage}
  // A future trusted host can append a validated event with the observed version:
  // store.append({expectedDigest: snapshot.journal.digest, event});
} finally {
  store.close();
}
```

Rules are copied before the asynchronous capability-loading boundary. Opening
requires an existing dedicated file and matching ticket/source-rule digest; it
never creates or migrates a missing, foreign or obsolete database. Use
`openRetryStore({...config, readOnly: true})` for inspection. Closed handles reject
operations; repeated `close()` is harmless.

Read-only CLI, from the kit root:

```sh
node scripts/inspect-router-worker-retries.mjs /absolute/US-08.rw-retries.sqlite US-08
```

Success prints the journal, derived state and storage metadata. Invalid stores
exit 2 with structured stderr and no partial stdout; bad CLI usage exits 1. Missing
files remain missing. This command neither creates a store nor starts work. It
uses this kit's current rule sources; source changes require explicit review,
not automatic adoption into an existing ticket.

## Storage and concurrency

One database represents one ticket and one source-rule version. Version 1 has
an immutable event sequence plus a metadata head; each row binds its event digest,
previous journal digest and resulting prefix digest. Reads replay the existing
retry state machine rather than trusting persisted counters. Missing/reordered/
edited rows, changed head/count, unknown schema, extra triggers and source-rule
mismatch are refused without application-level repair.

`append` performs `BEGIN IMMEDIATE`, validates the entire current history, checks
`expectedDigest`, validates the transition, inserts its event and updates the head
inside one transaction. It returns `{journal, state, storage, applied}` only after
commit. Concurrent writers cannot both apply different events against the same
version. A lock timeout fails; it is not treated as permission to retry a call.
`read` uses a consistent read transaction.

For a response lost after commit, replaying the identical `eventId` and content
with either its original predecessor digest or the current digest returns
`applied: false`, with no new row/count. Reusing that ID with different content is
an idempotency conflict. A new event with a stale version is rejected. No result,
including `applied: true`, authorizes model dispatch: all states remain
`launchable: false`, `deliveryAuthorized: false`.

## Creation and filesystem boundary

The filename must be normalized, absolute, end in `.rw-retries.sqlite`, and be
outside `.git` and `.claude` path components. Its existing parent must be canonical.
Creation initializes a complete scratch database in a private sibling directory,
closes it, applies mode `0600`, then exclusively hard-links it to the destination.
An existing file or symlink is never overwritten. The scratch directory is removed
on ordinary success/failure; process death may leave an orphan scratch directory.
There is no automatic orphan cleanup.

Open/read/write checks reject symlink/hard-link aliases, group/other-accessible
files, unsafe SQLite sidecars, paths whose device/inode changed and files above
16 MiB. Unknown/WAL headers are rejected before opening SQLite; this version only
supports local rollback-journal databases. It uses SQLite `synchronous=FULL` and
does not alter the existing Loop/Graph databases or schemas.

SQLite may recover its own interrupted rollback transaction when opening a valid
store read/write. That restores storage consistency; it is **not** an automatic
recovery of an agent call. Read-only inspection may refuse a database that requires
such recovery. Tests cover process termination, not power-loss behavior, every
filesystem, network shares or hostile same-user processes. No OS sandbox is implied.

## Restart semantics and remaining host obligations

- Prepared/started/unknown assignments and sticky stops survive reopening.
  Reopening does not reset attempts, clear stops or make pending work dispatchable.
- A committed `start` remains consumed after process death. A lost response replay
  does not create another call. Unknown work still needs the operator path.
- The future host must durably record intent/start **before** invoking a model,
  authenticate real session/call/receipt evidence and honor `applied: false`.
  This store does not implement that dispatch protocol or resume sessions.
- Database transactions only serialize this journal. They do not own a product
  checkout, authenticate events, settle usage, run Guardian or enforce global gates.
- The optional [anchored registry](retry-registry.md) now binds repo/ticket identity
  to one store and checks retained journal-prefix checkpoints. Use that layer for
  registered tickets; opening a raw database alone does not enforce it. Replacing
  a database or rolling it back while newer checkpoints survive is detected.
  Whole trusted-state rollback still needs an external trust source; this is not
  a complete anti-reset guarantee or product-ownership mechanism.
- No import of existing task history, owner retry exception, schema migration,
  reset, truncate, event deletion or automatic stop-clear API is provided.

Worker-supplied events must never be passed directly to `append`. Persistence
proves storage/replay properties under the stated local trust boundary, not the
authenticity of an assertion that a check ran or that a budget gate was clear.

## Tests

`node --test tests/router-worker-retry-store.test.mjs` covers restart, creation
refusal, permissions/aliases, read-only CLI, stale writers, lost-response replay,
source versions, malformed history, database replacement, two real competing
processes, an interrupted SQLite transaction and a committed-start writer death.
All data is in disposable temporary directories. No project worker or paid API runs.
