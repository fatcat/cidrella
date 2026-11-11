/**
 * Every operation the privileged helper runs: the exact command it builds,
 * and what it refuses. The helper and the web app's direct driver both build
 * their commands here.
 */
import fs from 'fs';
import vm from 'vm';
import { describe, it, expect } from 'vitest';
import { buildCommand, MANAGED_UNITS, OPS, RefusedError } from '../../../src/helper/commands.js';

const interfaces = () => ['lo', 'eth0'];
const build = (op, args) => buildCommand({ op, args }, { interfaces });
const refused = (op, args) => {
  try {
    build(op, args);
  } catch (err) {
    expect(err).toBeInstanceOf(RefusedError);
    return err.message;
  }
  throw new Error(`${op} was not refused`);
};

describe('arping', () => {
  it('probes one IPv4 address, once, for one second', () => {
    expect(build('arping', { ip: '10.0.0.5' })).toMatchObject({
      cmd: 'arping',
      args: ['-c', '1', '-w', '1', '10.0.0.5'],
    });
  });

  it('takes an IPv4-mapped address as the IPv4 address it is', () => {
    expect(build('arping', { ip: '::ffff:10.0.0.5' }).args.at(-1)).toBe('10.0.0.5');
  });

  it('refuses IPv6 (ARP is IPv4 only), a hostname and an option', () => {
    expect(refused('arping', { ip: '2001:db8::5' })).toMatch(/IPv4/);
    for (const ip of ['host.example', '-I', '10.0.0.5 -I eth0', '', null, 5]) {
      expect(refused('arping', { ip })).toMatch(/not an IP address/);
    }
  });
});

describe('ping', () => {
  it('pings an IPv4 address with the count and wait asked for', () => {
    expect(build('ping', { ip: '192.0.2.7', count: 3, timeoutSec: 2 })).toEqual({
      cmd: 'ping',
      args: ['-c', '3', '-W', '2', '192.0.2.7'],
      timeoutMs: 6500,
    });
  });

  it('pings an IPv6 address with -6, in its canonical spelling', () => {
    expect(build('ping', { ip: '2001:DB8:0:0::7' }).args).toEqual([
      '-6',
      '-c',
      '1',
      '-W',
      '2',
      '2001:db8::7',
    ]);
  });

  it('zones an IPv6 target to an interface on this host: link-local, or all nodes', () => {
    expect(build('ping', { ip: 'fe80::1', iface: 'eth0' }).args.at(-1)).toBe('fe80::1%eth0');
    expect(build('ping', { ip: 'ff02::1', iface: 'eth0', count: 2 }).args).toEqual([
      '-6',
      '-c',
      '2',
      '-W',
      '2',
      'ff02::1%eth0',
    ]);
  });

  it('refuses an interface not on this host, a zone on IPv4, and a zone in the address', () => {
    expect(refused('ping', { ip: 'fe80::1', iface: 'eth9' })).toMatch(/interface/);
    expect(refused('ping', { ip: 'ff02::1', iface: 'eth0; reboot' })).toMatch(/interface/);
    expect(refused('ping', { ip: '10.0.0.1', iface: 'eth0' })).toMatch(/IPv6/);
    expect(refused('ping', { ip: 'fe80::1%eth0' })).toMatch(/not an IP address/);
  });

  it('keeps the count and the wait small', () => {
    expect(refused('ping', { ip: '10.0.0.1', count: 4 })).toMatch(/count/);
    expect(refused('ping', { ip: '10.0.0.1', count: 0 })).toMatch(/count/);
    expect(refused('ping', { ip: '10.0.0.1', count: '1' })).toMatch(/count/);
    expect(refused('ping', { ip: '10.0.0.1', timeoutSec: 6 })).toMatch(/timeoutSec/);
  });
});

describe('unit', () => {
  it('runs the verb on the unit, with or without .service', () => {
    expect(build('unit', { verb: 'reload', unit: 'cidrella-dnsmasq' })).toEqual({
      cmd: 'systemctl',
      args: ['reload', 'cidrella-dnsmasq'],
      timeoutMs: 15_000,
    });
    expect(build('unit', { verb: 'restart', unit: 'cidrella-kea@dhcp6.service' })).toMatchObject({
      args: ['restart', 'cidrella-kea@dhcp6.service'],
      timeoutMs: 90_000,
    });
    expect(
      build('unit', { verb: 'reset-failed', unit: 'cidrella-dns-proxy.service' }).args,
    ).toEqual(['reset-failed', 'cidrella-dns-proxy.service']);
  });

  it('refuses a unit or a verb off the list', () => {
    expect(refused('unit', { verb: 'restart', unit: 'cidrella.service' })).toMatch(/not a unit/);
    expect(refused('unit', { verb: 'restart', unit: 'ssh' })).toMatch(/not a unit/);
    expect(refused('unit', { verb: 'restart', unit: 'toString' })).toMatch(/not a unit/);
    expect(refused('unit', { verb: 'enable', unit: 'cidrella-dnsmasq' })).toMatch(/not allowed/);
    expect(refused('unit', { verb: 'reload', unit: 'cidrella-dns-proxy' })).toMatch(/not allowed/);
    expect(refused('unit', { verb: '--now', unit: 'cidrella-dnsmasq' })).toMatch(/not allowed/);
  });
});

describe('update and ntp-on', () => {
  it('starts the update worker without waiting', () => {
    expect(build('update', { instance: '0.6.3-pre.8_1762700000' }).args).toEqual([
      '--no-block',
      'start',
      'cidrella-update@0.6.3-pre.8_1762700000.service',
    ]);
  });

  it('refuses an instance that is not a version and a time', () => {
    for (const instance of ['0.6.3', '../x_1', '0.6.3_1 foo', '0.6.3_1.service', '', null]) {
      expect(refused('update', { instance })).toMatch(/update instance/);
    }
  });

  it('turns NTP on, and only on', () => {
    expect(build('ntp-on', { off: true }).args).toEqual(['set-ntp', 'true']);
  });
});

describe('the operation list', () => {
  it('refuses anything else', () => {
    for (const op of ['exec', 'constructor', '__proto__', '', undefined]) {
      expect(refused(op, {})).toMatch(/not an operation/);
    }
    expect(OPS).toEqual(['arping', 'ping', 'unit', 'update', 'ntp-on']);
  });
});

// The polkit rule file, run with a stand-in for polkit's own API.
function polkitDecides() {
  const rules = [];
  const Result = { YES: 'yes', NOT_HANDLED: 'not handled' };
  vm.runInNewContext(
    fs.readFileSync(new URL('../../../../scripts/polkit/49-cidrella.rules', import.meta.url), 'utf8'),
    { polkit: { addRule: (fn) => rules.push(fn), Result } },
  );
  return (user, id, details = {}) => {
    const action = { id, lookup: (key) => details[key] };
    for (const rule of rules) {
      const result = rule(action, { user });
      if (result !== Result.NOT_HANDLED) return result;
    }
    return Result.NOT_HANDLED;
  };
}

describe('the polkit rule', () => {
  const decide = polkitDecides();
  const manage = (user, unit, verb) =>
    decide(user, 'org.freedesktop.systemd1.manage-units', { unit, verb });
  const ALL_VERBS = ['start', 'stop', 'restart', 'reload', 'reset-failed', 'enable', 'kill'];

  it('grants the helper exactly what the helper runs', () => {
    for (const [unit, verbs] of Object.entries(MANAGED_UNITS)) {
      for (const verb of ALL_VERBS) {
        expect(manage('cidrella-helper', unit, verb), `${verb} ${unit}`).toBe(
          verbs.includes(verb) ? 'yes' : 'not handled',
        );
      }
    }
    expect(manage('cidrella-helper', 'cidrella.service', 'restart')).toBe('not handled');
    expect(manage('cidrella-helper', 'cidrella-update@0.6.3_1.service', 'start')).toBe('yes');
    expect(manage('cidrella-helper', 'cidrella-update@0.6.3_1.service', 'stop')).toBe(
      'not handled',
    );
    expect(decide('cidrella-helper', 'org.freedesktop.timedate1.set-ntp')).toBe('yes');
  });

  it('grants no one else anything, the web account included', () => {
    for (const user of ['cidrella', 'nobody']) {
      for (const [unit, verbs] of Object.entries(MANAGED_UNITS)) {
        for (const verb of verbs) {
          expect(manage(user, unit, verb), `${user}: ${verb} ${unit}`).toBe('not handled');
        }
      }
      expect(manage(user, 'cidrella-update@0.6.4_1.service', 'start')).toBe('not handled');
      expect(decide(user, 'org.freedesktop.timedate1.set-ntp')).toBe('not handled');
    }
  });
});
