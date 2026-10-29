// ─── Central default values ──────────────────────────────
// Every tunable constant lives here. DB-seeded settings use these as
// initial values (see db/init.js ensureDefaults). Server code imports
// either the DB-backed getter or the constant directly, never both.

import path from 'path';
import {
  GEOIP_CACHE_MAX,
  GEOIP_CACHE_TTL_MS,
  PROXY_TCP_IDLE_TIMEOUT_MS,
  PROXY_MAX_TCP_CONNECTIONS,
  PROXY_TCP_RELAY_TIMEOUT_MS,
  DNSMASQ_INTERNAL_PORT,
  DNSMASQ_INTERNAL_PORT_ALT,
  DEFAULT_DNS_LISTEN_PORT,
  ENCRYPTED_FORWARDER_PORT,
  PROXY_UDP_TIMEOUT_MS,
  ENCRYPTED_FORWARDER_TIMEOUT_MS,
  ENCRYPTED_FORWARDER_BUDGET_MS,
  ENCRYPTED_FORWARDER_HOLD_MS,
  resolveDnsmasqInternalPort,
  resolveDnsListenPort,
  DATA_DIR,
} from '../dns-proxy/constants.js';


// Left by a restore: the next boot restarts every DNS/DHCP backend, so the
// daemons load the restored leases instead of writing theirs over them.
export const BACKEND_RESTART_MARKER = path.join(DATA_DIR, 'runtime', 'restart-backends-on-boot');

// ─── DB-seeded settings (user-configurable via UI / API) ─────────

export const DEFAULTS = {
  dns_upstream_servers: ['8.8.8.8', '9.9.9.9'],
  // The plaintext backup resolver's addresses, tried after dns_upstream_servers.
  dns_upstream_backup_servers: [],
  // With a backup set, in both modes: 'failover' asks the backup only when the
  // primary fails, 'balance' spreads queries over both (utils/forwarding-settings.js).
  dns_upstream_backup_mode: 'balance',
  dns_soa_defaults: {
    soa_refresh: 3600,
    soa_retry: 900,
    soa_expire: 604800,
    soa_minimum_ttl: 1800,
    soa_primary_ns: 'ns1.localhost',
    soa_admin_email: 'admin.localhost',
  },
  default_lease_time: '1h',
  default_gateway_position: 'first',
  subnet_name_template: '%1.%2.%3.%4/%bitmask',
  default_scan_interval: '',
  default_scan_enabled: '1',
  blocklist_enabled: 'true',
  blocklist_redirect_ip: '',
  blocklist_redirect_ip6: '',
  // ISO time filtering resumes after a pause, '' when not paused (routes/blocklists.js).
  filtering_paused_until: '',
  dnssec_enabled: 'false',
  // When 'true', dnsmasq is authoritative-only: it answers for local zones but
  // does not forward/recurse for external domains (no server= lines emitted).
  dns_no_recursion: 'false',
  // Encrypted forwarding: 'off' | 'tls' (DoT) | 'https' (DoH). When on, dnsmasq
  // forwards to the in-Node stub which encrypts to forwarder_encrypted_upstreams.
  forwarder_encryption: 'off',
  forwarder_encrypted_upstreams: [],
  // Global IPv6 switch, off on new installs and upgrades. Applied by
  // PUT /api/interfaces/config, see utils/ipv6-support.js.
  ipv6_enabled: 'false',
  rogue_dhcp_detection_enabled: 'false',
  rogue_dhcp_probe_interval_min: '15',
  blocklist_update_schedule: 'daily',
  // Per-feed download ceiling in MB. Upstream lists grow: the Block List
  // Project malware feed passed 51MB / 2.65M entries in 2026 and broke the old
  // hardcoded 20MB cap. 128 leaves real headroom while still refusing a
  // runaway or hostile source URL. Read fresh on every refresh.
  blocklist_max_feed_mb: '128',
  backup_schedule: 'off',
  backup_retention_count: '7',
  installation_complete: 'false',
  setup_wizard_completed: '0',
  setup_state: '{"done":false}',
  password_min_length: '8',
  password_require_mixed_case: 'true',
  password_require_number: 'true',
  password_require_symbol: 'false',
  // Minutes without activity before a sign-in session ends: 0, 15, 30 or 60,
  // 0 for no inactivity limit. Every session also ends 24 hours after sign-in.
  session_idle_timeout_minutes: '60',
  // Migration 033 seeds this row as 'true' and 076 flips a fresh database to
  // 'false', so this default only matters if the row is ever deleted.
  dhcp_enabled: 'false',
  audit_log_retention_days: 90,
  geoip_enabled: 'false',
  geoip_mode: 'blocklist',
  geoip_proxy_port: '5353', // legacy, kept for migration compat
  geoip_db_path: 'auto',
  geoip_last_updated: '',
  geoip_update_schedule: 'monthly',
  map_home: '', // Resolution Map home point, "lat,lon"; '' = not set
  update_check_enabled: 'true',
  // v0.4.15 web-port settings. Empty string means "use the env var / fallback"
  //, the server resolves to DB value if set, env var if set, hardcoded
  // default otherwise. Edits via the Interfaces UI populate these; install.sh
  // sets the env vars (via systemd drop-in) but does NOT touch the DB, so an
  // unedited install always follows the env path.
  http_redirect_enabled: 'true',
  https_port: '',
  http_port: '',
  ip_history_retention_days: '7',
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

export const DNS_TEST_TIMEOUT_MS = 5000;
export const DNS_TEST_RETRY_DELAY_MS = 5000;
export const SCAN_BATCH_SIZE = 10;
export const MAX_SCAN_SIZE = 4096;
// Finished scans kept per network. The scan list shows the newest 50 and the
// scheduler reads only the newest; older runs were never pruned (23,708 rows
// on one install, 175 a day).
export const SCAN_HISTORY_KEEP = 100;
export const GEOIP_CHECK_INTERVAL_MS = 6 * 60 * 60 * 1000; // 6 hours
export const GEOIP_STARTUP_DELAY_MS = 15000; // 15 seconds
export const GEOIP_DOWNLOAD_TIMEOUT_MS = 60000; // 60 seconds
export const ARPING_TIMEOUT_MS = 5000;
export const PING_TIMEOUT_MS = 1500;
// Echoes sent before a host the scanner last saw online is called offline,
// once its ARP and single echo both went unanswered. WiFi clients drop
// broadcast ARP (about one in three on one install's Proxmox hosts) and now
// and then a lone echo too; one reply out of these keeps the host online.
export const OFFLINE_CONFIRM_PINGS = 3;
export const AUDIT_PRUNE_INTERVAL_MS = 6 * 60 * 60 * 1000; // 6 hours
export const DHCP_LEASE_WATCH_MS = 10000; // 10 seconds
export const PASSIVE_LIVENESS_POLL_MS = 5000; // 5 seconds
export const PASSIVE_LIVENESS_DEBOUNCE_MS = 60000; // 60 seconds per IP
export const PASSIVE_LIVENESS_STALE_MS = 600000; // 10 minutes → mark offline
export const DHCP_FINGERPRINT_POLL_MS = 5000; // tail dnsmasq.log for DHCP fingerprints
export const PROXY_HEALTH_CHECK_MS = 3000; // 3 seconds
export const PROXY_MAX_RESTART_ATTEMPTS = 3;
export const PROXY_RESTART_DELAY_MS = 2000; // 2 seconds between restart attempts
// While bypassed, how long before trying the proxy again: the first wait, then
// doubling up to the last. A failed try costs a few seconds of DNS while the
// backend moves off the LAN port and back, so tries back off.
export const PROXY_RECOVERY_FIRST_MS = 5 * 60 * 1000;
export const PROXY_RECOVERY_MAX_MS = 60 * 60 * 1000;
export const BLOCKLIST_DOWNLOAD_TIMEOUT_MS = 60000;
// Rows per write transaction while importing a feed. The DNS proxy shares this
// process and better-sqlite3 is synchronous, so an unbounded transaction is an
// unbounded DNS outage. At 25k the malware feed (2.65M domains) blocks for at
// most ~60ms per batch instead of ~4s in one go, with no loss in total
// throughput. Also the page size for the staged-to-live apply loop.
export const BLOCKLIST_INSERT_BATCH = 25000;

// Wireshark manuf download (utils/mac-vendor.js). Not operator-tunable: it is a
// single fixed upstream file, unlike blocklist feeds which the operator points
// wherever they like. The cap exists so a broken or hostile upstream cannot
// hand us an unbounded body; the real file is around 5MB, so 32MB is generous
// headroom rather than a tight fit.
export const MANUF_DOWNLOAD_TIMEOUT_MS = 30000;
export const MANUF_MAX_BYTES = 32 * 1024 * 1024;
export const UPDATE_CHECK_INTERVAL_MS = 60 * 60 * 1000; // 1 hour
export const UPDATE_CHECK_DELAY_MS = 0; // check immediately on startup
export const GITHUB_REPO = 'fatcat/cidrella'; // owner/repo for update checks

// PowerDNS Recursor (behind the proxy, in dnsmasq's place) gives a forwarder
// this long before trying again: just past the forwarder's whole budget, so
// it never sends a second copy while the first is still being worked on, and
// inside the proxy's wait, so the client hears the answer.
export const RECURSOR_NETWORK_TIMEOUT_MS = ENCRYPTED_FORWARDER_BUDGET_MS + 100;
// PowerDNS Authoritative on loopback: DNS for Recursor, and its HTTP API.
export const PDNS_AUTH_DNS_PORT = 5300;
export const PDNS_AUTH_API_PORT = 8053;


/**
 * Where the DNS backend (dnsmasq or PowerDNS Recursor) answers on loopback:
 * the internal port behind the proxy, or in bypass mode the LAN port itself.
 * null with DNS switched off. `listenPort` is the stored dns_listen_port.
 */
export function backendDnsPort({ listenPort, bypass = false, enabled = true }) {
  if (!enabled) return null;
  const lan = resolveDnsListenPort(listenPort);
  return bypass ? lan : resolveDnsmasqInternalPort(lan);
}
export const ANALYTICS_FLUSH_INTERVAL_MS = 5000; // 5 seconds
export const ANALYTICS_RETENTION_CLEANUP_MS = 6 * 60 * 60 * 1000; // 6 hours

// Baked DHCP NTP defaults: option 42 (DHCPv4) from pool.ntp.org and option 56
// (DHCPv6) from 2.pool.ntp.org, the one pool name that answers with IPv6.
// scripts/refresh-ntp-defaults.js refreshes both at release-build time so new
// installs and reset databases do not carry stale pool answers indefinitely.
export const DHCP_DEFAULT_NTP_SERVERS = '69.164.213.136,172.234.25.10,172.233.189.68,198.44.55.245';
export const DHCP6_DEFAULT_NTP_SERVERS =
  '2602:fcac:0:7b::74,2603:c020:0:8369:feed:feed:feed:feed,2600:1702:4a73:e00f:c3ee:91f2:71d8:5243,2607:f710:35::29c:0:6';
export const DHCP_DEFAULT_NTP_SERVERS_REFRESHED_AT = '2026-10-05';

export {
  GEOIP_CACHE_MAX,
  GEOIP_CACHE_TTL_MS,
  PROXY_TCP_IDLE_TIMEOUT_MS,
  PROXY_MAX_TCP_CONNECTIONS,
  PROXY_TCP_RELAY_TIMEOUT_MS,
  DNSMASQ_INTERNAL_PORT,
  DNSMASQ_INTERNAL_PORT_ALT,
  DEFAULT_DNS_LISTEN_PORT,
  ENCRYPTED_FORWARDER_PORT,
  PROXY_UDP_TIMEOUT_MS,
  ENCRYPTED_FORWARDER_TIMEOUT_MS,
  ENCRYPTED_FORWARDER_BUDGET_MS,
  ENCRYPTED_FORWARDER_HOLD_MS,
  resolveDnsmasqInternalPort,
  resolveDnsListenPort,
  DATA_DIR,
};
