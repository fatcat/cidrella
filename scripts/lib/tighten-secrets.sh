#!/bin/bash
# CIDRella secret file permission tightening.
#
# Source this file; do not execute it. Provides:
#   - tighten_secrets <data-dir>: chmod 600/700 on the secret paths under
#     the given data directory (typically /var/lib/cidrella).
#
# v0.4.8 narrowed the default perms on the SQLite DB, DuckDB analytics,
# TLS private key, backups, and trained anomaly models so only the cidrella
# service user and root can read them. Prior to this, everything was created
# with mode 644 by the service's default umask, meaning any local OS user
# could read the DB (getting bcrypt hashes + audit log) and the TLS key.
#
# This function is idempotent and only tightens (never loosens). It's called
# from install.sh post-service-start and from update.sh post-health-check.
# Every chmod is `|| true`, files may legitimately not exist on a fresh
# install until the service creates them.
#
# dnsmasq subtree is NOT touched: dnsmasq drops to the `nobody` user at
# startup and needs to read its own state files on SIGHUP reload. Tightening
# /var/lib/cidrella/dnsmasq/ would break DNS/DHCP config reload.

if [ "${__CIDRELLA_TIGHTEN_SECRETS_LIB_LOADED:-}" = "1" ]; then
  return 0 2>/dev/null || exit 0
fi
__CIDRELLA_TIGHTEN_SECRETS_LIB_LOADED=1

tighten_secrets() {
  local data_dir="${1:-/var/lib/cidrella}"

  # SQLite DB + WAL/shm sidecars
  chmod 600 "$data_dir/cidrella.db"     2>/dev/null || true
  chmod 600 "$data_dir/cidrella.db-wal" 2>/dev/null || true
  chmod 600 "$data_dir/cidrella.db-shm" 2>/dev/null || true

  # DuckDB analytics + sidecars
  chmod 600 "$data_dir/analytics.duckdb" 2>/dev/null || true
  for f in "$data_dir"/analytics.duckdb.*; do
    [ -f "$f" ] && chmod 600 "$f" 2>/dev/null || true
  done

  # TLS material, cert is public but the private key absolutely is not.
  chmod 700 "$data_dir/certs"            2>/dev/null || true
  chmod 600 "$data_dir/certs/server.key" 2>/dev/null || true

  # Backups contain full DB dumps, strictly admin-only.
  chmod 700 "$data_dir/backups" 2>/dev/null || true
  for f in "$data_dir"/backups/*.tar.gz "$data_dir"/backups/*.tar.gz.enc; do
    [ -f "$f" ] && chmod 600 "$f" 2>/dev/null || true
  done

  # Trained anomaly models reveal per-client DNS behavior profiles.
  chmod 700 "$data_dir/anomaly"        2>/dev/null || true
  chmod 700 "$data_dir/anomaly/models" 2>/dev/null || true
  for f in "$data_dir"/anomaly/models/*; do
    [ -f "$f" ] && chmod 600 "$f" 2>/dev/null || true
  done
}
