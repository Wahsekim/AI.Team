# Launch host (owner decision 2026-11-13: one script before and after the run)

Status: `prepare` and `close` exist and are tested offline. Usage settlement and
the launch-manifest preflight are not chained yet. Nothing here calls a model.

In the two disposable smoke runs every gate before and after the run was run by
hand, in an order nothing enforced. The launch host puts them behind one command.
During the run it changes nothing: only the count engine (count, output ceiling,
halt on failure) and the [write boundary](write-boundary.md) hook act then.

## Prepare

```sh
node kit/scripts/launch-router-worker.mjs prepare RUN.json --team-root <activated copy> --product-root <product-root>
```

`RUN.json` is the file `freeze-run-router-worker.mjs` takes. Exit 0 prepared,
2 refused, 1 usage. Steps, in this order:

1. Refuse if `<copy>/rw-launch.json` exists. An activated copy is prepared once.
2. Freeze the run ([run arguments](run-args.md)). This writes nothing, so an
   invalid run is refused before anything is taken.
3. Acquire the ownership lease on the product for this copy.
4. Arm the write boundary for the run's tickets.
5. Observe the [isolation gate](isolation-observation.md) with that lease. It
   must be `clear`.
6. Write `<copy>/rw-launch.json` and print it.

A refusal at step 4, 5 or 6 releases the lease taken at step 3. A lease held by
another host is refused at step 3 and left alone. The refusal carries the code of
the step that refused (`BUDGET_*`, `LEASE_HELD`, `BOUNDARY_REFUSED`, ...) or
`LAUNCH_REFUSED` with the codes of the isolation findings.

The record carries `runId`, both roots, `productHead`, the `lease` digest,
`isolationDigest`, `boundaryDigest`, `argsDigest`, the frozen `runRecord`, the
engine `args` and a digest of itself. The main session starts the engine with
exactly `args` from this record.

## Order at launch

Run `prepare` from a shell before the session that will launch the engine is
started in the copy. The hook is registered by `prepare`, and Claude Code is
documented to read hook configuration when a session starts; a session opened
before `prepare` may run without the hook. This order has not been tested on
this machine. Before launching, the owner checks in the new session that
`/hooks` lists the `PreToolUse` write-boundary hook and that the arguments
passed to the engine are the `args` of `rw-launch.json`.

## Close

```sh
node kit/scripts/launch-router-worker.mjs close RESULT.json --team-root <activated copy>
```

`RESULT.json` is the engine return the main session saved. Exit 0 closed clean,
2 refused or closed with findings, 1 usage.

A return that does not match the launch record is refused (`LAUNCH_REFUSED`):
nothing is written and the lease stays held, so the right file can be presented.
The match is `accountRun` on the record's `args` and `runRecord`: same run id,
count, mode, failure policy and ceiling, every call in plan order. A changed launch
record, a copy with no record, and a second close are refused the same way.

Otherwise close records what the run left and releases the lease:

| Finding | Meaning |
|---|---|
| `WRITE_OUTSIDE_BOUNDARY` (with the paths) | the work tree holds a changed, untracked or ignored path outside the armed write paths. This is the only check that sees writes made through Bash |
| `PRODUCT_HEAD_MOVED` | the product has a commit the run did not start from; workers do not commit |
| `BOUNDARY_CHANGED` | the boundary file is missing or is not the one armed at prepare |
| `LEASE_NOT_HELD_BY_THIS_LAUNCH`, `LEASE_RELEASE_FAILED` | the lease was not released by this close; another host's lease is left alone |

`<copy>/rw-close.json` carries `status` (`clean` or `review`), the `account`
(calls and engine blockers), `productHead`, `changedPaths`, the findings and
`leaseReleased`. `clean` says the run stayed inside its gates; it says nothing
about the quality of the work. Read `account.blockers` for the engine's verdict.

`WRITE_OUTSIDE_BOUNDARY` is found after the fact and only inside the product
work tree. A write elsewhere on the machine is not seen.

When the engine returns nothing (crash, interrupt), there is no return to
close with. The operator releases the lease with `lease-router-worker.mjs
release` and deletes the copy.

## What it does not do

`unresolved` in the record lists:

- `owner-attendance`: ADR 0006 still requires the owner present; the script
  cannot observe that.
- `launch-manifest-preflight`: `preflight-run.mjs` is not chained yet, so the
  args carry no `launchManifestDigest` unless `RUN.json` supplies one.
- `in-run-admission`: no call is admitted one by one during the run. The retry
  cap and input-side usage are only judged afterwards. Closing this needs an
  external process that drives the runtime, which the owner did not choose for
  owner-attended single-round runs.
- `hook-fires-inside-workflow-agents`, `bash-writes`: see the write boundary.

The close record lists `usage-settlement` and `retry-journal`: metering,
ticket settlement, run settlement and the retry journal are still run by hand
after close.

Nothing forces the main session to use the record's `args`: the main session
starts the engine, and the script cannot stand between them. Close detects a
different run id, count, ceiling, plan order or agent type from what the engine
echoes. The engine does not echo the briefs, so a launch with changed task
text is not detected; that needs the agent transcripts, which the settlement
step will read. Until then the owner compares the launched arguments with
`rw-launch.json` at launch.
