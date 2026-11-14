import { describe, expect, it } from 'vitest';
import { querySourceIp } from '../../../../src/backends/pdns/log-format.js';
import { emptyDhcpCounts, parseLogLines } from '../../../../src/utils/metrics-aggregator.js';
import { formatQueryLine } from '../../../../src/utils/query-log-line.js';

// Recursor 5.3.11's lines, captured on testerella (2026-10-11) with logging.quiet off.
const RECURSOR = {
  question:
    'Oct 11 13:43:46 msg="Question" subsystem="syncres" level="0" prio="Info" tid="1" ts="1791726226.436" ecs="" mtid="0" proto="udp" qname="example.com" qtype="A" remote="10.0.0.22:39801"',
  questionV6:
    'Oct 11 13:43:46 msg="Question" subsystem="syncres" level="0" prio="Info" tid="2" ts="1791726226.567" ecs="" mtid="1" proto="udp" qname="testerella.the-mcnultys.org" qtype="AAAA" remote="[fd00:a::22]:57741"',
  answer:
    'Oct 11 13:43:46 msg="Answer" subsystem="syncres" level="0" prio="Info" tid="1" ts="1791726226.550" answers="2" proto="udp" qname="example.com" qtype="A" rcode="0" remote="10.0.0.22:39801"',
  cached:
    'Oct 11 13:44:03 msg="Question answered from packet cache" subsystem="in" level="0" prio="Notice" tid="1" ts="1791726243.980" proto="udp" qname="example.com" qtype="A" remote="[fd00:a::22]:36192" source="[fd00:a::22]:36192" tag="0"',
  daemon:
    'Oct 11 13:43:44 msg="Processing main YAML settings" level="0" prio="Notice" tid="0" ts="1791726224.422" path="/var/lib/cidrella/pdns/recursor/recursor.yml"',
};
const AUTH = 'Oct 11 13:44:09 UDP server bound to 127.0.0.1:5398';
const proxyLine = (clientIp) =>
  formatQueryLine({ clientIp, domain: 'a.example', responseCode: 'NOERROR' }).trimEnd();

describe('PowerDNS querySourceIp', () => {
  it("reads the client from the proxy's lines, either family", () => {
    expect(querySourceIp(proxyLine('10.0.0.5'))).toBe('10.0.0.5');
    expect(querySourceIp(proxyLine('fd00::5'))).toBe('fd00::5');
  });

  it("reads the client from Recursor's question lines in bypass mode, either family", () => {
    expect(querySourceIp(RECURSOR.question)).toBe('10.0.0.22');
    expect(querySourceIp(RECURSOR.questionV6)).toBe('fd00:a::22');
    expect(querySourceIp(RECURSOR.cached)).toBe('fd00:a::22');
  });

  it('counts each query once and no daemon message', () => {
    expect(querySourceIp(RECURSOR.answer)).toBeNull();
    expect(querySourceIp(RECURSOR.daemon)).toBeNull();
    expect(querySourceIp(AUTH)).toBeNull();
  });
});

// PDNS-METRICS-01: the aggregator counted no DNS query on this stack.
describe('metrics from pdns.log', () => {
  it('counts the queries in the PowerDNS log', () => {
    const source = { querySourceIp, dhcpMessage: () => null };
    const lines = [
      AUTH,
      RECURSOR.daemon,
      proxyLine('10.0.0.5'),
      proxyLine('fd00::5'),
      RECURSOR.question,
      RECURSOR.answer,
      RECURSOR.cached,
    ];
    expect(parseLogLines(lines, source)).toEqual({ dnsQueries: 4, dhcp: emptyDhcpCounts() });
  });
});
