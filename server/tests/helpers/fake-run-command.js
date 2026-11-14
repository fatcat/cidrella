/**
 * A runCommand (src/utils/run-command.js) driven by a synchronous mock, so a
 * test written against execFileSync keeps its shape: the mock returns the
 * command's stdout or throws its failure, and this turns that into the
 * resolution or rejection runCommand gives.
 *
 *   const exec = vi.hoisted(() => vi.fn());
 *   vi.mock('../../src/utils/run-command.js', async () =>
 *     (await import('../helpers/fake-run-command.js')).fakeRunCommandModule(exec));
 *
 * A thrown error's `status` becomes its `code`, as execFile reports an exit.
 */
export function runCommandFrom(mock) {
  return async (cmd, args = [], options = {}) => {
    try {
      const out = await mock(cmd, args, options);
      return { stdout: out == null ? '' : String(out), stderr: '' };
    } catch (err) {
      if (err && err.code == null && err.status != null) err.code = err.status;
      throw err;
    }
  };
}

export function fakeRunCommandModule(mock) {
  return { runCommand: runCommandFrom(mock) };
}
