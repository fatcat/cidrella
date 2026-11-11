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
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: 2000,
    })
      .toString()
      .trim();
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
  return [...[...dns].map((d) => `DNS:${d}`), ...[...ips].map((i) => `IP:${i}`)].join(',');
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

// Who a certificate names and when it ends, for the audit row of a change;
// null when there is none or it cannot be read.
export function certSummary(certPath) {
  try {
    const cert = new X509Certificate(fs.readFileSync(certPath));
    return {
      subject: cert.subject.replace(/\n/g, ', '),
      issuer: cert.issuer.replace(/\n/g, ', '),
      valid_to: cert.validTo,
      sha256: cert.fingerprint256,
    };
  } catch {
    return null;
  }
}

// True only for a certificate this appliance generated: self-signed, carrying
// the exact subject generateCert() writes. Anything else belongs to the
// operator, and replacing it would destroy their certificate AND its private
// key, which is not a thing an upgrade gets to do.
export function isSelfGeneratedCert(certPath) {
  try {
    const cert = new X509Certificate(fs.readFileSync(certPath));
    if (cert.subject !== cert.issuer) return false;
    const fields = new Set(cert.subject.split('\n').map((s) => s.trim()));
    return fields.has('CN=cidrella') && fields.has('O=CIDRella');
  } catch {
    return false;
  }
}

/** A generated certificate is replaced this long before it ends. */
export const RENEW_BEFORE_DAYS = 30;
const DAY_MS = 24 * 60 * 60 * 1000;

// Days until a certificate ends (negative once it has); null when it cannot be read.
export function certDaysLeft(certPath, now = Date.now()) {
  try {
    const ends = new X509Certificate(fs.readFileSync(certPath)).validToDate.getTime();
    return Math.floor((ends - now) / DAY_MS);
  } catch {
    return null;
  }
}

// True for a certificate CIDRella generated that is within RENEW_BEFORE_DAYS of
// its end, or past it. An operator's certificate is never renewed for them.
export function certNeedsRenewal(certPath, now = Date.now()) {
  const left = certDaysLeft(certPath, now);
  return left !== null && left <= RENEW_BEFORE_DAYS && isSelfGeneratedCert(certPath);
}

function generateCert(san) {
  const args = [
    'req',
    '-x509',
    '-newkey',
    'rsa:2048',
    '-keyout',
    keyFilePath,
    '-out',
    certFilePath,
    '-days',
    '365',
    '-nodes',
    '-subj',
    '/CN=cidrella/O=CIDRella/C=US',
  ];
  try {
    execFileSync('openssl', [...args, '-addext', `subjectAltName=${san}`], { stdio: 'pipe' });
    console.log(`Self-signed certificate generated (${san})`);
  } catch (err) {
    // -addext needs OpenSSL 1.1.1+. Falling back keeps the appliance bootable
    // on an older toolchain, at the cost of the browser warning this fixes.
    console.warn(
      `Could not add subjectAltName to the certificate (${err.message.trim()}). ` +
        'Falling back to a certificate without one. Browsers will reject it by name, ' +
        'so reach the UI by IP or install a certificate of your own.',
    );
    execFileSync('openssl', args, { stdio: 'pipe' });
    console.log('Self-signed certificate generated (no subjectAltName)');
  }
}

export function ensureCerts(dataDir) {
  const certsDir = path.join(dataDir, 'certs');
  keyFilePath = path.join(certsDir, 'server.key');
  certFilePath = path.join(certsDir, 'server.crt');

  if (fs.existsSync(keyFilePath) && fs.existsSync(certFilePath)) {
    if (certHasSan(certFilePath) && !certNeedsRenewal(certFilePath)) {
      warnIfEnding(certFilePath);
      console.log('Using existing TLS certificates');
      return { keyPath: keyFilePath, certPath: certFilePath };
    }
    if (certHasSan(certFilePath)) {
      console.log('The generated TLS certificate is near its end, generating a new one');
      generateSelfSignedCert();
      return { keyPath: keyFilePath, certPath: certFilePath };
    }
    if (!isSelfGeneratedCert(certFilePath)) {
      console.warn(
        'The installed TLS certificate has no subjectAltName, which browsers ' +
          'reject by name. Leaving it alone because CIDRella did not generate it, and ' +
          'replacing it would destroy your certificate and its private key. Reissue it with ' +
          'a subjectAltName, or remove server.crt and server.key to fall back to a ' +
          'generated certificate.',
      );
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

  generateSelfSignedCert();
  return { keyPath: keyFilePath, certPath: certFilePath };
}

// A new self-signed certificate and key at the paths ensureCerts set, named for
// this host as it is now. Every path that makes one (first boot, renewal, the
// reset action) comes through here.
export function generateSelfSignedCert() {
  generateCert(
    buildSanList({
      hostname: os.hostname(),
      fqdn: systemFqdn(),
      interfaces: os.networkInterfaces(),
    }),
  );
}

// An operator's certificate is theirs to replace; say when it is running out.
function warnIfEnding(certPath) {
  const left = certDaysLeft(certPath);
  if (left === null || left > RENEW_BEFORE_DAYS || isSelfGeneratedCert(certPath)) return;
  console.warn(
    left < 0
      ? `The installed TLS certificate ended ${-left} day(s) ago. Upload a new one in Settings, or reset to a generated certificate.`
      : `The installed TLS certificate ends in ${left} day(s). Upload a new one in Settings before then.`,
  );
}

/**
 * Renew a generated certificate that is near its end and serve it at once, no
 * restart. Returns `{ before, after }` (certSummary) when it renewed, else null.
 * Run daily: an appliance stays up for longer than a certificate lasts.
 */
export function renewCertIfDue(now = Date.now()) {
  if (!certFilePath || !fs.existsSync(certFilePath)) return null;
  if (!certNeedsRenewal(certFilePath, now)) {
    warnIfEnding(certFilePath);
    return null;
  }
  const before = certSummary(certFilePath);
  generateSelfSignedCert();
  reloadTlsCerts();
  return { before, after: certSummary(certFilePath) };
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
