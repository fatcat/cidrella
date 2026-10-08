/**
 * A fresh DATA_DIR for a test file whose code under test reads it at import
 * time (config/defaults.js resolves DATA_DIR once, when first loaded, and
 * backup.js builds its paths from it). Import this FIRST in the test file:
 * ES modules evaluate in import order, so every module after it sees the
 * temp directory. setupTestDb sets DATA_DIR only after its own imports.
 */
import fs from 'fs';
import os from 'os';
import path from 'path';

export const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'cidrella-test-'));
process.env.DATA_DIR = DATA_DIR;
for (const dir of ['dnsmasq/hosts.d', 'dnsmasq/dhcp-hosts.d', 'dnsmasq/conf.d', 'certs']) {
  fs.mkdirSync(path.join(DATA_DIR, dir), { recursive: true });
}
