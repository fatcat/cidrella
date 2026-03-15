// ─── Central default values ──────────────────────────────
// Every tunable constant lives here. DB-seeded settings use these as
// initial values (see db/init.js ensureDefaults). Server code imports
// either the DB-backed getter or the constant directly — never both.

import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ─── Data directory (single source of truth) ─────────────
export const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, '..', '..', 'data');

// ─── DB-seeded settings (user-configurable via UI / API) ─────────

export const DEFAULTS = {
  dns_upstream_servers:    ['8.8.8.8', '9.9.9.9'],
  dns_soa_defaults: {
    soa_refresh:     3600,
    soa_retry:       900,
    soa_expire:      604800,
    soa_minimum_ttl: 1800,
    soa_primary_ns:  'ns1.localhost',
    soa_admin_email: 'admin.localhost',
  },
  default_lease_time:      '1h',
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
  geoip_proxy_port:        '5353',     // legacy — kept for migration compat
  geoip_db_path:           'auto',
  geoip_last_updated:      '',
  geoip_update_schedule:   'monthly',
  update_check_enabled:    'true',
  ip_history_retention_days: '7',
  analytics_retention_days: '7',
  anomaly_detection_enabled: 'false',
  anomaly_scoring_interval_min: '15',
  anomaly_training_interval_hours: '6',
  anomaly_min_training_hours: '48',
  anomaly_sensitivity: 'medium',
  anomaly_retention_days: '30',
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
export const PASSIVE_LIVENESS_POLL_MS     = 5000;            // 5 seconds
export const PASSIVE_LIVENESS_DEBOUNCE_MS = 60000;           // 60 seconds per IP
export const PASSIVE_LIVENESS_STALE_MS    = 600000;          // 10 minutes → mark offline
export const PROXY_HEALTH_CHECK_MS        = 3000;              // 3 seconds
export const PROXY_MAX_RESTART_ATTEMPTS   = 3;
export const PROXY_RESTART_DELAY_MS       = 2000;              // 2 seconds between restart attempts
export const BLOCKLIST_DOWNLOAD_TIMEOUT_MS = 60000;
export const UPDATE_CHECK_INTERVAL_MS = 6 * 60 * 60 * 1000; // 6 hours
export const UPDATE_CHECK_DELAY_MS    = 30000;               // 30 seconds
export const GITHUB_REPO              = 'fatcat/cidrella';    // owner/repo for update checks

export const DNSMASQ_INTERNAL_PORT     = 5353;                  // dnsmasq DNS port (proxy-fronted)
export const ANALYTICS_FLUSH_INTERVAL_MS  = 5000;              // 5 seconds
export const ANALYTICS_RETENTION_CLEANUP_MS = 6 * 60 * 60 * 1000; // 6 hours

// Secondary DNS server used when auto-populating DHCP option 6
export const FALLBACK_SECONDARY_DNS   = '9.9.9.9';
