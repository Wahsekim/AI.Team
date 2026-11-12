# PM Memory

Append-only, dated. PM writes one delta block at the end of every cycle. The
PM reads the counters block + the last few dated blocks only; cold sessions
never read this file in full.
Rotation: slim-active + archive (`docs/process-index.md` -> Rotation Regime).
When past ~300 lines, rotate dated blocks to
`memory/pm-archive-<from>_<to>.md` and keep the last 2-3 blocks verbatim.

## Counters

```yaml
feature_cycles_since_hardening: 0
coaching_triggers_queued: 0
last_coaching_lifecycle_entry: none
last_audit_lifecycle_entry: none
last_hardening_reset_entry: none
```

**Counter rules:** this structured block is the CANONICAL value; every
increment ALSO appears in the same cycle's close line — both move together,
atomically, never one without the other (prose-only counters drift).
`feature_cycles_since_hardening` resets to 0 on hardening-recon completion,
wave or no wave, recording the recon's lifecycle entry in
`last_hardening_reset_entry`. Reconcile counters against the lifecycle log at
every rotation.

---

<!-- SEED — REPLACE AT BOOTSTRAP, DO NOT KEEP. Write your real cycle-001 block
     (real date, real state, real open threads, plus the bootstrap-validation
     note listing the paths actually verified) using the shape below, and
     DELETE this comment and the skeleton. A placeholder date or an
     already-resolved open thread left here poisons every later cold read. -->

```md
## <YYYY-MM-DD> - cycle 001

### State
- <what actually happened this cycle>

### Surprises
- <or "none">

### Open Threads
- <real open threads only>

### What Next Wake Should Look At First
- <files/tickets>
```
