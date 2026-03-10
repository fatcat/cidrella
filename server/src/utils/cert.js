import { execFileSync } from 'child_process';
import fs from 'fs';
import path from 'path';

let httpsServer = null;
let keyFilePath = null;
let certFilePath = null;

export function ensureCerts(dataDir) {
  const certsDir = path.join(dataDir, 'certs');
  keyFilePath = path.join(certsDir, 'server.key');
  certFilePath = path.join(certsDir, 'server.crt');

  if (fs.existsSync(keyFilePath) && fs.existsSync(certFilePath)) {
    console.log('Using existing TLS certificates');
    return { keyPath: keyFilePath, certPath: certFilePath };
  }

  fs.mkdirSync(certsDir, { recursive: true });

  console.log('Generating self-signed TLS certificate...');
  execFileSync('openssl', [
    'req', '-x509', '-newkey', 'rsa:2048',
    '-keyout', keyFilePath, '-out', certFilePath,
    '-days', '365', '-nodes',
    '-subj', '/CN=cidrella/O=CIDRella/C=US'
  ], { stdio: 'pipe' });

  console.log('Self-signed certificate generated');
  return { keyPath: keyFilePath, certPath: certFilePath };
}

export function setHttpsServer(server) {
  httpsServer = server;
}

export function reloadTlsCerts() {
  if (!httpsServer || !keyFilePath || !certFilePath) return false;
  try {
    const key = fs.readFileSync(keyFilePath);
    const cert = fs.readFileSync(certFilePath);
    httpsServer.setSecureContext({ key, cert });
    console.log('TLS certificates reloaded');
    return true;
  } catch (err) {
    console.error('Failed to reload TLS certificates:', err.message);
    return false;
  }
}
