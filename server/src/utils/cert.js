import { execFileSync } from 'child_process';
import fs from 'fs';
import path from 'path';

export function ensureCerts(dataDir) {
  const certsDir = path.join(dataDir, 'certs');
  const keyPath = path.join(certsDir, 'server.key');
  const certPath = path.join(certsDir, 'server.crt');

  if (fs.existsSync(keyPath) && fs.existsSync(certPath)) {
    console.log('Using existing TLS certificates');
    return { keyPath, certPath };
  }

  fs.mkdirSync(certsDir, { recursive: true });

  console.log('Generating self-signed TLS certificate...');
  execFileSync('openssl', [
    'req', '-x509', '-newkey', 'rsa:2048',
    '-keyout', keyPath, '-out', certPath,
    '-days', '365', '-nodes',
    '-subj', '/CN=cidrella/O=CIDRella/C=US'
  ], { stdio: 'pipe' });

  console.log('Self-signed certificate generated');
  return { keyPath, certPath };
}
