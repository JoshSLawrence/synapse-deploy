#!/usr/bin/env bash
#
# Releases main's current head as VERSION: checks everything that can be
# checked, creates the immutable release with generated notes, and points the
# lightweight major tag (v1, v2, ...) at the same commit.
#
# Environment variables:
#   VERSION     the version to release, vMAJOR.MINOR.PATCH (required)
#   DRY_RUN     "true" prints the release notes and the commands, changes nothing
#   PREFLIGHT   "true" runs the read-only checks and stops before the notes
#   SKIP_E2E    "true" releases without a successful Azure E2E run
#   GH_REPO, GH_TOKEN, GITHUB_SHA, GITHUB_REF   set by the workflow
#
# The pure functions come first so release-test.sh can source this file;
# main runs only when the file is executed.

set -euo pipefail

log_info() { printf '\033[0;34m[info]\033[0m %s\n' "$*"; }
log_warn() { printf '\033[0;33m[warn]\033[0m %s\n' "$*" >&2; }
log_error() { printf '\033[0;31m[error]\033[0m %s\n' "$*" >&2; }

valid_version() {
  [[ "${1:-}" =~ ^v(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$ ]]
}

# True when new sorts strictly after old; an empty old (no release yet)
# always passes.
is_higher() {
  local new="$1" old="${2:-}" top
  [[ -z "$old" ]] && return 0
  [[ "$new" == "$old" ]] && return 1
  top="$(printf '%s\n%s\n' "$new" "$old" | sort -V | tail -n 1)"
  [[ "$top" == "$new" ]]
}

major_of() {
  printf '%s\n' "${1%%.*}"
}

# v0.x has no major tag: 0.y.z releases are all breaking by semver.
moves_major() {
  [[ "$(major_of "$1")" != "v0" ]]
}

# ref_info TAG: prints "<object type> <object sha>", or nothing when the tag
# does not exist. Any other failure is fatal: a wrong answer here would
# release over an existing tag.
ref_info() {
  local out
  if out="$(gh api "repos/${GH_REPO}/git/ref/tags/$1" --jq '.object.type + " " + .object.sha' 2>&1)"; then
    printf '%s\n' "$out"
  elif [[ "$out" == *"HTTP 404"* ]]; then
    return 0
  else
    log_error "Cannot read the tag $1: ${out}. Check the token's permissions and retry."
    return 1
  fi
}

# gh_read WHAT ARGS...: a read-only `gh api` call. On failure it says what
# was being read and what to do, instead of leaving only gh's own message.
gh_read() {
  local what="$1" out
  shift
  if ! out="$(gh api "$@" 2>&1)"; then
    log_error "Cannot read ${what}: ${out}. Retry the run; if it keeps failing, check the token's permissions and https://www.githubstatus.com."
    return 1
  fi
  printf '%s\n' "$out"
}

# release_exists TAG: 0 when a release exists for the tag, 1 on a 404, 2 on
# any other failure, so a transient error is never read as "no release".
release_exists() {
  local out
  if out="$(gh api "repos/${GH_REPO}/releases/tags/$1" --jq .tag_name 2>&1)"; then
    return 0
  elif [[ "$out" == *"HTTP 404"* ]]; then
    return 1
  fi
  log_error "Cannot read the release for $1: ${out}. Retry the run; if it keeps failing, check the token's permissions and https://www.githubstatus.com."
  return 2
}

# release_recovery: runs on any failure between creating the release and
# starting the major tag move, when the release may or may not exist.
release_recovery() {
  log_error "The release ${release_version} may exist: re-run Release with the same version to resume (only while main hasn't moved), or move the major tag by hand."
  if [[ -n "${MAJOR:-}" ]]; then
    printf 'To move %s now:\n' "$MAJOR" >&2
    print_move_command "$GITHUB_SHA" >&2
  fi
}

# print_move_command SHA: the command that creates or moves the major tag.
print_move_command() {
  local sha="$1"
  if [[ -z "$major_sha" ]]; then
    printf 'gh api -X POST repos/%s/git/refs -f ref=refs/tags/%s -f sha=%s\n' "$GH_REPO" "$MAJOR" "$sha"
  else
    printf 'gh api -X PATCH repos/%s/git/refs/tags/%s -f sha=%s -F force=false\n' "$GH_REPO" "$MAJOR" "$sha"
  fi
}

main() {
  local version="${VERSION:-}" dry_run="${DRY_RUN:-false}" preflight="${PREFLIGHT:-false}"
  local skip_e2e="${SKIP_E2E:-false}" resume=0 sha="${GITHUB_SHA:?set GITHUB_SHA}"
  local head existing highest count status reason out errfile moved has_release imm

  : "${GH_REPO:?set GH_REPO}"
  : "${GITHUB_REF:?set GITHUB_REF}"

  # 1. The version.
  if ! valid_version "$version"; then
    log_error "'${version}' is not a version: use vMAJOR.MINOR.PATCH, such as v1.2.3."
    return 1
  fi

  # 2. Only main's current head is released.
  if [[ "$GITHUB_REF" != "refs/heads/main" ]]; then
    log_error "Release runs from main, not ${GITHUB_REF}: dispatch the workflow with --ref main."
    return 1
  fi
  head="$(gh_read "main's head commit" "repos/${GH_REPO}/commits/main" --jq .sha)"
  if [[ "$head" != "$sha" ]]; then
    log_error "main moved since this run started: run Azure E2E and Release again on the new main."
    return 1
  fi

  # 3, 4. Existing tags. The highest one decides what a resumed run may be.
  highest="$(gh_read "the existing tags" --paginate "repos/${GH_REPO}/tags" --jq '.[].name' |
    { grep -E '^v(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$' || true; } |
    sort -V | tail -n 1)"
  existing="$(ref_info "$version")"
  if [[ -n "$existing" ]]; then
    has_release=0
    release_exists "$version" || has_release=$?
    if [[ $has_release -eq 2 ]]; then
      return 1
    elif [[ "$existing" == "commit ${sha}" && "$version" == "$highest" && $has_release -eq 0 ]]; then
      resume=1
      log_warn "${version} is already released at ${sha}: only the major tag is moved."
    else
      log_error "${version} already exists and cannot be resumed: tags are never reused, release a higher version."
      return 1
    fi
  fi
  if [[ $resume -eq 0 ]] && ! is_higher "$version" "$highest"; then
    log_error "Versions only increase: the highest is ${highest}, so release a higher version than ${version}. Backports to an older major are not supported."
    return 1
  fi

  # 5. Evidence that the live test passed for this commit.
  if [[ $resume -eq 1 ]]; then
    log_info "Resuming: the Azure E2E evidence was checked when ${version} was released."
  elif [[ "$skip_e2e" == "true" ]]; then
    log_warn "Releasing without a successful Azure E2E run (skip-e2e)."
  else
    count="$(gh_read "the Azure E2E runs" "repos/${GH_REPO}/actions/workflows/azure-e2e.yaml/runs?head_sha=${sha}&branch=main&status=success" --jq .total_count)"
    if [[ "${count:-0}" -lt 1 ]]; then
      log_error "No successful Azure E2E run for ${sha}: dispatch Azure E2E on main, approve it, then run Release again."
      return 1
    fi
    log_info "Azure E2E succeeded for ${sha}."
  fi

  # 6. The major tag may only move forward.
  MAJOR=""
  major_sha=""
  if moves_major "$version"; then
    MAJOR="$(major_of "$version")"
    out="$(ref_info "$MAJOR")"
    if [[ -n "$out" ]]; then
      if [[ "${out%% *}" != "commit" ]]; then
        log_error "${MAJOR} is an annotated tag: delete it and run Release again; it must be a lightweight tag."
        return 1
      fi
      major_sha="${out#* }"
      status="$(gh_read "the comparison of ${MAJOR} with ${sha}" "repos/${GH_REPO}/compare/${major_sha}...${sha}" --jq .status)"
      if [[ "$status" != "ahead" && "$status" != "identical" ]]; then
        log_error "${MAJOR} points at ${major_sha}, which is not behind ${sha} (${status}): the two have diverged or ${MAJOR} is ahead, so it would not move forward. Release from a descendant of it, or move the tag by hand."
        return 1
      fi
    fi
  else
    log_info "${version} is a 0.x release: there is no major tag."
  fi

  # 7. The read-only part is done.
  if [[ "$preflight" == "true" ]]; then
    log_info "Preflight passed for ${version} at ${sha}."
    return 0
  fi

  # 8. Dry run: show what a real run would publish.
  if [[ "$dry_run" == "true" ]]; then
    if [[ $resume -eq 0 ]]; then
      log_info "Release notes for ${version}:"
      gh api -X POST "repos/${GH_REPO}/releases/generate-notes" -f "tag_name=${version}" -f "target_commitish=${sha}" --jq .body
      log_info "Would run: gh release create ${version} --target ${sha} --title ${version} --generate-notes"
    fi
    if [[ -n "$MAJOR" ]]; then
      log_info "Would run: $(print_move_command "$sha")"
    fi
    return 0
  fi

  # 9. The release. The workflow's token creates the tag with it.
  # From here the release may exist even if a command fails, so say how to
  # recover. errtrace lets the trap fire inside main.
  release_version="$version"
  set -o errtrace
  trap release_recovery ERR
  if [[ $resume -eq 0 ]]; then
    log_info "Creating the release ${version}"
    gh release create "$version" --target "$sha" --title "$version" --generate-notes
  fi
  out="$(ref_info "$version")"
  if [[ "$out" != "commit ${sha}" ]]; then
    log_error "The tag ${version} does not point at ${sha} (${out:-missing}): check the release by hand before anything else."
    return 1
  fi
  imm="$(gh api "repos/${GH_REPO}/releases/tags/${version}" --jq .immutable 2>/dev/null)" || imm="unknown"
  if [[ "$imm" != "true" ]]; then
    log_warn "${version} is not confirmed immutable (${imm}): enable immutable releases in the repository settings."
  fi
  # The major tag step reports its own failures.
  trap - ERR

  # 10. The major tag.
  if [[ -n "$MAJOR" ]]; then
    log_info "Pointing ${MAJOR} at ${sha}"
    errfile="$(mktemp)"
    moved=1
    if [[ -z "$major_sha" ]]; then
      gh api -X POST "repos/${GH_REPO}/git/refs" -f "ref=refs/tags/${MAJOR}" -f "sha=${sha}" >/dev/null 2>"$errfile" || moved=0
    else
      gh api -X PATCH "repos/${GH_REPO}/git/refs/tags/${MAJOR}" -f "sha=${sha}" -F force=false >/dev/null 2>"$errfile" || moved=0
    fi
    reason="$(cat "$errfile")"
    rm -f "$errfile"
    if [[ $moved -eq 0 ]]; then
      : "${reason:=the API refused the update}"
      log_error "${version} is released, but ${MAJOR} was not moved: ${reason}. Move it by hand now, before main moves (a re-run with the same version resumes only while main is at ${sha}):"
      print_move_command "$sha" >&2
      return 1
    fi
    # 11. Verify.
    out="$(ref_info "$MAJOR")"
    if [[ "$out" != "commit ${sha}" ]]; then
      log_error "${MAJOR} does not point at ${sha} after the move (${out:-missing}): move it by hand."
      return 1
    fi
  fi

  if [[ -n "${GITHUB_STEP_SUMMARY:-}" ]]; then
    {
      printf '### Released %s\n\n' "$version"
      printf -- "- Commit: \`%s\`\n" "$sha"
      printf -- '- Release: https://github.com/%s/releases/tag/%s\n' "$GH_REPO" "$version"
      if [[ -n "$MAJOR" ]]; then printf -- "- Major tag: \`%s\`\n" "$MAJOR"; fi
      if [[ "$skip_e2e" == "true" && $resume -eq 0 ]]; then
        printf -- '- Released without a green Azure E2E run\n'
      fi
    } >>"$GITHUB_STEP_SUMMARY"
  fi
  log_info "Released ${version}${MAJOR:+ and moved ${MAJOR}}."
}

if [[ "${BASH_SOURCE[0]}" == "$0" ]]; then
  main "$@"
fi
