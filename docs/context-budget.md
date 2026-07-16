# Context Budget (P1-05)

Cold-start prompt load is a cost and a reliability risk: the more standing
text a session must ingest, the higher the spend and the higher the chance a
rule is skipped. This file records the measured load, the budgets, and the
regime that keeps them from drifting.

Measure any time with:

```bash
scripts/measure-context.sh .
```

Tokens are estimated as bytes/4 — an order-of-magnitude gauge, not billing.

## Measured baseline (2026-07-16, fresh kit)

| Set | Files | Estimated tokens | Budget (ratchet) |
|---|---|---|---|
| PM wake set | CLAUDE.md, profiles x2, charter, agents/pm.md, meta-rules, workflow-catalog, lessons index | ~17,900 | 25,000 |
| Worker read set (backend) | wrapper, role file, profiles x2, templates.md, meta-rules, verify-discipline, lessons index | ~8,300 | 10,000 |

Notes on conservatism: ledgers (`lifecycle`, `pm-decisions`, `memory/pm.md`)
are partial reads by protocol (last N entries/lines) and are excluded;
`templates.md` is counted in full although a dispatch uses one section.

## Budget regime

- The budgets above are **ratchets**: `measure-context.sh` exits 1 when a set
  exceeds its budget, so growth becomes a deliberate decision (raise the
  budget here, with a reason) instead of drift.
- Wire it next to the validator in review flows for doc-heavy changes; it is
  NOT part of the PM wake step (measurement is a maintenance activity).
- When trimming, prefer: move reference material out of always-read files
  into on-demand docs; keep always-read files to rules that change behavior.

## Enforcement-class labeling

Every rule surface should be readable as one of (see
`docs/harness-assumptions.md` → Enforcement classes):

- **runtime-enforced** — wrapper frontmatter (`model`/`effort`/`maxTurns`/
  `tools`/`permissionMode`), workflow budget gates, hook deny rules,
  engine validation/fail-closed paths (tested in `tests/`);
- **test-enforced** — invariants covered by `node --test tests/` and
  `scripts/validate-team.sh`;
- **advisory** — prompt-level conventions (token budgets, meta-rules,
  briefs). Never present an advisory rule as a mechanical control.

## Known duplication (dedupe candidates, checked 2026-07-16)

- "Workers do not spawn workers / only the PM dispatches" — stated in
  `CLAUDE.md` Hard Rules (authoritative) and restated in wrapper rules and
  `docs/engine.md` context. Restatements are acceptable ONLY as one-line
  pointers; full restatement is drift risk.
- "No external-service MCPs for workers / no MCP in-loop" — `CLAUDE.md`
  Hard Rules (authoritative), wrapper rules, `agents/pm.md`,
  `docs/engine.md`. Same pointer rule.
- Single-source values (models → roster; tier bands → `agents/pm.md`;
  budget/halt axes → charter) are already validator-checked
  (`drift-caps`/`drift-bands`/`drift-models`).

Rule of thumb: a rule lives in exactly ONE authority surface (per the
CLAUDE.md Authority Map); every other mention is a pointer, not a paraphrase.
