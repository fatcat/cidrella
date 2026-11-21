/**
 * The class of every table and every settings key: what happens to it when
 * CIDRella runs as more than one instance (docs/REDUNDANCY-PLAN.md, section 1).
 *
 *   estate     the data of record. One instance owns it; every other holds a
 *              copy, so any of them can take over without loss.
 *   host       about this box alone. Never leaves it.
 *   collected  measured on the instance that produced it and copied up to the
 *              owner, never sent down.
 *
 * A new table or settings key is classified here in the change that adds it:
 * tests/unit/sync/registry.test.js fails on one that is missing, and on an
 * entry for something that no longer exists.
 */
const ESTATE = 'estate';
const HOST = 'host';
const COLLECTED = 'collected';

const estate = (key = 'id', more = {}) => ({ class: ESTATE, key, ...more });
const host = { class: HOST };
const collected = { class: COLLECTED };

// The after-commit hooks (utils/after-commit.js) a change to a table calls for
// on an instance that received it: what it serves must follow the new data.
const DNS = 'regenerate_dns';
const DHCP = 'regenerate_dhcp';
const RESOLVER = 'regenerate_dnsmasq_conf';

/**
 * Every table. An estate table names its key, one column, which is how a row
 * is told apart between instances. `hostColumns` are the columns of an estate
 * table that stay behind: state this box keeps about the row. `hooks` are the
 * applies a change to the table calls for where the DNS and DHCP servers read
 * it.
 */
export const TABLES = {
  anomaly_allowlist: estate(),
  anomaly_models: collected,
  anomaly_scores: estate(),
  api_tokens: estate(),
  audit_log: estate(),
  backups: host,
  blocklist_allowlist: estate(),
  // Which lists are on is shared; each box downloads its own copy of a list.
  blocklist_categories: estate('slug', {
    hostColumns: ['domain_count', 'last_fetched_at', 'last_error', 'etag', 'last_modified'],
  }),
  blocklist_domains: host,
  blocklist_stage: host,
  configuration_generations: host,
  device_fingerprint_changes: estate(),
  device_fingerprints: estate('mac_address'),
  dhcp_authorized_servers: estate(),
  dhcp_custom_options: estate('id', { hooks: [DHCP] }),
  dhcp_leases: estate(),
  dhcp_option_defaults: estate('id', { hooks: [DHCP] }),
  dhcp_reservations: estate('id', { hooks: [DHCP] }),
  dhcp_scope_options: estate('id', { hooks: [DHCP] }),
  dhcp_scope_pools: estate('id', { hooks: [DHCP] }),
  dhcp_scopes: estate('id', { hooks: [DHCP] }),
  dns_records: estate('id', { hooks: [DNS] }),
  dns_zones: estate('id', { hooks: [DNS] }),
  filtering_exemptions: estate(),
  folders: estate(),
  geoip_ip_allowlist: estate(),
  geoip_rules: estate(),
  // A reserved address is cut out of the DHCP pool that holds it.
  ip_addresses: estate('id', { hooks: [DHCP] }),
  ip_events: estate(),
  ip_range_events: estate(),
  mac_vendors: host,
  metrics: collected,
  metrics_blocklist_hits: collected,
  metrics_forwarder: collected,
  metrics_geoip_hits: collected,
  metrics_proxy_perf: collected,
  network_scans: estate(),
  range_types: estate(),
  ranges: estate('id', { hooks: [DHCP] }),
  rogue_dhcp_events: estate(),
  scan_results: estate(),
  schema_version: host,
  sessions: host,
  // Classified key by key, below.
  settings: estate('key', { hooks: [DNS, DHCP, RESOLVER] }),
  subnets: estate('id', { hooks: [DNS, DHCP] }),
  // The change log itself and this box's place in it (sync/log.js).
  sync_log: host,
  sync_state: host,
  user_backup_codes: estate(),
  users: estate(),
  vlans: estate(),
};

/**
 * Every settings key. A key missing here is treated as host, which is the
 * safe way to be wrong: it stays on the box.
 */
export const SETTINGS = {
  analytics_retention_days: ESTATE,
  anomaly_acknowledged_score_id: ESTATE,
  // Written by the anomaly sidecar: the state of the one running on this box.
  anomaly_daemon_status: HOST,
  anomaly_detection_enabled: ESTATE,
  anomaly_min_training_hours: ESTATE,
  anomaly_retention_days: ESTATE,
  anomaly_scoring_interval_min: ESTATE,
  anomaly_sensitivity: ESTATE,
  anomaly_training_interval_hours: ESTATE,
  audit_log_retention_days: ESTATE,
  // Which DNS and DHCP servers this box runs.
  backend_stack: HOST,
  backup_last_run: HOST,
  backup_name_template: HOST,
  backup_retention_count: HOST,
  backup_schedule: HOST,
  blocklist_enabled: ESTATE,
  // Counted from this box's copy of the lists.
  blocklist_enabled_domain_count: HOST,
  blocklist_max_feed_mb: ESTATE,
  blocklist_redirect_ip: ESTATE,
  blocklist_redirect_ip6: ESTATE,
  blocklist_update_schedule: ESTATE,
  default_gateway_position: ESTATE,
  default_lease_time: ESTATE,
  default_scan_enabled: ESTATE,
  default_scan_interval: ESTATE,
  // Before backend_stack; read once at boot to carry an old choice over.
  dhcp_backend: HOST,
  // This box's own address, as last written into the DNS Servers default.
  dhcp_dns_default_server_ip: HOST,
  dhcp_enabled: HOST,
  dns_enabled: HOST,
  dns_forwarder_down: HOST,
  dns_listen_port: HOST,
  dns_no_recursion: ESTATE,
  dns_proxy_bypass: HOST,
  dns_soa_defaults: ESTATE,
  dns_upstream_backup_mode: ESTATE,
  dns_upstream_backup_servers: ESTATE,
  dns_upstream_servers: ESTATE,
  dnssec_enabled: ESTATE,
  filtering_paused_until: ESTATE,
  forwarder_encrypted_upstreams: ESTATE,
  forwarder_encryption: ESTATE,
  geoip_db_path: HOST,
  geoip_enabled: ESTATE,
  geoip_last_updated: HOST,
  geoip_mode: ESTATE,
  geoip_proxy_port: HOST,
  geoip_update_schedule: ESTATE,
  http_port: HOST,
  http_redirect_enabled: HOST,
  https_port: HOST,
  installation_complete: HOST,
  interface_config: HOST,
  ip_history_retention_days: ESTATE,
  ipv6_enabled: ESTATE,
  // Signs this box's sessions, which are host data too.
  jwt_secret: HOST,
  last_running_version: HOST,
  last_updater_run_at: HOST,
  map_home: ESTATE,
  password_min_length: ESTATE,
  password_require_mixed_case: ESTATE,
  password_require_number: ESTATE,
  password_require_symbol: ESTATE,
  restore_carryover: HOST,
  rogue_dhcp_detection_enabled: ESTATE,
  rogue_dhcp_probe_interval_min: ESTATE,
  session_idle_timeout_minutes: ESTATE,
  setup_state: HOST,
  setup_wizard_completed: HOST,
  subnet_name_template: ESTATE,
  update_available_version: HOST,
  update_chain: HOST,
  update_check_enabled: HOST,
  update_checked_at: HOST,
  update_intermediate_notes: HOST,
  update_manifest_available: HOST,
  update_release_url: HOST,
};
