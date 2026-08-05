import { execFileSync } from 'child_process';
import { X509Certificate } from 'crypto';
import fs from 'fs';
import os from 'os';
import path from 'path';

let httpsServer = null;
let keyFilePath = null;
let certFilePath = null;

// A hostname we are willing to put in a certificate. Anything with a comma or
// a space would corrupt the SAN list we hand to openssl, so reject outright
// rather than trying to escape it.
const SAFE_NAME = /^[a-zA-Z0-9]([a-zA-Z0-9.-]*[a-zA-Z0-9])?$/;

// The system's fully-qualified name, when it has one. os.hostname() usually
// returns the short form, but the FQDN is what an operator actually types in a
// browser, so a cert without it is a cert they still get warned about.
function systemFqdn() {
  try {
    const out = execFileSync('hostname', ['-f'], {
      stdio: ['ignore', 'pipe', 'ignore'], timeout: 2000,
    }).toString().trim();
    return out.includes('.') && SAFE_NAME.test(out) ? out : null;
  } catch {
    return null;
  }
}

// Names this appliance can legitimately be reached by. Exported for tests.
export function buildSanList({ hostname, fqdn, interfaces } = {}) {
  const dns = new Set(['cidrella', 'localhost']);
  const ips = new Set(['127.0.0.1']);

  for (const name of [hostname, fqdn]) {
    if (name && SAFE_NAME.test(name)) dns.add(name);
  }
  for (const addrs of Object.values(interfaces || {})) {
    for (const a of addrs || []) {
      if (a.family === 'IPv4' && !a.internal) ips.add(a.address);
    }
  }
  return [
    ...[...dns].map(d => `DNS:${d}`),
    ...[...ips].map(i => `IP:${i}`),
  ].join(',');
}

// Certificates generated before v0.4.16 carry a CN and no subjectAltName.
export function certHasSan(certPath) {
  try {
    return Boolean(new X509Certificate(fs.readFileSync(certPath)).subjectAltName);
  } catch {
    // Unreadable or unparseable. Treat as needing regeneration.
    return false;
  }
}

function generateCert(san) {
  const args = [
    'req', '-x509', '-newkey', 'rsa:2048',
    '-keyout', keyFilePath, '-out', certFilePath,
    '-days', '365', '-nodes',
    '-subj', '/CN=cidrella/O=CIDRella/C=US',
  ];
  try {
    execFileSync('openssl', [...args, '-addext', `subjectAltName=${san}`], { stdio: 'pipe' });
    console.log(`Self-signed certificate generated (${san})`);
  } catch (err) {
    // -addext needs OpenSSL 1.1.1+. Falling back keeps the appliance bootable
    // on an older toolchain, at the cost of the browser warning this fixes.
    console.warn(`Could not add subjectAltName to the certificate (${err.message.trim()}). ` +
      'Falling back to a certificate without one. Browsers will reject it by name, ' +
      'so reach the UI by IP or install a certificate of your own.');
    execFileSync('openssl', args, { stdio: 'pipe' });
    console.log('Self-signed certificate generated (no subjectAltName)');
  }
}

export function ensureCerts(dataDir) {
  const certsDir = path.join(dataDir, 'certs');
  keyFilePath = path.join(certsDir, 'server.key');
  certFilePath = path.join(certsDir, 'server.crt');

  if (fs.existsSync(keyFilePath) && fs.existsSync(certFilePath)) {
    if (certHasSan(certFilePath)) {
      console.log('Using existing TLS certificates');
      return { keyPath: keyFilePath, certPath: certFilePath };
    }
    // Browsers have required subjectAltName since Chrome 58 and reject a
    // CN-only certificate outright, so the operator cannot reach the UI even
    // after choosing to trust it. Replace it once, on upgrade.
    console.log('Existing TLS certificate has no subjectAltName, regenerating it');
  } else {
    fs.mkdirSync(certsDir, { recursive: true });
    console.log('Generating self-signed TLS certificate...');
  }

  generateCert(buildSanList({
    hostname: os.hostname(),
    fqdn: systemFqdn(),
    interfaces: os.networkInterfaces(),
  }));
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
