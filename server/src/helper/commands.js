/**
 * The privileged actions the web app may ask for, and the exact command each
 * one runs. Both drivers of utils/privileged.js build their commands here: the
 * helper process (helper/main.js) in production, and the web app itself in
 * development and tests. A request that passes in one passes in the other.
 *
 * A request is { op, args }. buildCommand checks every argument and returns
 * { cmd, args, timeoutMs }, or throws a RefusedError saying what was wrong.
 * No shell runs, and nothing reaches the command but the checked fields,
 * rewritten to their canonical form. Commands are found on the PATH the
 * process was started with, which the helper's unit sets.
 */
import os from 'os';
import { parseIp, formatIp } from '../utils/address.js';

export class RefusedError extends Error {
  constructor(reason) {
    super(reason);
    this.name = 'RefusedError';
  }
}

// The units the web app may control, and how: the same list as the polkit
// rule (scripts/polkit/49-cidrella.rules), which a test holds them to.
const DAEMON_VERBS = ['start', 'stop', 'restart', 'reload'];
export const MANAGED_UNITS = Object.freeze({
  'cidrella-dnsmasq.service': DAEMON_VERBS,
  'cidrella-kea@dhcp4.service': DAEMON_VERBS,
  'cidrella-kea@dhcp6.service': DAEMON_VERBS,
  'cidrella-pdns-auth.service': DAEMON_VERBS,
  'cidrella-pdns-recursor.service': DAEMON_VERBS,
  'cidrella-radvd.service': DAEMON_VERBS,
  // Started again by the watchdog after a hang, past a start limit.
  'cidrella-dns-proxy.service': ['start', 'stop', 'restart', 'reset-failed'],
});

// The update worker's instance: the target version, then the start time in
// seconds (routes/version.js).
const UPDATE_INSTANCE_RE = /^[0-9A-Za-z.+-]+_[0-9]+$/;

// arping gives up after one second (-w 1); this is the kill past that.
export const ARPING_TIMEOUT_MS = 5000;
// systemctl restart and stop wait for the unit; the rest answer at once.
const UNIT_WAIT_TIMEOUT_MS = 90_000;
const COMMAND_TIMEOUT_MS = 15_000;

const MAX_PINGS = 3;
const MAX_PING_WAIT_SEC = 5;

const hostInterfaces = () => Object.keys(os.networkInterfaces());

// One address, either family, with no zone (an interface is its own field).
function address(value, family = null) {
  const parsed = typeof value === 'string' ? parseIp(value, { zoneId: false }) : null;
  if (!parsed) throw new RefusedError('not an IP address');
  const found = parsed.bits === 32 ? 4 : 6;
  if (family && found !== family) throw new RefusedError(`not an IPv${family} address`);
  return { text: formatIp(parsed.value, parsed.bits), family: found };
}

function wholeNumber(value, name, min, max) {
  if (!Number.isInteger(value) || value < min || value > max) {
    throw new RefusedError(`${name} must be a whole number from ${min} to ${max}`);
  }
  return value;
}

function iface(value, interfaces) {
  if (typeof value !== 'string' || !interfaces().includes(value)) {
    throw new RefusedError('not an interface on this host');
  }
  return value;
}

const BUILDERS = {
  // ARP is IPv4 only; IPv6 finds its neighbors with an echo and the
  // neighbor table instead.
  arping(args) {
    const ip = address(args.ip, 4);
    return { cmd: 'arping', args: ['-c', '1', '-w', '1', ip.text], timeoutMs: ARPING_TIMEOUT_MS };
  },

  // An echo to one address. `iface` zones an IPv6 target (a link-local
  // address, or ff02::1 for every node on the link).
  ping(args, { interfaces }) {
    const ip = address(args.ip);
    const count = wholeNumber(args.count ?? 1, 'count', 1, MAX_PINGS);
    const waitSec = wholeNumber(args.timeoutSec ?? 2, 'timeoutSec', 1, MAX_PING_WAIT_SEC);
    let target = ip.text;
    if (args.iface != null) {
      if (ip.family !== 6) throw new RefusedError('an interface zones only an IPv6 address');
      target = `${ip.text}%${iface(args.iface, interfaces)}`;
    }
    return {
      cmd: 'ping',
      args: [
        ...(ip.family === 6 ? ['-6'] : []),
        '-c',
        String(count),
        '-W',
        String(waitSec),
        target,
      ],
      timeoutMs: waitSec * 1000 * count + 500,
    };
  },

  unit(args) {
    const name =
      typeof args.unit === 'string' && !args.unit.endsWith('.service')
        ? `${args.unit}.service`
        : args.unit;
    const verbs = Object.hasOwn(MANAGED_UNITS, name) ? MANAGED_UNITS[name] : null;
    if (!verbs) throw new RefusedError('not a unit CIDRella controls');
    if (!verbs.includes(args.verb))
      throw new RefusedError(`${args.verb} is not allowed on ${name}`);
    const waits = args.verb === 'restart' || args.verb === 'stop';
    return {
      cmd: 'systemctl',
      // As the caller spelled it: systemctl takes the name with or without
      // .service, and the list was checked with it.
      args: [args.verb, args.unit],
      timeoutMs: waits ? UNIT_WAIT_TIMEOUT_MS : COMMAND_TIMEOUT_MS,
    };
  },

  // Start the update worker and return at once: it restarts this service.
  update(args) {
    if (typeof args.instance !== 'string' || !UPDATE_INSTANCE_RE.test(args.instance)) {
      throw new RefusedError('not an update instance');
    }
    return {
      cmd: 'systemctl',
      args: ['--no-block', 'start', `cidrella-update@${args.instance}.service`],
      timeoutMs: COMMAND_TIMEOUT_MS,
    };
  },

  'ntp-on'() {
    return { cmd: 'timedatectl', args: ['set-ntp', 'true'], timeoutMs: COMMAND_TIMEOUT_MS };
  },
};

export const OPS = Object.freeze(Object.keys(BUILDERS));

/** The command for `{op, args}`, or a RefusedError. */
export function buildCommand(request, { interfaces = hostInterfaces } = {}) {
  const op = request?.op;
  if (typeof op !== 'string' || !Object.hasOwn(BUILDERS, op)) {
    throw new RefusedError('not an operation the helper runs');
  }
  const args = request.args && typeof request.args === 'object' ? request.args : {};
  return BUILDERS[op](args, { interfaces });
}
