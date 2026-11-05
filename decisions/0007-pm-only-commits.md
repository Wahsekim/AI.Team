# ADR 0007: PM-only commits; read-only skill update reporting

Date: 2026-11-05
Status: Accepted (owner direction: “only the pm session commits”).

Only the PM session may create commits in the AI.Team repository, on a
working branch. Workers hand back diffs and test evidence. Push authority is
per task: the PM pushes only the working branch the owner named or approved
for that task (a branch created for owner-directed work counts as approved
for that work); never `main`, never `--force`. No standing branch name is
authorized — the earlier `codex/loop-graph-mvp` allowance is retired with
that branch. This supersedes the broader agent-commit wording.

We considered letting a weekly bot open update PRs. That requires a remote
branch push even before GitHub accepts the PR request. We reject this
exception: the skill monitor gets read-only repository access and may show a
diff, never create commits, refs or PRs. Do not enable PR-write permissions
for this feature. The PM reviews the pinned candidate and makes any commit.
