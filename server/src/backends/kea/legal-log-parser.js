/**
 * The DHCPv4 legal log as render.js formats it. Kea writes a line for each
 * lease it commits, so each is a client's REQUEST and the ACK:
 *   <date> <time> UTC type=3 mac=aa:bb:.. prl=01,03,06 vci=MSFT 5.0 host=laptop ack ip=10.0.0.5
 * That is a finished transaction for the fingerprint watcher
 * (utils/dhcp-fingerprint.js), the same as dnsmasq's log-dhcp output gives
 * it. DHCP message counts come from Kea's statistics instead
 * (dhcpCounters), since a DISCOVER or a NAK never reaches this log.
 *
 * DHCPv4 only: option 55 and option 60 are DHCPv4 codes, and the DHCPv6
 * legal log keeps Kea's default format.
 */
import { extractMac } from '../../utils/mac.js';
import { normalizeOpt55 } from '../../utils/device-classifier.js';

const LINE_RE =
  /\btype=(\d+) mac=([0-9a-f:]*) prl=([0-9a-f,]*) vci=(.*?) host=(\S*)( ack ip=\S+)?\s*$/i;

/** One legal-log line as { msgtype, mac, opt55, opt60, hostname, answer }, or null. */
export function parseLegalLine(line) {
  const m = LINE_RE.exec(line);
  if (!m) return null;
  const opt55 = m[3]
    ? normalizeOpt55(
        m[3]
          .split(',')
          .filter(Boolean)
          .map((byte) => String(parseInt(byte, 16)))
          .join(','),
      )
    : '';
  return {
    msgtype: Number(m[1]),
    mac: extractMac(m[2]),
    opt55: opt55 || null,
    opt60: m[4].trim() || null,
    hostname: m[5] || null,
    answer: m[6] ? m[6].trim().split(' ')[0] : null,
  };
}

export const isLegalLine = (line) => LINE_RE.test(line);

/**
 * The parser utils/dhcp-fingerprint.js drives: ingest(line) takes one line,
 * drain() returns the ACKed REQUESTs as { mac, opt55, opt60, hostname }.
 * Each line is a whole transaction, so nothing waits for trailing detail.
 */
export function createLegalLogParser() {
  let finished = [];
  return {
    ingest(line) {
      const parsed = parseLegalLine(line);
      if (parsed?.msgtype === 3 && parsed.answer === 'ack' && parsed.mac) {
        finished.push({
          mac: parsed.mac,
          opt55: parsed.opt55,
          opt60: parsed.opt60,
          hostname: parsed.hostname,
        });
      }
    },
    drain() {
      const out = finished;
      finished = [];
      return out;
    },
  };
}
