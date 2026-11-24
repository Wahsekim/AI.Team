# AI Team dashboard

A read-only page that shows one team instance's latest Router/Worker batch:
which ticket ran, which step it reached, what it cost, and what waits for the
PM. It is generated on demand as one static HTML file. It never writes into the
instance and never changes how a batch runs.

Design source: the owner's design of 2026-11-18 (`AI-Team-Dashboard-Design`,
v1.0, with `dashboard-prototype.html` as the visual reference). This is the
first slice of its phase 1.

## Usage

```bash
node scripts/dashboard.mjs --instance <instance-root> > dashboard.html
node scripts/dashboard.mjs --instance <instance-root> \
  --transcripts ~/.claude/projects/<project>/<session-id> \
  --quota ~/.claude/ai-team/quota.json \
  --now 2026-11-24T18:00:00Z > dashboard.html
```

| Flag | Required | Effect |
|---|---|---|
| `--instance <root>` | yes | Instance root to read (the folder holding `profiles/`, `batches/`, `.claude/`). |
| `--transcripts <session-dir>` | no | Claude Code session folder of the PM session that ran the batch. Adds the per-step token split (input, output, cache write, cache read) and the observed model, read through `scripts/measure-spawn.mjs --json`. |
| `--quota <file>` | no | Account quota snapshot (format below). Without it the quota bar says "Unavailable". |
| `--now <iso>` | no | Clock used for "waiting" and "still open" durations. Default: the host clock. |

Exit 2 on a missing or wrong `--instance`, an unknown flag or a bad `--now`.
Open the file in a browser. Regenerate it to refresh.

The page is self-contained: CSS, the selection script and the 12 Lucide icons
(ISC licence notice in `src/dashboard/icons.mjs`) are inline, and a
Content-Security-Policy of `default-src 'none'` blocks any fetch. Artifact
chips link to the record files with `file://` URLs, so the page holds the
instance's absolute path; keep it local.

Quota file format (written by a statusline adapter that does not exist yet):

```json
{ "account_id": "...", "sampled_at": "2026-11-24T17:58:00Z",
  "windows": { "five_hour": { "used_percentage": 37, "resets_at": "2026-11-24T20:00:00Z" },
               "seven_day": { "used_percentage": 12, "resets_at": 1764316800 } } }
```

`resets_at` takes an ISO string or epoch seconds. A snapshot sampled more than
10 minutes before collection renders as "Stale" with its sampling time.

## Shape

| File | Role |
|---|---|
| `src/dashboard/model.mjs` | The snapshot shape and the Field constructors. The only contract between collector and renderer. |
| `src/dashboard/collect.mjs` | `collect(instanceRoot, opts) -> snapshot`. Read-only. Batch selection and batch-level fields. |
| `src/dashboard/ticket.mjs` | One ticket and its three steps, derived from the batch records. Pure. |
| `src/dashboard/render.mjs` | `render(snapshot) -> html`. Escapes every instance string. |
| `src/dashboard/strings.mjs`, `style.css`, `client.js`, `icons.mjs` | UI copy, styles (from the prototype), ticket and step selection, inline icons. |
| `scripts/dashboard.mjs` | Argument parsing and stdout. |

Every value that could be mistaken for data is a Field
`{ state, value, source, reason }`:

| State | Meaning | Rendered as |
|---|---|---|
| `available` | Read as is from a record. | The value. |
| `derived` | Computed from records; `source` names the method. | The value, with "(approx.)" when the source is tool activity. |
| `counting` | The record that settles it is not written yet. | "Counting". |
| `stale` | Sampled too long ago (quota only). | The value plus "Stale" and its sampling time. |
| `not-applicable` | The field has no meaning here, such as a model for a kit step. | "Not applicable". |
| `unavailable` | No source exists today. | "Unavailable" and the reason. Never a sample value, a zero or an empty bar. |

The renderer marks every Field with `data-state`, which the tests read.

## Batch selection

If `<instance>/rw-batch.json` exists, the open batch at the root is shown.
Otherwise the archived batch in `batches/` with the latest `after.json`
`closedAt` (fallback `batch.json` `openedAt`) is shown. File modification
times are never used. Only an instance whose `profiles/team-mode.json` says
`router-worker` gets the batch view.

## Fields

Paths are relative to the batch folder unless they start with `profiles/` or `.claude/`.

| Panel | Field | State when present | Source | When unavailable |
|---|---|---|---|---|
| App bar | Project name, slug | available | `profiles/team-mode.json` `spec.project`; specialist: `profiles/project.md` | No name in either file. |
| App bar | Mode | available / derived | `team-mode.json` `mode`, `status`; no file means specialist | Never. |
| Quota | 5h and 7d used %, reset time, sampling time | available / stale | `--quota` file | No `--quota`, unreadable file, no valid window. |
| Project line | Milestone name and scope | none | none | Always: no declared milestone exists in the instance; the tracker is PM-only. |
| Project line | This batch tokens | available / counting | `settlement.json` `run.totalTokens` (tickets + guardian, input + cache write) | Counting until settlement. |
| Project line | Batch blockers | available | `after.json` `account.blockers` | Until the batch closes. Labelled batch blockers, not project blockers. |
| Project line | Instance total | derived | Sum of `run.totalTokens` over every `settlement.json`, one per `runId` | No settled batch. |
| Sidebar | Round and ceiling | available | `return.json` `itersRun`; `batch.json` `args.rounds` | Round of an open engine batch: progress lives in the Claude Code session until the engine returns. |
| Sidebar | Ticket total | available | `batch.json` `tickets[]` | Never for a batch. |
| Sidebar | Accepted count | available / derived | `after.json` `tickets[].status == passed`; before close `return.json` `verificationStatus` | No engine result yet. |
| Sidebar | Run, branch, opened, closed, archived | available | `batch.json`, `after.json`, `abandoned.json` | Closed/archived until they happen. |
| Sidebar | Run time | derived | `closedAt - openedAt`, or now minus `openedAt` while open | Never. |
| Sidebar | Waiting for PM | derived / not-applicable | now minus `closedAt` while a halt waits for acknowledgement | An archived batch: no record says when the halt was acknowledged. |
| Sidebar | Guardian, main session, reviews tokens (unattributed) | available / counting | `settlement.json` `calls[]` with `ticket: null`, `mainSessionTokens`, `reviewCost` | Counting until settlement. |
| Sidebar | Output tokens (engine) | available | `return.json` `budgetStatus.loopSpent` | No engine result yet. |
| Ticket | Id, title, goal, acceptance | available | `batch.json` `tickets[]` | Goal missing from the record. |
| Ticket | Status | derived | Rules below | Never. |
| Ticket | Attempt and ceiling | available | `return.json` `results[].attempts`; `batch.json` `limits.attemptsPerTicket` | No engine result yet ("Not dispatched"). |
| Ticket | Ticket tokens | available / counting | `settlement.json` `tickets[].spentTokens` | Counting until settlement. |
| Ticket | Output tokens | available | `return.json` `workerTokens + verifierTokens` | No engine result yet. |
| Step | State | derived | `return.json` `workerStatus`, `verificationStatus`; `commits.json`; `abandoned.json` | Pending until a result exists. |
| Step | Wrapper | available | `batch.json` `args.plan[]` | No plan entry. Commit step: not-applicable. |
| Step | Model | available / derived | Configured: `team-mode.json` `staffing.<duty>`; observed with `--transcripts` | No staffing entry. |
| Step | Activity, notes, failures, commands | available | `return.json` `worker.outcome/notes`, `verifier.summary/failures/commandsRun`; commit: `abandoned.json` / `after.json` `next` | No result yet. |
| Step | Last journal event | derived | `settlement.json` `ticketRecords[].journal.events` | "No journal event" before settlement. |
| Step | First tool call | derived (approx.) | `.claude/rw-write-boundary.log.jsonl`, lines of the step's wrapper inside the batch window | No tool call by that wrapper. |
| Step | Step time | derived (approx.) | Span between the first and last tool call of the wrapper | Fewer than two tool calls: journal events carry no timestamps. |
| Step | Tokens | available / counting | `settlement.json` `calls[]` by ticket and duty, one per `agentId` | Counting until settlement. |
| Step | Token split | derived | `measure-spawn.mjs --json` row per `agentId` | No `--transcripts`, or the agent's transcript is not in that folder. |
| Step | Artifacts | available | The batch record files, with their `digest` as version | A missing record shows as "not written". |
| Footer | Collected at, timezone, sources found and missing | derived | Host clock and `Intl` timezone | Never. |

Ticket status, first match wins: a `commits.json` entry with a sha is
Committed; `verificationStatus` passed is Accepted · awaiting commit; worker
`blocked` or `terminal_stop` is Blocked · awaiting PM; verification failed or a
worker error is Verification not passed · awaiting PM; any other engine result
is in progress; no result is Not dispatched, or, in an open batch,
"progress not recorded in the instance".

Rework: "return suggested" comes from `needsFixRetest` or `fixRetestQueue`;
"re-dispatched" only from `priorAttempts` or a journal `prepare` with
`continuationOf`. A suggested return draws a dashed arrow, a re-dispatch a solid
one. When the worker stopped before any change, no arrow is drawn and the note
says there is nothing to return.

## Token meters

The kit records two units for the same call, and the page keeps them apart:

- **input + cache write** (`input+cache_creation`): settlement, the budget gate's unit. Headline figure for tickets, steps and the batch.
- **output tokens, engine meter**: `return.json` worker and verifier deltas. Shown as a separate labelled line.

No figure on the page adds one unit to the other. The token split from
`--transcripts` shows all four classes side by side without a total.

## Defaults applied

The owner delegated the spec's open questions (spec section 4). Each took the
recommended default:

1. Primary token unit: settlement input + cache write as the headline; output in its own labelled line; never summed.
2. Quota: read from an optional `--quota` file in the proposed format; absent means "Unavailable — no quota source configured". The statusline adapter that would write it is not built.
3. Milestone: no declared scope, so the project line shows "milestone not declared" and no bar.
4. Blockers: batch blockers from `after.json`, labelled as such.
5. Worker blocked vs verification failed: the implement step is red "Blocked (scope/permission)", the ticket "Blocked · awaiting PM", no rework arrow; a verifier that ran no command because there was no candidate is grey "Stopped · no candidate".
6. Guardian and reviews: three steps only; the guardian verdict sits under the path, guardian and review tokens in the unattributed lines.
7. No open batch: the latest archived batch with the pill "Last executed" and the halt, blockers and next step in a PM banner.
8. Specialist instances: a reduced view stating that the batch view is unavailable and why. The lifecycle-only view is a later slice.
9. Step time: approximated from the write-boundary log and labelled "approx."; with one tool call it is unavailable.
10. Token split: only with `--transcripts`; otherwise "unavailable" with the reason.
11. Refresh: a static file regenerated on demand; no server.
12. Timezone: the host timezone from `Intl`, printed in the footer.
13. Language: English strings in one table (`src/dashboard/strings.mjs`).
14. Merged/delivered: not checked; the commit step stops at Committed.

One choice beyond the spec: every ticket view and step panel is rendered on
the server into hidden sections, and the inline script only toggles
visibility. No instance text is built in the browser, so escaping happens in
one place.

## Not in this slice

The quota snapshot writer, a milestone scope file, a project switcher, live
refresh, the specialist lifecycle view, the merge check, and the round of an
open engine batch. Main-session dispatch (`rw-dispatch.jsonl`) is not read.

## Tests

`node --test tests/dashboard.test.mjs`. The fixture
`tests/fixtures/dashboard/rw-instance/` is the real US-61 batch of the UHF
instance with host paths replaced by `<instance>`, `<product-root>` and
`<home>`.
