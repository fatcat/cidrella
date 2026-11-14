/**
 * What the privileged helper may load. It holds CAP_NET_RAW and the polkit
 * rights, so its code stays small enough to read in one sitting: its own
 * modules, the shared socket code, and a few leaf utilities. No database, no
 * settings, no packages, and no dynamic imports (its code id covers every
 * file it loads).
 */
import { describe, it, expect } from 'vitest';
import { importClosure } from '../../../src/ipc/code-id.js';
import { HELPER_ENTRY } from '../../../src/helper/protocol.js';

const ALLOWED = [
  /^src\/helper\/[^/]+\.js$/,
  /^src\/ipc\/[^/]+\.js$/,
  /^src\/utils\/(address|capabilities|executable|run-command)\.js$/,
];

describe('the privileged helper closure', () => {
  const { files, packages, dynamicImports } = importClosure(HELPER_ENTRY);

  it('loads only its own modules, the socket code and leaf utilities', () => {
    expect(files.filter((file) => !ALLOWED.some((re) => re.test(file)))).toEqual([]);
  });

  it('imports no packages and nothing dynamically', () => {
    expect(packages).toEqual([]);
    expect(dynamicImports).toEqual([]);
  });
});
