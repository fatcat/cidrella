/**
 * Passive DHCP device/OS fingerprinting.
 *
 * Tails the DHCP backend's log (logSource().createDhcpParser reassembles each
 * DHCP transaction: option 55, option 60, the supplied hostname and the MAC
 * the server ACKed), classifies it offline (device-classifier.js + MAC OUI),
 * and stores a per-MAC fingerprint. No raw sockets and no DHCP hook script.
 *
 * Mirrors the watcher shape of passive-liveness.js (readLogTail + poll loop).
 *
 * DHCPv4 only, deliberately: the fingerprint is option 55 and option 60, which
 * are DHCPv4 option codes, keyed by the client's MAC. A DHCPv6 exchange
 * (SOLICIT ... REPLY, identified by a DUID, with ORO option 6 and vendor class
 * option 16 in their own namespace) is ignored here rather than folded into the
 * option-55 fingerprint, so an IPv6-only device gets no device_type from DHCP.
 */

import fs from 'fs';
import { readLogTail } from './log-reader.js';
import { lookupVendor } from './mac-vendor.js';
import { classify } from './device-classifier.js';
import { getByMac, upsertFingerprint } from '../models/device-fingerprint.js';
import { DHCP_FINGERPRINT_POLL_MS } from '../config/defaults.js';
import { getService } from '../backends/index.js';

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
    opt55,
    opt60,
    hostname,
    vendor,
  });
  upsertFingerprint(db, {
    mac_address: tx.mac,
    dhcp_fingerprint: opt55,
    vendor_class: opt60,
    dhcp_hostname: hostname,
    device_type,
    os_family,
    confidence,
    source: 'dhcp',
    raw: JSON.stringify({ opt55, opt60, hostname, vendor }),
  });
}

export function startDhcpFingerprintWatcher(db) {
  const source = getService('dhcp').logSource();
  if (!source?.createDhcpParser) return null;
  const logFile = source.path;
  const parser = source.createDhcpParser();
  let offset = 0;

  // Start at EOF, don't replay history.
  try {
    offset = fs.statSync(logFile).size;
  } catch {
    /* not created yet */
  }

  function poll() {
    try {
      const { lines, newOffset } = readLogTail(logFile, offset);
      offset = newOffset;
      const now = Date.now();
      for (const line of lines) parser.ingest(line, now);
      for (const finalized of parser.drain({ now })) {
        try {
          persist(db, finalized);
        } catch (err) {
          console.warn('[dhcp-fingerprint] persist failed:', err?.message || err);
        }
      }
    } catch (err) {
      console.warn('[dhcp-fingerprint] poll error:', err?.message || err);
    }
  }

  const interval = setInterval(poll, DHCP_FINGERPRINT_POLL_MS);
  console.log(`[dhcp-fingerprint] Watching ${logFile} (poll ${DHCP_FINGERPRINT_POLL_MS / 1000}s)`);
  return interval;
}
