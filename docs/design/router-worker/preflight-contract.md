# Offline Router/Worker preflight contract

Implemented 2026-11-08. This is local consistency evidence, not deployment
authorization. Every successful result remains `launchable: false`.

## Invocation

```sh
node scripts/preflight-router-worker.mjs INPUT.json TEAM_ROOT APPROVAL_RELATIVE_PATH REVIEWED_APPROVAL_SHA256
```

The last argument is `sha256:<64 lowercase hex>` over the exact approval file
bytes, supplied separately by the reviewing PM/owner workflow. The command does
not derive that anchor from the file it is supposed to verify. Do not let an
untrusted task choose both its approval record and its trusted digest.

Success emits JSON on stdout and exits 0. Invalid inputs or failed checks emit
structured errors on stderr, no partial stdout, and exit 2; usage errors exit 1.
The CLI performs no dispatch, shell execution, network call or file writes.

The library entry is:

```js
preflight({ input, teamRoot, approvalPath, expectedApprovalDigest })
// => { preview, preflight } or { errors: [{ code, field, reason }] }
```

`input` is the existing version-1 or version-2 compiler input. The team root must
be a canonical non-symlink directory. Approval and source paths are literal,
normalized paths relative to that root; no glob, traversal or symlink components
are accepted. The input and each source file are limited to 1 MiB. The approval,
reference records and declared context file bundle are capped at 4 MiB total;
the method loader retains its separate pinned-file limits.

## Approval record

The record has exactly:

| Field | Required value / meaning |
|---|---|
| `schemaVersion` | `1` |
| `purpose` | `offline-preflight`, never live-launch authority |
| `status` | `approved`; consistency check only, not proof of a human signature |
| `inputDigest` | Existing canonical JSON digest of the complete compiler input |
| `sources` | Exactly one `{field, path}` entry for each reference below |
| `context` | Approved declared-read graph, measurement metric and ratchet limits |

Required references are `policy.approvalRef`, `policy.stackRef`,
`policy.runtimeRef`, `policy.rosterRef`, `mandate.approvalRef`, and the three
`policy.profiles.<exec|check|guard>.permissionRef` fields.

Each reference resolves to a JSON record with exactly `{id, value}`. Its `id`
must equal the input reference ID; `digest(value)` must equal the reference
digest. The stack value must expose `verificationCommands` equal to the proposed
policy commands. The roster value must expose `wrappers: {exec, check, guard}`
equal to the proposed wrapper identifiers. Other record values are frozen
evidence, not an implemented interpretation of runtime permissions or approvals.

These versioned JSON records are a new offline adapter input. They are **not**
already generated from the legacy Markdown files. RW-03 must define their
generation and independent validation against real instantiated source files.
Do not create a second manually divergent roster or policy in deployment.

## Declared context graph

`context` contains exactly:

- `metric: "ceil-utf8-bytes/4"`.
- `roots: {exec: [paths], check: [paths], guard: [paths]}`. Each duty must include
  `.claude/agents/<declared-wrapper>.md` among its roots.
- `limits: {exec: positiveInteger, check: positiveInteger, guard: positiveInteger}`.
  These are explicit approved ratchet values, not defaults inferred by the model.
- `nodes: [{path, sha256, reads: [paths]}]`, at most 256 nodes. Every referenced
  dependency must have a node and every node must be reachable from a root.

For each duty, traverse the declared graph and count each reachable file once.
Cycles do not inflate the count. Verify each file's raw-byte digest, then compute
`ceil((sourceBytes + renderedBriefBytes) / 4)`. Exec/check include their frozen
briefs, including selected method bodies and metadata. A source path read by
different duties is counted for each duty, because those are separate contexts.

This follows the existing bytes/4 estimation convention, with explicitly
conservative rounding once per combined set rather than the legacy script's
per-file integer truncation. It is neither tokenizer output nor a billing meter.
There is no automatic truncation or budget increase on overflow.

Guardian currently has no complete frozen invocation prompt: only its declared
file set is measured, with `includesBrief: false`. Every duty has
`completeInvocation: false`, because runtime-injected context and read-graph
completeness are not established. Missing Guardian prompt measurement cannot be
interpreted as zero actual context or sufficient rollout evidence.

## Evidence and limits

The successful preflight record binds the reviewed approval bytes, full input,
compiler preview, source-file byte inventory, context measurements and unresolved
gates. Its own digest excludes itself. The loader re-reads frozen files before
returning; v2 method bundles are freshly resolved and compared again as well.

This detects local drift during ordinary preflight operation. It is not an
atomic filesystem transaction and does not protect against a hostile local
writer racing checks or changing files after return. RW-04 must freeze/revalidate
the complete launch bundle at admission.

Specifically **not proven**:

- Human identity, genuine consent, expiry or revocation of the supplied approval.
- Whether natural-language wrapper instructions secretly imply more file reads
  than the approved graph declares; the graph is not inferred from prose.
- Runtime wrapper registration, actual tool permissions, model/effort settings,
  sandbox isolation or complete runtime prompt size.
- Product checkout identity, post-exec candidate/diff, security coverage,
  governance equivalence, live retry counters or usage/delivery settlement.

The tests use temporary synthetic records, wrappers and approvals. They establish
source consistency and refusal behavior only. Do not rename this stage
`STATIC_VALIDATED` for the entire team or use its result as a launch token.
