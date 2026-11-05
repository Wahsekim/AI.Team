# Role-specific methods

This kit carries selected methods from [Matt Pocock](https://github.com/mattpocock/skills)
and [Lauren Tan's original Pstack](https://github.com/cursor/plugins/tree/main/pstack).
It neither installs plugins globally nor requires an agent-specific skill loader.
The PM explicitly supplies a role and task at brief construction time. The worker
receives a **reviewed excerpt**, not a slash command or a new permission.

| Role | Task value | Upstream source | Evidence expected |
|---|---|---|---|
| PM | `spec` | to-spec (formerly to-prd) | scoped draft, test seams, exclusions |
| PM | `tickets` | to-tickets (formerly to-issues) | reviewable slices and blocking edges |
| Backend or Frontend | `debug` | diagnosing-bugs (formerly diagnose) | red reproduction, green regression or explicit blocker |
| Architect | `interface-design` | architect's rationale and design-red-flags references | caller-first sketch, tradeoffs and risks |
| QA, Verifier or Reviewer | `impact-review` | blast-radius | downstream assumption, executable proof or explicitly unproven |

Role IDs on the command line are lowercase; the reviewer/verifier aliases do
not create new roster roles. Ordinary features, typo fixes and unrelated work
get no extra prompt. Use explicit classification, not keyword matching. Example:

```sh
node scripts/role-skills.mjs brief backend debug
node scripts/role-skills.mjs brief qa impact-review
node scripts/role-skills.mjs brief backend copy-edit   # empty stdout
```

There is no engine schema change: for count runs prepare the worker's `brief`
and `verifierBrief` separately, in advance. For inline/wrapper dispatch the
same PM instruction applies. Selection and injection are not proof the model
followed the method; record observable outcomes instead. There is no runtime
access-control claim. The upstream snapshots are regular repository files.

## Why excerpts?

The PM drafting methods omit tracker publication. Pstack architect ordinarily
launches an arena; blast-radius can call other skills/models. Workers are not
coordinators. Only local design/review material is injected. Do not recursively
install dependencies, switch models, spawn workers or authorize external
writes because a third-party instruction asks. The existing charter, task
authority, budget, QA checks and stop rules still apply. The vendored optional
debug HITL template is data, not a hook; never execute it automatically.

## Updates

The allowlist and renderer are in `scripts/role-skills.mjs`. Upstream IDs,
file SHA-256s and MIT notices are retained in `agents/skill-packs/`. Dispatch
is offline and verifies the selected source before emitting any text.

1. `node scripts/role-skills.mjs verify` checks the installed pins offline.
2. `node scripts/role-skills.mjs check-upstream` fetches each official Git
   HEAD into temporary storage and compares **only the selected files**.
   Exit 0 = unchanged; 1 = drift; 2 = error/incompatible input. It never
   adopts upstream changes. For the weekly report see below.
3. Review upstream changes including licenses, subordinate references,
   side effects, and renderer boundaries. In a clean worktree run
   `node scripts/role-skills.mjs refresh matt FULL_UPSTREAM_COMMIT_SHA` or
   `refresh pstack FULL_UPSTREAM_COMMIT_SHA`. Optionally append a trusted
   local upstream checkout path to read Git objects without the network.
   This rewrites only that source's allowlisted bytes and lock entry.
4. Inspect the source diff **and the rendered briefs**, then run
   `node --test tests/role-skills.test.mjs` and the normal kit checks before
   committing. Missing/renamed files, incompatible headings or capability
   changes require a human decision, not automatic fallback to another skill.
   Roll back the update commit as a unit (snapshots + lock + renderer).

### Weekly read-only report

After this workflow reaches the default branch, Actions checks on Mondays at
07:17 UTC or on manual dispatch on that branch. No push trigger, repository
write token, bot branch or PR. Leave Actions PR creation disabled for this
feature. The ephemeral checkout can materialize candidate files for the
diff; no Git commit or remote write is made. An available update appears in
the run summary and the job exits nonzero to flag that PM review is needed.

The PM can rehearse locally in a clean disposable checkout with
`node scripts/role-skills.mjs prepare-update /tmp/new-proposal.md` (use a
previously absent report path). Check the source, rendered methods, tests
and per-dispatch token budget. Only the PM may commit an accepted update on
a working branch; push authority remains separate. See [ADR 0007](../decisions/0007-pm-only-commits.md).
Existing deployments must still pull or be updated; in-flight briefs do not change.
