# Anchored offline retry registry

Status: local stable-ticket storage and checkpoint consistency, Node 24+.
This is not a dispatcher, product lock, runtime registry, approval authority or
complete rollback defense. Every returned state remains non-launchable.

## Interface and trust anchor

`src/router-worker/retry-registry.mjs` exports:

- `createRetryRegistry({root, repoId, rules})`: explicitly create a new private
  directory and return an anchor. Existing directories are refused. Unsupported
  Node versions fail before claiming a path.
- `openRetryRegistry({anchor, rules})`: verify the separately retained anchor and
  rule version, without creating missing state.
- `registry.register(ticketId)`: allocate one stable repo/ticket store, or inspect
  its existing complete registration. An incomplete registration is an error,
  never permission to initialize a fresh history.
- `registry.openTicket(ticketId, {readOnly})`: return a handle with `read`,
  `append({expectedDigest, event})`, `checkpoint({expectedDigest})` and `close`.
  Read-only handles cannot append or checkpoint.

The caller retains the returned anchor separately from the registry; it includes
the canonical root, its device/inode, registry ID, repo ID, rule digest and
manifest digest. Loading a newly supplied anchor from the same mutable registry
does not establish trust. This library does not authenticate the operator or
bind `repoId` to exclusive ownership of an actual product checkout.

For each repo/ticket, a deterministic key selects one directory and a permanent
root-level claim. The claim is published before allocating the ticket directory.
A binding pins its allocation, directory and database identities, source rules
and initial journal. Deleting only the ticket directory leaves the claim behind,
so registration fails rather than resetting counts. A crash partway through
registration similarly requires investigation; there is no automatic cleanup,
reset, replacement or migration command.

## Checkpoints and interrupted acknowledgements

Successful `append` first commits the existing SQLite journal transaction, then
publishes an immutable journal-prefix checkpoint before returning. Each retained
checkpoint must match replayed history. Replacing the database is refused by its
identity binding; restoring an older valid database in place is refused while
the newer checkpoint is retained. Conflicting writers cannot both apply an event
to the same journal version.

There is deliberately no cross-file atomicity claim. A crash after SQLite commit
but before checkpoint publication can leave `checkpoint.lagging: true`. Inspection
shows the committed history without modifying it. Fresh events are blocked until:

1. The original identical event is replayed (no second count), publishing its
   checkpoint; or
2. The trusted operator reviews the current history and explicitly calls
   `checkpoint` with the current journal digest.

Checkpointing does not start work, clear a stop, change a counter, prove the
interrupted process stopped or resolve missing usage. An unknown execution remains
unknown. A concurrent advancement can make checkpoint acknowledgement fail; reread
and reconcile instead of dispatching again.

Do not delete checkpoint/claim files to repair an error. Whole-registry rollback,
deletion of both a database and its newer checkpoints, or replacement of the
separately trusted anchor is **not** detected in general. Hashes and local inode
checks are not an external monotonic counter, signature authority or defense
against a hostile same-user process. Tests cover local process/concurrency and
partial-rollback cases, not power loss or every filesystem. No host may claim full
anti-reset protection from this API alone.

## Read-only operator command

Save the returned anchor in an operator-controlled file and retain its exact
file-byte SHA-256 separately. Then, from the kit root:

```sh
node scripts/inspect-router-worker-registry.mjs /absolute/anchor.json sha256:REPLACE_WITH_RETAINED_64_HEX_DIGEST US-08
```

The placeholder is intentionally invalid; do not calculate a fresh digest from
an untrusted replacement file merely to make inspection pass. The command checks
anchor bytes, registry binding, retained checkpoints and the replayed journal.
It never creates, repairs or resumes anything. Missing state or inconsistency
exits 2 with structured stderr and no partial stdout; usage errors exit 1.

The older `inspect-router-worker-retries.mjs` remains useful for raw database
diagnostics, but does **not** inspect the anchor or checkpoints. A raw database
that passes its internal checks can still fail registry inspection after rollback.
Neither command grants permission to resume.

## Tests

`tests/router-worker-retry-registry.test.mjs` covers stable reopen, root/anchor
mismatch, missing registration components, fresh database substitution, retained
checkpoint rollback detection, lost acknowledgement, explicit checkpointing,
read-only behavior, aliases/corruption, two competing real processes, and CLI
no-write/no-initialization behavior. The unsupported-version branch is exercised
by overriding the version value in an isolated child; that is not a full Node 22
compatibility run.
