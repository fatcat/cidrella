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
import { extractMac } from './mac.js';
import { readLogTail } from './log-reader.js';
import { lookupVendor } from './mac-vendor.js';
import { classify, normalizeOpt55 } from './device-classifier.js';
import { getByMac, upsertFingerprint } from '../models/device-fingerprint.js';
import { DATA_DIR, DHCP_FINGERPRINT_POLL_MS } from '../config/defaults.js';

const LOG_FILE = path.join(DATA_DIR, 'dnsmasq', 'dnsmasq.log');

// "<ts> dnsmasq-dhcp[pid]: <xid> <content>". Include the process id in the
// accumulator key so an xid reused after a dnsmasq restart cannot inherit the
// previous process's partial transaction.
const DHCP_LINE_RE = /dnsmasq-dhcp\[(\d+)\]:\s+(\d+)\s+(.*)$/;
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
        updatedAt: now
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
export function drainFinalized(pending, {
  now = Date.now(),
  quietMs = FINALIZE_QUIET_MS,
  staleMs = STALE_PENDING_MS
} = {}) {
  const finalized = [];
  for (const [key, tx] of pending) {
    const idleMs = now - tx.updatedAt;
    if (tx.ackSeen && tx.mac && idleMs >= quietMs) {
      finalized.push({
        mac: tx.mac,
        opt55: tx.opt55,
        opt60: tx.opt60,
        hostname: tx.hostname
      });
      pending.delete(key);
    } else if (idleMs >= staleMs) {
      pending.delete(key);
    }
  }
  return finalized;
}

// Classify + persist a finalized transaction.
function persist(db, tx) {
  const previous = getByMac(db, tx.mac);
  // Renewals may omit any one signal. Reclassify from the newest complete
  // evidence set instead of turning a partial packet into an empty fingerprint.
  const opt55 = tx.opt55 || previous?.dhcp_fingerprint || null;
  const opt60 = tx.opt60 || previous?.vendor_class || null;
  const hostname = tx.hostname || previous?.dhcp_hostname || null;
  const vendor = tx.mac ? lookupVendor(tx.mac) : null;
  const { device_type, os_family, confidence } = classify({
    opt55, opt60, hostname, vendor,
  });
  upsertFingerprint(db, {
    mac_address: tx.mac,
    dhcp_fingerprint: opt55,
    vendor_class: opt60,
    dhcp_hostname: hostname,
    device_type, os_family, confidence,
    source: 'dhcp',
    raw: JSON.stringify({ opt55, opt60, hostname, vendor }),
  });
}

export function startDhcpFingerprintWatcher(db) {
  let offset = 0;
  const pending = new Map();

  // Start at EOF, don't replay history.
  try { offset = fs.statSync(LOG_FILE).size; } catch { /* not created yet */ }

  function poll() {
    try {
      const { lines, newOffset } = readLogTail(LOG_FILE, offset);
      offset = newOffset;
      const now = Date.now();
      for (const line of lines) ingestLine(line, pending, now);
      for (const finalized of drainFinalized(pending, { now })) {
        try { persist(db, finalized); }
        catch (err) { console.warn('[dhcp-fingerprint] persist failed:', err?.message || err); }
      }
    } catch (err) {
      console.warn('[dhcp-fingerprint] poll error:', err?.message || err);
    }
  }

  const interval = setInterval(poll, DHCP_FINGERPRINT_POLL_MS);
  console.log(`[dhcp-fingerprint] Watching ${LOG_FILE} (poll ${DHCP_FINGERPRINT_POLL_MS / 1000}s)`);
  return interval;
}
