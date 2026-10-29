/**
 * Restarting the DNS proxy process, for the watchdog. The process is killed
 * outright (a hung event loop never runs a SIGTERM handler, and systemd would
 * wait out its stop timeout), and whatever supervises it starts it again:
 *
 *   systemd  Restart=always, and `systemctl start` here too, for a unit that
 *            hit its start limit or was stopped
 *   s6       the longrun restarts it
 *   none     development: the proxy client starts a new child when it
 *            cannot connect (utils/dns-proxy-client.js)
 *
 * CIDRELLA_DNS_PROXY_SUPERVISOR names which (unset means none).
 */
import fs from 'fs';
import { runCommand } from '../utils/run-command.js';
import { proxyLog } from '../dns-proxy/log.js';

export const PROXY_UNIT = 'cidrella-dns-proxy.service';

// Is `pid` the DNS proxy, and not a process that took its number since?
function isProxyPid(pid) {
  try {
    return fs.readFileSync(`/proc/${pid}/cmdline`, 'utf8').includes('dns-proxy/main.js');
  } catch {
    return false;
  }
}

/** Kill the proxy process `pid` (when it is still the proxy) and have it started again. */
export async function restartProxyProcess(pid) {
  if (Number.isInteger(pid) && pid > 1 && isProxyPid(pid)) {
    try {
      process.kill(pid, 'SIGKILL');
      proxyLog('warn', 'Killed the DNS proxy process', { pid });
    } catch (err) {
      proxyLog('warn', 'Could not kill the DNS proxy process', { pid, error: err.message });
    }
  }
  if (process.env.CIDRELLA_DNS_PROXY_SUPERVISOR !== 'systemd') return;
  try {
    await runCommand('systemctl', ['reset-failed', PROXY_UNIT]).catch(() => {});
    await runCommand('systemctl', ['start', PROXY_UNIT]);
  } catch (err) {
    proxyLog('error', 'Could not start the DNS proxy unit', { error: err.message });
  }
}
