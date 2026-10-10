#!/usr/bin/env bash
#
# Assertions the workflow makes between deployments. Each prints what it
# checked and exits non-zero with the reason when it fails.
#
#   check.sh counts <label> <template> <deployed> <skipped> <deleted> <deleted-at-least> <results-file>
#   check.sh state <v1|v2> <snapshot-file>
#   check.sh unchanged <snapshot-a> <snapshot-b>
#
# Environment variables (state): see azure.sh.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=.github/scripts/azure-e2e/lib.sh
source "$SCRIPT_DIR/lib.sh"
require_tool jq

fail() {
  log_error "$*"
  exit 1
}

# Template resources the action neither deploys nor deletes: the managed
# virtual network, pools, and the workspace's default linked services.
count_deployable() {
  jq '[.resources[] | select((.type | test("workspaces/(managedVirtualNetworks|bigDataPools|sqlPools)$"; "i") | not)
        and (.name | test("-WorkspaceDefault(Storage|SqlServer)"; "i") | not))] | length' "$1"
}

cmd_counts() {
  local label="$1" template="$2" deployed="$3" skipped="$4" deleted="$5" deleted_min="$6" results="$7" expected
  expected="$(count_deployable "$template")"
  jq -cn --arg label "$label" --arg deployed "$deployed" --arg skipped "$skipped" --arg deleted "$deleted" \
    --argjson expected_deployed "$expected" \
    '{label: ("action outputs: " + $label), deployed: $deployed, skipped: $skipped, deleted: $deleted, expected_deployed: $expected_deployed}' |
    tee -a "$results" >&2
  [ "$deployed" = "$expected" ] || fail "${label}: the action reported ${deployed} deployed, but the template has ${expected} deployable artifact(s): compare the 'deployed' lines in the step's log."
  if [ "$deleted_min" = "0" ]; then
    [ "$deleted" = "0" ] || fail "${label}: the action reported ${deleted} deleted, expected 0."
  else
    [ "$deleted" -ge "$deleted_min" ] || fail "${label}: the action reported ${deleted} deleted, expected at least ${deleted_min}."
  fi
  log_info "${label}: ${deployed} deployed, ${skipped} skipped, ${deleted} deleted, as expected"
}

V1_PRESENT=(pipelines/pl_e2e pipelines/pl_e2e_flow datasets/ds_e2e dataflows/df_e2e
  linkedServices/ls_e2e_storage triggers/tr_e2e_daily notebooks/nb_e2e sqlScripts/sql_e2e
  lakeDatabases/lakedb_e2e managedPrivateEndpoints/mpe-e2e-blob integrationRuntimes/ir-e2e)
V2_PRESENT=(pipelines/pl_e2e linkedServices/ls_e2e_storage triggers/tr_e2e_daily
  lakeDatabases/lakedb_e2e integrationRuntimes/ir-e2e)
V2_ABSENT=(pipelines/pl_e2e_flow datasets/ds_e2e dataflows/df_e2e notebooks/nb_e2e
  sqlScripts/sql_e2e managedPrivateEndpoints/mpe-e2e-blob)

lake_children() {
  # Names of a lake database's tables or relationships, sorted.
  local kind="$1"
  http GET "${DATA_HOST}/databases/lakedb_e2e/${kind}?api-version=${LAKE_API}" "$DATA_RESOURCE"
  [ "$STATUS" = "200" ] || fail "Listing lakedb_e2e ${kind} answered ${STATUS}; the lake database should exist."
  jq -r '(.items // .value // [])[]? | (.name // .Name // .properties.Name)' "$BODY" | LC_ALL=C sort | paste -sd, -
}

cmd_state() {
  local which="$1" snapshot="$2" name tables relationships want_tables want_relationships
  local -a present absent=()
  if [ "$which" = "v1" ]; then
    present=("${V1_PRESENT[@]}")
    want_tables="customers,orders"
    want_relationships="orders_customers"
  else
    present=("${V2_PRESENT[@]}")
    absent=("${V2_ABSENT[@]}")
    want_tables="customers"
    want_relationships=""
  fi
  for name in "${present[@]}"; do
    grep -qxF "$name" "$snapshot" || fail "${which}: ${name} is missing from the workspace."
  done
  for name in "${absent[@]}"; do
    if grep -qxF "$name" "$snapshot"; then fail "${which}: ${name} is still in the workspace; delete-artifacts should have removed it."; fi
  done
  # shellcheck source=.github/scripts/azure-e2e/azure.sh
  source "$SCRIPT_DIR/azure.sh"
  trap 'rm -rf "$SCRATCH"' EXIT
  tables="$(lake_children tables)"
  relationships="$(lake_children relationships)"
  [ "$tables" = "$want_tables" ] || fail "${which}: lakedb_e2e tables are [${tables}], expected [${want_tables}]."
  [ "$relationships" = "$want_relationships" ] || fail "${which}: lakedb_e2e relationships are [${relationships}], expected [${want_relationships}]."
  log_info "${which}: ${#present[@]} artifact(s) present, ${#absent[@]} absent, lake tables [${tables}], relationships [${relationships}]"
}

cmd_unchanged() {
  if ! diff -u "$1" "$2" > /dev/null; then
    diff -u "$1" "$2" >&2 || true
    fail "The workspace changed between $1 and $2, but nothing should have: a dry run must not change anything."
  fi
  log_info "The workspace is unchanged ($(wc -l < "$1" | tr -d ' ') artifact(s))"
}

case "${1:-}" in
  counts) shift && cmd_counts "$@" ;;
  state) shift && cmd_state "$@" ;;
  unchanged) shift && cmd_unchanged "$@" ;;
  *) fail "Usage: check.sh counts|state|unchanged ..." ;;
esac
