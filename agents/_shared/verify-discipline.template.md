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
