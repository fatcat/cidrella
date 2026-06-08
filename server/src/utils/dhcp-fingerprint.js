/**
 * Passive DHCP device/OS fingerprinting.
 *
 * Tails dnsmasq's `log-dhcp` output (already enabled) and reconstructs each DHCP
 * transaction from its multi-line log block, which dnsmasq prefixes with a
 * shared numeric transaction id. We capture option 55 (parameter request list),
 * option 60 (vendor class) and the supplied hostname, correlate them with the
 * MAC from the DHCPACK, classify offline (device-classifier.js + MAC OUI), and
 * store a per-MAC fingerprint. No raw sockets, no dhcp-script, no dnsmasq change.
 *
 * Mirrors the watcher shape of passive-liveness.js (readLogTail + poll loop).
 */

import fs from 'fs';
import path from 'path';
import { readLogTail } from './log-reader.js';
import { lookupVendor } from './mac-vendor.js';
import { classify, normalizeOpt55 } from './device-classifier.js';
import { upsertFingerprint } from '../models/device-fingerprint.js';
import { DATA_DIR, DHCP_FINGERPRINT_POLL_MS } from '../config/defaults.js';

const LOG_FILE = path.join(DATA_DIR, 'dnsmasq', 'dnsmasq.log');

// "<ts> dnsmasq-dhcp[pid]: <xid> <content>"  → captures xid + content
const DHCP_LINE_RE = /dnsmasq-dhcp\[\d+\]:\s+(\d+)\s+(.*)$/;
const MAC_RE = /\b([0-9a-fA-F]{2}(?::[0-9a-fA-F]{2}){5})\b/;

// Bounded per-transaction accumulator so a busy network can't grow it without limit.
const MAX_PENDING = 1000;

/**
 * Apply a single parsed log-dhcp line to the pending-transaction map.
 * Exported for unit testing. Returns the finalized record on a DHCPACK, else null.
 */
export function ingestLine(line, pending) {
  const m = line.match(DHCP_LINE_RE);
  if (!m) return null;
  const xid = m[1];
  const content = m[2];

  let tx = pending.get(xid);
  const ensure = () => {
    if (!tx) {
      // evict oldest if at cap
      if (pending.size >= MAX_PENDING) {
        const oldest = pending.keys().next().value;
        if (oldest !== undefined) pending.delete(oldest);
      }
      tx = { mac: null, opt55: null, opt60: null, hostname: null };
      pending.set(xid, tx);
    }
    return tx;
  };

  if (content.startsWith('vendor class:')) {
    ensure().opt60 = content.slice('vendor class:'.length).trim() || null;
  } else if (content.startsWith('client provides name:')) {
    const h = content.slice('client provides name:'.length).trim();
    if (h) ensure().hostname = h;
  } else if (content.startsWith('requested options:')) {
    const codes = normalizeOpt55(content.slice('requested options:'.length).trim());
    if (codes) ensure().opt55 = codes;
  } else if (/^DHCP(DISCOVER|REQUEST|ACK|INFORM)\b/.test(content)) {
    const mac = content.match(MAC_RE);
    if (mac) ensure().mac = mac[1].toLowerCase();
    if (content.startsWith('DHCPACK')) {
      const final = tx;
      pending.delete(xid);
      return final && final.mac ? final : null;
    }
  }
  return null;
}

// Classify + persist a finalized transaction.
function persist(db, tx) {
  const vendor = tx.mac ? lookupVendor(tx.mac) : null;
  const { device_type, os_family, confidence } = classify({
    opt55: tx.opt55, opt60: tx.opt60, hostname: tx.hostname, vendor,
  });
  upsertFingerprint(db, {
    mac_address: tx.mac,
    dhcp_fingerprint: tx.opt55,
    vendor_class: tx.opt60,
    dhcp_hostname: tx.hostname,
    device_type, os_family, confidence,
    source: 'dhcp',
    raw: JSON.stringify({ opt55: tx.opt55, opt60: tx.opt60, hostname: tx.hostname, vendor }),
  });
}

export function startDhcpFingerprintWatcher(db) {
  let offset = 0;
  const pending = new Map();

  // Start at EOF — don't replay history.
  try { offset = fs.statSync(LOG_FILE).size; } catch { /* not created yet */ }

  function poll() {
    try {
      const { lines, newOffset } = readLogTail(LOG_FILE, offset);
      offset = newOffset;
      for (const line of lines) {
        const finalized = ingestLine(line, pending);
        if (finalized) {
          try { persist(db, finalized); }
          catch (err) { console.warn('[dhcp-fingerprint] persist failed:', err?.message || err); }
        }
      }
    } catch (err) {
      console.warn('[dhcp-fingerprint] poll error:', err?.message || err);
    }
  }

  const interval = setInterval(poll, DHCP_FINGERPRINT_POLL_MS);
  console.log(`[dhcp-fingerprint] Watching ${LOG_FILE} (poll ${DHCP_FINGERPRINT_POLL_MS / 1000}s)`);
  return interval;
}
