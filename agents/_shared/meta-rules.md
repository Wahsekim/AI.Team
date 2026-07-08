# Standing Meta-Rules (M1-M6)

Distilled from the source project's recurring lesson families (dozens of
individually-learned lessons collapsed into six standing rules). Every agent
reads this file at brief-read; the PM applies M1 at every brief construction.
These supersede re-deriving the same lesson per incident.

## M1 - Tier Sizing

Size a brief by THREE cost drivers, not by edit-surface size:

1. **Investigation cost** - must the worker read/enumerate/decide BEFORE
   editing? (investigate-then-fix, investigate-then-decide-skip, large file
   reads, cross-file contract reconciliation) -> the dominant driver.
2. **Verification cost** - each self-verify step (build / boot / request /
   test / report / screenshot) adds real tokens; >=2 steps means the brief is
   never plain "surgical". Any test-suite run puts the brief in the test-tier
   band regardless of edit size.
3. **Retry allowance** - code-shipping estimates pre-budget the verification
   round-trip: `worker + (1 x verifier tier) + (0.5 x fix-retest cost)`.

Bias UP when in doubt; apply a +30-50% novelty buffer when the brief shape has
no precedent in the band table.

### Calibration framework (not absolute values)

The canonical band table lives ONLY in `agents/pm.md` -> Rules -> Tier
calibration. It ships as START bands - **recalibrate from your first 10
dispatches**; band values are project- and model-specific, only the sizing
logic above is universal.

Variance-trigger batching rule: `|actual - estimated| / estimated` above the
charter variance threshold QUEUES a coaching trigger with a stated reason;
triggers are BATCHED and drained in one Coach dispatch at session/loop end or
after several accumulate - never one Coach spawn per trigger.

## M2 - Verify Against Clean State

Never trust a green signal produced against cached, stale, or wrong-profile
state:

- clean or non-incremental build before the FINAL verification pass whenever
  build-cache-sensitive surfaces were touched;
- when a warning COUNT is the verification signal, a cache-busting build is
  mandatory and the build mode is labeled in the report;
- capture real exit codes (`${PIPESTATUS[0]}` or equivalent); never visual-scan
  output; never pipe through filters that mask exit codes;
- production-like smoke uses the production-like launch profile - a dev-profile
  boot silently verifies the wrong environment/database;
- a tool-precondition failure (missing build artifacts, unresolved design-time
  context) is a precondition failure, NOT a product defect - fix the
  precondition, re-run, then judge.

Stack-specific command discipline: `_shared/verify-discipline.md`.

## M3 - Handoff-Hypothesis Check

Never act on another agent's diagnosis without ONE confirming probe. In your
first ~2K tokens:

```text
HANDOFF-HYPOTHESIS CHECK: prior <agent> claimed <X>; verifying via <evidence>.
{Confirmed: continuing.} OR {Mis-diagnosed: actual <Y>; pivoting; flagging PM.}
```

Outgoing handoffs mirror this: state a cause as VERIFIED (with method and
evidence) or as an UNVERIFIED hypothesis - never assert an unverified cause as
fact. The cost asymmetry is what makes the rule universal: a confirming probe
is cheap, a phantom fix built on a wrong diagnosis costs a full implementation
cycle. Observed as (source project): ~2K-token checks saving 30-50K
phantom-fix retries.

## M4 - Self-Report Distrust

Worker token/progress self-reports bias heavily optimistic — a model-level
property of LLM agents, not a project quirk. Observed as (source project):
+100-300% typical divergence, up to ~+480%. Trust harness-measured numbers ONLY
for variance, tier calibration, and coaching triggers; self-report is a
feel-of-effort signal. When self-report vs harness diverges >30%, dual-record
both in the lifecycle Notes. The same distrust applies to "within budget" and
"all done" claims - measure, don't believe.

## M5 - Owner-Perspective Close

A ticket is NOT done until the flow works as the owner would drive it: real
browser / real client, production-like profile and data path, real data markers
in the response body - not just a 200 status. Green test suites are Signal A -
necessary, never sufficient. Session close requires Signal B: a
production-like smoke plus the 4-question owner-perspective scan
(visual / auth / data path / performance). "DONE" means "the owner would use
this today", not "tickets closed". Two-signal close: A and B, never one
standing in for the other.

## M6 - Defect-Class Sweep

On the SECOND occurrence of any defect class, stop patching instances: search
the whole codebase for the class and fix ALL occurrences in one dispatch, then
add a sentinel (a test or a grep gate) so the class cannot silently recur.
Agents patch instances, not classes — without a forcing rule the same class
recurs indefinitely. Observed as (source project): one class of user-visible
string leaks (raw locale keys / hardcoded literals) recurred six times, each
patched as a one-off. Applies equally to code defects (hardcoded strings,
missing guards, unguarded call sites) and process defects (stale counters,
missed transitions). Full class catalog + mechanical controls:
`docs/failure-classes.md`.
