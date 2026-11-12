# Decisions Index

ADRs are numbered and append-only. Use `0000-template.md` for new decisions.

| ADR | Date | Status | Title |
|---|---|---|---|
| 0000 | YYYY-MM-DD | template | ADR template |
| 0001 | 2026-10-06 | Accepted | Loop/Graph rollout execution decisions |
| 0002 | 2026-10-07 | Accepted for implementation (PM sign-off; owner ratification pending) | One local execution owner per state directory (R03a) |
| 0003 | 2026-10-07 | Accepted for implementation (owner approved the behavior change; ratification pending) | Product-target isolation (R03b) |
| 0004 | 2026-10-07 | Accepted for implementation (PM sign-off; owner ratification pending) | Durable stop record (R04a) |
| 0005 | 2026-10-07 | Accepted for implementation (PM sign-off; owner ratification pending) | Conservative recovery commands (R05b) |
| 0006 | 2026-11-05 | Proposed (owner ratification pending) | Pilot operating contract (R06) |
| [0007](0007-pm-only-commits.md) | 2026-11-05 | Accepted (owner direction) | PM-only commits; read-only skill update reporting |
| [0008](0008-router-worker-topology.md) | 2026-11-09 | Accepted (topology/retry mapping only; live activation gated) | Optional Router/Worker topology |
| [0009](0009-kit-instance-separation.md) | 2026-11-12 | Accepted (owner ratification 2026-11-12) | Separate the kit root from the project instance root |

## When To Write An ADR

- stack choice or stack change;
- project/team governance change;
- security/auth/data exposure decision;
- persistence/migration strategy;
- documentation completeness policy;
- methodology/profile lock;
- any owner-ratified exception to the charter.

