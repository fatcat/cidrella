/**
 * The web app's end of a process socket (server.js, framing.js): it connects
 * and keeps reconnecting, says hello on every connect, and matches replies to
 * requests by id.
 *
 * The hello carries the protocol version and the code id the web app expects
 * (code-id.js). A peer on another version, or running other code than this
 * web app ships, is asked to exit once (`shutdown`); its supervisor starts the
 * new code. Code that keeps differing (a broken install) is not restarted in a
 * loop.
 *
 * With `entry` and no supervisor (`supervisorEnv` unset in the environment:
 * development), the client starts the process itself as a child when nothing
 * answers, and stops it at exit.
 */
import net from 'net';
import { spawn } from 'child_process';
import { encode, createDecoder } from './framing.js';
import { socketPathTooLong } from './server.js';

const BACKOFF_FIRST_MS = 250;
const BACKOFF_MAX_MS = 2000;
const REQUEST_TIMEOUT_MS = 3000;

/**
 * `name` is the peer as a log line names it ("DNS proxy"). `onMessage(message,
 * settle)` gets every message but hello; `settle(id, value)` resolves the
 * request with that id. `onConnect(write)` runs after the hello on each
 * connect, `onHello(peer)` when the peer's hello arrives.
 */
export function createProcessClient({
  name,
  protocolVersion,
  entry = null,
  supervisorEnv = null,
  parentEnv = null,
  childEnv = () => ({}),
  log,
  onMessage,
  onConnect,
  onHello,
}) {
  let socketPath = null;
  let socket = null;
  let connected = false;
  let running = false;
  let backoff = BACKOFF_FIRST_MS;
  let retryTimer = null;
  let expectedCodeId = null;
  let peer = null;
  let child = null;
  let nextId = 1;
  const waiting = new Map();
  let restartAskedFor = null;
  // Callers waiting for the peer's hello (whenReady).
  let readyWaiters = [];

  function write(message) {
    if (!connected) return false;
    socket.write(encode(message));
    return true;
  }

  function settle(id, value) {
    const pending = waiting.get(id);
    if (!pending) return;
    waiting.delete(id);
    clearTimeout(pending.timer);
    pending.resolve(value);
  }

  function hello(message) {
    peer = { ...message };
    delete peer.type;
    if (message.v !== protocolVersion) {
      log('warn', `The ${name} speaks another protocol version, asking it to restart`, {
        peer: message.v,
        web: protocolVersion,
      });
      write({ type: 'shutdown' });
    } else if (expectedCodeId && message.codeId !== expectedCodeId) {
      // An update: the peer exits and its supervisor starts the new code.
      // Unchanged code keeps running.
      if (restartAskedFor === message.codeId) {
        log('error', `The ${name} still runs other code after a restart`, {
          peer: message.codeId,
          web: expectedCodeId,
        });
      } else {
        restartAskedFor = message.codeId;
        log('info', `The ${name} runs other code, asking it to restart`, {
          peer: message.codeId,
          web: expectedCodeId,
        });
        write({ type: 'shutdown' });
      }
    }
    onHello?.(peer);
    for (const resolve of readyWaiters) resolve(true);
    readyWaiters = [];
  }

  function spawnChild() {
    if (!entry || child || (supervisorEnv && process.env[supervisorEnv])) return;
    log('info', `Starting the ${name} process (no supervisor)`);
    child = spawn(process.execPath, [entry], {
      // The child goes when this process does, however it ends.
      env: {
        ...process.env,
        ...childEnv(),
        ...(parentEnv ? { [parentEnv]: String(process.pid) } : {}),
      },
      stdio: 'inherit',
    });
    child.on('exit', (code, signal) => {
      log('warn', `The ${name} process exited`, { code, signal });
      child = null;
    });
  }

  function scheduleConnect() {
    if (!running || retryTimer) return;
    retryTimer = setTimeout(() => {
      retryTimer = null;
      connect();
    }, backoff);
    retryTimer.unref?.();
    backoff = Math.min(backoff * 2, BACKOFF_MAX_MS);
  }

  function connect() {
    if (!running || socket) return;
    const sock = net.connect(socketPath);
    socket = sock;
    sock.on('connect', () => {
      connected = true;
      backoff = BACKOFF_FIRST_MS;
      write({ type: 'hello', v: protocolVersion, codeId: expectedCodeId });
      onConnect?.(write);
    });
    sock.on(
      'data',
      createDecoder(
        (message) => (message.type === 'hello' ? hello(message) : onMessage(message, settle)),
        (err) => {
          log('warn', `Closing the ${name} connection`, { error: err.message });
          sock.destroy();
        },
      ),
    );
    sock.on('error', (err) => {
      if (err.code === 'ENOENT' || err.code === 'ECONNREFUSED') spawnChild();
    });
    sock.on('close', () => {
      if (socket !== sock) return;
      socket = null;
      connected = false;
      peer = null;
      for (const id of [...waiting.keys()]) settle(id, null);
      scheduleConnect();
    });
  }

  // The child must not outlive the web app in development. A web app that is
  // killed outright fires no exit event; the child watches `parentEnv` itself.
  process.on('exit', () => child?.kill('SIGTERM'));

  return {
    /** Start talking to the peer on `socketPath`; false if the path cannot be used. */
    start({ socketPath: at, codeId = null }) {
      expectedCodeId = codeId;
      if (running) return true;
      const tooLong = socketPathTooLong(at, name);
      if (tooLong) {
        log('error', tooLong);
        return false;
      }
      socketPath = at;
      running = true;
      connect();
      return true;
    },
    stop({ stopChild = true } = {}) {
      running = false;
      clearTimeout(retryTimer);
      retryTimer = null;
      socket?.destroy();
      socket = null;
      connected = false;
      if (stopChild && child) {
        child.kill('SIGTERM');
        child = null;
      }
    },
    write,
    /**
     * Send `{type, id, ...fields}`; resolves with what onMessage settles for
     * that id, or null when the peer is away or does not answer in time.
     */
    request(type, fields = {}, timeoutMs = REQUEST_TIMEOUT_MS) {
      if (!connected) return Promise.resolve(null);
      const id = nextId++;
      return new Promise((resolve) => {
        const timer = setTimeout(() => settle(id, null), timeoutMs);
        timer.unref?.();
        waiting.set(id, { resolve, timer });
        write({ ...fields, type, id });
      });
    },
    /**
     * Resolves true once the peer has said hello (at once if it has), false
     * after `timeoutMs` without one.
     */
    whenReady(timeoutMs) {
      if (connected && peer) return Promise.resolve(true);
      return new Promise((resolve) => {
        const timer = setTimeout(() => {
          readyWaiters = readyWaiters.filter((r) => r !== done);
          resolve(false);
        }, timeoutMs);
        timer.unref?.();
        const done = (value) => {
          clearTimeout(timer);
          resolve(value);
        };
        readyWaiters.push(done);
      });
    },
    connected: () => connected,
    peer: () => peer,
  };
}
