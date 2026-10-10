#!/usr/bin/env bash
# Raw REST helpers over the signed-in Azure CLI, for the snapshot, the
# checks and the cleanup. Sourced, not run.
#
# Why curl and not `az rest`: the helpers need the response status and
# headers (Location, Retry-After) without `az` printing the body. The token
# comes from `az account get-access-token`, stays in a variable and a
# mode-600 file, and is never written to a log.
#
# Environment variables (all required):
#   AZURE_SYNAPSE_WORKSPACE, AZURE_RESOURCE_GROUP,
#   AZURE_SUBSCRIPTION_ID, AZURE_TENANT_ID

# shellcheck source=.github/scripts/azure-e2e/lib.sh
source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"

WS="${AZURE_SYNAPSE_WORKSPACE:?set AZURE_SYNAPSE_WORKSPACE}"
RG="${AZURE_RESOURCE_GROUP:?set AZURE_RESOURCE_GROUP}"
SUB="${AZURE_SUBSCRIPTION_ID:?set AZURE_SUBSCRIPTION_ID}"
TEN="${AZURE_TENANT_ID:?set AZURE_TENANT_ID}"
ACCT="${STORAGE_ACCOUNT:-}"

export DATA_HOST="https://${WS}.dev.azuresynapse.net"
export DATA_RESOURCE="https://dev.azuresynapse.net"
export ARM_HOST="https://management.azure.com"
export ARM_RESOURCE="https://management.azure.com"
export DATA_API="2019-06-01-preview"
export LAKE_API="2021-04-01"
export ARM_API="2019-06-01-preview"
export ARM_WS="/subscriptions/${SUB}/resourceGroups/${RG}/providers/Microsoft.Synapse/workspaces/${WS}"

require_tool az
require_tool curl
require_tool jq
require_tool perl

SCRATCH="$(mktemp -d)"
chmod 700 "$SCRATCH"
AUTH="$SCRATCH/auth"
HDRS="$SCRATCH/headers"
BODY="$SCRATCH/body"
export STATUS=""

# Replaces everything that identifies the test environment. Runs on every
# line written to the log or the results file.
redact() {
  R_WS="$WS" R_RG="$RG" R_SUB="$SUB" R_TEN="$TEN" R_ACCT="$ACCT" perl -pe '
    for my $p (["R_WS", "<workspace>"], ["R_RG", "<resource-group>"],
               ["R_ACCT", "<storage-account>"], ["R_SUB", "<subscription>"],
               ["R_TEN", "<tenant>"]) {
      my $v = $ENV{$p->[0]};
      next unless defined $v && length $v;
      s/\b\Q$v\E\b/$p->[1]/gi;
    }
    s/[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}/<guid>/gi;
    s/eyJ[A-Za-z0-9_-]{10,}[.A-Za-z0-9_-]*/<jwt>/g;
  '
}

# Usage: http METHOD URL RESOURCE [BODY_FILE]
# Sets STATUS (000 when the connection failed) and fills HDRS and BODY.
http() {
  local method="$1" url="$2" resource="$3" body_file="${4:-}" token
  local -a args=(-sS --max-time 120 -X "$method" -D "$HDRS" -o "$BODY" -w '%{http_code}' -H "@${AUTH}")
  if ! token="$(az account get-access-token --resource "$resource" --query accessToken -o tsv 2> /dev/null)" || [ -z "$token" ]; then
    log_error "Could not get a token for ${resource}: check that azure/login ran and the identity can sign in."
    exit 1
  fi
  (
    umask 077
    printf 'Authorization: Bearer %s\n' "$token" > "$AUTH"
  )
  if [ -n "$body_file" ]; then
    args+=(-H 'Content-Type: application/json' --data-binary "@${body_file}")
  fi
  : > "$HDRS"
  : > "$BODY"
  # A failed connection must reach the caller as status 000, not stop the script here.
  set +e
  STATUS="$(curl "${args[@]}" "$url" 2> "$SCRATCH/curl.err")"
  local rc=$?
  set -e
  if [ "$rc" -ne 0 ]; then
    STATUS="000"
    log_warn "${method} failed to connect: $(redact < "$SCRATCH/curl.err" | head -c 300)"
  fi
  rm -f "$AUTH"
}

# Usage: header NAME; the last response's header value (CR stripped), or "".
header() {
  awk -v want="$(printf '%s' "$1" | tr '[:upper:]' '[:lower:]')" '
    { sub(/\r$/, ""); i = index($0, ":"); if (i == 0) next
      k = tolower(substr($0, 1, i - 1))
      if (k == want) { v = substr($0, i + 1); sub(/^[ \t]+/, "", v); last = v } }
    END { print last }' "$HDRS"
}

body_field() {
  jq -r "$1" "$BODY" 2> /dev/null || true
}
