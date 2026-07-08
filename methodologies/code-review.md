# Code Review Methodology

Default stance: findings first, ordered by severity.

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

- [P1] Title - file:line
  Evidence and impact.

## Open Questions

## Test Gaps

## Summary
```

If no issues are found, say that clearly and name residual risk.
