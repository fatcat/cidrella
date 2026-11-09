/**
 * Run a command from commands.js and report how it went, never rejecting:
 * { ok, code, stdout, stderr }, `code` being the exit code, or the errno
 * ('ENOENT' for a command that is not installed, 'ETIMEDOUT' for one killed at
 * its timeout). Output is cut at OUTPUT_CAP_BYTES each, so a reply stays small.
 */
import { runCommand } from '../utils/run-command.js';

export const OUTPUT_CAP_BYTES = 64 * 1024;

const cap = (text) => {
  const s = typeof text === 'string' ? text : (text?.toString?.() ?? '');
  return Buffer.byteLength(s) > OUTPUT_CAP_BYTES
    ? Buffer.from(s).subarray(0, OUTPUT_CAP_BYTES).toString()
    : s;
};

export async function runBuilt({ cmd, args, timeoutMs }) {
  try {
    const { stdout, stderr } = await runCommand(cmd, args, { timeout: timeoutMs });
    return { ok: true, code: 0, stdout: cap(stdout), stderr: cap(stderr) };
  } catch (err) {
    return {
      ok: false,
      code: err?.code ?? null,
      stdout: cap(err?.stdout),
      stderr: cap(err?.stderr || (err?.stdout ? '' : err?.message)),
    };
  }
}
