/**
 * A member sending what it has measured up to its controller: the metrics
 * tables and the DNS query log (sync/collected-streams.js has the protocol).
 *
 * Each stream has a cursor in sync_state, the id of the last row the
 * controller said it holds. Rows after it go up in batches about once a
 * minute. With the controller away the rows wait where they are, under this
 * box's own retention like any other, so an outage longer than the retention
 * loses the oldest of them. That is accepted: they are measurements, not
 * data of record.
 *
 * When the controller changes, the cursors stay: the new controller has none
 * of this box's rows and no mark for it, takes the rows after the cursor,
 * and answers the last of them as its position. Nothing is sent twice. The
 * rows from before the change stay on the old controller, which is where
 * that history is lost on a forced promotion.
 */
import crypto from 'crypto';
import { MAX_BATCH_ROWS, STREAMS } from './collected-streams.js';
import { callController } from './controller-call.js';
import { readCredential } from './credential.js';
import { readSyncState, writeSyncState } from './log.js';
import { controllerOf } from './mode.js';

const UPLOAD_INTERVAL_MS = 60_000;
// Under the controller's JSON body limit (Express's 100 KB), with room.
const COLLECTED_BYTES = 80_000;
// One round stops here and the next carries on: a long backlog (a box that
// joined with a week of queries) goes up over several rounds.
const ROUND_BUDGET_MS = 45_000;

const cursorKey = (stream) => `collected_cursor:${stream.name}`;
const epochKey = (stream) => `collected_epoch:${stream.name}`;

function epochOf(db, stream, { renew = false } = {}) {
  let epoch = renew ? null : readSyncState(db, epochKey(stream));
  if (!epoch) {
    epoch = crypto.randomUUID();
    writeSyncState(db, epochKey(stream), epoch);
  }
  return epoch;
}

// As many of the rows, from the first, as one request may carry.
function fitting(rows) {
  let bytes = 0;
  let n = 0;
  for (const row of rows) {
    bytes += Buffer.byteLength(JSON.stringify(row)) + 1;
    if (n > 0 && bytes > COLLECTED_BYTES) break;
    n++;
  }
  return rows.slice(0, n);
}

// Send one stream's waiting rows. Returns how many the controller holds now
// that it did not before the call.
async function uploadStream(db, stream, deadline) {
  let sent = 0;
  while (Date.now() < deadline) {
    const cursor = Number(readSyncState(db, cursorKey(stream))) || 0;
    const rows = fitting(await stream.read(db, cursor, MAX_BATCH_ROWS));
    if (rows.length === 0) {
      // Ids below the cursor: this store started over (the analytics database
      // was rebuilt). Start over with it, under a new epoch.
      if (cursor > 0 && (await stream.head(db)) < cursor) {
        writeSyncState(db, cursorKey(stream), 0);
        epochOf(db, stream, { renew: true });
        continue;
      }
      return sent;
    }
    const last = rows.at(-1)[0];
    const response = await callController(db, {
      method: 'POST',
      path: `/api/sync/collected/${stream.name}`,
      body: { epoch: epochOf(db, stream), rows },
    });
    // One row the controller will never read: pass it, or it blocks the stream.
    if (response.status === 413 && rows.length === 1) {
      console.warn(`[sync] skipped a ${stream.name} row too large to send`);
      writeSyncState(db, cursorKey(stream), last);
      continue;
    }
    let position = null;
    try {
      position =
        response.status === 200 ? JSON.parse(response.body.toString('utf8')).position : null;
    } catch {
      /* not an answer */
    }
    if (!Number.isSafeInteger(position) || position < last) {
      throw new Error(
        `The controller answered ${response.status} to this member's ${stream.name} rows.`,
      );
    }
    if (position > last) {
      // The controller holds ids this box has not given out yet: its rows are
      // from before a restore. The same rows go again under a new epoch.
      epochOf(db, stream, { renew: true });
      continue;
    }
    writeSyncState(db, cursorKey(stream), last);
    sent += rows.length;
  }
  return sent;
}

/**
 * Send every stream's waiting rows to the controller, as far as one round
 * goes. Returns how many rows went. Throws when the controller cannot be
 * reached or refuses; nothing is lost, the cursors stay where they were.
 */
export async function uploadCollectedOnce(db, { budgetMs = ROUND_BUDGET_MS } = {}) {
  if (!controllerOf(db) || !readCredential(db)) return 0;
  const deadline = Date.now() + budgetMs;
  let sent = 0;
  for (const stream of STREAMS) {
    sent += await uploadStream(db, stream, deadline);
  }
  return sent;
}

/** Keep sending, about once a minute. Returns a function that stops it. */
export function startCollectedUpload(db) {
  let running = false;
  let lastError = null;
  const round = async () => {
    if (running) return;
    running = true;
    try {
      await uploadCollectedOnce(db);
      lastError = null;
    } catch (err) {
      // Said once per cause: a controller that is away stays away for a while.
      if (lastError !== err.message) console.warn(`[sync] ${err.message}`);
      lastError = err.message;
    } finally {
      running = false;
    }
  };
  const timer = setInterval(round, UPLOAD_INTERVAL_MS);
  timer.unref?.();
  return () => clearInterval(timer);
}
