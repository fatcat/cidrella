/**
 * Kea's lease watcher polls the lease statistics: a change in them, or Kea
 * answering again after it did not (at boot, before it is up), is a change.
 */
import { DATA_DIR } from '../../../helpers/isolated-data-dir.js';
import { describe, it, expect, afterAll, afterEach, vi } from 'vitest';
import fs from 'fs';
import { DHCP_LEASE_WATCH_MS } from '../../../../src/config/defaults.js';
import { createKeaBackend } from '../../../../src/backends/kea/index.js';

afterAll(() => fs.rmSync(DATA_DIR, { recursive: true, force: true }));
afterEach(() => vi.useRealTimers());

// A Kea that is down until `up`, answering statistic-get-all with `assigned`.
function fakeKea() {
  const kea = { up: false, assigned: 1 };
  kea.fetchImpl = async () => {
    if (!kea.up) throw new Error('connect ECONNREFUSED');
    const sample = (value) => [[value, '2026-10-07 12:00:00.000']];
    return new Response(
      JSON.stringify([
        { result: 0, arguments: { 'subnet[1].assigned-addresses': sample(kea.assigned) } },
      ]),
    );
  };
  return kea;
}

async function watching(kea) {
  vi.useFakeTimers({ toFake: ['setInterval'] });
  const onChange = vi.fn();
  const backend = createKeaBackend({ families: () => [4], fetchImpl: kea.fetchImpl });
  const stop = backend.dhcp.watchLeases(onChange);
  await vi.advanceTimersByTimeAsync(0);
  const tick = () => vi.advanceTimersByTimeAsync(DHCP_LEASE_WATCH_MS);
  return { onChange, stop, tick };
}

describe('Kea watchLeases', () => {
  it('is quiet while nothing changes, and calls on a change in the lease counts', async () => {
    const kea = fakeKea();
    kea.up = true;
    const { onChange, stop, tick } = await watching(kea);
    await tick();
    expect(onChange).not.toHaveBeenCalled();
    kea.assigned = 2;
    await tick();
    expect(onChange).toHaveBeenCalledTimes(1);
    stop();
  });

  it('calls once Kea answers after it did not, so a sync that failed is caught up', async () => {
    const kea = fakeKea();
    const { onChange, stop, tick } = await watching(kea);
    await tick();
    expect(onChange).not.toHaveBeenCalled();
    kea.up = true;
    await tick();
    expect(onChange).toHaveBeenCalledTimes(1);
    await tick();
    expect(onChange).toHaveBeenCalledTimes(1);
    stop();
  });
});
