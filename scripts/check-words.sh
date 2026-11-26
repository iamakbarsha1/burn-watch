#!/bin/sh
# v2 rule 6: neutral words in product source. Fails on any of these words in
# non-test source of the dashboard, the API and the shared packages, unless the
# file and word are on the allowlist.
set -eu
cd "$(git rev-parse --show-toplevel)"

WORDS='leaderboard|streaks?|stuck|missed|violations?|scores?'

# file<TAB>word, lower case. Each line says why the word stays.
ALLOW='apps/dashboard/src/lib/audit.ts	leaderboard
packages/shared/src/types.ts	leaderboard
packages/db/src/migrations.ts	leaderboard'
# lib/audit.ts, types.ts: audit actions and surfaces for rows written before v2 removed the leaderboard.
# migrations.ts: migration 0005 removes the leaderboard settings; its id is recorded in every database.

# git grep exits 1 when nothing matches; that is the pass case.
raw=$(git grep -niwoE "$WORDS" -- apps/dashboard/src apps/api/src packages/*/src \
  ':!*.test.ts' ':!*.test.tsx') || [ $? -eq 1 ]
hits=$(printf '%s\n' "$raw" | ALLOW="$ALLOW" awk -F: '
  BEGIN { n = split(ENVIRON["ALLOW"], a, "\n"); for (i = 1; i <= n; i++) ok[a[i]] = 1 }
  NF >= 3 { word = tolower($3); if (!(($1 "\t" word) in ok)) print }
')

if [ -n "$hits" ]; then
  echo "Words v2 keeps out of product source (see docs/ARCHITECTURE.md rule 6):"
  echo "$hits"
  exit 1
fi
echo "check-words: ok"
