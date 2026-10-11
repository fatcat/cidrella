/**
 * Where the PowerDNS files live under DATA_DIR. Everything here is derived
 * from CIDRella's database: Authoritative's sqlite database is rebuilt by
 * applyZones, and backups leave the whole directory out.
 *
 * The daemons run as the cidrella account with these directories as their
 * config dirs (scripts/systemd/cidrella-pdns-auth.service and
 * cidrella-pdns-recursor.service, the s6 scripts in Docker).
 */
import fs from 'fs';
import path from 'path';
import { DATA_DIR, PDNS_AUTH_API_PORT, PDNS_AUTH_DNS_PORT } from '../../config/defaults.js';

export const PDNS_DIR = path.join(DATA_DIR, 'pdns');
export const AUTH_DIR = path.join(PDNS_DIR, 'auth');
export const RECURSOR_DIR = path.join(PDNS_DIR, 'recursor');
// Control sockets and pid files of both daemons; rec_control finds Recursor here.
export const RUN_DIR = path.join(PDNS_DIR, 'run');
// The API key, kept apart from the rendered configuration.
export const SECRET_DIR = path.join(PDNS_DIR, 'secret');
export const API_KEY_FILE = 'api-key';

export const AUTH_CONF = path.join(AUTH_DIR, 'pdns.conf');
export const AUTH_DB = path.join(AUTH_DIR, 'pdns.sqlite3');
export const RECURSOR_CONF = path.join(RECURSOR_DIR, 'recursor.yml');
// Left by a restart that failed, so the next boot restarts.
export const RESTART_PENDING = path.join(DATA_DIR, 'runtime', 'pdns-restart-pending');

export const DAEMONS = Object.freeze(['auth', 'recursor']);

// scripts/systemd/cidrella-pdns-<daemon>.service
export const unitName = (daemon) => `cidrella-pdns-${daemon}`;
export const processName = (daemon) => (daemon === 'auth' ? 'pdns_server' : 'pdns_recursor');
// Docker only: the s6 run script waits for this before starting the daemon.
export const enableFlagPath = (daemon) => path.join(DATA_DIR, 'runtime', `pdns-${daemon}.enabled`);

export const authDnsPort = () => Number(process.env.PDNS_AUTH_PORT) || PDNS_AUTH_DNS_PORT;
export const authApiPort = () => Number(process.env.PDNS_API_PORT) || PDNS_AUTH_API_PORT;

export const binary = (daemon) =>
  daemon === 'auth'
    ? process.env.PDNS_SERVER_BIN || 'pdns_server'
    : process.env.PDNS_RECURSOR_BIN || 'pdns_recursor';
export const recControlBinary = () => process.env.REC_CONTROL_BIN || 'rec_control';

// Where each distribution's gsqlite3 package puts its schema: Debian's
// pdns-backend-sqlite3, then Alpine's pdns-backend-sqlite3.
const SCHEMA_CANDIDATES = [
  '/usr/share/pdns-backend-sqlite3/schema/schema.sqlite3.sql',
  '/usr/share/doc/pdns-backend-sqlite3/schema.sqlite3.sql',
  '/usr/share/doc/pdns/schema.sqlite3.sql',
];

/** The gsqlite3 schema file, or null when the backend is not installed. */
export function sqliteSchemaPath() {
  const candidates = process.env.PDNS_SQLITE_SCHEMA
    ? [process.env.PDNS_SQLITE_SCHEMA]
    : SCHEMA_CANDIDATES;
  return candidates.find((file) => fs.existsSync(file)) || null;
}
