#!/usr/bin/env bash
#
# Finds the workspace's own storage account, which the run uses as the
# managed private endpoint's target and the lake database's location, and
# writes the templates the run deploys: the committed ones with the
# placeholder storage host replaced, plus the two derived ones.
#
#   prepare.sh <output-dir>
#
#   <output-dir>/v1/TemplateForWorkspace.json          test/fixtures/azure-e2e/template
#   <output-dir>/v2/TemplateForWorkspace.json          test/fixtures/azure-e2e/template-v2
#   <output-dir>/v2-trigger/TemplateForWorkspace.json  v2, trigger changed
#   <output-dir>/empty/TemplateForWorkspace.json       v1 without resources
#
# Writes step outputs when GITHUB_OUTPUT is set: storage_account,
# storage_filesystem, storage_id, params_v1 and params_v2 (name=value lines
# for the action's parameters input). None of it is committed; the
# values are masked with ::add-mask:: as soon as they are found.
#
# Environment variables:
#   AZURE_SYNAPSE_WORKSPACE, AZURE_RESOURCE_GROUP - the test workspace

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(git rev-parse --show-toplevel)"
FIXTURES="$ROOT/test/fixtures/azure-e2e"
# shellcheck source=.github/scripts/azure-e2e/lib.sh
source "$SCRIPT_DIR/lib.sh"

require_tool az
require_tool jq

out="${1:?usage: prepare.sh <output-dir>}"
workspace="${AZURE_SYNAPSE_WORKSPACE:?set AZURE_SYNAPSE_WORKSPACE}"
group="${AZURE_RESOURCE_GROUP:?set AZURE_RESOURCE_GROUP}"

log_info "Reading the workspace's default storage"
storage="$(az synapse workspace show --resource-group "$group" --name "$workspace" \
  --query '{url: defaultDataLakeStorage.accountUrl, filesystem: defaultDataLakeStorage.filesystem, id: defaultDataLakeStorage.resourceId}' \
  --output json)"
url="$(jq -r '.url // empty' <<< "$storage")"
filesystem="$(jq -r '.filesystem // empty' <<< "$storage")"
storage_id="$(jq -r '.id // empty' <<< "$storage")"
if [ -z "$url" ] || [ -z "$filesystem" ]; then
  log_error "The workspace has no defaultDataLakeStorage (account URL and file system): check that the identity can read the workspace, and that the workspace was created with a storage account."
  exit 1
fi
account="${url#https://}"
account="${account%%.*}"
if [ -z "$storage_id" ]; then
  log_info "The workspace did not report the storage account's resource ID; looking it up"
  storage_id="$(az resource list --resource-type Microsoft.Storage/storageAccounts --name "$account" \
    --query '[0].id' --output tsv)"
fi
if [ -z "$storage_id" ]; then
  log_error "Cannot find the resource ID of storage account ${account}: check that the identity has Reader on it (or its resource group)."
  exit 1
fi

# Masked before anything is printed or set as an output, so the runner
# hides them in every later line of the job, including the env headers of
# the steps that receive them. A very short file system name is left
# alone: masking it would blank common words in the log.
mask() {
  if [ -n "${GITHUB_ACTIONS:-}" ] && [ -n "$1" ]; then
    echo "::add-mask::$1"
  fi
}
mask "$account"
mask "$url"
mask "$storage_id"
mask "${account}.dfs.core.windows.net"
mask "${account}.blob.core.windows.net"
if [ "${#filesystem}" -ge 6 ]; then
  mask "$filesystem"
fi
log_info "Storage target found (its names are masked in this job's log)"

# The placeholders in the committed templates: the storage host (lake
# database locations, endpoint FQDNs) and the file system.
rewrite() {
  sed -e "s#abfss://e2e@stexample#abfss://${filesystem}@${account}#g" -e "s/stexample/${account}/g"
}

derive() {
  local name="$1" source="$2" filter="$3"
  mkdir -p "$out/$name"
  jq "$filter" "$source" | rewrite > "$out/$name/TemplateForWorkspace.json"
  log_info "${name}: $(jq '.resources | length' "$out/$name/TemplateForWorkspace.json") resource(s)"
}

derive v1 "$FIXTURES/template/TemplateForWorkspace.json" '.'
derive v2 "$FIXTURES/template-v2/TemplateForWorkspace.json" '.'
derive empty "$FIXTURES/template/TemplateForWorkspace.json" '.resources = []'
# A started trigger refuses any change; the recurrence is what changes.
derive v2-trigger "$FIXTURES/template-v2/TemplateForWorkspace.json" \
  '(.resources[] | select(.type | test("triggers$"; "i")) | .properties.typeProperties.recurrence.interval) = 2'

params_v1="ls_e2e_storage_properties_typeProperties_url=${url}
mpe-e2e-blob_properties_privateLinkResourceId=${storage_id}"
params_v2="ls_e2e_storage_properties_typeProperties_url=${url}"

if [ -n "${GITHUB_OUTPUT:-}" ]; then
  {
    echo "storage_account=${account}"
    echo "storage_filesystem=${filesystem}"
    echo "storage_id=${storage_id}"
    echo "params_v1<<E2E_EOF"
    echo "$params_v1"
    echo "E2E_EOF"
    echo "params_v2<<E2E_EOF"
    echo "$params_v2"
    echo "E2E_EOF"
  } >> "$GITHUB_OUTPUT"
fi
log_info "Templates written under ${out}"
