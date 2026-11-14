/**
 * The web app's end of the socket to the privileged helper (helper/main.js),
 * on the shared process client (ipc/client.js). utils/privileged.js is its one
 * user: everything else asks privileged.js.
 *
 * The helper is supervised by systemd or s6 and never started from here: in
 * development and tests CIDRELLA_HELPER_SOCKET is unset and privileged.js
 * runs the commands itself.
 */
import { createProcessClient } from '../ipc/client.js';
import { createLog } from '../ipc/log.js';
import { HELPER_PROTOCOL_VERSION, helperCodeId } from '../helper/protocol.js';

const log = createLog('helper');
let helloListener = null;

const client = createProcessClient({
  name: 'privileged helper',
  protocolVersion: HELPER_PROTOCOL_VERSION,
  log,
  onMessage(message, settle) {
    if (message.type === 'result') settle(message.id, message);
    else log('warn', 'Unknown message from the privileged helper', { type: message.type });
  },
  onHello: (peer) => helloListener?.(peer),
});

/** Connect to the helper at `socketPath`; `onHello(peer)` on each hello. */
export function startHelperClient({ socketPath, codeId = helperCodeId(), onHello = null }) {
  helloListener = onHello;
  return client.start({ socketPath, codeId });
}

export const stopHelperClient = () => client.stop();

/**
 * Run `op` in the helper. Waits up to `readyMs` for a helper that is not
 * connected yet (a boot), then resolves its result ({ok, code, stdout,
 * stderr} or {refused}), or null when it is away or did not answer in
 * `timeoutMs`.
 */
export async function helperRun(op, args, { timeoutMs, readyMs = 5000 }) {
  if (!(await client.whenReady(readyMs))) return null;
  return client.request('run', { op, args }, timeoutMs);
}

export const helperPeer = () => client.peer();
export const helperConnected = () => client.connected();
