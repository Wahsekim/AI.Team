# Storage policy for Router/Worker state (rollout gate G-06)

Decision: **trusted operator** (owner, 2026-11-13). No external monotonic record
and no remote service is introduced.

## What the state is

| State | Holds | Where |
|---|---|---|
| Retry store and registry (`*.rw-retries.sqlite*`, `.rw-retries-*/`) | attempts, sessions and stops per ticket | local, gitignored |
| Registry anchor | the trust anchor of the registry | an operator-controlled file kept apart from the registry |
| Settlement ledger (`*.rw-settlement.json`) | measured usage per ticket | local, gitignored |
| Ownership lease (`rw-ownership-lease.json`) | which host owns a product | the product's Git directory |

None of it is committed, so nothing outside the machine can show that a copy is
old. The code detects a partial rollback (a database replaced while newer
checkpoints survive, a ledger that does not match its digest). It does not
detect a rollback of the whole state: an older, self-consistent copy reads as
fewer attempts and less spend, which would lift the retry cap and the budget
gate.

## The boundary

The operator is trusted not to roll this state back. Concretely:

1. Do not restore these files from a backup, copy them from another machine or
   replace them with an earlier copy while any ticket they describe is open.
2. If the whole state was rolled back anyway (restore, disk recovery, machine
   move), **nothing continues automatically**. Before any further call the
   operator records a `stop` with reason `operator-stop` on every affected
   ticket and reviews each by hand: attempts made, usage spent, candidate state.
3. Do not create a fresh journal or ledger for a ticket that already has one.
4. Keep the registry anchor apart from the registry and compare it by digest on
   every open, as [the registry](retry-registry.md) describes.

Enforcement is policy, not code. The residual risk is an operator who restores
a backup and does not notice; the result is more attempts or spend than the
caps allow, never an unverified delivery, because independent verification and
PM-only commits do not depend on this state.

A deployment with more than one operator, or one that cannot give this
assurance, needs the stronger option (an append-only record outside the
machine, compared at every open). That is not built.
