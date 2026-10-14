/**
 * What to send Authoritative to make it hold the desired zones: the zones to
 * create, the rrsets to replace or delete in each zone it has, and the zones
 * to delete. Pure. Only differences are sent, so a second apply sends nothing.
 *
 * Authoritative's database is CIDRella's alone, so a zone CIDRella does not
 * have is deleted.
 */

const sameRecords = (a, b) => a.length === b.length && a.every((content, i) => content === b[i]);

// The SOA serial moves with every DHCP lease that changes a name. A change of
// serial alone is still sent, but asks nothing of Recursor's cache.
const soaWithoutSerial = (content) => content.split(' ').toSpliced(2, 1).join(' ');

/** The rrset as the API takes it in a create or a REPLACE. */
const apiRrset = ({ name, type, ttl, records }) => ({
  name,
  type,
  ttl,
  records: records.map((content) => ({ content, disabled: false })),
});

/**
 * `desired`: from desiredZones. `current`: Map of zone name to the API's
 * zone object ({ id, name, rrsets }).
 *
 * Returns { creates, patches, deletes, changedZones }: creates are API zone
 * bodies; patches `{ id, name, rrsets, quiet }`, quiet when only a SOA serial
 * moved; deletes `{ id, name }`; changedZones the zone names whose answers
 * changed, for Recursor's cache.
 */
export function diffZones(desired, current) {
  const creates = [];
  const patches = [];
  const deletes = [];
  const changedZones = [];

  for (const [name, zone] of desired) {
    const have = current.get(name);
    if (!have) {
      creates.push({
        name,
        kind: 'Native',
        // CIDRella sets the serial; Authoritative must not raise it on a write.
        soa_edit_api: '',
        soa_edit: '',
        rrsets: [...zone.rrsets.values()].map(apiRrset),
      });
      changedZones.push(name);
      continue;
    }

    const haveRrsets = new Map(
      (have.rrsets || []).map((rrset) => [
        `${rrset.name}|${rrset.type}`,
        {
          ...rrset,
          records: (rrset.records || [])
            .filter((r) => !r.disabled)
            .map((r) => r.content)
            .sort(),
        },
      ]),
    );
    const rrsets = [];
    let quiet = true;
    for (const [key, want] of zone.rrsets) {
      const got = haveRrsets.get(key);
      if (got && got.ttl === want.ttl && sameRecords(got.records, want.records)) continue;
      rrsets.push({ ...apiRrset(want), changetype: 'REPLACE' });
      const serialOnly =
        want.type === 'SOA' &&
        got &&
        got.ttl === want.ttl &&
        got.records.length === 1 &&
        soaWithoutSerial(got.records[0]) === soaWithoutSerial(want.records[0]);
      if (!serialOnly) quiet = false;
    }
    for (const [key, got] of haveRrsets) {
      if (zone.rrsets.has(key)) continue;
      rrsets.push({ name: got.name, type: got.type, changetype: 'DELETE' });
      quiet = false;
    }
    if (rrsets.length) {
      patches.push({ id: have.id, name, rrsets, quiet });
      if (!quiet) changedZones.push(name);
    }
  }

  for (const [name, have] of current) {
    if (desired.has(name)) continue;
    deletes.push({ id: have.id, name });
    changedZones.push(name);
  }

  return { creates, patches, deletes, changedZones };
}
