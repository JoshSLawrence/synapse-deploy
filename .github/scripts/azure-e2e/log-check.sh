#!/usr/bin/env bash
#
# Scans the finished "Azure E2E" job's log for values that must never be in
# a public log: GUIDs, the workspace and storage hosts, resource paths and
# tokens. The run log of a public repository is readable by anyone, and the
# test environment's names live only in secrets.
#
#   log-check.sh <run-id>
#
# Environment variables: GH_TOKEN (actions: read), GH_REPO, GITHUB_SHA
# (the commit the run tests; the job prints it as its start marker).
#
# The job's own log is served only once the job has completed, so this runs
# as a second job.
#
# What the scan proves: hosts, resource paths, GUIDs and tokens never appear
# unmasked in the whole log. What it does not prove: that a bare workspace or
# resource-group name never appears. Those rely on the runner's
# case-sensitive secret masking. Read the first public log by hand, and if a
# case variant of a secret ever shows up, give this job the environment,
# ::add-mask:: the secrets here and grep for them case-insensitively.
#
# Hard rule: the allow-list below holds runner and azure/login boilerplate
# only. Allow-listing the workspace, the resource group, the storage account
# or any ID to silence a finding is a leak, not a fix.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=.github/scripts/azure-e2e/lib.sh
source "$SCRIPT_DIR/lib.sh"
require_tool gh
require_tool perl

run_id="${1:?usage: log-check.sh <run-id>}"
: "${GH_REPO:?set GH_REPO}"
: "${GITHUB_SHA:?set GITHUB_SHA}"

# Perl regexes for runner and actions/checkout boilerplate that carries a
# GUID of its own. Each match is cut out of the line before the scan, not
# the whole line skipped, so an Azure ID elsewhere on the line is still
# caught. Anchor every pattern on the exact context; never allow a bare GUID.
GUID='[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}'
ALLOW_CONTEXTS=(
  # "Worker ID: {<guid>}", printed by the runner's job setup.
  "Worker ID: \\{${GUID}\\}"
  # A per-step directory directly under the runner's temp folder, e.g.
  # "Temporarily overriding HOME='/home/runner/work/_temp/<guid>'" and
  # "/github/runner_temp/<guid>" in container mounts.
  "(?:/_temp|runner_temp)/${GUID}(?=[/'\"\\s]|\$)"
  # actions/checkout's credentials file: "git-credentials-<guid>.config".
  "git-credentials-${GUID}\\.config"
)

job_name="Azure E2E"
marker_start="Azure E2E at ${GITHUB_SHA}"
marker_end="Cleaning up orphan processes"
log="${RUNNER_TEMP:-/tmp}/azure-e2e-job-log.txt"
found="${RUNNER_TEMP:-/tmp}/azure-e2e-job-log-findings.txt"
trap 'rm -f "$log" "$found"' EXIT

# filter=latest, not a given attempt: it still finds the job when only this
# check was re-run, which gives it a newer attempt than the job has.
job_id="$(gh api "repos/${GH_REPO}/actions/runs/${run_id}/jobs?filter=latest" \
  --jq "[.jobs[] | select(.name == \"${job_name}\")][0].id // empty")" ||
  {
    log_error "Cannot list the run's jobs: the job needs 'actions: read' and a GH_TOKEN. Fix that and re-run this job."
    exit 1
  }
if [ -z "$job_id" ]; then
  log_error "Cannot find the job named '${job_name}' in run ${run_id}: masking is unproven, so read the run's log by hand."
  exit 1
fi

# The job always prints the start marker near its beginning and the runner
# prints the end marker last; a log missing either is empty or cut short,
# and zero findings in it prove nothing.
complete=0
for try in 1 2 3; do
  if gh api --allow-escape-sequences "repos/${GH_REPO}/actions/jobs/${job_id}/logs" > "$log" &&
    [ -s "$log" ] && grep -qF -- "$marker_start" "$log" && grep -qF -- "$marker_end" "$log"; then
    complete=1
    break
  fi
  log_warn "The ${job_name} job's log is not readable and complete yet (try ${try} of 3)"
  if [ "$try" -lt 3 ]; then sleep 10; fi
done
if [ "$complete" -ne 1 ]; then
  log_error "Cannot read the ${job_name} job's complete log (empty, cut short or not served): masking is unproven. Read the log by hand, then re-run this job."
  exit 1
fi

# Prints "<category> <line number>" per finding, never the matched text.
allow="$(printf '%s\n' "${ALLOW_CONTEXTS[@]}")"
LOGCHECK_ALLOW="$allow" perl -e '
  my @allow = grep { length } split /\n/, ($ENV{LOGCHECK_ALLOW} // "");
  my $zero = qr/^00000000-0000-0000-0000-0000000000[0-9a-f]{2}$/i;
  # "***" is the runner mask; the rest are the documentation placeholders.
  my %ok = map { $_ => 1 } ("***", "myworkspace", "stexample", "rg-example");
  while (my $line = <STDIN>) {
    $line =~ s/$_//gi for @allow;
    my %hit;
    for my $g ($line =~ /([0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12})/gi) {
      $hit{"guid"} = 1 unless $g =~ $zero;
    }
    for my $x ($line =~ /([^\s\/.@\x27"]+)\.dev\.azuresynapse\.net/gi) {
      $hit{"workspace-host"} = 1 unless $ok{lc $x};
    }
    # The SQL endpoints: <ws>.sql... and <ws>-ondemand.sql...
    for my $x ($line =~ /([^\s\/.@\x27"]+)\.sql\.azuresynapse\.net/gi) {
      (my $name = lc $x) =~ s/-ondemand$//;
      $hit{"sql-host"} = 1 unless $ok{$name};
    }
    for my $x ($line =~ /([^\s\/.@\x27"]+)\.(?:dfs|blob)\.core\.windows\.net/gi) {
      $hit{"storage-host"} = 1 unless $ok{lc $x};
    }
    # Only the account is judged; the file system is free text.
    for my $x ($line =~ /abfss:\/\/[^@\s\x27"]*@([^.\s\/\x27"]+)/gi) {
      $hit{"abfss-account"} = 1 unless $ok{lc $x};
    }
    for my $x ($line =~ /(?:\/|%2f)resourceGroups(?:\/|%2f)([^\/%\s\x27"]+)/gi) {
      $hit{"resource-group-path"} = 1 unless $ok{lc $x};
    }
    # Anchored on /providers/ so that the type names the action logs
    # (Microsoft.Synapse/workspaces/notebooks) are not mistaken for a path.
    for my $x ($line =~ /(?:\/|%2f)providers(?:\/|%2f)Microsoft\.Synapse(?:\/|%2f)workspaces(?:\/|%2f)([^\/%\s\x27"]+)/gi) {
      $hit{"workspace-path"} = 1 unless $ok{lc $x};
    }
    for my $x ($line =~ /(?:\/|%2f)storageAccounts(?:\/|%2f)([^\/%\s\x27"]+)/gi) {
      $hit{"storage-path"} = 1 unless $ok{lc $x};
    }
    $hit{"token"} = 1 if $line =~ /eyJ[A-Za-z0-9_-]{10,}/;
    print "$_ $.\n" for sort keys %hit;
  }
' < "$log" > "$found"

count="$(wc -l < "$found" | tr -d ' ')"
if [ "$count" -ne 0 ]; then
  while IFS= read -r category; do
    lines="$(awk -v c="$category" '$1 == c { printf "%s%s", sep, $2; sep = ", " }' "$found")"
    log_error "${category}: line(s) ${lines}"
  done < <(awk '{ print $1 }' "$found" | sort -u)
  log_error "${count} possible leak(s) at the lines above: the run log is public. Check those lines and, if they leak, delete the run's logs."
  exit 1
fi
log_info "The ${job_name} job's log ($(wc -l < "$log" | tr -d ' ') lines) shows no GUID, host, resource path or token outside the placeholders"
