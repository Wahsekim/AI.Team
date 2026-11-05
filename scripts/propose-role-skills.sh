#!/usr/bin/env bash
# Publisher for a tested disposable checkout. Never push to the base or force.
set -euo pipefail
report=${1:?pass the prepared Markdown report}
base=${GITHUB_REF_NAME:?}
repo=${GITHUB_REPOSITORY:?}
: "${GH_TOKEN:?workflow token required}" "${DEFAULT_BRANCH:?}"
[[ "$base" == "$DEFAULT_BRANCH" || "$base" == codex/role-skill-packs ]] || exit 2
[[ -s "$report" ]] || exit 2
git check-ref-format "refs/heads/$base"
git diff --cached --quiet || { echo 'Refusing an already staged checkout'; exit 2; }
git add -- agents/skill-packs/
git diff --cached --quiet && { echo 'No skill update'; exit 0; }
git diff --quiet || { echo 'Unexpected unstaged changes'; exit 2; }
base_sha=$(git rev-parse HEAD)
old=$(git rev-parse HEAD:agents/skill-packs/lock.json)
new=$(git rev-parse :agents/skill-packs/lock.json)
[[ "$old" != "$new" ]] || { echo 'Refusing pack edits without lock change'; exit 2; }
prefix="codex/skill-updates/$base/"
head="$prefix$old-$new"
owner=${repo%%/*}
open=$(gh api --method GET --paginate "repos/$repo/pulls" -f "base=$base" -f state=open \
  --jq '.[] | select(.head.repo.full_name == .base.repo.full_name) | .head.ref')
while IFS= read -r ref; do
  if [[ "$ref" == "$prefix"* ]]; then echo "Existing proposal: $ref; leaving it for review."; exit 0; fi
done <<< "$open"
previous=$(gh api --method GET "repos/$repo/pulls" -f "base=$base" -f "head=$owner:$head" -f state=all --jq '.[0].number // empty')
if [[ -n "$previous" ]]; then echo "Already proposed in #$previous; not reopening."; exit 0; fi
gh auth setup-git
tip=$(git ls-remote origin "refs/heads/$base")
[[ "${tip%%[[:space:]]*}" == "$base_sha" ]] || { echo 'Base moved; rerun against the new base.'; exit 2; }
existing=$(git ls-remote origin "refs/heads/$head")
if [[ -n "$existing" ]]; then
  # Recover from a push followed by an API failure. Refuse human-edited heads.
  git fetch --no-tags --depth=2 origin "refs/heads/$head"
  [[ "$(git rev-parse 'FETCH_HEAD^')" == "$base_sha" && "$(git rev-parse 'FETCH_HEAD^{tree}')" == "$(git write-tree)" ]] || {
    echo 'Existing proposal branch differs; manual review required.'; exit 2;
  }
else
  git -c user.name='github-actions[bot]' -c user.email='41898282+github-actions[bot]@users.noreply.github.com' \
    commit -m 'chore(skills): refresh reviewed-role upstream candidates'
  git push origin "HEAD:refs/heads/$head"
fi
gh pr create --repo "$repo" --base "$base" --head "$head" \
  --title 'Review upstream role skill changes' --body-file "$report"
