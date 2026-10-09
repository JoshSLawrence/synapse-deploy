#!/usr/bin/env bash
# Rebuilds dist/ and fails when it differs from what is committed, so a pull
# request cannot change src/ without the bundle that actually runs.
set -euo pipefail

log_info() { printf '\033[0;34m[info]\033[0m %s\n' "$*"; }
log_error() { printf '\033[0;31m[error]\033[0m %s\n' "$*" >&2; }

cd "$(git rev-parse --show-toplevel)"

log_info "Rebuilding dist/"
# Removed first so a stale tracked file the build no longer writes shows up
# as a deletion.
rm -rf dist
node scripts/build.mjs

# Disable errexit so both checks run and the message below is printed once.
set +e
git diff --exit-code -- dist >/dev/null
tracked=$?
untracked="$(git status --porcelain -- dist)"
set -e

if [[ $tracked -ne 0 || -n "$untracked" ]]; then
  log_error "dist/ is stale: run \`mise run build\` and commit dist/."
  git status --short -- dist >&2
  exit 1
fi

log_info "dist/ is up to date"
