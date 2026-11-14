/**
 * The privileged helper (cidrella-helper): the one process that holds
 * CAP_NET_RAW and the polkit rights to start and stop CIDRella's daemons, so
 * the web app, which serves every API route, holds neither.
 *
 * It runs a closed set of operations (commands.js) for the web app over a
 * Unix socket (CIDRELLA_HELPER_SOCKET, mode 0660 in a directory whose group
 * is cidrella), and nothing else: no database, no settings, no state. Like
 * the DNS proxy it says hello with its code id, exits when the web app asks
 * (an update changed its code) and exits 64 when its code is gone (a
 * rollback to a release without it).
 */
import { createIpcServer } from '../ipc/server.js';
import { CODE_GONE_EXIT, codeGone } from '../ipc/code-gone.js';
import { createLog } from '../ipc/log.js';
import { readProcessCapabilities } from '../utils/capabilities.js';
import { findExecutable } from '../utils/executable.js';
import { buildCommand, RefusedError } from './commands.js';
import { runBuilt } from './run.js';
import { HELPER_PROTOCOL_VERSION, MAX_RUNNING, helperCodeId } from './protocol.js';

const CODE_GONE_CHECK_MS = 1000;
const log = createLog('helper');
const socketPath = process.env.CIDRELLA_HELPER_SOCKET;
if (!socketPath) {
  log('error', 'CIDRELLA_HELPER_SOCKET is not set');
  process.exit(1);
}

const myCodeId = helperCodeId();
let running = 0;
const queued = [];

function capabilities() {
  try {
    return readProcessCapabilities();
  } catch {
    return null;
  }
}

async function run(message) {
  let command;
  try {
    command = buildCommand(message);
  } catch (err) {
    if (!(err instanceof RefusedError)) throw err;
    log('warn', 'Refused a request', { op: message.op, reason: err.message });
    ipc.send({ type: 'result', id: message.id, refused: err.message }, { always: true });
    return;
  }
  const result = await runBuilt(command);
  ipc.send({ type: 'result', id: message.id, ...result }, { always: true });
}

function next() {
  while (running < MAX_RUNNING && queued.length) {
    const message = queued.shift();
    running++;
    run(message)
      .catch((err) => {
        log('error', 'Running a request failed', { op: message.op, error: err.message });
        ipc.send({ type: 'result', id: message.id, ok: false, code: null, stderr: err.message });
      })
      .finally(() => {
        running--;
        next();
      });
  }
}

function shutdown(code = 0) {
  ipc.close();
  process.exit(code);
}

const ipc = createIpcServer({
  socketPath,
  name: 'privileged helper',
  // The web app reaches it through the directory's group (cidrella).
  mode: 0o660,
  log,
  onConnect: () => log('info', 'The web app connected'),
  onMessage(message) {
    switch (message.type) {
      case 'hello':
        ipc.send(
          {
            type: 'hello',
            v: HELPER_PROTOCOL_VERSION,
            codeId: myCodeId,
            pid: process.pid,
            capabilities: capabilities(),
            // Docker gives arping and ping their own file capabilities.
            fileCaps: process.env.CIDRELLA_HELPER_FILE_CAPS === '1',
            systemctl: findExecutable('systemctl') !== null,
          },
          { always: true },
        );
        return;
      case 'run':
        if (!Number.isInteger(message.id)) return;
        queued.push(message);
        next();
        return;
      case 'shutdown':
        log('info', 'The web app asked for a restart');
        shutdown(0);
        return;
      default:
        log('warn', 'Unknown message from the web app', { type: message.type });
    }
  },
});

process.on('SIGTERM', () => shutdown(0));
process.on('SIGINT', () => shutdown(0));

const entry = process.argv[1];
setInterval(() => {
  if (codeGone(entry)) {
    log('info', 'The helper code is gone (a rollback), exiting');
    shutdown(CODE_GONE_EXIT);
  }
}, CODE_GONE_CHECK_MS).unref();

try {
  await ipc.listen();
} catch (err) {
  log('error', 'Could not listen', { error: err.message });
  process.exit(1);
}
log('info', 'Privileged helper started', { pid: process.pid, codeId: myCodeId });
