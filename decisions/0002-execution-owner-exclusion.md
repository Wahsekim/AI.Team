# ADR 0002: One local execution owner per state directory (R03a)

Date: 2026-10-07
Status: Accepted for implementation (PM sign-off 2026-10-07T07:01:49Z: Q1 yes library-only, Q2 yes bounded process.execPath probe, Q3 yes, Q4 yes, Q5 yes with R07 limitation; CLI exit code 4 = execution exclusion); owner ratification pending

## Context

- R03 (plan §4) needs one dispatching host per execution state directory for the whole execution lifetime, failing closed. KO: a lock timeout admits a second writer, or owner death is taken as proof that every child exited. R03b (product target) is out of scope (ADR 0001, decision 5).
- Baseline 53296f6 has no interprocess guard. `fixture-driver.mjs:12-36` keeps an in-memory `WeakMap` per store object. `busy_timeout` and `BEGIN IMMEDIATE` (`store.mjs:11,26`) serialize single transactions only.
- X3: the repo's lock prior art (`reconcile-run.mjs:48-87`, `bootstrap-team.sh:60-100`) takes a lock back when the recorded PID is dead. It must not be copied.
- X6: `realpathSync` (JS) keeps a case alias on macOS. `realpathSync.native` canonicalizes it (probe P9).
- X7: a SQLite `locking_mode=EXCLUSIVE` + `BEGIN EXCLUSIVE` lock refuses other processes and aliases, and the kernel drops it on SIGKILL while a detached grandchild survives. Probes P1 and P5 confirm this on Node 24.21.0 and 25.6.1 (`docs/rollout-evidence/R03a/logs/`).
- New probe facts:
  - P2: a second SQLite connection in the same process is refused.
  - P3: a plain `fs.openSync` + `closeSync` of the lock file inside the holder process silently releases the lock (POSIX fcntl semantics). SQLite connections, stat, lstat and realpath do not.
  - P6: unlink and recreate while the lock is held lets a second process lock the new inode.
  - flock(1) is absent on macOS.
- So a kernel lock alone cannot prove exclusion for a lifetime.
- The reducer already blocks re-dispatch of the same run after a crash (STARTED → `interrupted`, `fixture-driver.mjs:45-49`). It does not cover a new run in the same directory, P3/P6 lock loss, or future effects that are not claims.

## Decision

1. **Kernel lock (liveness layer).** New module `src/loop/execution-owner.mjs`.
   - Lock file: `<stateDir>/execution-owner.sqlite`. SQLite also creates `-journal` beside it.
   - Acquire: `new DatabaseSync(path)`, then `PRAGMA busy_timeout=0; PRAGMA locking_mode=EXCLUSIVE; BEGIN EXCLUSIVE`. The transaction is never committed; it is held until release (`ROLLBACK`, `close()`) or process exit.
   - errcode 5 (BUSY) → `EXECUTION_OWNER_ACTIVE`, immediately, with no wait or retry.
   - Any other error (26 NOTADB, 14 CANTOPEN, IOERR) → `CAPABILITY_MISSING`. The file is never deleted or repaired.
   - It is a separate file, not `loop.sqlite`, so status, events, audit, show and stop never contend.
2. **Durable marker (exclusion layer).**
   - Table `executions` in the control store, created lazily by the acquire call and never by `openStore`, so X5 does not widen. Columns:
     - `seq` PK; `owner_id` (crypto.randomUUID, unique); `open` 0/1;
     - `state_path`, `state_dev`, `state_ino`, `lock_ino`;
     - `pid`, `hostname`, `opened_at`: informational only, never read by any decision;
     - `closed_at`; `close_kind` graceful|operator; `close_note`.
   - The partial unique index `ON executions(open) WHERE open=1` allows at most one open row. A CHECK requires a complete close. Triggers refuse any UPDATE of a closed row and any DELETE (probe 3).
   - The history is append-only.
3. **Transitions.** There are no others: no reopen, no delete, no expiry.
   - (a) *none open → open(me)*: in one `BEGIN IMMEDIATE` on the control store, after the kernel lock is held. If any open row exists, whatever its pid, time or host: `EXECUTION_OPEN`, and the kernel lock is released at once.
   - (b) *open(me) → closed/graceful* on `release()`. It needs no active step and no run in the store that is `RECOVERY_REQUIRED` or has a dispatch STARTED/UNKNOWN without a receipt, or a STARTED projection. Otherwise release drops only the kernel lock and **leaves the marker open**.
   - (c) *open(other) → closed/operator* via `closeOrphanedExecution({ store, ownerId, note })`. The caller must hold the kernel lock, which proves the recorded owner no longer holds it. It needs the exact open `owner_id` and a non-empty operator note. The open row's `lock_ino`, `state_dev` and `state_ino` must equal the freshly locked file and directory; otherwise `EXECUTION_OWNER_ACTIVE`, because the lock no longer proves the owner is gone (review F2). It does not change run state; reducer recovery (R05 ingest/abandon) is still required. The library function is in R03a scope (Q1). R05b wires the CLI.
4. **Fencing.**
   - `store.apply(action, command, now, fence)`: inside the same transaction, if an open row exists, `tick`/`claim` without a fence, or with a different `owner_id`, are refused with `EXECUTION_OPEN`.
   - A fenced call with no matching open row → `OWNER_LOST`.
   - Other actions (`stop`, `interrupted`, `settle*`, `abandon`) stay unfenced, so R04 stop and R05 recovery work.
   - The driver passes only a fenced store wrapper to `executeStored*`. At each `step()` it calls `owner.assertHeld()`: the handle is not released, and `lstat(lock).ino`/`dev` and the state directory's (dev, ino) are unchanged. Otherwise `OWNER_LOST` and no dispatch. This fails closed against P6.
5. **Identity.**
   - State directory = `realpathSync.native(dirname(store.filename))` plus `statSync` (dev, ino). The store exposes `filename`. `:memory:` → `CAPABILITY_MISSING`.
   - The lock is per inode, so symlink, case, relative and bind aliases meet one lock (P1, P2).
   - The lock file must be a regular non-symlink file with `nlink === 1` on the directory's device; otherwise `CAPABILITY_MISSING`, untouched.
   - **One control store per state directory** (attempt 2, review F1). The kernel lock is per directory, but the marker lives in a store file. So the first successful acquire records the store's (basename, dev, ino) in a `store_binding` table inside the lock file. It writes the binding under the kernel lock and commits before the lifetime `BEGIN EXCLUSIVE`; `locking_mode=EXCLUSIVE` keeps the lock across that commit. Every later acquire, and every operator close, compares the opened store with the binding. Any mismatch, including the same path with a new inode, gives `STORE_MISMATCH` (CLI exit 4) and writes no marker.
   - P3 guard: the driver refuses (`SCOPE_DENIED`) a state directory inside the product root, because the snapshot would open and close the lock file in-process. Its root resolution moves to `.native` (`fixture-driver.mjs:25,32`). Rule: no module other than `execution-owner.mjs` opens the lock path.
6. **One driver per owner handle.** The handle replaces the per-store-object `WeakMap` as the authority. A second `createFixtureDriver` on the same handle → `INVALID_TRANSITION`. `createFixtureDriver` requires `owner`; there is no optional bypass.
7. **Fail-closed matrix.** In every row, inspection and stop are unaffected. They never open the lock file.

| Condition | Execution (driver, `fixture`, `demo`) |
|---|---|
| Node < 24 | `CAPABILITY_MISSING` (existing check) |
| platform not `darwin`/`linux` (incl. win32) | `CAPABILITY_MISSING` |
| `:memory:` store; lock path symlink, non-regular or nlink > 1 | `CAPABILITY_MISSING` |
| lock open/lock error other than BUSY | `CAPABILITY_MISSING`; file untouched |
| a cross-process probe after acquire (a `process.execPath` child tries the same lock and must get errcode 5) does not get BUSY, e.g. no-op locks on NFS/SMB/FUSE | `CAPABILITY_MISSING`, release (Q2) |
| BUSY | `EXECUTION_OWNER_ACTIVE` |
| open marker of another owner | `EXECUTION_OPEN` |

Never: takeover on a dead PID, expiry by time or timeout, a force flag, deleting the lock file to recover, or automatic replay of unknown work.

## Considered Alternatives

1. **mkdir lock directory.** There is no kernel release on death. A crash either sticks with no way to tell a live owner from a dead one, or needs PID/time reclaim. That is KO "PID/time metadata alone cannot authorize takeover".
2. **Lockfile + PID (prior art X3).** Reclaiming on a dead PID is KO "owner death interpreted as proof all children exited": the detached group survived its host in P5. PID reuse makes even liveness unreliable.
3. **flock via child `flock(1)`.** It is absent on macOS (probe), so it fails closed everywhere we test. The helper process's lifetime is separate from the owner's, so a helper killed or orphaned independently of the host breaks "held for the entire execution lifetime".
4. **SQLite lock only.** After SIGKILL (P5), lock-file replacement (P6) or an in-process foreign open/close (P3), a second host dispatches a new run while the first host's child, or the live first host itself, still mutates. That is KO duplicated execution.
5. **Marker only.** Exclusion holds, but the operator cannot tell a live owner from a dead one when closing. Closing a live owner's marker is a duplicate-execution path, and helping the operator would mean PID/time heuristics, which are KO.
6. **Lock on `loop.sqlite`.** It blocks status, audit and stop, which R04 forbids.
7. **Native flock addon.** It adds a build dependency to a zero-dependency kit. Its crash semantics are the same as option 4.

## Consequences

- **Intended stuck state.** Any unclean exit (SIGKILL, power loss, an uncaught crash, or a release with unresolved work) leaves the marker open. The directory then refuses execution until an operator close, even when the crash happened at an idle point. Without trusting PID or time, the host cannot tell idle from mid-spawn. Inspection keeps working.
- **Fixture CLI.** Its fresh-directory-per-run rule (`fixture-demo.mjs:21-25`) already refuses a second run. A crashed CLI directory is never re-executed by the CLI anyway. The marker matters for library hosts (crash tests, future R14).
- **R02 tests.** `reopen()` changes: it acquires, asserts `EXECUTION_OPEN`, performs an operator close, and then keeps today's assertions.
- **R04.** Stop stays unfenced and lock-free. The version race (R-1) is unchanged and still owned by R04.
- **R05a.** A read-only open must tolerate a missing `executions` table.
- **R05b.** The CLI pairs the operator close with ingest/abandon.
- **R14.** It must acquire an owner.
- **R03b.** It may reuse the module keyed on the target.
- **Limitations.**
  - Same-UID code can still delete or replace the files. Replacement is detected by `OWNER_LOST`/`EXECUTION_OPEN`, not prevented.
  - Direct library calls to `executeStored*` are trusted host code. They are covered only by the unfenced `tick`/`claim` guard.
  - An older binary ignores the marker; there is no metadata version bump (Q5, R07).
  - Linux is unverified until the CI ubuntu Node 24 job runs.
  - After a lock-file replacement, `closeOrphanedExecution` refuses to close the open row, and the directory stays stuck. R05b must define the manual procedure.
  - The store binding lives in the lock file. Deleting or replacing the lock file therefore also resets the binding. This is the same same-UID tampering limit as above.
  - `store.openExecution` and `store.closeExecution` are public and do not take the lock. They are trusted-library surface; only `execution-owner.mjs` calls them.
  - Direct unfenced `tick`/`claim` on a second, unbound store file in the directory is not blocked, because that store has no marker. Only `acquireExecutionOwner` enforces the binding (trusted-library limit).

## Follow-ups

- [x] PM sign-off on Q1–Q5 (2026-10-07T07:01:49Z); owner ratification of this ADR pending.
- [ ] R05a/R05b: read the marker read-only; CLI operator close with a recorded note.
- [ ] R07: version the `executions` table and refuse marker-unaware binaries.
- [ ] R03b: target exclusion on the same primitive; switch the remaining `realpathSync` identity uses to `.native`.
