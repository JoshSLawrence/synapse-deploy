#!/usr/bin/env bash
# Tests the pure functions of release.sh. Each case sources it in a subshell,
# so its `set -euo pipefail` cannot leak into this script or into the next
# case.
set -euo pipefail

cd "$(dirname "${BASH_SOURCE[0]}")"
failures=0

# check <description> <expected: 0 or 1> <function> [args...]
check() {
  local description="$1" expected="$2" status=0
  shift 2
  (
    # shellcheck source=.github/scripts/release.sh
    source ./release.sh
    "$@"
  ) >/dev/null 2>&1 || status=$?
  if [[ $status -ne $expected ]]; then
    printf '[FAIL] %s: exit %s, expected %s\n' "$description" "$status" "$expected" >&2
    failures=$((failures + 1))
  fi
}

check "valid_version accepts v1.2.3" 0 valid_version v1.2.3
check "valid_version accepts v0.10.0" 0 valid_version v0.10.0
check "valid_version rejects 1.2.3" 1 valid_version 1.2.3
check "valid_version rejects v1.2" 1 valid_version v1.2
check "valid_version rejects v01.2.3" 1 valid_version v01.2.3
check "valid_version rejects v1.2.3-rc1" 1 valid_version v1.2.3-rc1
check "valid_version rejects empty" 1 valid_version ""

check "is_higher: v1.10.0 after v1.9.0" 0 is_higher v1.10.0 v1.9.0
check "is_higher: v2.0.0 after v1.9.9" 0 is_higher v2.0.0 v1.9.9
check "is_higher: v1.2.10 after v1.2.9" 0 is_higher v1.2.10 v1.2.9
check "is_higher: v1.9.0 not after v1.10.0" 1 is_higher v1.9.0 v1.10.0
check "is_higher: equal is not higher" 1 is_higher v1.2.3 v1.2.3
check "is_higher: empty old passes" 0 is_higher v1.0.0 ""

# major_of prints, so compare its output.
out="$(
  # shellcheck source=.github/scripts/release.sh
  source ./release.sh
  major_of v2.3.4
)"
if [[ "$out" != "v2" ]]; then
  printf '[FAIL] major_of v2.3.4 printed %s, expected v2\n' "$out" >&2
  failures=$((failures + 1))
fi

check "moves_major is false for v0.4.0" 1 moves_major v0.4.0
check "moves_major is true for v1.0.0" 0 moves_major v1.0.0

if [[ $failures -ne 0 ]]; then
  printf '[error] %s release test(s) failed\n' "$failures" >&2
  exit 1
fi
printf '[info] All release tests passed\n'
