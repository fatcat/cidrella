/**
 * Where Kea's files live under DATA_DIR, and the environment that confines
 * the Kea daemons to them. Kea 3 refuses lease, log, legal-log and socket
 * paths outside the directories its KEA_* variables name, so the units (and
 * `kea-dhcp4 -t`) run with keaEnv().
 */
import fs from 'fs';
import path from 'path';
import { DATA_DIR } from '../../config/defaults.js';

export const KEA_DIR = path.join(DATA_DIR, 'kea');
export const KEA_LOG_DIR = path.join(KEA_DIR, 'log');
// The control API password, kept apart so backups can leave it out.
export const KEA_SECRET_DIR = path.join(KEA_DIR, 'secret');
export const KEA_PASSWORD_FILE = 'api-pw';
export const KEA_API_USER = 'cidrella';
// The DHCPv6 server DUID Kea is to answer with: dnsmasq's, carried over by a
// switch so DHCPv6 clients renew with Kea instead of waiting to rebind.
export const SERVER_DUID_FILE = path.join(KEA_DIR, 'server-duid');
// Left by a reload or restart that failed, so the next boot restarts.
export const RESTART_PENDING = path.join(DATA_DIR, 'runtime', 'kea-restart-pending');

export const FAMILIES = Object.freeze([4, 6]);

// Docker only: the s6 run script (rootfs/etc/s6-overlay/scripts/kea.sh) waits
// for this before starting the daemon. systemd needs no flag.
export const enableFlagPath = (family) =>
  path.join(DATA_DIR, 'runtime', `kea-dhcp${family}.enabled`);

export const confPath = (family) => path.join(KEA_DIR, `kea-dhcp${family}.conf`);
export const leaseFilePath = (family) => path.join(KEA_DIR, `kea-leases${family}.csv`);
export const logFilePath = (family) => path.join(KEA_LOG_DIR, `kea-dhcp${family}.log`);
export const legalLogBaseName = (family) => `kea-legal${family}`;

/**
 * The legal log Kea is writing now. Kea names it <base-name>.<YYYYMMDD>.txt
 * and starts a new one each day, so the newest name is the current file;
 * before the first lease there is none and this is null.
 */
export function newestLegalLog(family) {
  const prefix = `${legalLogBaseName(family)}.`;
  let names;
  try {
    names = fs.readdirSync(KEA_LOG_DIR);
  } catch {
    return null;
  }
  const dated = names.filter(
    (n) => n.startsWith(prefix) && /^\d{8}\.txt$/.test(n.slice(prefix.length)),
  );
  return dated.length ? path.join(KEA_LOG_DIR, dated.sort().at(-1)) : null;
}

/**
 * Delete legal log files dated more than `days` days before `now`. Kea starts
 * one a day and never removes them. Returns how many went.
 */
export function pruneLegalLogs(days, { now = Date.now() } = {}) {
  const cutoff = new Date(now - days * 86400_000).toISOString().slice(0, 10).replace(/-/g, '');
  let names;
  try {
    names = fs.readdirSync(KEA_LOG_DIR);
  } catch {
    return 0;
  }
  let removed = 0;
  for (const name of names) {
    const match = /^kea-legal[46]\.(\d{8})\.txt$/.exec(name);
    if (match && match[1] < cutoff) {
      fs.rmSync(path.join(KEA_LOG_DIR, name), { force: true });
      removed++;
    }
  }
  return removed;
}

// Each daemon's HTTP control socket, on loopback only.
export const controlPort = (family) =>
  Number(process.env[`KEA_CONTROL_PORT${family}`]) || (family === 6 ? 8006 : 8004);

// scripts/systemd/cidrella-kea@.service, one instance per daemon.
export const unitName = (family) => `cidrella-kea@dhcp${family}`;
export const binary = (family) => process.env[`KEA_DHCP${family}_BIN`] || `kea-dhcp${family}`;

export function keaEnv() {
  return {
    KEA_DHCP_DATA_DIR: KEA_DIR,
    KEA_LOG_FILE_DIR: KEA_LOG_DIR,
    KEA_LEGAL_LOG_DIR: KEA_LOG_DIR,
    KEA_CONTROL_SOCKET_DIR: path.join(KEA_DIR, 'run'),
    KEA_PIDFILE_DIR: path.join(KEA_DIR, 'run'),
    KEA_LOCKFILE_DIR: path.join(KEA_DIR, 'run'),
  };
}
