// Sequences the model walks found, each a bug that was fixed. Every step is
// checked against the same invariants as the random walks, and each walk
// ends with a reload that must bring the same screen back.
import { describe, it, vi } from 'vitest';
import { useModelSession } from './session.js';

vi.mock('../../../../../src/api/client.js', () => ({
  default: { get: vi.fn(), put: vi.fn(), post: vi.fn(), delete: vi.fn(), patch: vi.fn() },
}));
vi.mock('../../../../../src/ui/useToast.js', () => ({ useToast: () => ({ add: vi.fn() }) }));
vi.mock('vue-router', async (importOriginal) => ({
  ...(await importOriginal()),
  useRouter: () => ({ push: vi.fn(), currentRoute: { value: { fullPath: '/networks' } } }),
}));

describe('Networks workspace regressions', () => {
  const { walk } = useModelSession();

  it('a network with only a reverse zone opens the DNS view on it', () =>
    walk(['tab dns', 'network 14']));

  it('searching All Unallocated Networks matches its networks', () =>
    walk(['unallocated', 'search "1.1.1"', 'table-search "1.1"']));

  it('a folder chosen from the unallocated explorer shows its allocated networks', () =>
    walk(['unallocated', 'folder 2']));

  it('the DNS view chooses among the zones the search leaves', () =>
    walk(['search "172.16"', 'tab dns']));

  it('a search on the DNS view moves the choice to a zone it leaves', () =>
    walk(['tab dns', 'search "lab"']));

  it('Ungrouped reads only its own networks', () =>
    walk(['folder ungrouped', 'search "10.0.1"', 'tab dns', 'tab dhcp']));

  it('Ungrouped survives a reload', () => walk(['folder ungrouped', 'tab dns']));

  // The estate's DNS read overwrote the one zone list with the zones an
  // earlier search matched, so a network entered later had no zone cards.
  it('a search on one view does not take zones from another context', () =>
    walk(['tab dns', 'search "laptop"', 'tab dhcp', 'search "172.16"', 'network 13', 'stat dns']));

  // Choosing a zone, a network's reverse zones or a scope kept the page of
  // the list before it, past the end of a shorter one.
  it('choosing a zone starts its list on the first page', () =>
    walk(['page-size 32', 'tab dns', 'page next', 'pick-zone 201']));

  // Not a bug found, a guard on the switch: zone-file names (@ for the apex
  // MX, relative hosts, the MX target absolute) in the estate and a network,
  // and still off after the reload every walk ends with.
  it('Show domain names off writes names as the zone file does, across a reload', () =>
    walk(['tab dns', 'domain-names', 'network 11', 'tab dns', 'zone 101']));

  it('Show available stays off across a reload', () =>
    walk(['network 13', 'available', 'tab dhcp', 'tab addresses']));

  // navigate merged the state's `reverseNetwork` into a query keyed `rzones`,
  // so a network's reverse zones were never saved.
  it('a network-wide reverse zone choice survives a reload', () =>
    walk(['tab dns', 'pick-network 11']));

  // Restoring the filters counted as changing them, which reset the page.
  it('the page survives a reload', () => walk(['page-size 32', 'tab dns', 'page next']));

  it('the sort survives a reload', () =>
    walk(['tab dhcp', 'page-size 32', 'folder 1', 'tab dns', 'sort record_enabled']));

  // All Allocated Networks is home: every allocated network, nothing left over.
  it('All Allocated Networks shows every allocated network from any table', () =>
    walk([
      'network 13',
      'tab dns',
      'filter record_type 0',
      'search "lab"',
      'estate',
      'folder 1',
      'tab dhcp',
      'table-search "lease"',
      'estate',
    ]));
});
