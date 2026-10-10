#!/usr/bin/env bash
#
# The multi-command steps of the Azure E2E workflow, so that each workflow
# step is a single command.
#
#   steps.sh start
#   steps.sh check-v1|check-redeploy|check-dry|check-v2
#   steps.sh trigger-refused
#   steps.sh empty-failed
#
# Environment variables: E2E_DIR (set by "start"), and per command DEPLOYED,
# SKIPPED, DELETED, DRY_DELETED, OUTCOME; "start" reads the debug settings
# STEP_DEBUG_VAR and RUNNER_DEBUG_VAR (the repository variables
# ACTIONS_STEP_DEBUG and ACTIONS_RUNNER_DEBUG).

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=.github/scripts/azure-e2e/lib.sh
source "$SCRIPT_DIR/lib.sh"

cmd_start() {
  # The run log is public: debug logging would print the HTTP trace.
  if [ "${RUNNER_DEBUG:-}" = "1" ] || [ -n "${STEP_DEBUG_VAR:-}" ] || [ -n "${RUNNER_DEBUG_VAR:-}" ]; then
    log_error "Public runs must not log at debug level: re-run without 'Enable debug logging', and delete the repository variables ACTIONS_STEP_DEBUG and ACTIONS_RUNNER_DEBUG if they exist."
    exit 1
  fi
  echo "Azure E2E at ${GITHUB_SHA:?set GITHUB_SHA}"
  echo "E2E_DIR=${RUNNER_TEMP:?set RUNNER_TEMP}/azure-e2e" >> "${GITHUB_ENV:?set GITHUB_ENV}"
  mkdir -p "${RUNNER_TEMP}/azure-e2e/results"
}

# check_after <label> <snapshot name> <template> <deleted-at-least>
check_after() {
  local label="$1" snap="$2" template="$3" min="$4"
  "$SCRIPT_DIR/snapshot.sh" "$E2E_DIR/results/${snap}.txt"
  "$SCRIPT_DIR/check.sh" counts "$label" "$E2E_DIR/templates/${template}/TemplateForWorkspace.json" \
    "$DEPLOYED" "$SKIPPED" "$DELETED" "$min" "$E2E_DIR/results/outputs.jsonl"
}

cmd_check_v1() {
  check_after "deploy v1" after-v1 v1 0
  "$SCRIPT_DIR/check.sh" state v1 "$E2E_DIR/results/after-v1.txt"
}

cmd_check_redeploy() {
  check_after "redeploy v1" after-v1-redeploy v1 0
  "$SCRIPT_DIR/check.sh" unchanged "$E2E_DIR/results/after-v1.txt" "$E2E_DIR/results/after-v1-redeploy.txt"
}

cmd_check_dry() {
  check_after "dry run v2" after-dry-run v2 6
  "$SCRIPT_DIR/check.sh" unchanged "$E2E_DIR/results/after-v1-redeploy.txt" "$E2E_DIR/results/after-dry-run.txt"
}

cmd_check_v2() {
  check_after "deploy v2" after-v2 v2 6
  if [ "$DELETED" != "${DRY_DELETED:?set DRY_DELETED}" ]; then
    log_error "The dry run planned ${DRY_DELETED} deletion(s), the deployment made ${DELETED}: compare the two steps' logs."
    exit 1
  fi
  "$SCRIPT_DIR/check.sh" state v2 "$E2E_DIR/results/after-v2.txt"
}

cmd_trigger_refused() {
  local outcome="${OUTCOME:?set OUTCOME}"
  if [ "$outcome" != "failure" ]; then
    log_error "The changed-trigger deployment ended '${outcome}', expected 'failure': a started trigger must refuse the update, and the action must report it."
    exit 1
  fi
  log_info "The started trigger refused the change"
}

cmd_empty_failed() {
  log_error "The empty-template deployment failed. The cleanup script then ran: if it passed, the workspace is restored; if not, it is not, so remove the leftovers by hand before the next run. See the failed step's log."
  exit 1
}

case "${1:-}" in
  start) cmd_start ;;
  check-v1) cmd_check_v1 ;;
  check-redeploy) cmd_check_redeploy ;;
  check-dry) cmd_check_dry ;;
  check-v2) cmd_check_v2 ;;
  trigger-refused) cmd_trigger_refused ;;
  empty-failed) cmd_empty_failed ;;
  *)
    log_error "Usage: steps.sh start|check-v1|check-redeploy|check-dry|check-v2|trigger-refused|empty-failed"
    exit 1
    ;;
esac
