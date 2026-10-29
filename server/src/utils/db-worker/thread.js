// The worker side of runDbTask (index.js): open the database, run one task,
// post its result, close.
import { parentPort, workerData } from 'worker_threads';
import Database from 'better-sqlite3';
import { TASKS } from './tasks.js';

const { task, dbPath, args } = workerData;
let db;
try {
  const run = TASKS[task];
  if (!run) throw new Error(`Unknown database task: ${task}`);
  db = new Database(dbPath, { readonly: true, fileMustExist: true });
  parentPort.postMessage({ ok: true, result: run(db, args) });
} catch (err) {
  parentPort.postMessage({ ok: false, error: err.message, code: err.code ?? null });
} finally {
  try {
    db?.close();
  } catch {
    /* ignore */
  }
}
