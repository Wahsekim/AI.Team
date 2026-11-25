#!/bin/bash
# check-public-data.sh — refuse client identifiers in the tracked tree of this
# public repository. History is not scanned: a past leak cannot be fixed by CI.
#
# Usage: scripts/check-public-data.sh [ROOT]   (default ROOT: .)
# Patterns: tracker work-package ids (OP# then digits) always, plus one extended regex
# per line of $PUBLIC_DATA_DENYLIST (a CI secret, so the names it lists are
# not themselves published). Matching is case-insensitive.
# A hit prints only file:line and the pattern number, never the matched text,
# because CI logs are public.
set -uo pipefail

ROOT="${1:-.}"
PATTERNS=('OP#[0-9]+')
while IFS= read -r line; do
  [ -n "$line" ] && PATTERNS+=("$line")
done <<< "${PUBLIC_DATA_DENYLIST:-}"

hits=0
for i in "${!PATTERNS[@]}"; do
  while IFS= read -r loc; do
    echo "FAIL - pattern $((i + 1)) matches at $loc"
    hits=$((hits + 1))
  done < <(git -C "$ROOT" grep -n -I -i -E -e "${PATTERNS[$i]}" -- . | cut -d: -f1,2)
done

if [ "$hits" -gt 0 ]; then
  echo "RESULT: CLIENT-DATA-FOUND — $hits line(s); replace them with synthetic data (Sample Project, T-1, src/ paths)"
  exit 1
fi
echo "RESULT: CLEAN — ${#PATTERNS[@]} pattern(s), no match in the tracked tree"
