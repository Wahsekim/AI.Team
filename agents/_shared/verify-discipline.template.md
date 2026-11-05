# Verify Discipline (template) - incorporates meta-rule M2

Copy to `_shared/verify-discipline.md` during bootstrap and fill placeholders
from `profiles/stack.md`. Applies to every agent running build, test, or server
commands. Every pitfall below cost the source project real incidents; keep the
sections even when a placeholder resolves to "none".

## Environment / launch pitfalls

- Canonical command env prefix: `{{ENV_PREFIX | from:profiles/stack.md | default:none}}`.
  If one exists, reproduce it VERBATIM in every brief that runs toolchain
  commands. Default reaction to "toolchain missing / version mismatch" errors:
  re-check the prefix BEFORE escalating (the false-block class).
- Port cleanup before any server boot or e2e run:
  `{{PORT_CLEANUP_COMMAND | e.g. lsof -i :PORT -t | xargs -r kill | optional}}`
  - a stale bind hangs suites silently until a watchdog kills them.
- Production-like smoke launch:
  `{{PRODUCTION_LAUNCH_COMMAND | from:profiles/stack.md}}` - a bare release
  build may still default to the dev profile and dev database, silently smoking
  the wrong environment. Verify positive real-data markers, not just an HTTP
  200 (M5).

## Clean-state builds (M2)

- Finish ALL writes first, then build ONCE LAST; capture the exit code via
  `${PIPESTATUS[0]}` (or equivalent) - never visual-scan "build succeeded",
  never pipe through output-truncating filters (use `tee <log>` instead).
- `{{CLEAN_BUILD_COMMAND | optional}}` BEFORE the final build+test pass when
  `{{BUILD_CACHE_SENSITIVE_SURFACES | e.g. templates, codegen inputs, composition root}}`
  were touched - incremental caches produce stale-artifact false-PASS.
- Warning COUNT as the verification signal ->
  `{{NO_INCREMENTAL_BUILD_COMMAND | optional}}` is MANDATORY; label the mode in
  the report (`Warnings: N (clean)` vs `Warnings: N (incremental - exit-code-only signal)`).
- Uncertain exit -> run TWICE, both must match, before claiming PASS/FAIL.
  Never build while another worker is mid-write on the source tree.

## Long-running test output

- `{{LONG_TEST_VERBOSITY_FLAG | optional}}` - minimal verbosity can emit no
  stdout for minutes (fixture boot), tripping stream watchdogs. Elapsed beyond
  `{{STALL_SUSPECT_MINUTES | default:5}}` min with no progress line -> suspect a
  port/fixture hang; check the ports above before assuming a real stall.

## Runtime log audit

After every server boot + request cycle: capture server stdout to disk, then
grep for `warning|error|exception|fail` minus the brief-supplied allow-list.
Any surviving line = FAIL. The PM supplies the allow-list in the brief; never
allow-list a new warning without explicit owner ack.

## File-existence checks

Always recursive: `find <path> -name '<pattern>'` (or `ls -R`) - a bare
`ls <dir>` misses nested files and produces false flags.

## Oracle falsifiability (review 2026-09-25, F-03)

For every CRITICAL integration gate (device/hardware smoke, protocol
round-trip, release build) the verifier answers, in the report, "what would
make this oracle fail?" — and the answer must name the specific operation under
test, not adjacent traffic:

- arm a FRESH transaction window AFTER the handshake/ready state, send the
  explicit request, correlate ITS response (never search the whole received
  buffer for a token the connection handshake also emits);
- run a NEGATIVE CONTROL once per suite: suppress the send/reply under test and
  confirm the test FAILS; a test that cannot fail is not evidence;
- release resources on the timeout/disconnect paths (`finally`);
- record the oracle identity with the evidence: test file path + content hash
  (`sha256sum <test file>`), so a green command is bound to the assertion that
  produced it.

A green command alone is insufficient when the oracle is weak; the PM treats a
gate without a falsifiability line as N/A-with-reason, never as PASS.

## Landing / git index discipline (review 2026-09-25, I-10, recommendation 12)

Before ANY commit that names paths (`git commit <pathspec>`), run
`git diff --cached --stat`: if the index holds unrelated staged changes, commit
them separately (or unstage them) FIRST — a pathspec commit silently drops
index-only intent for the paths it does not name. Do not blanket-ban pathspec
commits; inspect staged intent and preserve unrelated work. Report the landing
as `delivery: {status, ref}` (engine worker contract): a denied commit is
`status: failed` with the exact denial text, never a note under a green tick.
