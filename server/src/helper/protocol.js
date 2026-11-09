/**
 * What the web app and the privileged helper say over the helper's socket
 * (ipc/framing.js: one JSON object per line).
 *
 * web app to helper:
 *   hello {v, codeId}        first, on every connect
 *   run {id, op, args}       run one operation (commands.js)
 *   shutdown                 exit; the supervisor starts the helper again
 *
 * helper to web app:
 *   hello {v, codeId, pid, netRaw, systemctl}
 *                            netRaw: CAP_NET_RAW is in its effective set;
 *                            systemctl: there is one to run (not in Docker)
 *   result {id, ok, code, stdout, stderr}
 *   result {id, refused}     the request did not pass commands.js
 */
import { fileURLToPath } from 'url';
import { codeId } from '../ipc/code-id.js';

export const HELPER_PROTOCOL_VERSION = 1;

export const HELPER_ENTRY = fileURLToPath(new URL('./main.js', import.meta.url));

export const helperCodeId = () => codeId(HELPER_ENTRY);

// The most commands run at once; more wait their turn. A scan probes in
// batches well under this.
export const MAX_RUNNING = 64;
