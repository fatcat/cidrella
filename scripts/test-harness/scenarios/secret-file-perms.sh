#!/bin/bash
# Scenario: secret-file-perms
#
# Validates the v0.4.8 secret-file-permission tightening. After a fresh
# install, cidrella.db, analytics.duckdb, server.key and their sidecars
# must be mode 600, certs/, backups/, anomaly/ must be mode 700. The
# dnsmasq subtree must stay at 755 because dnsmasq drops to the `nobody`
# user and needs to read its own state files on SIGHUP reload — tightening
# it breaks config reload.
#
# This catches the v0.4.7 regression where the DB and TLS private key were
# world-readable (644) and any local user could read bcrypt hashes and
# the TLS private key.

SCENARIO_NAME="secret-file-perms"
SCENARIO_DESCRIPTION="Verify v0.4.8+ secret-file-permission tightening after fresh install"

scenario_setup() {
  # No setup — runner wipes host before this scenario.
  return 0
}

scenario_run() {
  install_latest_release
}

scenario_assert() {
  # ─── SQLite DB + WAL/SHM sidecars: 600 ────────────────
  assert_file_mode /var/lib/cidrella/cidrella.db 600
  assert_file_owner /var/lib/cidrella/cidrella.db cidrella
  # The WAL/SHM files only exist if there's been activity — service has
  # started so they probably do. Conditional assertion would be nicer but
  # keep it simple; if they're missing, the test documents that.
  if [ -e /var/lib/cidrella/cidrella.db-wal ]; then
    assert_file_mode /var/lib/cidrella/cidrella.db-wal 600
  fi
  if [ -e /var/lib/cidrella/cidrella.db-shm ]; then
    assert_file_mode /var/lib/cidrella/cidrella.db-shm 600
  fi

  # ─── DuckDB analytics: 600 ────────────────────────────
  if [ -e /var/lib/cidrella/analytics.duckdb ]; then
    assert_file_mode /var/lib/cidrella/analytics.duckdb 600
  fi

  # ─── TLS private key: 600 (critical) ──────────────────
  assert_file_mode /var/lib/cidrella/certs/server.key 600
  assert_file_owner /var/lib/cidrella/certs/server.key cidrella

  # ─── Secret directories: 700 ──────────────────────────
  assert_file_mode /var/lib/cidrella/certs 700
  assert_file_mode /var/lib/cidrella/backups 700
  assert_file_mode /var/lib/cidrella/anomaly 700
  if [ -d /var/lib/cidrella/anomaly/models ]; then
    assert_file_mode /var/lib/cidrella/anomaly/models 700
  fi

  # ─── Dnsmasq subtree stays 755 (intentional) ──────────
  # dnsmasq drops to `nobody` after startup and needs to read its own state
  # on SIGHUP reload. Tightening this breaks DNS/DHCP config reload.
  assert_file_mode /var/lib/cidrella/dnsmasq 755
}

scenario_capture() {
  capture_command "data_dir_listing" "ls -la /var/lib/cidrella/"
  capture_command "certs_dir_listing" "ls -la /var/lib/cidrella/certs/"
  capture_command "dnsmasq_dir_listing" "ls -la /var/lib/cidrella/dnsmasq/"
  capture_command "anomaly_dir_listing" "ls -la /var/lib/cidrella/anomaly/"
}

scenario_main
