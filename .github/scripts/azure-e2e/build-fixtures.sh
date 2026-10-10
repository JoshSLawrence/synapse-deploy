#!/usr/bin/env bash
#
# Regenerates the committed exported templates from the Git folder in
# test/fixtures/azure-e2e/workspace, with the actions repository's offline
# build (no credentials, no network access to Azure; it only downloads
# Microsoft's export bundle). Outputs go to test/fixtures/azure-e2e:
#
#   ACTIONS_DIR=~/source/github/actions build-fixtures.sh
#
#   template/     the whole folder
#   template-v2/  the folder without the artifacts v2 removes
#   parameters.json, parameters-v2.json
#                 the parameters files, with placeholder values that the
#                 run replaces through the action's `parameters` input
#
# Environment variables:
#   ACTIONS_DIR - a checkout of JoshSLawrence/actions (required)

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
FIXTURES="$(git rev-parse --show-toplevel)/test/fixtures/azure-e2e"
# shellcheck source=.github/scripts/azure-e2e/lib.sh
source "$SCRIPT_DIR/lib.sh"

require_tool jq
if [ -z "${ACTIONS_DIR:-}" ] || [ ! -x "$ACTIONS_DIR/synapse/scripts/build.sh" ]; then
  log_error "ACTIONS_DIR must be a checkout of the actions repository (synapse/scripts/build.sh not found): set it and retry."
  exit 1
fi

# Removed in v2, so that the second deployment must delete them: a
# pipeline, its data flow and dataset (a dependency chain), a notebook, a
# SQL script, the managed private endpoint, and a lake table with the
# relationship that uses it.
V2_REMOVED=(
  pipeline/pl_e2e_flow.json
  dataflow/df_e2e.json
  dataset/ds_e2e.json
  notebook/nb_e2e.json
  sqlscript/sql_e2e.json
  managedVirtualNetwork/default/managedPrivateEndpoint/mpe-e2e-blob.json
  database/lakedb_e2e/table/orders.json
  database/lakedb_e2e/relationship/orders_customers.json
)

scratch="$(mktemp -d)"
trap 'rm -rf "$scratch"' EXIT

export_folder() {
  local folder="$1" dest="$2"
  log_info "Exporting ${folder} to ${dest}"
  rm -rf "$scratch/out"
  WORKING_DIR="$folder" OUTPUT_DIR="$scratch/out" WORKSPACE_NAME=myworkspace \
    "$ACTIONS_DIR/synapse/scripts/build.sh" > "$scratch/build.log" 2>&1 || {
    cat "$scratch/build.log" >&2
    log_error "The export failed: see the output above."
    exit 1
  }
  mkdir -p "$dest"
  # Sorted keys and a trailing newline keep regenerated diffs small.
  for f in TemplateForWorkspace.json TemplateParametersForWorkspace.json; do
    jq -S . "$scratch/out/$f" > "$dest/$f"
  done
  log_info "$(jq '.resources | length' "$dest/TemplateForWorkspace.json") resource(s) in ${dest}"
}

export_folder "$FIXTURES/workspace" "$FIXTURES/template"

cp -R "$FIXTURES/workspace" "$scratch/workspace-v2"
for f in "${V2_REMOVED[@]}"; do
  rm "$scratch/workspace-v2/$f"
done
export_folder "$scratch/workspace-v2" "$FIXTURES/template-v2"
# Placeholder values only: the real storage URL and endpoint target are
# found at run time and never committed.
for suffix in "" "-v2"; do
  src="$FIXTURES/template${suffix}/TemplateParametersForWorkspace.json"
  jq -S '.parameters.workspaceName.value = "myworkspace"' "$src" > "$FIXTURES/parameters${suffix}.json"
done
log_info "Done. Review and commit test/fixtures/azure-e2e/template and template-v2."
