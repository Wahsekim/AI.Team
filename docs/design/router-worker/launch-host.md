# Launch host (owner decision 2026-11-13: one script before and after the run)

Status: the `prepare` half exists and is tested offline. The `close` half and the
launch-manifest preflight are not built yet. Nothing here calls a model.

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

Nothing forces the main session to use the record's `args`; the close step will
compare the engine's echoed arguments with `argsDigest`.
