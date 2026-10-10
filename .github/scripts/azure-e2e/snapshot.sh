#!/usr/bin/env bash
#
# Lists the workspace's artifacts (never their contents) as sorted
# kind/name lines, minus what the workspace creates itself, so a run can
# prove it left the workspace as it found it.
#
#   snapshot.sh <output-file> [--require-empty]
#
# With --require-empty it fails when anything is listed: the run's cleanup
# deletes everything that is not in a template, so it must not start in a
# workspace that holds anything else.
#
# Environment variables: see azure.sh.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=.github/scripts/azure-e2e/azure.sh
source "$SCRIPT_DIR/azure.sh"
trap 'rm -rf "$SCRATCH"' EXIT

out="${1:?usage: snapshot.sh <output-file> [--require-empty]}"
require_empty="${2:-}"

collections=(credentials dataflows datasets linkedServices notebooks pipelines
  sparkJobDefinitions sqlScripts triggers kqlScripts sparkConfigurations
  managedVirtualNetworks/default/managedPrivateEndpoints)

: > "$out.raw"

# Usage: list_pages KIND URL RESOURCE JQ_NAMES
list_pages() {
  local kind="$1" url="$2" resource="$3" names="$4" next try
  while [ -n "$url" ]; do
    # Only throttling, a server error or a failed connection is retried; any
    # other status (401, 403, 404, 400, ...) will not change on a retry.
    for try in 1 2 3; do
      http GET "$url" "$resource"
      case "$STATUS" in
        429 | 5?? | 000)
          if [ "$try" -lt 3 ]; then
            log_warn "${kind}: list answered ${STATUS} (try ${try} of 3); retrying in 5 s"
            sleep 5
          fi
          ;;
        *) break ;;
      esac
    done
    if [ "$STATUS" != "200" ]; then
      # No status is tolerated: an empty list on a transient error would hide
      # a pre-existing artifact from the "before" snapshot, and the cleanup
      # would then delete it as one of the run's own. No snapshot beats a
      # wrong one.
      log_error "${kind}: list answered ${STATUS} ($(body_field '.error.message // .message // empty' | redact | head -c 160)); the snapshot would be incomplete. Retry the run, and check that the identity can list ${kind}."
      exit 1
    fi
    jq -r --arg kind "$kind" "[$names] | .[] | \$kind + \"/\" + ." "$BODY" >> "$out.raw"
    next="$(body_field '.nextLink // empty')"
    # A nextLink on another host would get the token sent there.
    case "$next" in
      "" | "$DATA_HOST"/* | "$ARM_HOST"/*) url="$next" ;;
      *)
        log_error "${kind}: nextLink points at another host; refusing to follow it."
        exit 1
        ;;
    esac
  done
}

log_info "Listing the workspace's artifacts"
for collection in "${collections[@]}"; do
  list_pages "${collection##*/}" "${DATA_HOST}/${collection}?api-version=${DATA_API}" "$DATA_RESOURCE" '.value[]?.name'
done
# Lake databases: only the ones the action would manage. The service lists
# {"items":[{"name", "properties":{"Origin", "Properties"}}]}; the flat shape
# (Name, Origin at the top) is accepted too. Origin.Type is compared without
# regard to case; IsSyMSCDMDatabase must be the boolean true.
list_pages lakeDatabases "${DATA_HOST}/databases?api-version=${LAKE_API}" "$DATA_RESOURCE" \
  '(.items // .value // [])[]? | select(((.properties // .).Origin.Type? // "" | ascii_upcase) == "SPARK" and ((.properties // .).Properties.IsSyMSCDMDatabase? // false) == true) | (.name // .Name)'
list_pages integrationRuntimes "${ARM_HOST}${ARM_WS}/integrationRuntimes?api-version=${ARM_API}" "$ARM_RESOURCE" '.value[]?.name'

# The workspace creates these itself.
grep -viE '^(linkedServices/.*-WorkspaceDefault(Storage|SqlServer)|credentials/WorkspaceSystemIdentity|managedPrivateEndpoints/synapse-ws-.*|integrationRuntimes/AutoResolveIntegrationRuntime)$' "$out.raw" | LC_ALL=C sort -u > "$out" || true
rm -f "$out.raw"
log_info "$(wc -l < "$out" | tr -d ' ') artifact(s) beyond the workspace's own"

if [ "$require_empty" = "--require-empty" ] && [ -s "$out" ]; then
  log_error "The workspace already holds artifacts (listed below). The cleanup deletes everything that is not in a template, so run against an empty workspace, or remove these first."
  redact < "$out" >&2
  exit 1
fi
