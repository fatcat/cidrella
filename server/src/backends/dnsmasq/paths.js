/**
 * Where dnsmasq's files live under DATA_DIR. dnsmasq.conf.default points
 * hostsdir, dhcp-hostsdir, conf-dir, the pid, log and lease files at these.
 */
import path from 'path';
import { DATA_DIR } from '../../config/defaults.js';

export const DNSMASQ_DIR = path.join(DATA_DIR, 'dnsmasq');
export const DNSMASQ_CONF = path.join(DNSMASQ_DIR, 'dnsmasq.conf');
// Hosts files, reread on SIGHUP and by inotify.
export const HOSTS_DIR = path.join(DNSMASQ_DIR, 'hosts.d');
// DHCP reservations, reread on SIGHUP and by inotify.
export const DHCP_HOSTS_DIR = path.join(DNSMASQ_DIR, 'dhcp-hosts.d');
// Zone and scope config, read only at start.
export const CONF_DIR = path.join(DNSMASQ_DIR, 'conf.d');
export const DNSMASQ_PID = path.join(DNSMASQ_DIR, 'dnsmasq.pid');
export const LEASE_FILE = path.join(DNSMASQ_DIR, 'dnsmasq.leases');
export const LOG_FILE = path.join(DNSMASQ_DIR, 'dnsmasq.log');
// Left by a restart that failed, so the next boot restarts regardless.
export const RESTART_PENDING = path.join(DATA_DIR, 'runtime', 'dnsmasq-restart-pending');
