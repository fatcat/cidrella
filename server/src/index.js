import express from 'express';
import https from 'https';
import http from 'http';
import fs from 'fs';
import path from 'path';
import helmet from 'helmet';
import cors from 'cors';
import morgan from 'morgan';
import { fileURLToPath } from 'url';

import { initDb } from './db/init.js';
import { authMiddleware } from './auth/middleware.js';
import authRoutes from './auth/routes.js';
import healthRoutes from './routes/health.js';
import subnetRoutes from './routes/subnets.js';
import rangeTypeRoutes from './routes/range-types.js';
import rangeRoutes from './routes/ranges.js';
import settingsRoutes from './routes/settings.js';
import dnsRoutes from './routes/dns.js';
import { ensureCerts } from './utils/cert.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, '..', 'data');
const HTTPS_PORT = parseInt(process.env.HTTPS_PORT || '8443', 10);
const HTTP_PORT = parseInt(process.env.HTTP_PORT || '8080', 10);

async function main() {
  // Ensure data directories exist
  const dataDirs = ['certs', 'backups', 'dnsmasq/hosts.d', 'dnsmasq/dhcp-hosts.d', 'dnsmasq/conf.d', 'blocklists'];
  for (const dir of dataDirs) {
    fs.mkdirSync(path.join(DATA_DIR, dir), { recursive: true });
  }

  // Initialize database
  await initDb(DATA_DIR);
  console.log('Database initialized');

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

  // Auth middleware for API routes
  app.use(authMiddleware);

  // API routes
  app.use('/api/auth', authRoutes);
  app.use('/api/health', healthRoutes);
  app.use('/api/subnets', subnetRoutes);
  app.use('/api/range-types', rangeTypeRoutes);
  app.use('/api/settings', settingsRoutes);
  app.use('/api/dns', dnsRoutes);
  app.use('/api/subnets/:subnetId/ranges', rangeRoutes);

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
