/**
 * What dnsmasq's log says, for the readers that tail it: passive liveness
 * (who queried), the metrics aggregator (query and DHCP message counts) and
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
// tag.
const DHCP_CLIENT_RE =
  /\bDHCP(?:DISCOVER|REQUEST|RELEASE|INFORM|DECLINE|SOLICIT|RENEW|REBIND|CONFIRM|INFORMATION-REQUEST)\b/;
const DHCP_SERVER_RE = /\bDHCP(?:OFFER|ACK|NAK|ADVERTISE|REPLY)\b/;

/** 'client' or 'server' for a DHCP message line, null for any other line. */
export function dhcpDirection(line) {
  if (DHCP_CLIENT_RE.test(line)) return 'client';
  if (DHCP_SERVER_RE.test(line)) return 'server';
  return null;
}

const DHCP_RE =
  /\b(?:DHCPDISCOVER|DHCPOFFER|DHCPREQUEST|DHCPACK|DHCPNAK|DHCPRELEASE|DHCPINFORM|DHCPDECLINE)\b|available DHCP|dnsmasq-dhcp\[\d+\]:|\bsent size:\s+\d+\s+option:|\brequested options:|\bnext server:|\bclient provides name:|\bvendor class:|\btags:\s+scope/i;

/** Whether a line belongs to DHCP (the log viewer's DHCP filter). */
export function isDhcpLine(line) {
  return DHCP_RE.test(line);
}
