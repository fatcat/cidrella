#!/bin/bash
# CIDRella systemd unit install helpers.
#
# Source this file; do not execute it. Provides:
#   - install_systemd_unit <source> <dest>: idempotent copy + daemon-reload hint
#   - reload_systemd:                      daemon-reload wrapper
#   - install_logrotate_configs <dir>:     every file in <dir> into
#                                          /etc/logrotate.d
#   - ensure_service_user <name>:          a system account for a unit
#   - install_polkit_rule <src> [dir]:     a polkit rule, swapped in whole
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

# install_logrotate_configs <dir>
#   Installs every file in <dir> (a slot's scripts/logrotate) into
#   /etc/logrotate.d under its own name, and says so. Nothing on a host
#   without logrotate.
install_logrotate_configs() {
  local dir="${1:?logrotate config dir required}" conf
  [ -d /etc/logrotate.d ] || return 0
  for conf in "$dir"/*; do
    [ -f "$conf" ] || continue
    install -m 0644 -o root -g root "$conf" "/etc/logrotate.d/$(basename "$conf")"
    ok "Installed logrotate config (/etc/logrotate.d/$(basename "$conf"))"
  done
}

# ensure_service_user <name>
#   A system account with a group of its own, no home and no login shell, for
#   a unit to run as (cidrella-helper). Nothing when it exists. Echoes
#   "created" when it made one; returns 1 when useradd failed.
ensure_service_user() {
  local name="${1:?user name required}"
  if id "$name" >/dev/null 2>&1; then
    return 0
  fi
  useradd --system --user-group --no-create-home --shell /usr/sbin/nologin "$name" || return 1
  printf 'created\n'
}

# install_polkit_rule <src> [rules_dir]
#   Installs the polkit rule <src> as <rules_dir>/<its name> (rules_dir is
#   /etc/polkit-1/rules.d unless given), mode 0644, root's when run as root.
#   polkitd watches the directory and reloads on the first change, so a rule
#   written in place is read half-written: "Error loading script", and for a
#   moment the rule grants nothing. The new copy goes to a dotfile polkitd
#   ignores (it loads *.rules only) beside the target, then a rename swaps it
#   in whole. Nothing is written when the installed rule already matches.
#   Echoes "changed" when it wrote one; returns 1 on failure.
install_polkit_rule() {
  local src="${1:?source rule path required}"
  local dir="${2:-/etc/polkit-1/rules.d}"
  local dst="$dir/$(basename "$src")"
  local tmp="$dir/.$(basename "$src").new"
  local owner=()
  [ -f "$src" ] || return 1
  if [ -f "$dst" ] && cmp -s "$src" "$dst"; then
    return 0
  fi
  [ "$(id -u)" = 0 ] && owner=(-o root -g root)
  mkdir -p "$dir" || return 1
  if install -m 0644 "${owner[@]}" "$src" "$tmp" && mv -f "$tmp" "$dst"; then
    printf 'changed\n'
    return 0
  fi
  rm -f "$tmp"
  return 1
}
