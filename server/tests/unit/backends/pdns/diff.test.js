import { describe, it, expect } from 'vitest';
import { diffZones } from '../../../../src/backends/pdns/diff.js';

const SOA = (serial) => `ns1.example.test. admin.example.test. ${serial} 3600 900 604800 300`;

function desired(name, rrsets) {
  return new Map([
    [name, { name, rrsets: new Map(rrsets.map((r) => [`${r.name}|${r.type}`, r])) }],
  ]);
}

// The API's form: records as objects, in whatever order it keeps them.
const api = (zone, rrsets) => ({
  id: zone,
  name: zone,
  rrsets: rrsets.map(({ records, ...r }) => ({
    ...r,
    records: [...records].reverse().map((content) => ({ content, disabled: false })),
  })),
});

const soa = (serial) => ({ name: 'example.test.', type: 'SOA', ttl: 60, records: [SOA(serial)] });
const a = (records, ttl = 60) => ({ name: 'web.example.test.', type: 'A', ttl, records });
const aaaa = (records) => ({ name: 'web.example.test.', type: 'AAAA', ttl: 60, records });

describe('diffZones', () => {
  it('creates a missing zone with every rrset, the serial left to CIDRella', () => {
    const { creates, changedZones } = diffZones(
      desired('example.test.', [soa(1), a(['10.0.0.1'])]),
      new Map(),
    );
    expect(creates).toHaveLength(1);
    expect(creates[0]).toMatchObject({ name: 'example.test.', soa_edit_api: '', soa_edit: '' });
    expect(creates[0].rrsets[1]).toEqual({
      name: 'web.example.test.',
      type: 'A',
      ttl: 60,
      records: [{ content: '10.0.0.1', disabled: false }],
    });
    expect(changedZones).toEqual(['example.test.']);
  });

  it('sends nothing when the zone matches, whatever order the API keeps records in', () => {
    const rrsets = [soa(1), a(['10.0.0.1', '10.0.0.2']), aaaa(['fd00::1'])];
    const plan = diffZones(
      desired('example.test.', rrsets),
      new Map([['example.test.', api('example.test.', rrsets)]]),
    );
    expect(plan).toEqual({ creates: [], patches: [], deletes: [], changedZones: [] });
  });

  it('replaces a changed rrset and deletes one no longer wanted, both families', () => {
    const plan = diffZones(
      desired('example.test.', [soa(1), a(['10.0.0.9'])]),
      new Map([
        ['example.test.', api('example.test.', [soa(1), a(['10.0.0.1']), aaaa(['fd00::1'])])],
      ]),
    );
    expect(plan.patches).toEqual([
      {
        id: 'example.test.',
        name: 'example.test.',
        quiet: false,
        rrsets: [
          {
            ...a(['10.0.0.9']),
            records: [{ content: '10.0.0.9', disabled: false }],
            changetype: 'REPLACE',
          },
          { name: 'web.example.test.', type: 'AAAA', changetype: 'DELETE' },
        ],
      },
    ]);
    expect(plan.changedZones).toEqual(['example.test.']);
  });

  it('replaces an rrset whose TTL alone changed', () => {
    const plan = diffZones(
      desired('example.test.', [soa(1), a(['10.0.0.1'], 300)]),
      new Map([['example.test.', api('example.test.', [soa(1), a(['10.0.0.1'], 60)])]]),
    );
    expect(plan.patches[0].rrsets).toHaveLength(1);
    expect(plan.patches[0].quiet).toBe(false);
  });

  it('sends a new SOA serial quietly: nothing for the cache', () => {
    const plan = diffZones(
      desired('example.test.', [soa(2)]),
      new Map([['example.test.', api('example.test.', [soa(1)])]]),
    );
    expect(plan.patches).toHaveLength(1);
    expect(plan.patches[0].quiet).toBe(true);
    expect(plan.changedZones).toEqual([]);
  });

  it('deletes a zone CIDRella does not have', () => {
    const plan = diffZones(
      new Map(),
      new Map([['old.test.', { id: 'old.test.', name: 'old.test.' }]]),
    );
    expect(plan.deletes).toEqual([{ id: 'old.test.', name: 'old.test.' }]);
    expect(plan.changedZones).toEqual(['old.test.']);
  });
});
