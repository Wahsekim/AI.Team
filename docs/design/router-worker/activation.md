# Activation for one disposable smoke run

Status: this is the first step that makes Router/Worker wrappers runnable. It
calls no model and starts no run. Its only scope is `disposable-smoke`.

Until now every draft wrapper said "Do not run from this draft" and there was no
way to change that. Activation produces a **new copy** of the instance in which
the wrappers are runnable. The instance and its `kit/` are never written, so the
project's standing team is unchanged whatever happens in the smoke run.

```sh
node kit/scripts/activate-router-worker.mjs SPEC.json DRAFT.json /abs/NEW.rw-active \
  --instance <instance-root> --approval <approval.json> --approval-digest sha256:<64 hex>
```

Exit 0 prints the activation record; exit 2 is a refusal; exit 1 is usage.

## Owner approval

Activation needs a file written by the owner and, separately, the digest of that
file as the caller reviewed it (the same anchor pattern as the offline
preflight):

```json
{
  "schemaVersion": 1,
  "purpose": "router-worker-activation",
  "status": "approved",
  "scope": "disposable-smoke",
  "specDigest": "sha256:<digest of SPEC.json content>",
  "draftDigest": "sha256:<digest field of DRAFT.json>",
  "approvedBy": "<name>",
  "acceptedUnknowns": ["BASH_NOT_SANDBOXED"]
}
```

The approval is for exactly one spec and one draft. A file digest is a
consistency check, not a signature: it shows the file is the one that was
reviewed, not who wrote it.

`acceptedUnknowns` may list only findings of the
[isolation gate](isolation-observation.md) that an owner is allowed to accept.
Today that is `BASH_NOT_SANDBOXED` alone: the check worker needs Bash to run the
project's tests, and ADR 0006 already states that a same-UID checkout is not a
sandbox and that the disposable clone is the boundary. A `blocked` finding can
never be accepted. An accepted finding stays in the isolation record with
severity `accepted`; it no longer keeps the gate from `clear`. Only an activated
copy carries accepted findings.

## What activation does

1. Stages a fresh copy from the instance and the pinned kit (the same code as
   `team-mode.mjs stage`). An existing staging directory is not trusted or reused.
   A refused activation removes only a staging copy it created itself; a
   directory another attempt put at that path is left as it is.
2. Refuses unless the copy passes the unmodified deployment validator, its read
   closure is complete and every enabled workflow duty is staffed.
3. Replaces each inactive marker the draft wrote (wrappers, worker role files,
   the common protocol, the routing supplement, the roster) with an activation
   line. Each marker must be found exactly once. Model, turn limit, tools,
   denied tools and permission mode of every wrapper are left byte-identical.
4. Writes `profiles/team-mode.json` with `status: activated-disposable-smoke`,
   `launchable: true` and the approval, spec and draft digests.
5. Runs the deployment validator again on the result, then renames the
   directory to its `.rw-active` name. A refusal at any step deletes the copy.

## Refusals

| Code | Reason |
|---|---|
| `INVALID_ACTIVATION` | destination not a new absolute `.rw-active` path, or unreadable input |
| `APPROVAL_MISSING`, `APPROVAL_CHANGED` | no approval file, or it differs from the reviewed digest |
| `APPROVAL_INVALID` | wrong purpose, status or scope; another spec or draft; no approver; an unknown field; a finding that may not be accepted |
| `ACTIVATION_REFUSED` | staging failed, validator failed, a duty is unstaffed, or an inactive marker is missing or duplicated |

## Using the activated copy

The runtime starts in the `.rw-active` directory. Before any call the host still
needs, each on its own record: the ownership lease held by that directory on a
disposable clone of the product, the [write boundary](write-boundary.md) armed
for that product, the isolation gate `clear` with that lease, the
frozen run arguments, and the budget gate from settlement. Activation replaces
none of them. After the run the copy is deleted or archived, never reused and
never merged back into the instance.

## Not covered

- Everything a live run alone can show: independent sessions, runtime
  enforcement of the tool lists, canary negatives.
- Creating the disposable product clone.
- The wall-clock and plan-window ceilings of ADR 0006 are owner-attended policy.
- Retries need a main-session resume ([continuation](continuation.md)); the
  smoke scope is one execution and one check.
- No activation of the instance itself, and no scope other than
  `disposable-smoke`, exists.
