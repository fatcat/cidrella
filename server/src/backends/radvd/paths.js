/**
 * Where radvd's configuration and runtime files live, and how its unit and
 * binary are named. scripts/systemd/cidrella-radvd.service and the s6 run
 * script (rootfs/etc/s6-overlay/s6-rc.d/radvd/run) must agree.
 */
import path from 'path';
import { DATA_DIR } from '../../config/defaults.js';

export const RADVD_DIR = path.join(DATA_DIR, 'radvd');
export const RADVD_CONF = path.join(RADVD_DIR, 'radvd.conf');
export const RADVD_PID = path.join(RADVD_DIR, 'radvd.pid');
// Written while radvd is wanted; the s6 run script waits for it.
export const ENABLE_FILE = path.join(DATA_DIR, 'runtime', 'radvd.enabled');
export const RESTART_PENDING = path.join(DATA_DIR, 'runtime', 'radvd-restart-pending');
export const UNIT = 'cidrella-radvd';

/** The radvd binary; RADVD_BIN overrides it (tests, unusual installs). */
export const radvdBinary = () => process.env.RADVD_BIN || 'radvd';
