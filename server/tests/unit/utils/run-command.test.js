/**
 * runCommand: a child process the event loop does not wait on, always with a
 * timeout. Runs node itself, so the test needs nothing installed.
 */
import { describe, expect, it } from 'vitest';
import { runCommand } from '../../../src/utils/run-command.js';

const node = process.execPath;

describe('runCommand', () => {
  it('resolves the output of a command that succeeds', async () => {
    const { stdout, stderr } = await runCommand(node, ['-e', 'console.log("hi"); console.error("e")']);
    expect(stdout).toBe('hi\n');
    expect(stderr).toBe('e\n');
  });

  it('rejects a non-zero exit with its code and stderr', async () => {
    const err = await runCommand(node, ['-e', 'console.error("bad"); process.exit(3)']).catch(
      (e) => e,
    );
    expect(err).toMatchObject({ code: 3, stderr: 'bad\n' });
  });

  it('kills a command that runs past its timeout and says so', async () => {
    const started = Date.now();
    const err = await runCommand(node, ['-e', 'setTimeout(() => {}, 10000)'], {
      timeout: 200,
    }).catch((e) => e);
    expect(err).toMatchObject({ code: 'ETIMEDOUT', killed: true });
    expect(Date.now() - started).toBeLessThan(5000);
  });

  it('reports a missing command as ENOENT', async () => {
    const err = await runCommand('cidrella-no-such-command', []).catch((e) => e);
    expect(err.code).toBe('ENOENT');
  });

  it('writes `input` to the command', async () => {
    const { stdout } = await runCommand(
      node,
      ['-e', 'process.stdin.on("data", (d) => process.stdout.write(String(d).toUpperCase()))'],
      { input: 'abc' },
    );
    expect(stdout).toBe('ABC');
  });

  it('leaves the event loop free while the command runs', async () => {
    let ticks = 0;
    const timer = setInterval(() => ticks++, 10);
    await runCommand(node, ['-e', 'const end = Date.now() + 300; while (Date.now() < end);']);
    clearInterval(timer);
    expect(ticks).toBeGreaterThan(10);
  });
});
