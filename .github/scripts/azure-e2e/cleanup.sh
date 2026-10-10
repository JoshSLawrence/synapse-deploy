#!/usr/bin/env bash
#
# Puts the workspace back as snapshot.sh found it: deletes every
# artifact that is not in the "before" snapshot, with the REST API and
# without the deployer, in dependency order, and fails if anything remains.
# This is the guarantee behind the run's cleanup: the deployer never
# deletes integration runtimes, and a failed run may stop anywhere.
#
#   cleanup.sh <before-snapshot> <work-dir>
#
# Environment variables: see azure.sh.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=.github/scripts/azure-e2e/azure.sh
source "$SCRIPT_DIR/azure.sh"
trap 'rm -rf "$SCRATCH"' EXIT

before="${1:?usage: cleanup.sh <before-snapshot> <work-dir>}"
work="${2:?usage: cleanup.sh <before-snapshot> <work-dir>}"
mkdir -p "$work"

# Referencing kinds go before the kinds they reference.
ORDER=(triggers pipelines dataflows datasets notebooks sqlScripts kqlScripts
  sparkJobDefinitions sparkConfigurations lakeDatabases managedPrivateEndpoints
  linkedServices credentials integrationRuntimes)

# Usage: delete_and_wait URL RESOURCE MAX_SECONDS
delete_and_wait() {
  local url="$1" resource="$2" max="$3" start
  http DELETE "$url" "$resource"
  case "$STATUS" in
    2* | 404) ;;
    *)
      log_warn "DELETE answered ${STATUS}: $(body_field '.error.message // .message // empty' | redact | head -c 300)"
      return 1
      ;;
  esac
  start="$(date +%s)"
  while :; do
    http GET "$url" "$resource"
    [ "$STATUS" = "404" ] && return 0
    if [ "$(($(date +%s) - start))" -gt "$max" ]; then
      log_warn "Still present after ${max} s (GET answered ${STATUS})"
      return 1
    fi
    sleep 5
  done
}

delete_lake_database() {
  local db="$1" kind child
  for kind in relationships tables; do
    http GET "${DATA_HOST}/databases/${db}/${kind}?api-version=${LAKE_API}" "$DATA_RESOURCE"
    [ "$STATUS" = "200" ] || continue
    while IFS= read -r child; do
      [ -n "$child" ] || continue
      delete_and_wait "${DATA_HOST}/databases/${db}/${kind}/${child}?api-version=${LAKE_API}" "$DATA_RESOURCE" 120 || true
    done < <(jq -r '(.items // .value // [])[]? | (.name // .Name // .properties.Name)' "$BODY")
  done
  delete_and_wait "${DATA_HOST}/databases/${db}?api-version=${LAKE_API}" "$DATA_RESOURCE" 120
}

delete_one() {
  local kind="$1" name="$2"
  case "$kind" in
    triggers)
      # A started trigger cannot be deleted.
      az synapse trigger stop --workspace-name "$WS" --name "$name" > /dev/null 2>&1 || true
      delete_and_wait "${DATA_HOST}/triggers/${name}?api-version=${DATA_API}" "$DATA_RESOURCE" 120
      ;;
    lakeDatabases) delete_lake_database "$name" ;;
    managedPrivateEndpoints)
      delete_and_wait "${DATA_HOST}/managedVirtualNetworks/default/managedPrivateEndpoints/${name}?api-version=${DATA_API}" "$DATA_RESOURCE" 600
      ;;
    integrationRuntimes)
      delete_and_wait "${ARM_HOST}${ARM_WS}/integrationRuntimes/${name}?api-version=${ARM_API}" "$ARM_RESOURCE" 600
      ;;
    *) delete_and_wait "${DATA_HOST}/${kind}/${name}?api-version=${DATA_API}" "$DATA_RESOURCE" 120 ;;
  esac
}

"$SCRIPT_DIR/snapshot.sh" "$work/now.txt" || {
  log_error "Cannot list the workspace, so nothing was cleaned up. Delete the run's leftovers by hand, or re-run once the listing works."
  exit 1
}
LC_ALL=C comm -13 "$before" "$work/now.txt" > "$work/extra.txt"
log_info "$(wc -l < "$work/extra.txt" | tr -d ' ') artifact(s) beyond the starting state"

failed=0
for kind in "${ORDER[@]}"; do
  while IFS= read -r line; do
    [ "${line%%/*}" = "$kind" ] || continue
    log_info "Deleting ${line}"
    delete_one "$kind" "${line#*/}" || failed=1
  done < "$work/extra.txt"
done

"$SCRIPT_DIR/snapshot.sh" "$work/after.txt" || {
  log_error "Cannot list the workspace after the cleanup, so it is unproven that the workspace is as it began. Check it by hand."
  exit 1
}
if ! diff -u "$before" "$work/after.txt" > "$work/diff.txt"; then
  redact < "$work/diff.txt" >&2
  log_error "The workspace is not as it began (differences above). Delete the leftovers by hand, in dependency order; the integration runtime last."
  exit 1
fi
if [ "$failed" -ne 0 ]; then
  log_warn "A deletion reported a problem, but the workspace matches its starting state"
fi
log_info "The workspace is as it began"
