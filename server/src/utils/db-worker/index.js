/**
 * Slow SQL off the main thread. A task runs in its own worker thread with its
 * own better-sqlite3 connection, so a long statement (a VACUUM, a count over
 * millions of blocklist rows) no longer stops the event loop the DNS proxy
 * answers on (docs/ARCHITECTURE.md, Event loop).
 *
 * One worker per task: the tasks are rare and slow, so a pool would buy
 * nothing. The worker opens the database read-only; anything a task writes
 * goes to a file of its own (a backup copy). Tasks live in tasks.js.
 */
import { Worker } from 'worker_threads';

const THREAD = new URL('./thread.js', import.meta.url);
const DEFAULT_TIMEOUT_MS = 10 * 60 * 1000;

export function runDbTask(task, { dbPath, timeout = DEFAULT_TIMEOUT_MS, ...args }) {
  return new Promise((resolve, reject) => {
    const worker = new Worker(THREAD, { workerData: { task, dbPath, args } });
    let settled = false;
    const finish = (fn, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      fn(value);
    };
    const timer = setTimeout(() => {
      const err = new Error(`Database task ${task} did not finish in ${timeout} ms`);
      err.code = 'ETIMEDOUT';
      void worker.terminate();
      finish(reject, err);
    }, timeout);
    worker.once('message', (message) => {
      if (message.ok) finish(resolve, message.result);
      else finish(reject, Object.assign(new Error(message.error), { code: message.code }));
    });
    worker.once('error', (err) => finish(reject, err));
    worker.once('exit', (code) => {
      finish(reject, new Error(`Database task ${task} exited with code ${code} and no result`));
    });
  });
}
