import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { startFakePdns } from '../../../helpers/fake-pdns.js';
import { createPdnsClient, PdnsError } from '../../../../src/backends/pdns/client.js';

let pdns;
let client;
beforeAll(async () => {
  pdns = await startFakePdns({ apiKey: 'right' });
  client = createPdnsClient({ port: pdns.port, apiKey: () => 'right' });
});
afterAll(() => pdns.close());

const zoneBody = (name) => ({
  name,
  kind: 'Native',
  rrsets: [
    {
      name,
      type: 'SOA',
      ttl: 60,
      records: [{ content: 'ns1.x. admin.x. 1 3600 900 604800 300', disabled: false }],
    },
  ],
});

describe('createPdnsClient', () => {
  it('creates, reads, patches and deletes a zone', async () => {
    await client.createZone(zoneBody('a.test.'));
    expect((await client.listZones()).map((z) => z.name)).toEqual(['a.test.']);
    expect(
      await client.patchZone('a.test.', [
        {
          name: 'h.a.test.',
          type: 'AAAA',
          ttl: 60,
          changetype: 'REPLACE',
          records: [{ content: 'fd00::1', disabled: false }],
        },
      ]),
    ).toBeNull();
    const zone = await client.getZone('a.test.');
    expect(zone.rrsets.map((r) => r.type)).toEqual(['SOA', 'AAAA']);
    await client.deleteZone('a.test.');
    expect(await client.listZones()).toEqual([]);
  });

  it('names the refusal the API gave', async () => {
    await client.createZone(zoneBody('b.test.'));
    const err = await client
      .patchZone('b.test.', [
        {
          name: 'h.elsewhere.test.',
          type: 'A',
          ttl: 60,
          changetype: 'REPLACE',
          records: [{ content: '10.0.0.1', disabled: false }],
        },
      ])
      .catch((e) => e);
    expect(err).toBeInstanceOf(PdnsError);
    expect(err.status).toBe(422);
    expect(err.message).toMatch(
      /PATCH .*b\.test\..* HTTP 422: RRset h\.elsewhere\.test\. is out of zone/,
    );
  });

  it('says when the key is refused', async () => {
    const wrong = createPdnsClient({ port: pdns.port, apiKey: () => 'wrong' });
    const err = await wrong.listZones().catch((e) => e);
    expect(err).toMatchObject({ name: 'PdnsError', status: 401 });
    expect(err.message).toMatch(/refused CIDRella's API key/);
  });

  it('reports a server that does not answer with no status', async () => {
    const closed = createPdnsClient({ port: 1, apiKey: () => 'right', timeoutMs: 1000 });
    const err = await closed.server().catch((e) => e);
    expect(err).toMatchObject({ name: 'PdnsError', status: null });
    expect(err.message).toMatch(/did not answer GET/);
  });
});
