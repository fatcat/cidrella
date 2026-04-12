#!/bin/bash
# CIDRella systemd unit install helpers.
#
# Source this file; do not execute it. Provides:
#   - install_systemd_unit <source> <dest>: idempotent copy + daemon-reload hint
#   - reload_systemd:                      daemon-reload wrapper
#
# Depends on log.sh. Caller must source log.sh first.

if [ "${__CIDRELLA_SYSTEMD_LIB_LOADED:-}" = "1" ]; then
  return 0 2>/dev/null || exit 0
fi
__CIDRELLA_SYSTEMD_LIB_LOADED=1

# install_systemd_unit <src> <dst>
#   Copies <src> to <dst> only if they differ. Echoes "changed" on stdout
#   when the file was updated so the caller can batch a daemon-reload.
#   Returns 0 on success (whether or not anything changed), 1 on copy failure.
install_systemd_unit() {
  local src="${1:?source unit path required}"
  local dst="${2:?destination unit path required}"

  if [ ! -f "$src" ]; then
    return 1
  fi

  if [ -f "$dst" ] && diff -q "$src" "$dst" >/dev/null 2>&1; then
    return 0
  fi

  if cp "$src" "$dst"; then
    printf 'changed\n'
    return 0
  fi
  return 1
}

# reload_systemd
#   Runs `systemctl daemon-reload`. Fails softly with a warning if systemctl
#   is unavailable (e.g. running inside a container test harness).
reload_systemd() {
  if command -v systemctl >/dev/null 2>&1; then
    systemctl daemon-reload
    return $?
  fi
  return 0
}
