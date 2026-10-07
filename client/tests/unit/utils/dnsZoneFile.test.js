import { describe, expect, it } from 'vitest';
import { zoneFileName, zoneFileValue } from '../../../src/utils/dnsZoneFile.js';

describe('zoneFileName', () => {
  it('writes the zone as @ and a name under it relative, in any case', () => {
    expect(zoneFileName('example.com', 'example.com')).toBe('@');
    expect(zoneFileName('Example.COM.', 'example.com')).toBe('@');
    expect(zoneFileName('www.example.com', 'example.com.')).toBe('www');
    expect(zoneFileName('_sip._tcp.example.com', 'example.com')).toBe('_sip._tcp');
  });

  it('writes a name outside the zone absolute, with one trailing dot', () => {
    expect(zoneFileName('heimanfile.oss-cn-shenzhen.aliyuncs.com.', 'example.com')).toBe(
      'heimanfile.oss-cn-shenzhen.aliyuncs.com.',
    );
    expect(zoneFileName('aspmx.l.google.com', 'example.com')).toBe('aspmx.l.google.com.');
    // A suffix match is a whole label, not a string tail.
    expect(zoneFileName('notexample.com', 'example.com')).toBe('notexample.com.');
  });

  it('writes reverse names relative to their reverse zone, either family', () => {
    expect(zoneFileName('10.0.0.10.in-addr.arpa', '0.0.10.in-addr.arpa')).toBe('10');
    expect(
      zoneFileName(
        '1.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.8.b.d.0.1.0.0.2.ip6.arpa',
        '8.b.d.0.1.0.0.2.ip6.arpa',
      ),
    ).toBe('1.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0');
  });

  it('leaves an empty name alone', () => {
    expect(zoneFileName('', 'example.com')).toBe('');
    expect(zoneFileName(null, 'example.com')).toBe(null);
  });
});

describe('zoneFileValue', () => {
  it('writes a target name as the zone file does', () => {
    expect(zoneFileValue('MX', 'aspmx.l.google.com', 'example.com')).toBe('aspmx.l.google.com.');
    expect(zoneFileValue('CNAME', 'container-host.example.com', 'example.com')).toBe(
      'container-host',
    );
    expect(zoneFileValue('SRV', 'sip.example.com', 'example.com')).toBe('sip');
    expect(zoneFileValue('PTR', 'trust-a.example.com', '0.0.10.in-addr.arpa')).toBe(
      'trust-a.example.com.',
    );
  });

  it('leaves addresses and text as they are', () => {
    expect(zoneFileValue('A', '10.0.0.5', 'example.com')).toBe('10.0.0.5');
    expect(zoneFileValue('AAAA', '2001:db8::5', 'example.com')).toBe('2001:db8::5');
    expect(zoneFileValue('TXT', 'v=spf1 include:example.com -all', 'example.com')).toBe(
      'v=spf1 include:example.com -all',
    );
  });
});
