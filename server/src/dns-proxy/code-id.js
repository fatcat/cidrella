/**
 * The DNS proxy's code id (ipc/code-id.js): the proxy computes it once at
 * start, from the files it loaded; the web app computes it from its own slot,
 * and has the proxy restarted when the two differ.
 */
import { fileURLToPath } from 'url';
import { codeId } from '../ipc/code-id.js';

export const PROXY_ENTRY = fileURLToPath(new URL('./main.js', import.meta.url));

export const proxyCodeId = () => codeId(PROXY_ENTRY);
