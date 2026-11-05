# Code Review Methodology

Default stance: findings first, ordered by severity.

## Severity Gate (evidence, not vibes)

- `[P1 blocking]` must cite either a concrete failure scenario (the input or
  state that triggers it and the resulting misbehavior) or the exact rule it
  breaks. A finding that can cite neither is at most `[P2 non-blocking]`.
- A speculative or theoretical risk that needs an unlikely precondition is at
  most `[P3 nit]`.
- Label every finding inline so a first-time reader understands it: never a
  bare `P1`; write `[P1 blocking]` (must fix before merge),
  `[P2 non-blocking]` (suggestion), `[P3 nit]` (polish, theoretical edge,
  coverage deferred to CI).
- Do not cap the number of findings; gate severity instead. Never restate a
  finding already resolved in the current diff.
- A change to runtime behavior (anything beyond a docs-only or tests-only
  diff) needs ONE representative real-run record (real command, real exit
  code — `_shared/verify-discipline.md`); lacking it is `[P1 blocking]`.
  One representative run is enough: untested extra profiles or platforms the
  author flagged untestable here are at most `[P3 nit]`, never a matrix
  demand.

## Review Scope

- behavioral regressions;
- data loss or migration risk;
- security/auth/session risk;
- broken contracts;
- missing or weak tests;
- unclear ownership or maintainability problems;
- docs/profile drift.

## Output

```md
## Findings

- [P1 blocking] Title - file:line
  Failure scenario or rule broken; impact.

## Open Questions

## Test Gaps

## Summary
```

If no issues are found, say that clearly and name residual risk.
