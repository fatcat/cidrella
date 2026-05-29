import { afterEach, describe, expect, it } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import {
  clearStartupStatus,
  readStartupStatus,
  startupStatusPath,
  writeStartupStatus,
} from '../../../src/utils/startup-status.js';

let tmpDir = null;
const originalDataDir = process.env.DATA_DIR;

function useTempDataDir() {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cidrella-startup-status-'));
  process.env.DATA_DIR = tmpDir;
  return tmpDir;
}

afterEach(() => {
  process.env.DATA_DIR = originalDataDir;
  if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true });
  tmpDir = null;
});

describe('startup status file', () => {
  it('writes and reads startup status under DATA_DIR/runtime', () => {
    const dataDir = useTempDataDir();
    writeStartupStatus({ state: 'starting', pid: 123, started_at: 'now' });

    expect(startupStatusPath()).toBe(path.join(dataDir, 'runtime', 'backend-startup-status.json'));
    expect(readStartupStatus()).toEqual({ state: 'starting', pid: 123, started_at: 'now' });
  });

  it('clears startup status when the backend reports ready', () => {
    useTempDataDir();
    writeStartupStatus({ state: 'starting', pid: 123 });
    clearStartupStatus();

    expect(readStartupStatus()).toBeNull();
  });
});
