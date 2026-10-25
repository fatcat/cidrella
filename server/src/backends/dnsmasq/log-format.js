/**
 * What dnsmasq's log says, for the readers that tail it: passive liveness
 * (who queried), the metrics aggregator (query and DHCP message counts, per
 * family) and
 * the log viewer's DHCP filter.
 */
import { LOG_FILE } from './paths.js';

export { LOG_FILE };

// Matches: "query[A] example.com from 192.168.1.100"
//      and: "query[AAAA] example.com from fd00:a::1600"
const QUERY_FROM_RE = /\bquery\[.+?\]\s+\S+\s+from\s+([0-9a-fA-F.:]+)/;

/** The client address of a DNS query line, or null for any other line. */
export function querySourceIp(line) {
  return line.match(QUERY_FROM_RE)?.[1] ?? null;
}

// DHCP conversation halves. DHCPv4 clients send DISCOVER, REQUEST, RELEASE,
// INFORM and DECLINE; the server answers with OFFER, ACK and NAK. DHCPv6
// (RFC 8415, as dnsmasq's rfc3315.c logs it) has its own names: clients send
// SOLICIT, REQUEST, RENEW, REBIND, CONFIRM, RELEASE, DECLINE and
// INFORMATION-REQUEST, and the server answers with ADVERTISE and REPLY.
// dnsmasq logs one line per message with the type as the first word after the
// tag, then the address when there is one, then the client's MAC (DHCPv4) or
// DUID (DHCPv6).
const DHCP_MESSAGE_RE =
  /\bDHCP(DISCOVER|REQUEST|RELEASE|INFORM|DECLINE|SOLICIT|RENEW|REBIND|CONFIRM|INFORMATION-REQUEST|OFFER|ACK|NAK|ADVERTISE|REPLY)\((?:[^)]*)\)\s*(\S*)/;
const SERVER_TYPES = new Set(['OFFER', 'ACK', 'NAK', 'ADVERTISE', 'REPLY']);
const V4_TYPES = new Set(['DISCOVER', 'INFORM', 'OFFER', 'ACK', 'NAK']);
const V6_TYPES = new Set([
  'SOLICIT',
  'RENEW',
  'REBIND',
  'CONFIRM',
  'INFORMATION-REQUEST',
  'ADVERTISE',
  'REPLY',
]);
// REQUEST, RELEASE and DECLINE exist in both families: the token after the
// type tells them apart, an IPv4 address or a six-octet MAC for DHCPv4, an
// IPv6 address or a longer DUID for DHCPv6.
const V4_TOKEN_RE = /^(?:\d{1,3}(?:\.\d{1,3}){3}|[0-9a-f]{2}(?::[0-9a-f]{2}){5})$/i;

/**
 * { direction: 'client' | 'server', family: 4 | 6 } for a DHCP message line,
 * null for any other line.
 */
export function dhcpMessage(line) {
  const m = line.match(DHCP_MESSAGE_RE);
  if (!m) return null;
  const type = m[1];
  const direction = SERVER_TYPES.has(type) ? 'server' : 'client';
  let family;
  if (V4_TYPES.has(type)) family = 4;
  else if (V6_TYPES.has(type)) family = 6;
  else family = V4_TOKEN_RE.test(m[2]) ? 4 : 6;
  return { direction, family };
}

const DHCP_RE =
  /\b(?:DHCPDISCOVER|DHCPOFFER|DHCPREQUEST|DHCPACK|DHCPNAK|DHCPRELEASE|DHCPINFORM|DHCPDECLINE)\b|available DHCP|dnsmasq-dhcp\[\d+\]:|\bsent size:\s+\d+\s+option:|\brequested options:|\bnext server:|\bclient provides name:|\bvendor class:|\btags:\s+scope/i;

/** Whether a line belongs to DHCP (the log viewer's DHCP filter). */
export function isDhcpLine(line) {
  return DHCP_RE.test(line);
}
