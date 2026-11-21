/**
 * Where what this instance observes goes. The daemons and the DNS proxy on a
 * box see things the data of record must learn: the DHCP server's leases, a
 * client that just asked a DNS question, a client's DHCP fingerprint. The code
 * that sees them reports them here and never writes them itself, so the same
 * code runs on an instance that does not own the data
 * (docs/REDUNDANCY-PLAN.md, section 3).
 *
 *   leases(db, leases)            the DHCP backend's whole lease set; resolves
 *                                 { synced, rejected, blocking }. The caller
 *                                 (syncLeasesNow) reloads this box's proxy
 *                                 exemptions afterwards; a sink does not.
 *   clientSeen(db, ip, options)   a client was heard from (recordDnsQueryLiveness)
 *   fingerprint(db, fingerprint)  a device_fingerprints row for a MAC
 */
import { localSink } from './local-sink.js';

let sink = localSink;

export const facts = () => sink;

/**
 * What a member does with what it observes, until it can send it to its
 * controller (phase 4 of docs/REDUNDANCY-PLAN.md): nothing. It does not own
 * the tables these facts are written to.
 */
export const memberSink = {
  leases: async () => ({ synced: 0, rejected: 0, blocking: [] }),
  clientSeen: () => {},
  fingerprint: () => {},
};

/** Send facts to `next` from now on. Returns the undo. */
export function setFactsSink(next) {
  const previous = sink;
  sink = next;
  return () => {
    sink = previous;
  };
}
