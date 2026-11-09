/**
 * The privileged helper as the process it runs as (helper/main.js), reached
 * through the web app's client (utils/helper-client.js). Stand-in arping,
 * ping, systemctl and timedatectl on its PATH record how they were run, so
 * nothing here needs a capability or polkit.
 */
import fs from 'fs';
import os from 'os';
import path from 'path';
import { spawn } from 'child_process';
import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from 'vitest';
import { HELPER_ENTRY, helperCodeId } from '../../src/helper/protocol.js';
import { CODE_GONE_EXIT } from '../../src/ipc/code-gone.js';
import * as Client from '../../src/utils/helper-client.js';

let dir;
let bin;
let calls;

// Each stand-in logs its name and arguments, one call per line. ping fails
// for 192.0.2.99, as for a host that does not answer.
const STUB = `#!/bin/sh
printf '%s' "$(basename "$0")" >> "$HELPER_TEST_CALLS"
for a in "$@"; do printf ' %s' "$a" >> "$HELPER_TEST_CALLS"; done
printf '\\n' >> "$HELPER_TEST_CALLS"
case "$*" in *192.0.2.99*) exit 1 ;; esac
[ "$(basename "$0")" = arping ] && echo 'Unicast reply from 10.0.0.5 [00:11:22:33:44:55]  0.6ms'
exit 0
`;

function startHelper(entry = HELPER_ENTRY, socketPath = path.join(dir, 'run', 'helper.sock')) {
  const child = spawn(process.execPath, [entry], {
    env: {
      PATH: `${bin}:/usr/bin:/bin`,
      CIDRELLA_HELPER_SOCKET: socketPath,
      HELPER_TEST_CALLS: calls,
    },
    stdio: 'ignore',
  });
  return { child, socketPath };
}

const exited = (child) =>
  new Promise((resolve) => child.on('exit', (code, signal) => resolve({ code, signal })));

const lastCall = () => fs.readFileSync(calls, 'utf8').trim().split('\n').at(-1);

let helper;

beforeAll(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'helper-'));
  bin = path.join(dir, 'bin');
  calls = path.join(dir, 'calls.log');
  fs.mkdirSync(bin);
  for (const name of ['arping', 'ping', 'systemctl', 'timedatectl']) {
    fs.writeFileSync(path.join(bin, name), STUB, { mode: 0o755 });
  }
  fs.writeFileSync(calls, '');
  helper = startHelper();
  await vi.waitFor(() => expect(fs.existsSync(helper.socketPath)).toBe(true));
  Client.startHelperClient({ socketPath: helper.socketPath });
}, 15000);

afterAll(() => {
  Client.stopHelperClient();
  helper?.child.kill('SIGTERM');
  fs.rmSync(dir, { recursive: true, force: true });
});

const run = (op, args) => Client.helperRun(op, args, { timeoutMs: 5000 });

describe('the privileged helper process', () => {
  it('says hello with its code id, pid and what it can run', async () => {
    await vi.waitFor(() => expect(Client.helperPeer()).not.toBeNull());
    expect(Client.helperPeer()).toMatchObject({
      v: 1,
      codeId: helperCodeId(),
      pid: helper.child.pid,
      systemctl: true,
      fileCaps: false,
    });
    expect(Client.helperPeer().capabilities).toHaveProperty('cap_net_raw_effective');
  });

  it('makes its socket readable and writable by its group, no one else', () => {
    expect(fs.statSync(helper.socketPath).mode & 0o777).toBe(0o660);
  });

  it('arpings an IPv4 address and hands back what arping printed', async () => {
    const result = await run('arping', { ip: '10.0.0.5' });
    expect(result).toMatchObject({ ok: true, code: 0 });
    expect(result.stdout).toContain('00:11:22:33:44:55');
    expect(lastCall()).toBe('arping -c 1 -w 1 10.0.0.5');
  });

  it('pings either family, and reports a host that does not answer', async () => {
    expect(await run('ping', { ip: '192.0.2.1' })).toMatchObject({ ok: true });
    expect(lastCall()).toBe('ping -c 1 -W 2 192.0.2.1');
    expect(await run('ping', { ip: '2001:db8::1', count: 3 })).toMatchObject({ ok: true });
    expect(lastCall()).toBe('ping -6 -c 3 -W 2 2001:db8::1');
    expect(await run('ping', { ip: '192.0.2.99' })).toMatchObject({ ok: false, code: 1 });
  });

  it('pings every node on a link through an interface the host has', async () => {
    const iface = Object.keys(os.networkInterfaces())[0];
    expect(await run('ping', { ip: 'ff02::1', iface, count: 2 })).toMatchObject({ ok: true });
    expect(lastCall()).toBe(`ping -6 -c 2 -W 2 ff02::1%${iface}`);
  });

  it('runs a unit verb, the update worker and NTP', async () => {
    expect(await run('unit', { verb: 'reload', unit: 'cidrella-dnsmasq' })).toMatchObject({
      ok: true,
    });
    expect(lastCall()).toBe('systemctl reload cidrella-dnsmasq');
    await run('update', { instance: '0.6.3_1762700000' });
    expect(lastCall()).toBe('systemctl --no-block start cidrella-update@0.6.3_1762700000.service');
    await run('ntp-on', {});
    expect(lastCall()).toBe('timedatectl set-ntp true');
  });

  it('refuses what is off its list, running nothing', async () => {
    const before = fs.readFileSync(calls, 'utf8');
    expect(await run('unit', { verb: 'restart', unit: 'ssh' })).toMatchObject({
      refused: 'not a unit CIDRella controls',
    });
    expect(await run('arping', { ip: '10.0.0.5 -I eth0' })).toMatchObject({
      refused: 'not an IP address',
    });
    expect(await run('exec', { cmd: 'sh' })).toMatchObject({
      refused: 'not an operation the helper runs',
    });
    expect(fs.readFileSync(calls, 'utf8')).toBe(before);
  });
});

describe('when the helper exits by itself', () => {
  let other;
  afterEach(() => other?.child.kill('SIGTERM'));

  it('exits when the web app ships other code', async () => {
    Client.stopHelperClient();
    other = startHelper(HELPER_ENTRY, path.join(dir, 'other', 'helper.sock'));
    await vi.waitFor(() => expect(fs.existsSync(other.socketPath)).toBe(true));
    const done = exited(other.child);
    Client.startHelperClient({ socketPath: other.socketPath, codeId: 'other-code' });
    expect(await done).toEqual({ code: 0, signal: null });
    Client.stopHelperClient();
  }, 15000);

  it('exits 64 when the file it was started from is gone', async () => {
    const link = path.join(dir, 'main-link.js');
    fs.symlinkSync(HELPER_ENTRY, link);
    other = startHelper(link, path.join(dir, 'gone', 'helper.sock'));
    await vi.waitFor(() => expect(fs.existsSync(other.socketPath)).toBe(true));
    const done = exited(other.child);
    fs.unlinkSync(link);
    expect(await done).toEqual({ code: CODE_GONE_EXIT, signal: null });
  }, 15000);
});
