#!/bin/bash
# CIDRella dnsmasq runtime-file permission repair.
#
# Source this file; do not execute it. Provides:
#   - repair_dnsmasq_log_permissions <data-dir>
#
# dnsmasq writes its log after dropping to the `nobody` user. CIDRella tails
# that same log for Settings > Logging, passive liveness, and metrics. Keep
# the file owned by dnsmasq's runtime user, but readable by the cidrella group.

if [ "${__CIDRELLA_DNSMASQ_PERMS_LIB_LOADED:-}" = "1" ]; then
  return 0 2>/dev/null || exit 0
fi
__CIDRELLA_DNSMASQ_PERMS_LIB_LOADED=1

repair_dnsmasq_log_permissions() {
  local data_dir="${1:-/var/lib/cidrella}"
  local log_file="$data_dir/dnsmasq/dnsmasq.log"

  mkdir -p "$data_dir/dnsmasq" 2>/dev/null || true
  touch "$log_file" 2>/dev/null || true
  chgrp cidrella "$log_file" 2>/dev/null || true
  chmod 0640 "$log_file" 2>/dev/null || true
}
