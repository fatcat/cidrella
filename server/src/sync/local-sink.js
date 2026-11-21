/**
 * The facts sink of an instance that owns the data of record: each fact goes
 * straight into the database, as it always has.
 */
import { ingestLeases } from '../services/dhcp-lease-ingest.js';
import { recordDnsQueryLiveness } from '../utils/ip-liveness.js';
import { upsertFingerprint } from '../models/device-fingerprint.js';

export const localSink = {
  leases: (db, leases) => ingestLeases(db, leases),
  clientSeen: (db, ip, options) => recordDnsQueryLiveness(db, ip, options),
  fingerprint: (db, fingerprint) => upsertFingerprint(db, fingerprint),
};
