#!/usr/bin/env bash
# Runs the built action with no network and checks how it handles inputs. It
# also proves the bundle loads, which catches top-level errors in bundled
# dependencies (for example @azure/identity under ESM).
set -euo pipefail

log_info() { printf '\033[0;34m[info]\033[0m %s\n' "$*"; }
log_error() { printf '\033[0;31m[error]\033[0m %s\n' "$*" >&2; }

cd "$(git rev-parse --show-toplevel)"

ZERO_GUID="00000000-0000-0000-0000-000000000000"
failures=0

# run_case <name> <expected output pattern> [VAR=value ...]
# The action must exit non-zero and print the pattern. The environment is
# emptied so the runner's own INPUT_* variables cannot leak in.
run_case() {
  local name="$1" pattern="$2"
  shift 2
  local output status

  log_info "Case: ${name}"
  set +e
  output="$(env -i PATH="$PATH" HOME="${HOME:-/tmp}" "$@" node dist/index.js 2>&1)"
  status=$?
  set -e

  if [[ $status -eq 0 ]]; then
    log_error "${name}: expected a failure, got exit 0"
    failures=$((failures + 1))
  elif ! grep -Eq -- "$pattern" <<<"$output"; then
    log_error "${name}: output does not match /${pattern}/"
    printf '%s\n' "$output" >&2
    failures=$((failures + 1))
  fi
}

oidc=("INPUT_CLIENT-ID=${ZERO_GUID}" "INPUT_TENANT-ID=${ZERO_GUID}")
base=("INPUT_WORKSPACE-NAME=myworkspace" "INPUT_TEMPLATE-FILE=TemplateForWorkspace.json")

run_case "missing workspace-name" "workspace-name is required"
run_case "missing template-file" "template-file is required" \
  "INPUT_WORKSPACE-NAME=myworkspace"
run_case "unknown cloud" "cloud must be one of AzureCloud" \
  "${base[@]}" "${oidc[@]}" "INPUT_CLOUD=Azure Public"
run_case "unknown auth" "auth must be one of oidc, client-secret, managed-identity" \
  "${base[@]}" "${oidc[@]}" "INPUT_AUTH=password"
run_case "oidc without client-id" "oidc requires the client-id" \
  "${base[@]}" "INPUT_TENANT-ID=${ZERO_GUID}"
run_case "client secret with oidc" "set auth: client-secret" \
  "${base[@]}" "${oidc[@]}" "INPUT_CLIENT-SECRET=not-a-real-secret"
run_case "bad boolean" "delete-artifacts must be true or false" \
  "${base[@]}" "${oidc[@]}" "INPUT_DELETE-ARTIFACTS=yes"
run_case "bad parameters line" "line 2: expected name=value" \
  "${base[@]}" "${oidc[@]}" $'INPUT_PARAMETERS=a=1\nnot-a-pair'
run_case "bad workspace-name" "workspace-name .*is not a valid workspace name" \
  "INPUT_WORKSPACE-NAME=evil.example/x" "INPUT_TEMPLATE-FILE=t.json" "${oidc[@]}"
run_case "valid inputs reach the stub" "not implemented yet" \
  "${base[@]}" "${oidc[@]}"
run_case "managed identity reaches the stub" "not implemented yet" \
  "${base[@]}" "INPUT_AUTH=managed-identity"

# The client secret may only appear in the runner's own mask command.
log_info "Case: client secret is never echoed"
set +e
output="$(env -i PATH="$PATH" HOME="${HOME:-/tmp}" "${base[@]}" "${oidc[@]}" \
  "INPUT_CLIENT-SECRET=smoke-secret-value" node dist/index.js 2>&1)"
set -e
if ! grep -q '^::add-mask::smoke-secret-value$' <<<"$output"; then
  log_error "client secret: the mask command is missing"
  failures=$((failures + 1))
elif grep -v '^::add-mask::' <<<"$output" | grep -q 'smoke-secret-value'; then
  log_error "client secret: the value is echoed outside the mask command"
  failures=$((failures + 1))
fi

if [[ $failures -ne 0 ]]; then
  log_error "${failures} smoke case(s) failed"
  exit 1
fi
log_info "All smoke cases passed"
