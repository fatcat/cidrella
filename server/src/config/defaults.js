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
  // Per-feed download ceiling in MB. Upstream lists grow: the Block List
  // Project malware feed passed 51MB / 2.65M entries in 2026 and broke the old
  // hardcoded 20MB cap. 128 leaves real headroom while still refusing a
  // runaway or hostile source URL. Read fresh on every refresh.
  blocklist_max_feed_mb:   '128',
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
// Rows per write transaction while importing a feed. The DNS proxy shares this
// process and better-sqlite3 is synchronous, so an unbounded transaction is an
// unbounded DNS outage. At 25k the malware feed (2.65M domains) blocks for at
// most ~60ms per batch instead of ~4s in one go, with no loss in total
// throughput. Also the page size for the staged-to-live apply loop.
export const BLOCKLIST_INSERT_BATCH        = 25000;

// Wireshark manuf download (utils/mac-vendor.js). Not operator-tunable: it is a
// single fixed upstream file, unlike blocklist feeds which the operator points
// wherever they like. The cap exists so a broken or hostile upstream cannot
// hand us an unbounded body; the real file is around 5MB, so 32MB is generous
// headroom rather than a tight fit.
export const MANUF_DOWNLOAD_TIMEOUT_MS     = 30000;
export const MANUF_MAX_BYTES               = 32 * 1024 * 1024;
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
// LAN-facing DNS port when dns_listen_port is unset or unusable.
export const DEFAULT_DNS_LISTEN_PORT   = 53;
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

/**
 * The LAN-facing DNS port, from a stored `dns_listen_port` value, falling back
 * to 53 for anything that is not a usable port.
 *
 * Two callers resolved this differently. `utils/dnsmasq.js` range-checked and
 * fell back to 53; `utils/dns-proxy.js` used `Number(value) || 53`, which
 * accepts anything non-zero, so a stored 70000 became a bind attempt on 70000
 * while the dnsmasq config it is supposed to sit in front of stayed on 53.
 * `/api/settings` validates this key, so the bad value only arrives from a
 * restored or hand-edited DB, which is exactly when the two halves disagreeing
 * is hardest to diagnose.
 * See REVIEW.md, duplicate-logic audit #10.
 *
 * @param {unknown} rawValue stored dns_listen_port
 * @returns {number} a port in 1-65535, or 53
 */
export function resolveDnsListenPort(rawValue) {
  const p = Number(rawValue);
  return Number.isInteger(p) && p >= 1 && p <= 65535 ? p : DEFAULT_DNS_LISTEN_PORT;
}
export const ANALYTICS_FLUSH_INTERVAL_MS  = 5000;              // 5 seconds
export const ANALYTICS_RETENTION_CLEANUP_MS = 6 * 60 * 60 * 1000; // 6 hours

// Secondary DNS server used when auto-populating DHCP option 6
export const FALLBACK_SECONDARY_DNS   = '9.9.9.9';

// Baked DHCP option 42 default. Refresh this at release-build time with
// scripts/refresh-ntp-defaults.js so new installs and reset databases do not
// carry stale pool.ntp.org answers indefinitely.
export const DHCP_DEFAULT_NTP_SERVERS = '162.244.81.139,23.155.72.147,66.85.78.80,66.118.229.14';
export const DHCP_DEFAULT_NTP_SERVERS_REFRESHED_AT = '2026-09-02';
