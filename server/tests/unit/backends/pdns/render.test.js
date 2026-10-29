import { describe, it, expect } from 'vitest';
import {
  absoluteName,
  desiredZones,
  renderAuthConfig,
  renderRecursorConfig,
  servedTtl,
  txtContent,
} from '../../../../src/backends/pdns/render.js';
import {
  PROXY_UDP_TIMEOUT_MS,
  RECURSOR_NETWORK_TIMEOUT_MS,
  ENCRYPTED_FORWARDER_BUDGET_MS,
} from '../../../../src/config/defaults.js';
import { LOCAL_RECORD_TTL } from '../../../../src/backends/shared/dns-zone-model.js';

const zone = (id, name, extra = {}) => ({
  id,
  name,
  soa_primary_ns: 'ns1.example.test',
  soa_admin_email: 'admin@example.test',
  soa_serial: 7,
  soa_refresh: 3600,
  soa_retry: 900,
  soa_expire: 604800,
  soa_minimum_ttl: 300,
  ...extra,
});

let nextId = 1;
const record = (zoneId, fqdn, type, value, extra = {}) => ({
  id: nextId++,
  zoneId,
  fqdn,
  type,
  value,
  ttl: null,
  priority: null,
  weight: null,
  port: null,
  ...extra,
});

const rrsetsOf = (zones, name) => Object.fromEntries(zones.get(name).rrsets);

describe('desiredZones', () => {
  it('writes SOA and NS from the zone row', () => {
    const zones = desiredZones({ zones: [zone(1, 'Example.Test')], records: [] });
    const rrsets = rrsetsOf(zones, 'example.test.');
    expect(rrsets['example.test.|SOA']).toEqual({
      name: 'example.test.',
      type: 'SOA',
      ttl: LOCAL_RECORD_TTL,
      records: ['ns1.example.test. admin.example.test. 7 3600 900 604800 300'],
    });
    expect(rrsets['example.test.|NS'].records).toEqual(['ns1.example.test.']);
  });

  it('groups records into rrsets, sorted, at the lowest TTL among them', () => {
    const zones = desiredZones({
      zones: [zone(1, 'example.test')],
      records: [
        record(1, 'web.example.test', 'A', '10.0.0.2', { ttl: 600 }),
        record(1, 'web.example.test', 'A', '10.0.0.1', { ttl: 300 }),
        record(1, 'web.example.test', 'AAAA', 'FD00:0:0::0001'),
      ],
    });
    const rrsets = rrsetsOf(zones, 'example.test.');
    expect(rrsets['web.example.test.|A']).toMatchObject({
      ttl: 300,
      records: ['10.0.0.1', '10.0.0.2'],
    });
    expect(rrsets['web.example.test.|AAAA']).toMatchObject({
      ttl: LOCAL_RECORD_TTL,
      records: ['fd00::1'],
    });
  });

  it('writes each record type in zone-file form', () => {
    const zones = desiredZones({
      zones: [zone(1, 'example.test')],
      records: [
        record(1, 'www.example.test', 'CNAME', 'web.example.test'),
        record(1, 'example.test', 'MX', 'Mail.example.test', { priority: 5 }),
        record(1, '_sip._tcp.example.test', 'SRV', 'sip.example.test', {
          priority: 1,
          weight: 2,
          port: 5060,
        }),
        record(1, 'example.test', 'TXT', 'v=spf1 -all'),
      ],
    });
    const rrsets = rrsetsOf(zones, 'example.test.');
    expect(rrsets['www.example.test.|CNAME'].records).toEqual(['web.example.test.']);
    expect(rrsets['example.test.|MX'].records).toEqual(['5 mail.example.test.']);
    expect(rrsets['_sip._tcp.example.test.|SRV'].records).toEqual(['1 2 5060 sip.example.test.']);
    expect(rrsets['example.test.|TXT'].records).toEqual(['"v=spf1 -all"']);
  });

  it('serves the first PTR at a name and none of the placeholders, both families', () => {
    const v4 = '0.10.in-addr.arpa';
    const v6 = '0.0.0.0.0.0.0.0.0.0.0.0.0.0.d.f.ip6.arpa';
    const nibbles = `1.${'0.'.repeat(15)}${v6}`;
    const zones = desiredZones({
      zones: [zone(1, v4), zone(2, v6)],
      records: [
        record(1, `5.0.${v4}`, 'PTR', 'first.example.test'),
        record(1, `5.0.${v4}`, 'PTR', 'second.example.test'),
        { ...record(1, `6.0.${v4}`, 'PTR', '10.0.0.6'), placeholder: true },
        record(2, nibbles, 'PTR', 'six.example.test'),
        { ...record(2, `2.${'0.'.repeat(15)}${v6}`, 'PTR', 'fd00::2'), placeholder: true },
      ],
    });
    const rev4 = rrsetsOf(zones, `${v4}.`);
    expect(rev4[`5.0.${v4}.|PTR`].records).toEqual(['first.example.test.']);
    expect(rev4[`6.0.${v4}.|PTR`]).toBeUndefined();
    const rev6 = rrsetsOf(zones, `${v6}.`);
    expect(rev6[`${nibbles}.|PTR`].records).toEqual(['six.example.test.']);
    expect(Object.keys(rev6).filter((key) => key.endsWith('|PTR'))).toHaveLength(1);
  });

  it('keeps the first CNAME and drops other data at its name', () => {
    const zones = desiredZones({
      zones: [zone(1, 'example.test')],
      records: [
        record(1, 'alias.example.test', 'A', '10.0.0.9'),
        record(1, 'alias.example.test', 'CNAME', 'web.example.test'),
        record(1, 'alias.example.test', 'CNAME', 'other.example.test'),
      ],
    });
    const rrsets = rrsetsOf(zones, 'example.test.');
    expect(rrsets['alias.example.test.|CNAME'].records).toEqual(['web.example.test.']);
    expect(rrsets['alias.example.test.|A']).toBeUndefined();
  });

  it('leaves out names outside the zone and values that are not names or addresses', () => {
    const zones = desiredZones({
      zones: [zone(1, 'example.test')],
      records: [
        record(1, 'host.elsewhere.test', 'A', '10.0.0.1'),
        record(1, 'bad.example.test', 'A', 'fd00::1'),
        record(1, 'bad.example.test', 'AAAA', '10.0.0.1'),
        record(1, 'bad.example.test', 'CNAME', 'not a name'),
        record(1, 'line.example.test', 'TXT', 'two\nlines'),
      ],
    });
    expect(Object.keys(rrsetsOf(zones, 'example.test.'))).toEqual([
      'example.test.|SOA',
      'example.test.|NS',
    ]);
  });

  it('skips a zone whose name or SOA fields are not DNS names', () => {
    const zones = desiredZones({
      zones: [zone(1, 'bad zone'), zone(2, 'ok.test', { soa_primary_ns: 'x y' })],
      records: [],
    });
    expect(zones.size).toBe(0);
  });
});

describe('txtContent', () => {
  it('escapes quotes, backslashes and bytes outside printable ASCII', () => {
    expect(txtContent('a "q" \\ b')).toBe('"a \\"q\\" \\\\ b"');
    expect(txtContent('café\tx')).toBe('"caf\\195\\169\\009x"');
  });

  it('splits a value longer than 255 bytes into strings', () => {
    const content = txtContent('x'.repeat(300));
    expect(content).toBe(`"${'x'.repeat(255)}" "${'x'.repeat(45)}"`);
  });
});

describe('absoluteName and servedTtl', () => {
  it('makes names absolute and lowercase, refusing what is not a name', () => {
    expect(absoluteName('Web.Example.Test.')).toBe('web.example.test.');
    expect(absoluteName('_dmarc.example.test')).toBe('_dmarc.example.test.');
    expect(absoluteName('a..b')).toBeNull();
    expect(absoluteName('-bad.test')).toBeNull();
    expect(absoluteName(`${'a'.repeat(64)}.test`)).toBeNull();
  });

  it('serves a record its own TTL, else the local one', () => {
    expect(servedTtl({ type: 'A', ttl: 900 })).toBe(900);
    expect(servedTtl({ type: 'AAAA', ttl: null })).toBe(LOCAL_RECORD_TTL);
    expect(servedTtl({ type: 'CNAME', ttl: 0 })).toBe(LOCAL_RECORD_TTL);
  });
});

describe('renderRecursorConfig', () => {
  const base = {
    zones: ['example.test.', '0.10.in-addr.arpa.'],
    listen: ['127.0.0.1', '::1'],
    port: 5353,
    authPort: 5300,
    forwarders: ['127.0.0.1:5356'],
    recursion: true,
    validation: 'validate',
    networkTimeoutMs: RECURSOR_NETWORK_TIMEOUT_MS,
    runDir: '/data/pdns/run',
  };

  it('forwards local zones to Authoritative with a trust anchor each, the rest to the forwarder', () => {
    const { text } = renderRecursorConfig(base);
    expect(text).toContain(
      '  forward_zones:\n    - zone: "0.10.in-addr.arpa"\n      forwarders:\n        - "127.0.0.1:5300"\n    - zone: "example.test"',
    );
    expect(text).toContain('    - name: "example.test"\n      reason: "CIDRella local zone"');
    expect(text).toContain(
      '  forward_zones_recurse:\n    - zone: "."\n      forwarders:\n        - "127.0.0.1:5356"',
    );
    expect(text).toContain('  dont_query:\n    - "0.0.0.0/0"\n    - "::/0"');
  });

  it('quotes IPv6 values so YAML reads them as strings', () => {
    const { text } = renderRecursorConfig(base);
    expect(text).toContain('    - "::1"\n');
    expect(text).toContain('    - "::1/128"\n');
  });

  it('logs each query only in bypass mode, where Recursor answers clients itself', () => {
    expect(renderRecursorConfig(base).text).not.toContain('logging:');
    const bypass = renderRecursorConfig({ ...base, logQueries: true });
    expect(bypass.text).toContain('logging:\n  quiet: false\n');
    expect(bypass.fixed).not.toBe(renderRecursorConfig(base).fixed);
  });

  it('forwards nothing upstream with recursion off', () => {
    expect(renderRecursorConfig({ ...base, recursion: false }).text).toContain(
      '  forward_zones_recurse: []\n',
    );
  });

  it('puts zone changes in the reloadable part and the rest in the fixed part', () => {
    const one = renderRecursorConfig(base);
    const zones = renderRecursorConfig({ ...base, zones: ['example.test.'] });
    expect(zones.fixed).toBe(one.fixed);
    expect(zones.zones).not.toBe(one.zones);
    for (const change of [
      { listen: ['127.0.0.1'] },
      { port: 53 },
      { recursion: false },
      { validation: 'process' },
    ]) {
      const next = renderRecursorConfig({ ...base, ...change });
      expect(next.fixed, JSON.stringify(change)).not.toBe(one.fixed);
      expect(next.zones).toBe(one.zones);
    }
  });

  it('waits for the forwarder past its budget and inside the proxy timeout', () => {
    expect(RECURSOR_NETWORK_TIMEOUT_MS).toBeGreaterThan(ENCRYPTED_FORWARDER_BUDGET_MS);
    expect(RECURSOR_NETWORK_TIMEOUT_MS).toBeLessThan(PROXY_UDP_TIMEOUT_MS);
    expect(renderRecursorConfig(base).text).toContain(
      `  network_timeout: ${RECURSOR_NETWORK_TIMEOUT_MS}\n`,
    );
  });
});

describe('renderAuthConfig', () => {
  it('keeps DNS and the API on loopback', () => {
    const conf = renderAuthConfig({
      dbPath: '/data/pdns/auth/pdns.sqlite3',
      port: 5300,
      apiPort: 8053,
      apiKey: 'k',
      runDir: '/data/pdns/run',
    });
    expect(conf).toContain('local-address=127.0.0.1\n');
    expect(conf).toContain('webserver-address=127.0.0.1\n');
    expect(conf).toContain('webserver-allow-from=127.0.0.1/32,::1/128\n');
    expect(conf).toContain('api-key=k\n');
  });
});
