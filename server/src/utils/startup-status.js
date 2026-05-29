import fs from 'fs';
import path from 'path';

const STATUS_DIR = 'runtime';
const STATUS_FILE = 'backend-startup-status.json';

function dataDir() {
  return process.env.DATA_DIR || '/data';
}

export function startupStatusPath() {
  return path.join(dataDir(), STATUS_DIR, STATUS_FILE);
}

export function readStartupStatus() {
  try {
    return JSON.parse(fs.readFileSync(startupStatusPath(), 'utf8'));
  } catch {
    return null;
  }
}

export function writeStartupStatus(status) {
  const filePath = startupStatusPath();
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(status, null, 2)}\n`, { mode: 0o600 });
}

export function clearStartupStatus() {
  try {
    fs.unlinkSync(startupStatusPath());
  } catch (err) {
    if (err?.code !== 'ENOENT') throw err;
  }
}

export function markBackendReady() {
  clearStartupStatus();
}
