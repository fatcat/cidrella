import express from 'express';
import https from 'https';
import http from 'http';
import fs from 'fs';
import path from 'path';
import helmet from 'helmet';
import cors from 'cors';
import morgan from 'morgan';
import { fileURLToPath } from 'url';

import { initDb, getDb } from './db/init.js';
import { authMiddleware } from './auth/middleware.js';
import authRoutes from './auth/routes.js';
import healthRoutes from './routes/health.js';
import subnetRoutes from './routes/subnets.js';
import rangeTypeRoutes from './routes/range-types.js';
import rangeRoutes from './routes/ranges.js';
import settingsRoutes from './routes/settings.js';
import dnsRoutes from './routes/dns.js';
import dhcpRoutes, { migrateLegacyScopeOptions } from './routes/dhcp.js';
import scanRoutes from './routes/scans.js';
import auditRoutes from './routes/audit.js';
import blocklistRoutes from './routes/blocklists.js';
import operationsRoutes from './routes/operations.js';
import setupRoutes from './routes/setup.js';
import geoipRoutes from './routes/geoip.js';
import folderRoutes from './routes/folders.js';
import vlanRoutes from './routes/vlans.js';
import userRoutes from './routes/users.js';
import { ensureCerts } from './utils/cert.js';
import { startLeaseWatcher } from './utils/dhcp.js';
import { startBlocklistScheduler } from './utils/blocklist.js';
import { startBackupScheduler } from './utils/backup.js';
import { startGeoipScheduler, startProxyIfEnabled } from './utils/geoip.js';
import { startScanScheduler } from './utils/scan-scheduler.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, '..', 'data');
const HTTPS_PORT = parseInt(process.env.HTTPS_PORT || '8443', 10);
const HTTP_PORT = parseInt(process.env.HTTP_PORT || '8080', 10);

async function main() {
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

  // Start DHCP lease file watcher
  startLeaseWatcher(getDb());

  // Start blocklist auto-update scheduler
  startBlocklistScheduler();

  // Start backup scheduler
  startBackupScheduler();

  // Start GeoIP scheduler and proxy (if enabled)
  startGeoipScheduler();
  await startProxyIfEnabled();

  // Start scan scheduler for periodic subnet scans
  startScanScheduler();

  // Audit log retention: delete entries older than 7 days
  function pruneAuditLog() {
    try {
      const db = getDb();
      const result = db.prepare("DELETE FROM audit_log WHERE created_at < datetime('now', '-7 days')").run();
      if (result.changes > 0) {
        console.log(`Audit log pruned: ${result.changes} entries older than 7 days removed`);
      }
    } catch (err) {
      console.error('Audit log prune error:', err.message);
    }
  }
  pruneAuditLog();
  setInterval(pruneAuditLog, 6 * 60 * 60 * 1000); // every 6 hours

  // Generate or load TLS certs
  const { keyPath, certPath } = ensureCerts(DATA_DIR);

  // Create Express app
  const app = express();

  // Middleware
  app.use(helmet({
    contentSecurityPolicy: false,  // Allow inline scripts for Vue
    crossOriginEmbedderPolicy: false
  }));
  app.use(cors());
  app.use(morgan('short'));
  app.use(express.json());

  // Setup routes (pre-auth — accessible before installation is complete)
  app.use('/api/setup', setupRoutes);

  // Auth middleware for API routes
  app.use(authMiddleware);

  // API routes
  app.use('/api/auth', authRoutes);
  app.use('/api/health', healthRoutes);
  app.use('/api/subnets', subnetRoutes);
  app.use('/api/range-types', rangeTypeRoutes);
  app.use('/api/settings', settingsRoutes);
  app.use('/api/dns', dnsRoutes);
  app.use('/api/dhcp', dhcpRoutes);
  app.use('/api/scans', scanRoutes);
  app.use('/api/audit', auditRoutes);
  app.use('/api/blocklists', blocklistRoutes);
  app.use('/api/operations', operationsRoutes);
  app.use('/api/geoip', geoipRoutes);
  app.use('/api/folders', folderRoutes);
  app.use('/api/vlans', vlanRoutes);
  app.use('/api/users', userRoutes);
  app.use('/api/subnets/:subnetId/ranges', rangeRoutes);

  // Block page for filtered domains
  app.get('/blocked', (req, res) => {
    const domain = req.query.domain || req.hostname;
    res.status(200).send(`<!DOCTYPE html>
<html><head><title>Blocked</title>
<style>body{font-family:system-ui,sans-serif;display:flex;justify-content:center;align-items:center;height:100vh;margin:0;background:#f5f5f5}
.card{background:white;padding:2rem;border-radius:8px;box-shadow:0 2px 8px rgba(0,0,0,.1);text-align:center;max-width:400px}
h1{color:#e74c3c;margin:0 0 1rem}p{color:#666}</style>
</head><body><div class="card">
<h1>Blocked</h1>
<p>Access to <strong>${domain.replace(/[<>"'&]/g, '')}</strong> has been blocked by your network administrator.</p>
</div></body></html>`);
  });

  // Serve Vue frontend (built files)
  const clientDist = path.join(__dirname, '..', '..', 'client', 'dist');
  if (fs.existsSync(clientDist)) {
    app.use(express.static(clientDist));
    // SPA fallback — serve index.html for all non-API routes
    app.get(/^(?!\/api).*/, (req, res) => {
      res.sendFile(path.join(clientDist, 'index.html'));
    });
  } else {
    app.get('/', (req, res) => {
      res.json({ message: 'IPAM API running. Client not built yet.' });
    });
  }

  // HTTPS server
  const httpsOptions = {
    key: fs.readFileSync(keyPath),
    cert: fs.readFileSync(certPath)
  };

  https.createServer(httpsOptions, app).listen(HTTPS_PORT, () => {
    console.log(`HTTPS server listening on port ${HTTPS_PORT}`);
  });

  // HTTP redirect to HTTPS (non-fatal if port is in use)
  const httpServer = http.createServer((req, res) => {
    const host = req.headers.host?.replace(`:${HTTP_PORT}`, `:${HTTPS_PORT}`) || `localhost:${HTTPS_PORT}`;
    res.writeHead(301, { Location: `https://${host}${req.url}` });
    res.end();
  });
  httpServer.on('error', (err) => {
    if (err.code === 'EADDRINUSE') {
      console.warn(`HTTP redirect port ${HTTP_PORT} already in use, skipping HTTP redirect server`);
    } else {
      console.error('HTTP server error:', err);
    }
  });
  httpServer.listen(HTTP_PORT, () => {
    console.log(`HTTP redirect server listening on port ${HTTP_PORT} -> ${HTTPS_PORT}`);
  });
}

main().catch(err => {
  console.error('Failed to start server:', err);
  process.exit(1);
});
