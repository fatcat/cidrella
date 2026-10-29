/**
 * reloadAll with GeoIP on: a first start has no database path until the web
 * app sends its config, and that is not a missing database. A configured path
 * with no file still warns.
 */
import fs from 'fs';
import os from 'os';
import path from 'path';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as Server from '../../../src/dns-proxy/server.js';

const settings = { geoip_enabled: 'true' };
Server.configureProxyServer({
  setting: (key) => settings[key] ?? null,
  cachedSetting: (key) => settings[key] ?? null,
  db: () => null,
});

let warn;
let tmpDir;
beforeEach(() => {
  warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.spyOn(console, 'log').mockImplementation(() => {});
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'reload-all-'));
});
afterEach(() => {
  vi.restoreAllMocks();
  fs.rmSync(tmpDir, { recursive: true, force: true });
  Server.setProxyConfig({ geoipDbPath: null });
});

const mmdbWarnings = () => warn.mock.calls.filter(([line]) => /MMDB/.test(line));

describe('reloadAll with GeoIP on', () => {
  it('waits for the config without a warning when there is no database path yet', async () => {
    Server.setProxyConfig({ geoipDbPath: null });
    await Server.reloadAll();
    expect(mmdbWarnings()).toEqual([]);
    expect(Server.isGeoipLoaded()).toBe(false);
  });

  it('warns when the configured database file is missing', async () => {
    Server.setProxyConfig({ geoipDbPath: path.join(tmpDir, 'none.mmdb') });
    await Server.reloadAll();
    expect(mmdbWarnings().length).toBeGreaterThan(0);
    expect(Server.isGeoipLoaded()).toBe(false);
  });
});
