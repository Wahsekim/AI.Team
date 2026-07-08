# Shared Agent Rules (`_shared/`)

Files here apply to every agent. The PM folds the relevant excerpts into each
brief; workers do not fetch mid-task.

## Files

| File | Purpose |
|---|---|
| `meta-rules.md` | standing meta-rules M1-M6; read at every brief construction |
| `verify-discipline.template.md` | clean-state verification discipline; copy to `verify-discipline.md` at bootstrap and fill stack placeholders |
| `browser-access.template.md` | real-browser UI verification mandate; copy to `browser-access.md` at bootstrap and fill |

Post-bootstrap, the instantiated `verify-discipline.md` and `browser-access.md`
are the operative files — overlays and briefs point at those, never at the
`.template.md` seeds.

## Single-Source Rules (anti-drift)

Certain values drift when restated. Each has exactly ONE home; every other file
points at it and never repeats the value.

| Value class | Single source | Everyone else |
|---|---|---|
| Per-role model + reasoning effort | `agents/roster.md` roster table | wrappers and briefs copy from it; roster wins on conflict |
| Token tier bands | `agents/pm.md` -> Rules -> Tier calibration | `meta-rules.md` M1 and `agents/templates.md` point there |
| Budget/halt axes (caps, ceilings, halt thresholds) | charter -> Canonical Budget/Halt Table | ADRs, overlays, briefs reference the table |
| Append-only surface rotation | `docs/process-index.md` -> Rotation Regime | each ledger carries a pointer header |

When a value must change, change it at the single source first (ADR when
material), then fix pointers. Restating a single-source value in another file
is a drift bug, not a convenience.
