/**
 * Run a command without blocking the event loop. The web API, the DNS proxy
 * and daemon control share one loop, so a synchronous child process stops
 * DNS answers until it returns (docs/ARCHITECTURE.md, Event loop).
 *
 * Resolves { stdout, stderr } as strings. Rejects on a non-zero exit, a
 * timeout or a spawn failure with the error carrying `code` (the exit code,
 * or the errno such as 'ENOENT'), `stdout`, `stderr` and `killed`. A timeout
 * is always set: a hung command is a failure, not a wait forever.
 */
import { execFile } from 'child_process';

const DEFAULT_TIMEOUT_MS = 15_000;
const DEFAULT_MAX_BUFFER = 16 * 1024 * 1024;

export function runCommand(
  cmd,
  args = [],
  { timeout = DEFAULT_TIMEOUT_MS, input = null, maxBuffer = DEFAULT_MAX_BUFFER, cwd, env } = {},
) {
  return new Promise((resolve, reject) => {
    const child = execFile(
      cmd,
      args,
      { timeout, maxBuffer, cwd, env, encoding: 'utf8', killSignal: 'SIGKILL' },
      (error, stdout, stderr) => {
        if (error) {
          error.stdout = stdout;
          error.stderr = stderr;
          if (error.killed && !error.code) error.code = 'ETIMEDOUT';
          reject(error);
          return;
        }
        resolve({ stdout, stderr });
      },
    );
    if (input != null) {
      child.stdin.on('error', () => {});
      child.stdin.end(input);
    }
  });
}
