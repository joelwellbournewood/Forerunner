#!/usr/bin/env bash
# publish-release: tag the head of the default branch with the version it carries and push the
# tag, which starts .github/workflows/release.yml. One run, one confirmation.
#
#   scripts/publish-release.sh            the repository this clone came from
#   FORERUNNER_REPO=<url> publish-release.sh   any other copy (no clone needed)
#   FORERUNNER_BRANCH   the branch to tag (default claude/forerunner-1-0-build-o53s04)
#   FORERUNNER_YES=1    skip the confirmation (tests)
#
# It refuses when the tag exists, when the branch's versions disagree, or when CHANGELOG.md has
# no section for the version. It works in a temporary clone and leaves nothing behind.
set -euo pipefail

branch="${FORERUNNER_BRANCH:-claude/forerunner-1-0-build-o53s04}"
here="$(cd "$(dirname "$0")" && pwd)"
repo="${FORERUNNER_REPO:-}"
if [ -z "$repo" ]; then
  repo="$(git -C "$here" remote get-url origin 2>/dev/null || true)"
fi
if [ -z "$repo" ]; then
  read -r -p "Repository URL (for example https://github.com/<owner>/<repo>.git): " repo
fi
command -v git >/dev/null || { echo "publish-release: git is not installed"; exit 1; }

work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT
echo "Fetching $branch from $repo ..."
git clone --quiet --depth 1 --branch "$branch" "$repo" "$work/repo"
cd "$work/repo"

version="$(sed -n 's/^  "version": "\([^"]*\)".*/\1/p' package.json | head -n 1)"
[ -n "$version" ] || { echo "publish-release: no version in package.json"; exit 1; }
tag="v$version"
if command -v node >/dev/null && [ -f scripts/release-version.mjs ]; then
  node scripts/release-version.mjs --check --expect "$tag" >/dev/null ||
    { echo "publish-release: the version files do not all say $version"; exit 1; }
fi
grep -q "^## \[$version\]" CHANGELOG.md ||
  { echo "publish-release: CHANGELOG.md has no [$version] section"; exit 1; }
if [ -n "$(git ls-remote --tags origin "refs/tags/$tag")" ]; then
  echo "publish-release: $tag already exists; nothing to do"; exit 1
fi

commit="$(git rev-parse --short HEAD)"
echo
echo "  Release $tag"
echo "  Commit  $commit: $(git log -1 --format=%s)"
echo "  Branch  $branch"
echo
if [ "${FORERUNNER_YES:-}" != "1" ]; then
  read -r -p "Publish $tag? This builds and publishes the release. [y/N] " answer
  case "$answer" in y|Y|yes|YES) ;; *) echo "Nothing published."; exit 1 ;; esac
fi
git tag "$tag" HEAD
git push --quiet origin "refs/tags/$tag"
echo "Pushed $tag. The release builds now."
case "$repo" in
  https://github.com/*)
    url="${repo%.git}/actions/workflows/release.yml"
    echo "Watch it: $url"
    if [ "${FORERUNNER_YES:-}" != "1" ] && command -v xdg-open >/dev/null; then
      xdg-open "$url" >/dev/null 2>&1 || true
    fi
    ;;
esac
