#!/usr/bin/env bash
# Re-create the given commits (oldest first) with identical trees, authors and messages, signed,
# remapping parents that were themselves re-created. Prints "old new" pairs and the new tip.
set -euo pipefail
declare -A map
new=""
for c in "$@"; do
  tree=$(git rev-parse "$c^{tree}")
  args=()
  for p in $(git log -1 --format=%P "$c"); do
    p=$(git rev-parse "$p")
    args+=(-p "${map[$p]:-$p}")
  done
  msgfile=$(mktemp)
  git log -1 --format=%B "$c" > "$msgfile"
  full=$(git rev-parse "$c")
  new=$(GIT_AUTHOR_NAME="$(git log -1 --format=%an "$c")" \
        GIT_AUTHOR_EMAIL="$(git log -1 --format=%ae "$c")" \
        GIT_AUTHOR_DATE="$(git log -1 --format=%aI "$c")" \
        git commit-tree -S "$tree" "${args[@]}" -F "$msgfile")
  rm -f "$msgfile"
  map[$full]=$new
  echo "$c -> $new"
done
echo "TIP $new"
