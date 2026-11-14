/**
 * Every privileged action the web app takes: a raw-socket probe (arping,
 * ping), a daemon start, stop, restart or reload, the update worker's start,
 * and turning NTP on. Nothing else in the web app runs these commands.
 *
 * Two drivers, one set of commands (helper/commands.js):
 *   helper  CIDRELLA_HELPER_SOCKET is set (systemd, s6): the privileged
 *           helper process runs it (helper/main.js). The web app holds no
 *           raw-socket capability and no polkit right of its own.
 *   direct  unset (development, tests): the web app runs it itself.
 *
 * Each action resolves { ok, code, stdout, stderr } and never rejects for a
 * command that failed. With the helper away it resolves
 * { ok: false, helperDown: true, ... }: a caller whose answer would be wrong
 * without the helper (a scan, which would mark every host offline) asks
 * `helperDown` and stops. A request that does not pass commands.js throws a
 * RefusedError: that is a bug in the caller.
 */
import { buildCommand } from '../helper/commands.js';
import { runBuilt } from '../helper/run.js';
import { helperConnected, helperPeer, helperRun, startHelperClient } from './helper-client.js';
import { getCapabilityWarning, readProcessCapabilities } from './capabilities.js';
import { isPreflightBoot } from './preflight.js';

export const HELPER_DOWN_MESSAGE = 'the privileged helper is not answering';

// How much longer than the command itself a reply may take: the socket, and
// the helper's queue while a scan fills it.
const REPLY_SLACK_MS = 5000;

const helperSocket = () => process.env.CIDRELLA_HELPER_SOCKET || null;
export const usesHelper = () => helperSocket() !== null;

async function privileged(op, args = {}) {
  const command = buildCommand({ op, args });
  if (!usesHelper()) return runBuilt(command);
  const reply = await helperRun(op, args, { timeoutMs: command.timeoutMs + REPLY_SLACK_MS });
  if (!reply) {
    return { ok: false, code: null, stdout: '', stderr: HELPER_DOWN_MESSAGE, helperDown: true };
  }
  // Passed here and refused there: the helper runs other code (an update
  // under way), which the client is already restarting.
  if (reply.refused) {
    return { ok: false, code: 'EREFUSED', stdout: '', stderr: `refused: ${reply.refused}` };
  }
  const { ok, code, stdout, stderr } = reply;
  return { ok, code, stdout, stderr };
}

/** ARP for an IPv4 address (one request, one second). */
export const arping = (ip) => privileged('arping', { ip });

/**
 * ICMP echo to `ip`, either family. `iface` zones an IPv6 target: a
 * link-local address, or ff02::1 for every node on that link.
 */
export const ping = (ip, { count = 1, timeoutSec = 2, iface = null } = {}) =>
  privileged('ping', { ip, count, timeoutSec, ...(iface ? { iface } : {}) });

/** systemctl `verb` on one of CIDRella's units (helper/commands.js MANAGED_UNITS). */
export const unitCommand = (verb, unit) => privileged('unit', { verb, unit });

/** Start the update worker for `instance` (version_seconds), without waiting. */
export const startUpdate = (instance) => privileged('update', { instance });

/** timedatectl set-ntp true. */
export const enableNtp = () => privileged('ntp-on');

/**
 * The failed result as an Error, as runCommand rejects: `code`, `stdout`,
 * `stderr`, and the message `what` failed with.
 */
export function resultError(result, what) {
  const err = new Error(`${what} failed: ${result.stderr || `exit ${result.code}`}`);
  err.code = result.code;
  err.stdout = result.stdout;
  err.stderr = result.stderr;
  if (result.helperDown) err.helperDown = true;
  return err;
}

/**
 * Why raw-socket probes may fail, or null: asked of whichever process runs
 * them. Under the helper, before its first hello, that it is not answering.
 */
export function capabilityWarning() {
  if (!usesHelper()) return getCapabilityWarning(readProcessCapabilities());
  const peer = helperConnected() ? helperPeer() : null;
  if (!peer) return `The privileged helper is not answering; scans and daemon control fail.`;
  if (peer.fileCaps) return null;
  return peer.capabilities
    ? getCapabilityWarning(peer.capabilities)
    : 'The privileged helper could not read its capabilities.';
}

/** The capabilities of whichever process runs the probes, for the health check. */
export function probeCapabilities() {
  if (!usesHelper()) return { source: 'web', ...readProcessCapabilities() };
  const peer = helperConnected() ? helperPeer() : null;
  return { source: 'helper', fileCaps: !!peer?.fileCaps, ...(peer?.capabilities ?? {}) };
}

const helloListeners = new Set();

/**
 * Run `listener` on every hello from the helper from now on: it answers
 * again (a restart, an update that changed its code), so work it could not
 * do while away can be done. Returns a function that removes it.
 */
export function onHelperHello(listener) {
  helloListeners.add(listener);
  return () => helloListeners.delete(listener);
}

/**
 * Connect to the helper, when there is one. Logs a capability warning on its
 * hello. Never from update.sh's preflight probe: the helper serves one web
 * app at a time, and the running one keeps it.
 */
export function startPrivileged() {
  const socketPath = helperSocket();
  if (!socketPath || isPreflightBoot()) return;
  startHelperClient({
    socketPath,
    onHello() {
      const warning = capabilityWarning();
      if (warning) {
        console.warn(
          `[capabilities] ${warning} Active ARP/ICMP liveness scans may report all hosts offline.`,
        );
      }
      for (const listener of helloListeners) listener();
    },
  });
}
