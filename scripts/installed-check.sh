#!/usr/bin/env bash
# Linux half of the installed-app check (ADR 0092, amendment of 2026-10-30): install the .deb
# (into /usr/lib, which this user cannot write) and start it with `--self-test`, then run the
# AppImage from a folder whose name has spaces and non-ASCII letters, each with a fresh data
# folder. The shell finds its runtime through Tauri's resource_dir() as a normal launch does,
# starts the daemon and waits for /health, /me and /setup. Exit 1 when either fails.
#
# Usage: bash scripts/installed-check.sh <path to .deb> <path to .AppImage>
# Needs sudo for apt; the self-tests run as the calling (non-root) user.
set -euo pipefail
deb="$(readlink -f "$1")"
appimage="$(readlink -f "$2")"
work="$(mktemp -d)"
fail=0
summary=()

run_case() {
  local name="$1"
  shift
  local home="$work/home $RANDOM"
  local report="$work/report-$RANDOM.json"
  mkdir -p "$home"
  echo "=== $name ==="
  set +e
  FORERUNNER_HOME="$home" "$@" --self-test --report "$report"
  local code=$?
  set -e
  if [ "$code" -eq 0 ] && grep -q '"ok": true' "$report" 2>/dev/null; then
    summary+=("- $name: ok")
  else
    echo "self-test exit $code"
    [ -f "$report" ] && cat "$report"
    summary+=("- $name: FAILED (exit $code)")
    fail=1
  fi
}

# 1. The .deb: /usr/lib/Forerunner is read-only for this user.
sudo apt-get install -y "$deb" >/dev/null
if [ "$(id -u)" -eq 0 ]; then
  echo "run this as a non-root user: the install folder must be read-only for the app" >&2
  exit 2
fi
run_case ".deb in /usr/lib (read-only)" /usr/bin/forerunner-desktop
sudo apt-get remove -y forerunner >/dev/null || sudo dpkg -r forerunner >/dev/null || true

# 2. The AppImage from a folder with spaces and non-ASCII letters. Without FUSE (CI) it
# extracts itself and runs from there; resource_dir() follows APPDIR either way.
dir="$work/My Apps/Forerünner Ä"
mkdir -p "$dir"
cp "$appimage" "$dir/Forerunner.AppImage"
chmod +x "$dir/Forerunner.AppImage"
APPIMAGE_EXTRACT_AND_RUN=1 run_case "AppImage from a folder with spaces and non-ASCII" "$dir/Forerunner.AppImage"

printf '%s\n' "${summary[@]}"
if [ -n "${GITHUB_STEP_SUMMARY:-}" ]; then
  { echo "### Installed app check (Linux)"; printf '%s\n' "${summary[@]}"; } >>"$GITHUB_STEP_SUMMARY"
fi
rm -rf "$work"
exit "$fail"
