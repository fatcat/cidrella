// ─── Central default values ──────────────────────────────
// Every tunable constant lives here. DB-seeded settings use these as
// initial values (see db/init.js ensureDefaults). Server code imports
// either the DB-backed getter or the constant directly — never both.

// ─── DB-seeded settings (user-configurable via UI / API) ─────────

export const DEFAULTS = {
  dns_upstream_servers:    ['8.8.8.8', '9.9.9.9'],
  dns_soa_defaults: {
    soa_refresh:     3600,
    soa_retry:       900,
    soa_expire:      604800,
    soa_minimum_ttl: 900,
    soa_primary_ns:  'ns1.localhost',
    soa_admin_email: 'admin.localhost',
  },
  default_lease_time:      '24h',
  default_gateway_position: 'first',
  subnet_name_template:    '%1.%2.%3.%4/%bitmask',
  default_scan_interval:   '',
  default_scan_enabled:    '1',
  blocklist_enabled:       'true',
  blocklist_redirect_ip:   '',
  blocklist_update_schedule: 'daily',
  backup_schedule:         'off',
  backup_retention_count:  '7',
  installation_complete:   'false',
  setup_wizard_completed:  '0',
  audit_log_retention_days: 7,
  geoip_enabled:           'false',
  geoip_mode:              'blocklist',
  geoip_proxy_port:        '5353',
  geoip_db_path:           'auto',
  geoip_last_updated:      '',
  geoip_update_schedule:   'monthly',
  update_check_enabled:    'true',
};

// ─── Shared constants (not in DB — implementation details) ───────

export const DNS_TEST_TIMEOUT_MS      = 5000;
export const DNS_TEST_RETRY_DELAY_MS  = 5000;
export const SCAN_BATCH_SIZE          = 10;
export const MAX_SCAN_SIZE            = 4096;
export const GEOIP_CACHE_MAX          = 10000;
export const GEOIP_CACHE_TTL_MS       = 60 * 60 * 1000;     // 1 hour
export const GEOIP_CHECK_INTERVAL_MS  = 6 * 60 * 60 * 1000; // 6 hours
export const GEOIP_STARTUP_DELAY_MS   = 15000;               // 15 seconds
export const GEOIP_DOWNLOAD_TIMEOUT_MS = 60000;              // 60 seconds
export const GEOIP_QUERY_TIMEOUT_MS   = 5000;
export const ARPING_TIMEOUT_MS        = 5000;
export const PING_TIMEOUT_MS          = 1500;
export const AUDIT_PRUNE_INTERVAL_MS  = 6 * 60 * 60 * 1000; // 6 hours
export const DHCP_LEASE_WATCH_MS      = 10000;               // 10 seconds
export const BLOCKLIST_DOWNLOAD_TIMEOUT_MS = 60000;
export const UPDATE_CHECK_INTERVAL_MS = 6 * 60 * 60 * 1000; // 6 hours
export const UPDATE_CHECK_DELAY_MS    = 30000;               // 30 seconds
export const GITHUB_REPO              = 'fatcat/cidrella';    // owner/repo for update checks

// Secondary DNS server used when auto-populating DHCP option 6
export const FALLBACK_SECONDARY_DNS   = '9.9.9.9';
