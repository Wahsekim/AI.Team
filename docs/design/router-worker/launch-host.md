# Launch host (owner decision 2026-11-13: one script before and after the run)

Status: `prepare`, `close` and `settle` exist and are tested offline; `prepare`
and `close` were used in the third smoke run, `settle` has not yet run on a real
session. Nothing here calls a model.

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
2. Freeze the run ([run arguments](run-args.md)), run the engine's static
   launch preflight (`preflight-run.mjs`) on the frozen arguments, and freeze
   again with its `launchManifestDigest`. A digest already in `RUN.json` is kept
   and no preflight runs. None of this writes to the copy or the product, so an
   invalid run or a failing preflight (`PREFLIGHT_FAILED`) is refused before
   anything is taken.
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
| `WRITE_OUTSIDE_BOUNDARY` (with the paths) | the work tree holds a changed or untracked path outside the armed write paths. This is the only check that sees writes made through Bash |
| `PRODUCT_HEAD_MOVED` | the product has a commit the run did not start from; workers do not commit |
| `BOUNDARY_CHANGED` | the boundary file is missing or is not the one armed at prepare |
| `LEASE_NOT_HELD_BY_THIS_LAUNCH`, `LEASE_RELEASE_FAILED` | the lease was not released by this close; another host's lease is left alone |

`<copy>/rw-close.json` carries `status` (`clean` or `review`), the `account`
(calls and engine blockers), `productHead`, `candidate` (the product state the
run ended in: commit plus every tracked and untracked file by content),
`changedPaths`, `hookLog` (counts
from the [hook call log](write-boundary.md): calls, calls by the run's
wrappers, their Bash calls, refusals, calls with no agent name), the findings
and `leaseReleased`. `hookLog` is not a finding: a worker that only read files
leaves no line. `clean` says the run stayed inside its gates; it says nothing
about the quality of the work. Read `account.blockers` for the engine's verdict.

`WRITE_OUTSIDE_BOUNDARY` is found after the fact and only inside the product
work tree. A write elsewhere on the machine is not seen.

Git-ignored paths are not judged (owner decision 2026-11-13, after the third
smoke run listed 65 build artifacts of the check wrapper's verification
commands). The record carries `ignoredChanges`: their count and the count per
top-level directory. They do not affect `status`. A write hidden in an ignored
path therefore shows only as a count; the isolation gate refuses a product that
already has ignored paths at prepare, so every counted path was created during
the run.

When the engine returns nothing (crash, interrupt), there is no return to
close with. The operator releases the lease with `lease-router-worker.mjs
release` and deletes the copy.

## Settle

```sh
node kit/scripts/measure-spawn.mjs <session-dir> --json > METER.json
node kit/scripts/launch-router-worker.mjs settle RESULT.json METER.json --team-root <activated copy>
```

The retry rules used by `settle` and `retry` are those of the copy: its own
`charter.md`, read through the kit that serves the command. A copy that is not a
two-root instance of that kit is refused (`RETRY_RULES_REFUSED`), and a charter
whose retry wording changed is refused (`RETRY_RULE_REVIEW_REQUIRED`) before
anything is settled or admitted. The journal carries the digest of those rules,
so a retry after a charter change is refused as well.

`<session-dir>` is the Claude Code session directory of the launching session.
Exit 0 settled clear, 2 refused or settled with something to review, 1 usage.
Settle needs the launch record and the close record, and the same engine return
the launch was closed with. It runs once.

1. **Calls.** The metered workflow agents of the run's wrappers are put in the
   order the workflow journal started them. They must be exactly the calls the
   engine return reports: per dispatched ticket and attempt the exec call, then
   the check call if the engine dispatched one, and the Guardian last. Anything else is
   refused and nothing is written.
2. **Briefs.** The transcript of each exec and check call must carry the frozen
   brief of its plan item (the runtime relays it with every line indented by two
   spaces). A call without it is the finding `BRIEF_NOT_FOUND` with ticket and
   duty. This is the check that the engine was launched with the frozen task
   text; it also fires if a later runtime relays briefs differently.
3. **Tickets.** Per dispatched ticket: a retry journal, the usage ledger with
   one meter read per call, and the [ticket settlement](settlement.md) against
   the authorization frozen for that ticket (`items[].authorizedTokens` in the
   run record).
4. **Run.** The [run settlement](settlement.md): tickets plus the Guardian
   against its estimate.

`<copy>/rw-settlement.json` carries `status` (`clear` only when the run gate is
clear and there is no finding), the `calls` with agent id, tokens and finished
flag, `mainSessionTokens`, the findings, the run settlement, and per dispatched
ticket its retry journal, usage ledger and ticket settlement (`ticketRecords`).

The retry journal in step 3 is written after the run from the engine return
(`journalSource: reconstructed-after-run`). Its admission gates are recorded as
clear with the launch record as their source, because the engine issued those
calls and no host judged them one by one. It shows what was called, not that a
gate was observed at call time; it will not catch a retry-cap breach inside a
run, which the count engine cannot produce (one exec and at most one check per
ticket).

## Retries

Owner decisions: Router/Worker is a parallel optional mode that stays in
disposable copies; a real product repository may be run against only with a Bash
sandbox; within the retry cap the SAME exec agent fixes its own work and the
SAME check agent verifies again, with the check report going back to the router
(2026-11-16).

Two live runs settled how that can be done:

- E-04 (2026-11-16): the count engine retried SMOKE-05 with a fresh exec and a
  fresh check agent and it passed. The retry cost about 34,000 input-side tokens
  for a one-line fix, because fresh agents re-read the project.
- A probe in the E-04 session: an agent the engine started cannot be resumed
  (`SendMessage`: "No transcript found for agent ID"; its transcript lives under
  `subagents/workflows/`). An agent started with the Agent tool can: a headless
  probe on Claude Code 2.1.323 resumed one with `SendMessage`, its context was
  intact, its turns were appended to the same transcript, and its tool calls
  kept the same agent name and id in hook input. A `PreToolUse` hook sees and
  can refuse both `Agent` and `SendMessage` calls of the main session.

So a run with same-agent retries cannot be dispatched by the engine. It is
dispatched by the copy's main session with the Agent tool, each call admitted by
a hook against the frozen plan. That path is being built; until it exists, an
engine run makes one attempt per ticket (`maxAttemptsPerTicket` default 1) and a
failed check halts it.

The engine's own retry with fresh agents stays available: `RUN.json` may set
`maxAttemptsPerTicket` to 2 or 3. Then `close` counts every attempt as a call
(`account.calls`: `tickets`, `exec`, `check`, `guard`; `account.attempts` per
ticket), `settle` expects an exec and a check call per attempt, each with its
own transcript, every attempt spends against the one output ceiling and the one
ticket authorization, and only the product state the run ended in is observed.

### Continuation after the run (kept, not wired)

`launch-router-worker.mjs retry` and `isolation-router-worker.mjs --retry-of`
prepare an exec continuation after a closed and settled engine run whose check
failed. They assumed the engine-started agent could be resumed, which the probe
above disproved. Nothing in the run flow calls them.

## What it does not do

`unresolved` in the record lists:

- `owner-attendance`: ADR 0006 still requires the owner present; the script
  cannot observe that.
- `launch-manifest-preflight`: listed only when the record's `launchManifest`
  is `absent` (a caller of the module that passed no preflight). The command
  always chains it. The preflight runs before the write boundary is armed; the
  manifest does not cover `.claude/settings.json`.
- `in-run-admission`: no call is admitted one by one during the run. The retry
  cap and input-side usage are only judged afterwards. Closing this needs an
  external process that drives the runtime, which the owner did not choose for
  owner-attended single-round runs.
- `bash-writes`: see the write boundary.

Nothing forces the main session to use the record's `args`: the main session
starts the engine, and the script cannot stand between them. Close detects a
different run id, count, ceiling, plan order or agent type from what the engine
echoes. The engine does not echo the briefs; `settle` finds a changed brief
afterwards from the agent transcripts. Nothing detects it before the calls are
made, so the owner still compares the launched arguments with `rw-launch.json`
at launch.
