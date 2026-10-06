/**
 * dnsmasq's `log-dhcp` output, reassembled into DHCP transactions for passive
 * device fingerprinting (utils/dhcp-fingerprint.js classifies and stores
 * them). dnsmasq writes each transaction as several lines sharing a numeric
 * transaction id; this keeps the option 55 list, option 60 vendor class and
 * client hostname per transaction and hands back each one dnsmasq ACKed.
 *
 * DHCPv4 only, deliberately: the fingerprint is option 55 and option 60, which
 * are DHCPv4 option codes, keyed by the client's MAC. A DHCPv6 exchange is
 * dropped here rather than folded into the option-55 fingerprint.
 */
import { extractMac } from '../../utils/mac.js';
import { normalizeOpt55 } from '../../utils/device-classifier.js';

// "<ts> dnsmasq-dhcp[pid]: <xid> <content>". Include the process id in the
// accumulator key so an xid reused after a dnsmasq restart cannot inherit the
// previous process's partial transaction.
const DHCP_LINE_RE = /dnsmasq-dhcp\[(\d+)\]:\s+(\d+)\s+(.*)$/;
// DHCPv6 message lines. REQUEST, RELEASE and DECLINE share their names with
// DHCPv4, so those are told apart by the client DUID (seven or more colon
// separated bytes) where a DHCPv4 line has an address and a MAC.
const DHCPV6_ONLY_RE = /^DHCP(SOLICIT|ADVERTISE|REPLY|RENEW|REBIND|CONFIRM|INFORMATION-REQUEST)\b/;
const DUID_TOKEN_RE = /(?:^|\s)(?:[0-9a-f]{2}:){6,}[0-9a-f]{2}(?:\s|$)/i;

function isDhcpv6Line(content) {
  return (
    DHCPV6_ONLY_RE.test(content) || (/^DHCP[A-Z]+\(/.test(content) && DUID_TOKEN_RE.test(content))
  );
}
// MAC parsing lives in utils/mac.js so this file and arp-cache.js cannot drift
// on what counts as a MAC. See REVIEW.md, duplicate-logic audit #13.

// Bounded per-transaction accumulator so a busy network can't grow it without limit.
const MAX_PENDING = 1000;
const FINALIZE_QUIET_MS = 1000;
const STALE_PENDING_MS = 60 * 1000;

/**
 * Apply a single parsed log-dhcp line to the pending-transaction map.
 * Exported for unit testing. ACKed records are finalized by drainFinalized()
 * after dnsmasq has written their trailing option detail.
 */
export function ingestLine(line, pending, now = Date.now()) {
  const m = line.match(DHCP_LINE_RE);
  if (!m) return null;
  const key = `${m[1]}:${m[2]}`;
  const content = m[3];
  // A DHCPv6 message marks its transaction as one this fingerprint ignores:
  // it stays in the map (never ACKed, so never finalized; the stale sweep
  // drops it) so its trailing option lines are dropped too.
  if (isDhcpv6Line(content)) {
    pending.delete(key);
    if (pending.size >= MAX_PENDING) pending.delete(pending.keys().next().value);
    pending.set(key, { ignored: true, ackSeen: false, updatedAt: now });
    return null;
  }
  if (pending.get(key)?.ignored) return null;

  let tx = pending.get(key);
  const ensure = () => {
    if (!tx) {
      // evict oldest if at cap
      if (pending.size >= MAX_PENDING) {
        const oldest = pending.keys().next().value;
        if (oldest !== undefined) pending.delete(oldest);
      }
      tx = {
        mac: null,
        opt55: null,
        opt60: null,
        hostname: null,
        ackSeen: false,
        updatedAt: now,
      };
      pending.set(key, tx);
    }
    tx.updatedAt = now;
    return tx;
  };

  if (content.startsWith('vendor class:')) {
    ensure().opt60 = content.slice('vendor class:'.length).trim() || null;
  } else if (content.startsWith('client provides name:')) {
    const h = content.slice('client provides name:'.length).trim();
    if (h) ensure().hostname = h;
  } else if (content.startsWith('requested options:')) {
    const codes = normalizeOpt55(content.slice('requested options:'.length).trim());
    if (codes) {
      const current = ensure();
      current.opt55 = current.opt55 ? `${current.opt55},${codes}` : codes;
    }
  } else if (/^DHCP(DISCOVER|REQUEST|ACK|INFORM)\b/.test(content)) {
    // extractMac returns null for 00:00:00:00:00:00, which the local regex
    // accepted: a DHCP packet with no client hwaddr used to fingerprint the
    // null MAC as if it were a device.
    const current = ensure();
    const mac = extractMac(content);
    if (mac) current.mac = mac;
    // Each incoming packet has its own option 55 list. dnsmasq logs that list
    // after the outgoing OFFER/ACK, so reset it when the incoming packet starts
    // and then append every trailing "requested options" fragment.
    if (/^DHCP(DISCOVER|REQUEST|INFORM)\b/.test(content)) {
      current.opt55 = null;
      current.ackSeen = false;
    }
    if (content.startsWith('DHCPACK')) {
      // Do not finalize here. dnsmasq emits requested-option detail after the
      // ACK, so the watcher drains ACKed transactions after a short quiet
      // period instead.
      current.ackSeen = true;
    }
  }
  return null;
}

/**
 * Return ACKed transactions after their trailing dnsmasq detail has arrived,
 * and discard abandoned transactions so the bounded map does not retain stale
 * evidence indefinitely.
 */
export function drainFinalized(
  pending,
  { now = Date.now(), quietMs = FINALIZE_QUIET_MS, staleMs = STALE_PENDING_MS } = {},
) {
  const finalized = [];
  for (const [key, tx] of pending) {
    const idleMs = now - tx.updatedAt;
    if (tx.ackSeen && tx.mac && idleMs >= quietMs) {
      finalized.push({
        mac: tx.mac,
        opt55: tx.opt55,
        opt60: tx.opt60,
        hostname: tx.hostname,
      });
      pending.delete(key);
    } else if (idleMs >= staleMs) {
      pending.delete(key);
    }
  }
  return finalized;
}

/**
 * A parser holding its own pending transactions:
 * ingest(line, now) takes one log line, drain({ now }) returns the finished
 * transactions ({ mac, opt55, opt60, hostname }).
 */
export function createDhcpLogParser() {
  const pending = new Map();
  return {
    ingest: (line, now = Date.now()) => ingestLine(line, pending, now),
    drain: (opts) => drainFinalized(pending, opts),
  };
}
