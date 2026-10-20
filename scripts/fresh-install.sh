#!/usr/bin/env bash
# Forerunner fresh install for Linux (Ubuntu 22.04+, Debian 12+, Fedora 39+).
#
# Idempotent: every step checks before it changes anything, so running it twice is safe.
# Timed: each step prints its elapsed seconds; the summary fails the run when the total is
# over the budget (900 s, the "fresh install in under 15 minutes" release criterion).
#
# Usage: bash scripts/fresh-install.sh [--non-interactive] [--dry-run] [--with-desktop] [--skip-tests]
#
#   --non-interactive  never prompt; install prerequisites without asking (CI, VMs)
#   --dry-run          print every step and the commands it would run, change nothing
#   --with-desktop     also install the Tauri system libraries (only needed to build the desktop app)
#   --skip-tests       skip typecheck and unit tests (not allowed for the release gate)
#
# Environment:
#   FORERUNNER_REPO_URL              git URL to clone when the script is not run from a checkout
#   FORERUNNER_INSTALL_DIR           where to clone (default: $HOME/forerunner)
#   FORERUNNER_INSTALL_BUDGET_SECONDS  time budget (default 900)
#   FORERUNNER_HOME                  overrides the application directories (see platform-notes.md)
#
# Exit codes: 0 ok, 1 a step failed, 2 configuration (no repository known), 3 over the time budget.
set -Eeuo pipefail

SCRIPT_START=$(date +%s)
BUDGET=${FORERUNNER_INSTALL_BUDGET_SECONDS:-900}
NON_INTERACTIVE=0
DRY_RUN=0
WITH_DESKTOP=0
SKIP_TESTS=0
STEP_NO=0
STEP_TOTAL=8
STEP_NAME=""
STEP_START=$SCRIPT_START
SUMMARY=()
REPO_DIR=""
PNPM_VERSION=""
SUDO=""

usage() {
  sed -n '2,21p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'
}

for arg in "$@"; do
  case "$arg" in
    --non-interactive) NON_INTERACTIVE=1 ;;
    --dry-run) DRY_RUN=1 ;;
    --with-desktop) WITH_DESKTOP=1 ;;
    --skip-tests) SKIP_TESTS=1 ;;
    -h | --help)
      usage
      exit 0
      ;;
    *)
      echo "fresh-install: unknown option: $arg" >&2
      usage >&2
      exit 2
      ;;
  esac
done

if [ "$NON_INTERACTIVE" = 1 ]; then
  export CI=${CI:-true}
  export DEBIAN_FRONTEND=noninteractive
fi
export COREPACK_ENABLE_DOWNLOAD_PROMPT=0
export COREPACK_ENABLE_STRICT=0

# ---------------------------------------------------------------------------------------------
# helpers
# ---------------------------------------------------------------------------------------------
now() { date +%s; }

say() { printf '      %s\n' "$*"; }

run() {
  if [ "$DRY_RUN" = 1 ]; then
    printf '      would run: %s\n' "$*"
    return 0
  fi
  printf '      $ %s\n' "$*"
  "$@"
}

step_begin() {
  STEP_NO=$((STEP_NO + 1))
  STEP_NAME=$1
  STEP_START=$(now)
  printf '[%d/%d] %s\n' "$STEP_NO" "$STEP_TOTAL" "$STEP_NAME"
}

step_end() {
  local status=${1:-ok}
  local t
  t=$(now)
  local elapsed=$((t - STEP_START))
  printf '      %s in %ds (total %ds)\n' "$status" "$elapsed" "$((t - SCRIPT_START))"
  SUMMARY+=("$(printf '%-48s %5ds  %s' "$STEP_NAME" "$elapsed" "$status")")
}

print_summary() {
  local t total
  t=$(now)
  total=$((t - SCRIPT_START))
  echo
  echo "Forerunner fresh install summary ($(uname -s | tr '[:upper:]' '[:lower:]') $(uname -m)$([ "$DRY_RUN" = 1 ] && echo ', dry run'))"
  printf '  %-48s %6s  %s\n' "step" "secs" "status"
  local line
  for line in "${SUMMARY[@]+"${SUMMARY[@]}"}"; do printf '  %s\n' "$line"; done
  printf '  %-48s %5ds  budget %ds\n' "total" "$total" "$BUDGET"
}

on_error() {
  local t
  t=$(now)
  echo
  echo "fresh-install: FAILED at step $STEP_NO ($STEP_NAME) after $((t - STEP_START))s, total $((t - SCRIPT_START))s" >&2
  SUMMARY+=("$(printf '%-48s %5ds  FAILED' "$STEP_NAME" "$((t - STEP_START))")")
  print_summary
  exit 1
}
trap on_error ERR

confirm() {
  # confirm "question": yes in non-interactive mode, otherwise ask (default yes).
  if [ "$NON_INTERACTIVE" = 1 ] || [ "$DRY_RUN" = 1 ]; then return 0; fi
  local answer
  read -r -p "      $1 [Y/n] " answer
  case "${answer:-y}" in
    y | Y | yes | YES) return 0 ;;
    *) return 1 ;;
  esac
}

have() { command -v "$1" >/dev/null 2>&1; }

need_sudo() {
  if [ "$(id -u)" = 0 ]; then
    SUDO=""
  elif have sudo; then
    SUDO="sudo"
  else
    echo "fresh-install: installing packages needs root or sudo" >&2
    return 1
  fi
}

pkg_manager() {
  if have apt-get; then
    echo apt
  elif have dnf; then
    echo dnf
  else
    echo none
  fi
}

pkg_install() {
  # pkg_install <apt packages...> -- <dnf packages...>
  local apt_pkgs=() dnf_pkgs=() target=apt p
  for p in "$@"; do
    if [ "$p" = "--" ]; then
      target=dnf
      continue
    fi
    if [ "$target" = apt ]; then apt_pkgs+=("$p"); else dnf_pkgs+=("$p"); fi
  done
  need_sudo
  case "$(pkg_manager)" in
    apt)
      run $SUDO apt-get update -qq
      run $SUDO apt-get install -y -qq --no-install-recommends "${apt_pkgs[@]}"
      ;;
    dnf)
      run $SUDO dnf install -y -q "${dnf_pkgs[@]}"
      ;;
    *)
      echo "fresh-install: no supported package manager (apt-get or dnf) found; install manually: ${apt_pkgs[*]}" >&2
      return 1
      ;;
  esac
}

node_ok() {
  have node || return 1
  node -e 'const [a, b] = process.versions.node.split(".").map(Number); process.exit(a > 22 || (a === 22 && b >= 13) ? 0 : 1)'
}

install_node() {
  need_sudo
  case "$(pkg_manager)" in
    apt)
      # NodeSource's apt repository pins the major version (node_22.x); the signing key is
      # fetched over https and stored in /etc/apt/keyrings, no script is piped into a shell.
      run $SUDO apt-get update -qq
      run $SUDO apt-get install -y -qq --no-install-recommends ca-certificates curl gnupg
      run $SUDO install -d -m 0755 /etc/apt/keyrings
      if [ "$DRY_RUN" = 1 ]; then
        say "would add the NodeSource node_22.x apt repository (/etc/apt/sources.list.d/nodesource.list)"
      else
        if [ ! -f /etc/apt/keyrings/nodesource.gpg ]; then
          curl -fsSL https://deb.nodesource.com/gpgkey/nodesource-repo.gpg.key |
            $SUDO gpg --dearmor --yes -o /etc/apt/keyrings/nodesource.gpg
        fi
        echo "deb [signed-by=/etc/apt/keyrings/nodesource.gpg] https://deb.nodesource.com/node_22.x nodistro main" |
          $SUDO tee /etc/apt/sources.list.d/nodesource.list >/dev/null
      fi
      run $SUDO apt-get update -qq
      run $SUDO apt-get install -y -qq nodejs
      ;;
    dnf)
      # Fedora 39+ ships nodejs22; RHEL/Alma/Rocky 9 use the nodejs:22 module stream.
      if ! run $SUDO dnf install -y -q nodejs22; then
        run $SUDO dnf module enable -y nodejs:22
        run $SUDO dnf install -y -q nodejs
      fi
      ;;
    *)
      echo "fresh-install: Node.js 22 is missing and neither apt-get nor dnf exists." >&2
      echo "Install Node 22.13 or newer from https://nodejs.org/ and run this script again." >&2
      return 1
      ;;
  esac
  hash -r
  if [ "$DRY_RUN" = 0 ] && ! node_ok; then
    echo "fresh-install: Node.js is still older than 22.13 after the install (found $(node --version 2>/dev/null || echo none))" >&2
    return 1
  fi
}

is_checkout() {
  [ -f "$1/pnpm-workspace.yaml" ] && [ -f "$1/AGENTS.md" ] && [ -e "$1/.git" ]
}

read_pnpm_version() {
  # From the packageManager field of package.json ("pnpm@10.28.0" -> 10.28.0).
  node -p "(require(process.argv[1]).packageManager || '').split('@')[1] || ''" "$1/package.json" 2>/dev/null || true
}

# ---------------------------------------------------------------------------------------------
# steps
# ---------------------------------------------------------------------------------------------
step_begin "Prerequisites: git, curl, Node.js 22, corepack"
missing=()
have git || missing+=(git)
have curl || missing+=(curl)
if [ ${#missing[@]} -gt 0 ]; then
  say "missing: ${missing[*]}"
  confirm "Install ${missing[*]} with $(pkg_manager)?" || {
    echo "fresh-install: cannot continue without ${missing[*]}" >&2
    exit 1
  }
  pkg_install git curl ca-certificates -- git curl ca-certificates
else
  say "git $(git --version | awk '{print $3}'), curl present"
fi
if node_ok; then
  say "node $(node --version) ok (>= 22.13)"
else
  say "node $(node --version 2>/dev/null || echo 'not found'); need 22.13 or newer"
  confirm "Install Node.js 22 with $(pkg_manager)?" || {
    echo "fresh-install: cannot continue without Node.js 22" >&2
    exit 1
  }
  install_node
fi
if [ "$DRY_RUN" = 1 ] && ! have node; then
  say "would verify node >= 22.13 after the install"
fi
if have corepack; then
  say "corepack $(corepack --version 2>/dev/null || echo present)"
elif have npm; then
  say "corepack is not bundled with this Node.js; installing it with npm"
  run npm install -g corepack
fi
step_end

step_begin "Repository (this checkout or FORERUNNER_REPO_URL)"
SCRIPT_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
INSTALL_DIR=${FORERUNNER_INSTALL_DIR:-$HOME/forerunner}
if is_checkout "$SCRIPT_DIR/.."; then
  REPO_DIR=$(cd "$SCRIPT_DIR/.." && pwd)
  say "using the checkout this script lives in: $REPO_DIR"
elif top=$(git rev-parse --show-toplevel 2>/dev/null) && [ -n "$top" ] && is_checkout "$top"; then
  REPO_DIR=$top
  say "using the checkout of the current directory: $REPO_DIR"
elif is_checkout "$INSTALL_DIR"; then
  REPO_DIR=$INSTALL_DIR
  say "using the existing install directory: $REPO_DIR (not updated; run git pull yourself)"
elif [ -n "${FORERUNNER_REPO_URL:-}" ]; then
  say "cloning $FORERUNNER_REPO_URL into $INSTALL_DIR"
  run git clone --depth 1 "$FORERUNNER_REPO_URL" "$INSTALL_DIR"
  REPO_DIR=$INSTALL_DIR
else
  echo >&2
  echo "fresh-install: no Forerunner repository found." >&2
  echo "Either run this script from inside a checkout (bash scripts/fresh-install.sh), or tell it" >&2
  echo "where to clone from:" >&2
  echo "    FORERUNNER_REPO_URL=https://<git host>/<owner>/forerunner.git bash fresh-install.sh --non-interactive" >&2
  echo "Optional: FORERUNNER_INSTALL_DIR=<dir> (default \$HOME/forerunner)." >&2
  exit 2
fi
if [ "$DRY_RUN" = 0 ]; then
  cd "$REPO_DIR"
  say "commit $(git rev-parse --short HEAD 2>/dev/null || echo unknown)"
fi
step_end

step_begin "pnpm via corepack (package.json version)"
if [ -f "$REPO_DIR/package.json" ] && have node; then
  PNPM_VERSION=$(read_pnpm_version "$REPO_DIR")
fi
if [ -z "$PNPM_VERSION" ]; then
  PNPM_VERSION="10"
  say "package.json not readable yet; falling back to pnpm major $PNPM_VERSION"
fi
if have pnpm && [ "$(pnpm --version 2>/dev/null || true)" = "$PNPM_VERSION" ]; then
  say "pnpm $PNPM_VERSION already active"
elif have corepack; then
  if ! run corepack enable; then
    need_sudo
    run $SUDO env "PATH=$PATH" corepack enable
  fi
  run corepack prepare "pnpm@$PNPM_VERSION" --activate
else
  say "corepack unavailable; installing pnpm with npm"
  run npm install -g "pnpm@$PNPM_VERSION"
fi
hash -r
if [ "$DRY_RUN" = 0 ]; then say "pnpm $(pnpm --version)"; fi
step_end

step_begin "pnpm install --frozen-lockfile"
run pnpm install --frozen-lockfile
step_end

if [ "$SKIP_TESTS" = 1 ]; then
  step_begin "pnpm typecheck"
  say "skipped (--skip-tests)"
  step_end "skipped"
  step_begin "pnpm test:unit"
  say "skipped (--skip-tests)"
  step_end "skipped"
else
  step_begin "pnpm typecheck"
  run pnpm typecheck
  step_end
  step_begin "pnpm test:unit"
  run pnpm test:unit
  step_end
fi

step_begin "Desktop (Tauri) system libraries"
if [ "$WITH_DESKTOP" = 1 ]; then
  pkg_install libwebkit2gtk-4.1-dev libgtk-3-dev libayatana-appindicator3-dev librsvg2-dev \
    patchelf libasound2-dev libxdo-dev build-essential libssl-dev file wget -- \
    webkit2gtk4.1-devel gtk3-devel libappindicator-gtk3-devel librsvg2-devel patchelf \
    alsa-lib-devel libxdo-devel openssl-devel gcc gcc-c++ make file wget
  say "Rust is not installed by this script; see docs/maintainers/release.md for the desktop build"
  step_end
else
  say "skipped (pass --with-desktop to install libwebkit2gtk, gtk3, appindicator, rsvg, alsa, xdo)"
  step_end "skipped"
fi

step_begin "App directories (fr setup --profile install-check)"
if [ "$DRY_RUN" = 1 ]; then
  run pnpm fr setup --non-interactive --profile install-check
elif pnpm fr --help 2>/dev/null | grep -q '^  setup'; then
  run pnpm fr setup --non-interactive --profile install-check
  run pnpm fr dirs
else
  say "NOTE: the fr CLI has no setup command yet; printing its help instead"
  run pnpm fr --help || true
fi
step_end

print_summary
TOTAL=$(($(now) - SCRIPT_START))
if [ "$TOTAL" -gt "$BUDGET" ]; then
  echo "fresh-install: took ${TOTAL}s, over the ${BUDGET}s budget" >&2
  exit 3
fi
if [ "$DRY_RUN" = 1 ]; then
  echo "fresh-install: dry run complete (nothing was changed)"
else
  echo "fresh-install: complete in ${TOTAL}s. Next: pnpm fr setup (credentials) or pnpm --filter @forerunner/desktop tauri dev"
fi
