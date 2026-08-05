// ─── Central default values ──────────────────────────────
// Every tunable constant lives here. DB-seeded settings use these as
// initial values (see db/init.js ensureDefaults). Server code imports
// either the DB-backed getter or the constant directly, never both.

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
  dnssec_enabled:          'false',
  // When 'true', dnsmasq is authoritative-only: it answers for local zones but
  // does not forward/recurse for external domains (no server= lines emitted).
  dns_no_recursion:        'false',
  // Encrypted forwarding: 'off' | 'tls' (DoT) | 'https' (DoH). When on, dnsmasq
  // forwards to the in-Node stub which encrypts to forwarder_encrypted_upstreams.
  forwarder_encryption:    'off',
  forwarder_encrypted_upstreams: [],
  rogue_dhcp_detection_enabled: 'false',
  rogue_dhcp_probe_interval_min: '15',
  blocklist_update_schedule: 'daily',
  backup_schedule:         'off',
  backup_retention_count:  '7',
  installation_complete:   'false',
  setup_wizard_completed:  '0',
  audit_log_retention_days: 7,
  geoip_enabled:           'false',
  geoip_mode:              'blocklist',
  geoip_proxy_port:        '5353',     // legacy, kept for migration compat
  geoip_db_path:           'auto',
  geoip_last_updated:      '',
  geoip_update_schedule:   'monthly',
  update_check_enabled:    'true',
  // v0.4.15 web-port settings. Empty string means "use the env var / fallback"
  //, the server resolves to DB value if set, env var if set, hardcoded
  // default otherwise. Edits via the Interfaces UI populate these; install.sh
  // sets the env vars (via systemd drop-in) but does NOT touch the DB, so an
  // unedited install always follows the env path.
  http_redirect_enabled:   'true',
  https_port:              '',
  http_port:               '',
  ip_history_retention_days: '7',
  offline_metadata_retention_days: '7',
  analytics_retention_days: '7',
  anomaly_detection_enabled: 'false',
  anomaly_scoring_interval_min: '15',
  anomaly_training_interval_hours: '6',
  anomaly_min_training_hours: '48',
  anomaly_sensitivity: 'medium',
  anomaly_retention_days: '30',
  anomaly_acknowledged_score_id: '0',
};

// ─── Shared constants (not in DB, implementation details) ───────

// Valid time range keys, single source of truth for metrics + analytics
export const VALID_RANGE_KEYS = ['1h', '4h', '12h', '24h', '2d', '1w'];

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
export const DHCP_FINGERPRINT_POLL_MS     = 5000;            // tail dnsmasq.log for DHCP fingerprints
export const PROXY_HEALTH_CHECK_MS        = 3000;              // 3 seconds
export const PROXY_MAX_RESTART_ATTEMPTS   = 3;
export const PROXY_RESTART_DELAY_MS       = 2000;              // 2 seconds between restart attempts
// DNS-over-TCP relay (used by DNSSEC-aware / large responses).
export const PROXY_TCP_IDLE_TIMEOUT_MS    = 10000;            // close idle client TCP conns
export const PROXY_MAX_TCP_CONNECTIONS    = 1000;            // concurrent client TCP conn cap
export const PROXY_TCP_RELAY_TIMEOUT_MS   = 5000;            // upstream-to-dnsmasq TCP relay timeout
export const BLOCKLIST_DOWNLOAD_TIMEOUT_MS = 60000;
export const UPDATE_CHECK_INTERVAL_MS = 60 * 60 * 1000;      // 1 hour
export const UPDATE_CHECK_DELAY_MS    = 0;                    // check immediately on startup
export const GITHUB_REPO              = 'fatcat/cidrella';    // owner/repo for update checks

// Internal port dnsmasq binds on 127.0.0.1 when the proxy fronts it.
// If the user picks this same port as their LAN-facing `dns_listen_port`,
// callers should use `resolveDnsmasqInternalPort()` (below) which shifts
// dnsmasq to a different internal port so the two never fight over the
// same bind address. 5353 is the historical default.
export const DNSMASQ_INTERNAL_PORT     = 5353;
export const DNSMASQ_INTERNAL_PORT_ALT = 5354;
// Loopback port the in-Node encrypted-forwarder stub binds; dnsmasq forwards
// here (server=127.0.0.1#<port>) when DoT/DoH forwarding is enabled. 5356 avoids
// 5353 (mDNS, dnsmasq internal) and 5355 (LLMNR).
export const ENCRYPTED_FORWARDER_PORT  = 5356;
export const ENCRYPTED_FORWARDER_TIMEOUT_MS = 5000;

/**
 * Returns the port dnsmasq should bind internally, given the user's LAN
 * DNS listen port. Shifts away from the default if the LAN port collides.
 *
 * @param {number|null|undefined} lanListenPort user-configured dns_listen_port
 * @returns {number} internal port dnsmasq should use
 */
export function resolveDnsmasqInternalPort(lanListenPort) {
  if (Number(lanListenPort) === DNSMASQ_INTERNAL_PORT) return DNSMASQ_INTERNAL_PORT_ALT;
  return DNSMASQ_INTERNAL_PORT;
}
export const ANALYTICS_FLUSH_INTERVAL_MS  = 5000;              // 5 seconds
export const ANALYTICS_RETENTION_CLEANUP_MS = 6 * 60 * 60 * 1000; // 6 hours

// Secondary DNS server used when auto-populating DHCP option 6
export const FALLBACK_SECONDARY_DNS   = '9.9.9.9';

// Baked DHCP option 42 default. Refresh this at release-build time with
// scripts/refresh-ntp-defaults.js so new installs and reset databases do not
// carry stale pool.ntp.org answers indefinitely.
export const DHCP_DEFAULT_NTP_SERVERS = '157.245.125.229,45.79.214.107,137.190.2.4,23.157.160.168';
export const DHCP_DEFAULT_NTP_SERVERS_REFRESHED_AT = '2026-07-24';
