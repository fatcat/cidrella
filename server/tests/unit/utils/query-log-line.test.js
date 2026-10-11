import { describe, expect, it } from 'vitest';
import { formatQueryLine, parseQueryLine, syslogTime } from '../../../src/utils/query-log-line.js';

const at = new Date(2026, 9, 1, 13, 5, 9);

describe('formatQueryLine', () => {
  it('writes an answered query with its rcode, first address and latency, either family', () => {
    expect(
      formatQueryLine(
        {
          clientIp: '10.0.0.5',
          domain: 'host.example',
          queryType: 'A',
          responseCode: 'NOERROR',
          action: 'allowed',
          resolvedIp: '93.184.216.34',
          latencyUs: 12_400,
        },
        at,
      ),
    ).toBe(
      'Oct  1 13:05:09 proxy: query[A] host.example from 10.0.0.5, NOERROR 93.184.216.34, 12 ms\n',
    );
    expect(
      formatQueryLine(
        {
          clientIp: 'fd00::5',
          domain: 'host.example',
          queryType: 'AAAA',
          responseCode: 'NOERROR',
          action: 'allowed',
          resolvedIp: '2001:db8::1',
          latencyUs: 800,
        },
        at,
      ),
    ).toBe(
      'Oct  1 13:05:09 proxy: query[AAAA] host.example from fd00::5, NOERROR 2001:db8::1, 1 ms\n',
    );
  });

  it('names a block, a timeout and an empty name', () => {
    const blocked = formatQueryLine(
      {
        clientIp: '10.0.0.5',
        domain: 'ads.example',
        queryType: 'A',
        action: 'blocked_blocklist',
        blockReason: 'ads',
        latencyUs: 100,
      },
      at,
    );
    expect(blocked).toContain('from 10.0.0.5, blocked (blocklist ads), 0 ms');
    const geoip = formatQueryLine(
      { clientIp: 'fd00::9', domain: 'x.example', action: 'blocked_geoip', blockReason: 'KP' },
      at,
    );
    expect(geoip).toContain('query[A] x.example from fd00::9, blocked (geoip KP)\n');
    const timeout = formatQueryLine(
      {
        clientIp: '10.0.0.5',
        domain: '',
        queryType: 'NS',
        responseCode: 'SERVFAIL',
        action: 'allowed',
        failure: 'timeout',
        latencyUs: 4_500_000,
      },
      at,
    );
    expect(timeout).toContain('query[NS] . from 10.0.0.5, SERVFAIL (timeout), 4500 ms');
  });

  it('stamps local time the way PowerDNS does', () => {
    expect(syslogTime(new Date(2026, 11, 25, 0, 0, 1))).toBe('Dec 25 00:00:01');
  });
});

describe('parseQueryLine', () => {
  it('reads the client back, either family', () => {
    for (const clientIp of ['10.0.0.5', 'fd00::5', 'fe80::1']) {
      const line = formatQueryLine({ clientIp, domain: 'a.example', responseCode: 'NOERROR' }, at);
      expect(parseQueryLine(line.trimEnd())).toBe(clientIp);
    }
  });

  it('ignores other lines', () => {
    for (const line of [
      'Oct 11 13:00:00 dnsmasq[12]: query[A] apple.com from 10.0.0.22',
      'Oct 11 13:43:46 msg="Question" subsystem="syncres" qname="example.com" remote="127.0.0.1:39801"',
      'Oct 11 13:44:09 UDP server bound to 127.0.0.1:5398',
      formatQueryLine({ domain: 'a.example' }, at),
    ]) {
      expect(parseQueryLine(line)).toBeNull();
    }
  });
});
