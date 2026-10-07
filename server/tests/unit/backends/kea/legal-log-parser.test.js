import { describe, it, expect } from 'vitest';
import {
  createLegalLogParser,
  parseLegalLine,
} from '../../../../src/backends/kea/legal-log-parser.js';

// Written by Kea 3.0.4 for a busybox udhcpc REQUEST (the live check).
const ACKED =
  '2026-10-07 15:53:26 UTC type=3 mac=06:8c:05:68:00:f1 prl=01,03,06,0c,0f,1c,2a vci=MSFT 5.0 host=laptop ack ip=192.168.50.100';

describe('parseLegalLine', () => {
  it('reads the fingerprint fields, option 55 as decimal codes', () => {
    expect(parseLegalLine(ACKED)).toEqual({
      msgtype: 3,
      mac: '06:8c:05:68:00:f1',
      opt55: '1,3,6,12,15,28,42',
      opt60: 'MSFT 5.0',
      hostname: 'laptop',
      answer: 'ack',
    });
  });

  it('reads empty fields as missing and ignores lines that are not ours', () => {
    expect(
      parseLegalLine('2026-10-07 15:53:26 UTC type=3 mac=06:8c:05:68:00:f1 prl= vci= host='),
    ).toMatchObject({
      opt55: null,
      opt60: null,
      hostname: null,
      answer: null,
    });
    expect(parseLegalLine('Address: 10.0.0.5 has been assigned')).toBeNull();
  });
});

describe('createLegalLogParser', () => {
  it('hands back each ACKed REQUEST once', () => {
    const parser = createLegalLogParser();
    parser.ingest(ACKED);
    parser.ingest(ACKED.replace(' ack ip=192.168.50.100', ''));
    expect(parser.drain()).toEqual([
      {
        mac: '06:8c:05:68:00:f1',
        opt55: '1,3,6,12,15,28,42',
        opt60: 'MSFT 5.0',
        hostname: 'laptop',
      },
    ]);
    expect(parser.drain()).toEqual([]);
  });
});
