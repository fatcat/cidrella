/**
 * The facts sink of an instance that owns the data of record: each fact goes
 * straight into the database, as it always has.
 */
import { ingestLeases } from '../services/dhcp-lease-ingest.js';
import { holdsDhcp } from './dhcp-active.js';
import { recordDnsQueryLiveness } from '../utils/ip-liveness.js';
import { upsertFingerprint } from '../models/device-fingerprint.js';

export const localSink = {
  // While another instance serves DHCP its leases are the leases, and this
  // box's own server holds only old ones: storing those would release every
  // real one (sync/dhcp-active.js).
  leases: (db, leases) =>
    holdsDhcp(db) ? ingestLeases(db, leases) : { synced: 0, rejected: 0, blocking: [] },
  clientSeen: (db, ip, options) => recordDnsQueryLiveness(db, ip, options),
  fingerprint: (db, fingerprint) => upsertFingerprint(db, fingerprint),
};
