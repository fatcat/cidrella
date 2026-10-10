import { DATA_DIR } from '../../../helpers/isolated-data-dir.js';
import { describe, it, expect, afterAll } from 'vitest';
import fs from 'fs';
import path from 'path';
import { createDnsmasqBackend } from '../../../../src/backends/dnsmasq/index.js';

afterAll(() => fs.rmSync(DATA_DIR, { recursive: true, force: true }));

describe('dnsmasq readLeases', () => {
  const backend = createDnsmasqBackend({ servesDhcp: () => true });
  const leaseFile = path.join(DATA_DIR, 'dnsmasq.leases');
  const read = () => backend.dhcp.readLeases({ leaseFile, settleMs: 1 });

  it('says there is no lease file before dnsmasq has written one', async () => {
    expect(await read()).toEqual({ leases: null, absent: true });
  });

  it('reads an empty file as no leases', async () => {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.writeFileSync(leaseFile, '');
    expect(await read()).toEqual({ leases: [] });
  });
});
