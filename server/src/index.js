import express from 'express';
import fs from 'fs';
import path from 'path';
import helmet from 'helmet';
import rateLimit, { ipKeyGenerator } from 'express-rate-limit';

import morgan from 'morgan';
import { fileURLToPath } from 'url';

// v0.4.15: backstop for any async handler that throws without a try/catch.
// The primary fix for the v0.4.14 bcrypt crash is in-handler type guards +
// try/catch; this is insurance so a *different* unprotected async handler
// can't kill the process if one slips through.
process.on('unhandledRejection', (reason, _promise) => {
  console.error('Unhandled promise rejection:', reason);
});
process.on('uncaughtException', (err) => {
  console.error('Uncaught exception:', err);
  // Do not exit, the server is expected to stay up. If the error indicates
  // corrupted state (e.g. DB closed), the operator still has cidrella-update
  // and cidrella-rollback as escape hatches.
});

import { initDb, getDb, getSetting } from './db/init.js';
import * as Range from './models/range.js';
import * as AuditLog from './models/audit-log.js';
import { DATA_DIR, AUDIT_PRUNE_INTERVAL_MS } from './config/defaults.js';
import { startHttpsServer, applyHttpRedirectConfig } from './utils/http-server.js';
import { sanitizeForLog } from './utils/validation.js';
import { authMiddleware } from './auth/middleware.js';
import { afterCommitMiddleware } from './utils/after-commit.js';
import authRoutes from './auth/routes.js';
import healthRoutes from './routes/health.js';
import subnetRoutes from './routes/subnets.js';
import rangeTypeRoutes from './routes/range-types.js';
import rangeRoutes from './routes/ranges.js';
import settingsRoutes from './routes/settings.js';
import dnsRoutes from './routes/dns.js';
import dhcpRoutes from './routes/dhcp.js';
import scanRoutes from './routes/scans.js';
import auditRoutes from './routes/audit.js';
import blocklistRoutes from './routes/blocklists.js';
import operationsRoutes from './routes/operations.js';
import setupRoutes from './routes/setup.js';
import geoipRoutes from './routes/geoip.js';
import folderRoutes from './routes/folders.js';
import vlanRoutes from './routes/vlans.js';
import userRoutes from './routes/users.js';
import logRoutes from './routes/logs.js';
import piholeRoutes from './routes/pihole.js';
import interfaceRoutes from './routes/interfaces.js';
import versionRoutes, { reapStaleUpdateStatusOnBoot } from './routes/version.js';
import { ensureCerts, setHttpsServer } from './utils/cert.js';
import { startLeaseWatcher, syncServerDnsDefault } from './utils/dhcp.js';
import { migrateLegacyScopeOptions, cleanupRedundantGatewayOptions } from './models/dhcp-option.js';
import { canonicalizeExisting as canonicalizeGeoipAllowlist } from './models/geoip-ip-allowlist.js';
import { startBlocklistScheduler } from './utils/blocklist.js';
import { startBackupScheduler, sweepStaleRestoreArtifacts } from './utils/backup.js';
import { startGeoipScheduler, startProxyIfEnabled } from './utils/dns-proxy.js';
import { startRogueDhcpScheduler } from './utils/dhcp-probe.js';
import { startScanScheduler } from './utils/scan-scheduler.js';
import {
  applyInterfaceConfig,
  regenerateDnsmasqConf,
  restartDnsmasq,
  isCidrellaDnsmasqRunning,
  dnsmasqRestartPending,
  withValidatedDnsmasqUpdate
} from './utils/dnsmasq.js';
import { ensureNtpEnabled, armDnssecTimecheckWhenSynced } from './utils/timesync.js';
import { applyEncryptedForwarder } from './utils/encrypted-forwarder.js';
import { resumeInterruptedScans } from './utils/scanner.js';
import { startVendorScheduler } from './utils/mac-vendor.js';
import { startUpdateScheduler } from './utils/update-checker.js';
import { startPassiveLivenessWatcher } from './utils/passive-liveness.js';
import { startDhcpFingerprintWatcher } from './utils/dhcp-fingerprint.js';
import { startMetricsAggregator } from './utils/metrics-aggregator.js';
import metricsRoutes from './routes/metrics.js';
import analyticsRoutes from './routes/analytics.js';
import anomalyRoutes from './routes/anomalies.js';
import rogueDhcpRoutes from './routes/rogue-dhcp.js';
import deviceRoutes from './routes/devices.js';
import { initAnalyticsDb } from './db/duckdb.js';
import { getCapabilityWarning } from './utils/capabilities.js';
import { captureBootServiceHealth } from './utils/service-health.js';
import { markBackendReady } from './utils/startup-status.js';
import { reconcileLegacyLifecycleMetadata } from './services/ip-lifecycle-service.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

async function main() {
  // Capture the previous process' systemd/journal crash context before the
  // normal boot path writes enough logs to bury the useful failure lines.
  captureBootServiceHealth();

  // Ensure data directories exist
  const dataDirs = ['certs', 'backups', 'dnsmasq/hosts.d', 'dnsmasq/dhcp-hosts.d', 'dnsmasq/conf.d', 'blocklists', 'geoip'];
  for (const dir of dataDirs) {
    fs.mkdirSync(path.join(DATA_DIR, dir), { recursive: true });
  }

  // Initialize database
  await initDb(DATA_DIR);
  console.log('Database initialized');

  // Migrate legacy DHCP scope columns to scope_options table
  migrateLegacyScopeOptions(getDb());

  // Remove redundant gateway options that should be inherited from subnet
  cleanupRedundantGatewayOptions(getDb());

  // Rewrite GeoIP allowlist entries to canonical CIDR form and collapse
  // same-network duplicates (idempotent; runs before the proxy loads them).
  // Never let a surprising data shape in this table take the whole
  // appliance down: worst case the allowlist stays un-canonicalized and
  // the proxy still loads whatever is stored.
  try {
    canonicalizeGeoipAllowlist(getDb());
  } catch (err) {
    console.error('GeoIP allowlist canonicalization failed (continuing with stored values):', err.message);
  }

  // Clear any ip_addresses rows whose DNS-sourced hostname no longer has a
  // backing A record (historic orphans from pre-refactor cleanup paths).
  try {
    const reconciliation = reconcileLegacyLifecycleMetadata(getDb());
    const n = reconciliation.dnsOrphans;
    const dhcpN = reconciliation.duplicateDhcpMacs;
    const unbackedDhcpN = reconciliation.unbackedDhcp;
    const staleDhcpN = reconciliation.staleDhcp;
    const expiredDhcpN = reconciliation.expiredDhcpAllocations;
    if (n > 0) console.log(`Reconciled ${n} orphan DNS-sourced ip_addresses row(s)`);
    if (dhcpN > 0) console.log(`Reconciled ${dhcpN} duplicate DHCP ip_addresses row(s)`);
    if (unbackedDhcpN > 0) console.log(`Reconciled ${unbackedDhcpN} unbacked DHCP ip_addresses row(s)`);
    if (staleDhcpN > 0) console.log(`Pruned ${staleDhcpN} stale DHCP ip_addresses row(s)`);
    if (expiredDhcpN > 0) console.log(`Released ${expiredDhcpN} expired DHCP allocation(s)`);
  } catch (err) {
    console.warn('IP metadata reconciliation skipped:', err?.message || err);
  }

  // Repair stale system "Gateway" range rows whose start_ip doesn't match
  // the subnet's own `gateway_address`. An earlier version of
  // migrateConfigToChild passed the PARENT's gateway IP to createSystemRanges
  // for every child, so /22 → 4x/24 divides left all four children pointing
  // at the parent's gateway IP, which falls outside the child's CIDR and
  // breaks the Grid View's gateway coloring. New divides use the child's
  // gateway; this heal fixes the ones that already landed.
  try {
    const repaired = Range.repairStaleGatewayRanges(getDb());
    if (repaired.changes > 0) console.log(`Repaired ${repaired.changes} stale Gateway range row(s)`);
  } catch (err) {
    console.warn('Gateway range repair skipped:', err?.message || err);
  }

  // Sweep abandoned restore-staging files from a prior crashed restore.
  // A SIGKILL/OOM between upload-start and cleanup strands multi-GB files
  // under DATA_DIR, which then silently consume the very disk headroom
  // the preflight size check is measuring.
  try {
    const swept = sweepStaleRestoreArtifacts();
    if (swept > 0) console.log(`Swept ${swept} stale restore-staging artifact(s)`);
  } catch (err) {
    console.warn('Restore-staging sweep skipped:', err?.message || err);
  }

  // Sync server IP into DNS Servers default
  syncServerDnsDefault(getDb());

  try {
    const warning = getCapabilityWarning();
    if (warning) {
      console.warn(`[capabilities] ${warning} Active ARP/ICMP liveness scans may report all hosts offline.`);
    }
  } catch (err) {
    console.warn(`[capabilities] Unable to inspect process capabilities: ${err?.message || err}`);
  }

  // Start DHCP lease file watcher
  startLeaseWatcher(getDb());

  // Start passive liveness watcher (DNS query log → is_online)
  startPassiveLivenessWatcher(getDb());

  // Passive device/OS fingerprinting from dnsmasq log-dhcp output
  startDhcpFingerprintWatcher(getDb());

  // 1. Configure dnsmasq for port 5353 + DHCP interfaces. Both writers skip
  // the write and return false when the composed config matches what's on
  // disk, so a clean reboot no longer blips DNS with a needless restart.
  // We still restart when dnsmasq isn't running at all, the boot path
  // doubles as "make sure DNS is up" and change-detection must not lose that.
  // (The blocklist scheduler's one-time legacy blocklist.conf blanking ~10s
  // in has its own restart guard and stays separate on purpose.)
  let ifaceChanged = false;
  let confChanged = false;
  try {
    ({ ifaceChanged, confChanged } = withValidatedDnsmasqUpdate(() => {
      const ifaceChanged = applyInterfaceConfig(getDb());
      const confChanged = regenerateDnsmasqConf(getDb());
      return { ifaceChanged, confChanged, changed: ifaceChanged || confChanged };
    }));
  } catch (err) {
    // The validated writer restored the last config. Keep the management API
    // available so the operator can correct the stored setting or record.
    console.error('dnsmasq config generation failed; retained previous config:', err.message);
  }
  try {
    // Restart when the config changed, when OUR unit is down (the specific
    // unit, not any dnsmasq on the host), or when a previous restart failed
    // and the running process may have loaded a stale config.
    if (ifaceChanged || confChanged || dnsmasqRestartPending() || !isCidrellaDnsmasqRunning()) {
      restartDnsmasq();
    } else {
      console.log('dnsmasq config unchanged and service running, skipping boot restart');
    }
  } catch { console.warn('dnsmasq restart failed (may not be installed)'); }

  // DNSSEC: dnsmasq starts lenient on signature timestamps (dnssec-no-timecheck).
  // Make sure NTP is running and arm a one-shot SIGHUP for once the clock syncs,
  // so it switches to enforcing. No-op unless dnssec_enabled.
  if (getSetting('dnssec_enabled') === 'true') {
    ensureNtpEnabled();
    armDnssecTimecheckWhenSynced();
  }

  // Encrypted DNS forwarders: start the in-Node DoT/DoH stub if enabled
  // (dnsmasq's server= already points at it via regenerateDnsmasqConf above).
  applyEncryptedForwarder();

  // 2. Initialize DuckDB analytics
  await initAnalyticsDb(DATA_DIR);

  // 3. Load blocklist + GeoIP data, then start proxy on port 53 (LAN IPs)
  await startProxyIfEnabled();

  // 3. Start schedulers
  startBlocklistScheduler();
  startBackupScheduler();
  startGeoipScheduler();
  startRogueDhcpScheduler();

  // Resume any scans interrupted by server restart, then start scheduler
  resumeInterruptedScans(getDb());
  startScanScheduler();

  // Start MAC vendor database auto-refresh (every 24h)
  startVendorScheduler();

  // Reap any update-status record left behind by a worker that died before
  // reporting progress (e.g. the v0.4.8/v0.4.9 sudo-NoNewPrivileges trap).
  // Runs before the update checker so the UI never sees a stuck "starting"
  // state on a fresh boot.
  reapStaleUpdateStatusOnBoot();

  // Start update checker (checks GitHub releases periodically)
  startUpdateScheduler();

  // Start metrics aggregator (collects stats every 60s for dashboard)
  startMetricsAggregator(getDb());

  // Audit log retention
  function pruneAuditLog() {
    try {
      const days = getSetting('audit_log_retention_days');
      const result = AuditLog.pruneAuditLog(getDb(), days);
      if (result.changes > 0) {
        console.log(`Audit log pruned: ${result.changes} entries older than ${days} days removed`);
      }
    } catch (err) {
      console.error('Audit log prune error:', err.message);
    }
  }
  pruneAuditLog();
  setInterval(pruneAuditLog, AUDIT_PRUNE_INTERVAL_MS);

  // Generate or load TLS certs
  const { keyPath, certPath } = ensureCerts(DATA_DIR);

  // Create Express app
  const app = express();
  // Case-sensitive + strict routing. Without these, Express matches
  // '/API/auth/login' to the '/api/auth' mount, but auth middleware
  // compares `req.path.startsWith('/api/')` with a case-sensitive JS
  // string, so uppercased paths skip auth entirely. The trio pentest
  // (2026-04-24) found this pivot let unauthenticated callers burn the
  // change-password rate limiter and produce unguarded 500s on
  // `/API/auth/me`. Turning on case-sensitive routing forces the router
  // to agree with the middleware.
  app.set('case sensitive routing', true);
  app.set('strict routing', true);

  // Middleware
  app.use(helmet({
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        scriptSrc: ["'self'"],
        styleSrc: ["'self'", "'unsafe-inline'"],  // Vue/PrimeVue injects inline styles
        imgSrc: ["'self'", "data:"],
        connectSrc: ["'self'"],
        fontSrc: ["'self'", "data:"],
        objectSrc: ["'none'"],
        frameAncestors: ["'none'"]
      }
    },
    crossOriginEmbedderPolicy: false,
    referrerPolicy: { policy: 'strict-origin-when-cross-origin' },
    strictTransportSecurity: { maxAge: 31536000, includeSubDomains: true }
  }));
  app.use((req, res, next) => {
    res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=(), payment=()');
    next();
  });
  app.use(morgan('short'));
  app.use(express.json());

  // Attach req.afterCommit(hookName) for routes to queue dedup'd regen.
  // Hooks fire on res.on('finish') so regen never blocks the HTTP response.
  app.use(afterCommitMiddleware);

  // Setup routes (pre-auth, accessible before installation is complete)
  app.use('/api/setup', setupRoutes);

  // API browser, developer tool only. Mounts /api-browser which enumerates
  // every registered route and offers an interactive client. In a release
  // audit the validator flagged that it was (a) pre-auth, (b) exposed a
  // full route inventory to unauthenticated callers, and (c) relaxed CSP
  // with `unsafe-inline`. Gate it to non-production explicitly so it never
  // mounts in a real deployment. The systemd unit sets NODE_ENV=production.
  if (process.env.NODE_ENV !== 'production') {
    const { default: apiBrowserRoutes } = await import('./routes/api-browser.js');
    app.use('/api-browser', apiBrowserRoutes);
  }

  // Internal API for anomaly detection sidecar (pre-auth, localhost-only)
  const { default: internalAnalyticsRoutes } = await import('./routes/internal-analytics.js');
  app.use('/api/internal/analytics', internalAnalyticsRoutes);

  // Auth middleware for API routes
  app.use(authMiddleware);

  // v0.4.15: authenticated write rate-limiter. v0.4.14 had only the login
  // limiter, so a compromised/bought token could fill the DB, thrash dnsmasq
  // regen, or spam audit_log at unlimited rates. This caps POST/PUT/PATCH/
  // DELETE per user (fallback to IP for anon/unauthed preflight). Reads are
  // intentionally unlimited, the calculate endpoint has its own cap, and
  // the rest are cheap.
  //
  // MUST be mounted AFTER authMiddleware, otherwise req.user is undefined
  // and every request keys off the same IP-fallback bucket, silently
  // short-circuiting the limiter (the v0.4.15 API agent caught this
  // exact bug in the initial commit; the first post-release patch moved
  // this mount below the auth middleware).
  const writeLimiter = rateLimit({
    windowMs: 60 * 1000,
    max: 300,  // 5/sec sustained per user, plenty for a human, too slow to brick the server
    message: { error: 'Too many write requests. Slow down or retry later.' },
    standardHeaders: true,
    legacyHeaders: false,
    keyGenerator: (req, res) => {
      if (req.user?.id) return `u:${req.user.id}`;
      // express-rate-limit v8+ insists on ipKeyGenerator for IPv6 safety.
      return ipKeyGenerator(req, res);
    },
    skip: (req) => {
      if (!req.path.startsWith('/api/')) return true;
      if (req.method === 'GET' || req.method === 'HEAD' || req.method === 'OPTIONS') return true;
      // The login/change-password limiters cover their own paths at a
      // stricter cadence; don't double-charge.
      if (req.path.startsWith('/api/auth/login')) return true;
      if (req.path.startsWith('/api/auth/change-password')) return true;
      return false;
    }
  });
  app.use(writeLimiter);

  // Dev-only tracking endpoint (set DEV_TRACKING=1 to enable)
  if (process.env.DEV_TRACKING === '1') {
    const { default: trackingRoutes } = await import('./routes/tracking.js');
    app.use('/api/dev/tracking', trackingRoutes);
    console.log('Dev interaction tracking enabled');
  }

  // API routes
  app.use('/api/auth', authRoutes);
  app.use('/api/health', healthRoutes);
  app.use('/api/subnets', subnetRoutes);
  app.use('/api/range-types', rangeTypeRoutes);
  app.use('/api/settings', settingsRoutes);
  app.use('/api/dns', dnsRoutes);
  app.use('/api/dhcp/rogue', rogueDhcpRoutes);
  app.use('/api/devices', deviceRoutes);
  app.use('/api/dhcp', dhcpRoutes);
  app.use('/api/scans', scanRoutes);
  app.use('/api/audit', auditRoutes);
  app.use('/api/blocklists', blocklistRoutes);
  app.use('/api/operations', operationsRoutes);
  app.use('/api/geoip', geoipRoutes);
  app.use('/api/folders', folderRoutes);
  app.use('/api/vlans', vlanRoutes);
  app.use('/api/users', userRoutes);
  app.use('/api/logs', logRoutes);
  app.use('/api/pihole', piholeRoutes);
  app.use('/api/interfaces', interfaceRoutes);
  app.use('/api/metrics', metricsRoutes);
  app.use('/api/analytics', analyticsRoutes);
  app.use('/api/anomalies', anomalyRoutes);
  app.use('/api/version', versionRoutes);
  app.use('/api/subnets/:subnetId/ranges', rangeRoutes);

  // JSON 404 for unknown /api paths. v0.4.14 fell through to the HTML SPA
  // fallback, breaking any API client parsing JSON. Mount AFTER all route
  // registrations so real handlers still win, but BEFORE the SPA fallback.
  app.use('/api', (req, res) => {
    res.status(404).json({ error: 'Not found' });
  });

  // Block page for filtered domains
  app.get('/blocked', (req, res) => {
    const rawDomain = req.query.domain || req.hostname;
    const domain = String(rawDomain).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
    res.status(200).send(`<!DOCTYPE html>
<html><head><title>Blocked</title>
<style>body{font-family:system-ui,sans-serif;display:flex;justify-content:center;align-items:center;height:100vh;margin:0;background:#f5f5f5}
.card{background:white;padding:2rem;border-radius:8px;box-shadow:0 2px 8px rgba(0,0,0,.1);text-align:center;max-width:400px}
h1{color:#e74c3c;margin:0 0 1rem}p{color:#666}</style>
</head><body><div class="card">
<h1>Blocked</h1>
<p>Access to <strong>${domain}</strong> has been blocked by your network administrator.</p>
</div></body></html>`);
  });

  // Global API error handler.
  // v0.4.15: generic response body for 5xx so raw err.message, which in
  // v0.4.14 leaked SQLite bind errors, `.toLowerCase is not a function`, and
  // JSON parser text, no longer reaches the client. Full detail stays in
  // the server log. Explicit 4xx errors (thrown with err.status set) are
  // passed through because routes use that path to surface validation
  // messages to clients.
  app.use('/api', (err, req, res, _next) => {
    const msg = err.message || 'Internal server error';

    // Detect missing table errors from SQLite, this one IS useful to the
    // operator (tells them to restart so migrations apply) and doesn't leak
    // anything attacker-controlled.
    if (msg.includes('no such table')) {
      const match = msg.match(/no such table:\s*(\S+)/);
      const table = match ? match[1] : 'unknown';
      console.error(`Missing table "${table}". Database migrations may not have been applied`);
      return res.status(500).json({
        error: `Missing database table "${table}". Please restart the server to apply pending migrations.`
      });
    }

    const status = err.status || 500;
    if (status >= 500) {
      console.error('API 5xx [%s]:', sanitizeForLog(`${req.method} ${req.originalUrl}`), msg);
      return res.status(status).json({ error: 'Internal server error' });
    }
    // Body-parse errors from express.json() leak parser detail ("Expected
    // ',' or '}' after ..."). Collapse those to a generic message.
    if (err.type === 'entity.parse.failed' || (err instanceof SyntaxError && 'body' in err)) {
      return res.status(400).json({ error: 'Invalid JSON body' });
    }
    if (err.type === 'entity.too.large') {
      return res.status(413).json({ error: 'Request body too large' });
    }
    // 4xx errors, route code already wrote a clean message; trust it.
    res.status(status).json({ error: msg });
  });

  // Serve Vue frontend (built files)
  const clientDist = path.join(__dirname, '..', '..', 'client', 'dist');
  if (fs.existsSync(clientDist)) {
    app.use(express.static(clientDist));
    // SPA fallback, serve index.html for all non-API routes
    app.get(/^(?!\/api).*/, (req, res) => {
      res.sendFile(path.join(clientDist, 'index.html'));
    });
  } else {
    app.get('/', (req, res) => {
      res.json({ message: 'CIDRella API running. Client not built yet.' });
    });
  }

  // HTTPS server, utils/http-server.js owns the listen + live-swap. It
  // reads the effective port from DB setting `https_port` first, falling
  // through to process.env.HTTPS_PORT and finally 8443. A UI edit to
  // `https_port` triggers a live port change via applyHttpsPortChange()
  // without a service restart.
  await startHttpsServer({
    app,
    keyPath,
    certPath,
    setHttpsServer,
    onReady: () => {
      try {
        markBackendReady();
      } catch (err) {
        console.warn(`Unable to clear startup status: ${err?.message || err}`);
      }
    },
  });

  // HTTP redirect, same lifecycle pattern. v0.4.15 adds a UI toggle to
  // disable it entirely (when TLS is fronted by nginx/traefik) and a UI
  // editable port setting.
  await applyHttpRedirectConfig();
}

main().catch(err => {
  console.error('Failed to start server:', err);
  process.exit(1);
});
