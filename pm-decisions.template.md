# PM Decisions

Terse ledger. One line for dispatch, one line for close. Owner's primary audit
surface — scannable in under a minute.

Budget/halt values live in the charter's Canonical Budget/Halt Table —
reference it, never restate values here.
Rotation: slim-active + archive (`docs/process-index.md` -> Rotation Regime).
When the ledger grows past ~200 lines, rotate to
`pm-decisions-archive-<from>_<to>.md` (byte-identical, immutable) and keep the
tail verbatim for continuity.

## Format

```text
YYYY-MM-DD {{TICKET_ID}} -> {{ROLE_DISPLAY_NAME}}, est {{N}} tok, brief: agents/lifecycle.md#[NNN], why: {{ONE_PHRASE}}
            -> closed: actual {{N}} tok (var {{+/-N%}}), outcome: {{<=30_WORDS}}, lifecycle: [NNN]
```

Engine-mode batches: one dispatch+close line per iteration, reconstructed from
the engine's `results[]` (per `docs/engine.md`), under a dated batch line.

---
