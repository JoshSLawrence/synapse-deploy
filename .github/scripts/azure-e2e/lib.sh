#!/usr/bin/env bash
# Shared helpers for the Azure E2E scripts: color-coded logging that
# writes to stderr, so stdout stays free for data.

if [ -t 2 ]; then
  _c_info=$'\033[0;34m' _c_warn=$'\033[0;33m' _c_err=$'\033[0;31m' _c_off=$'\033[0m'
else
  _c_info='' _c_warn='' _c_err='' _c_off=''
fi

log_info() { printf '%s[INFO]%s %s\n' "$_c_info" "$_c_off" "$*" >&2; }
log_warn() { printf '%s[WARN]%s %s\n' "$_c_warn" "$_c_off" "$*" >&2; }
log_error() { printf '%s[ERROR]%s %s\n' "$_c_err" "$_c_off" "$*" >&2; }

require_tool() {
  command -v "$1" > /dev/null 2>&1 || {
    log_error "$1 is not installed: install it and retry."
    exit 1
  }
}
