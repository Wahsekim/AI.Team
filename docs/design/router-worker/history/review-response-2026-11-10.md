# PR #5 review response — 2026-11-10

Scope: the supplied review of [PR #5](https://github.com/Wahsekim/AI.Team/pull/5),
plus the owner's direction to keep project documentation in English. This is an
author fact-check/response, not a second independent approval.

## Findings and decisions

| Finding | Category / priority | Fact-check and response |
|---|---|---|
| Ambient `GIT_EDITOR` prevents candidate observation | Host compatibility / P1, fix before merge | Reproduced with `GIT_EDITOR=true`: the real candidate test fails with `UNSUPPORTED_ENVIRONMENT`; the same test passes without it. Added a failing regression before the fix. Accept only `GIT_EDITOR` alongside existing `GIT_PAGER`, since these piped read-only Git commands invoke neither. Keep every other ambient `GIT_*` variable refused, including repository/index/object/config overrides. No shared Loop reader or global environment mutation. |
| Empty PR body and documentation-commit title | Reviewability / P2 | Confirmed through GitHub: body was empty, title was `docs(router-worker): prepare offline foundation PR handoff`. Owner explicitly approved updating title/body from the handoff after verification. Target title: `feat(router-worker): add non-launchable offline foundations`. |
| ADR ratification provenance | Governance / P1 if approval were absent | Both approvals are present in the owner's earlier explicit replies: responsibility equivalence with all governance retained, and the proposed stable counting mapping. Retain Accepted for those two items only. Added an English record of the exact approved scope/replies; deployment/spending checkboxes remain unchecked. No approval is inferred from code or tests. |
| Template charter vs instantiated authority | Deployment completeness / P1 rollout gate, not this offline PR | Confirmed: retry rules, coverage and draft generation currently use kit seeds. Named explicitly in G-01. A deployed adapter must bind actual `charter.md` and instance policy; this PR still cannot activate a team. |
| Generated artifact ignore rules | Repository hygiene / P3 | Confirmed absent. Added ignores for `.rw-draft.json`, retry SQLite files/sidecars and publication scratch directories. Do not ignore generic `registry.json` or `binding.json` names globally; keep private registry roots outside source trees. |
| Possible ADR-index conflict with PR #3 | Integration / P2 when merging | PR #3 is open and changes `decisions/README.md`, adding ADR 0006. Shared-file edits are confirmed; a conflict is possible, not proven merely by overlap. Recheck after either PR merges; retain both 0006 and 0008 entries. Do not alter the other PR or invent its ratification. |
| Multiple slices in one PR | Review scope / P3 | Confirmed: broader than the originally suggested first RW-01/RW-02 PR, but explicitly non-launchable with separate commits and reviewer order. Preserve commit history with a merge commit if repository policy permits; no merge is performed by this task. |
| One-method hard-coded loader | Extensibility / informational | Confirmed and deliberate. It validates one reviewed method, not arbitrary JSON catalogs. A second method requires reviewed code, dependencies, permissions, pins and tests. No generic-platform claim or automatic adoption. |

The `GIT_EDITOR=true` reproduction establishes the reported environment failure.
It does not independently establish that every version or invocation of Claude
Code sets that variable; the fix needs no such universal claim. The narrower
allowance avoids changing the shared snapshot API or accidentally accepting an
unrecognized Git override through a partial denylist.

## Language normalization

Translated four project documents and removed locale-specific filenames:

- `README.md`: implementation design, authority boundaries and rollout plan.
- `skill-catalog-assessment.md`: complete candidate/disposition inventory.
- `review-2026-11-06.md`: translated historical external review, not a new approval.
- `self-review-2026-11-09.md`: translated dated self-review and evidence record.

Updated internal links and declared English as the language for project-maintained
documentation in the root README. Historical originals remain in Git history.
The design's outdated pending-ratification and missing-registry notes were aligned
with already-recorded owner decisions and implemented code, without changing any
authorization. Historical test totals remain dated rather than relabelled current.

## Verification

- Before fix: the targeted real candidate test passed normally and failed under
  `GIT_EDITOR=true`; the newly added editor regression also failed.
- After fix: candidate plus real-local-check integration suites passed 25/25
  under `GIT_EDITOR=true` on Node 25.6.1. Editor/pager command values do not execute
  canary programs. All tested Git discovery/config overrides still fail closed.
- Full suite under `GIT_EDITOR=true`, Node 24.22.2: **742 tests, 740 passed,
  two skipped, zero failures**, about 45.5 seconds. Existing watchdog process
  visibility was enabled. No live model or deployment was used.
- Router/Worker suites under `GIT_EDITOR=true`, Node 22.23.4: 207 tests,
  172 passed, 35 capability-dependent skips, zero failures. This is the focused
  compatibility run, not a new full-suite Node 22 result.
- Translation checks preserved all 95 skill disposition rows and all three design
  example blocks. All 14 project README/design Markdown files passed local-link,
  fence, whitespace and no-Chinese-text checks. Generated artifact ignore checks
  passed without ignoring source fixtures or generic registry/binding names.
- Kit validation passed with its documented deployment skips.
- GitHub checks read for original head `e644c8f`: Linux/macOS × Node 22/24,
  ShellCheck, secret scan and `ci-required` all succeeded. This is evidence for
  that head only. New commits must pass their own checks before merge.

The ADR clarification intentionally changes a file included in the retry-rule
source digest. Existing offline journals tied to an earlier source snapshot do
not silently adopt new bytes. No journal migration/reset was performed or added.

## Post-push CI investigation

Run [42794349514](https://github.com/Wahsekim/AI.Team/actions/runs/42794349514)
on `780aa26` failed on Linux Node 24: the existing concurrent SessionStart test
received exit code 1 from one start hook. The macOS Node 24 job was canceled by
matrix fail-fast, not a second reported assertion failure. Both Node 22 jobs,
ShellCheck and secret scan passed. The watchdog scripts and test were unchanged
from the branch's main baseline at that head.

The focused test and 40 isolated two-start races passed locally on macOS with
Node 24. This does not establish the Linux failure's cause or prove it harmless.
The follow-up adds captured hook stdout/stderr to the two existing exit-code
assertions, without changing their expected values or adding automatic retries.
This is diagnostic coverage, not a claimed watchdog fix. A later green run alone
cannot establish that the original intermittent failure has been repaired.

The feature remains an offline foundation. Real deployment, permissions/ownership,
session continuation, usage settlement and live trials remain unresolved as
documented in G-01–G-06/E-01.
