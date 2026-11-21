/**
 * What a member has measured, arriving at its controller
 * (sync/collected-streams.js): mounted at /api/sync/collected, ahead of the
 * sign-in middleware, since a member presents its credential rather than a
 * session.
 *
 * Rows are stored under the instance the credential belongs to. Nothing in
 * the body says whose they are.
 */
import express, { Router } from 'express';
import { getDb } from '../db/init.js';
import { acceptBatch, MAX_BATCH_ROWS, streamNamed } from '../sync/collected-streams.js';
import { controllerOnly, epochGate, requireMember } from '../sync/require-member.js';
import { fenceSelf } from '../services/controller-promotion.js';

const router = Router();
router.use(controllerOnly);
router.use(requireMember, epochGate(fenceSelf));
// For a server that has not parsed the body already. Behind the app's own
// parser its limit stands, and the member batches under that (COLLECTED_BYTES
// in sync/collected-upload.js).
router.use(express.json({ limit: '1mb' }));

const isEpoch = (value) => typeof value === 'string' && /^[0-9a-f-]{36}$/.test(value);

/**
 * POST /api/sync/collected/:stream { epoch, rows: [[id, ...values]] }
 * Answers { position, taken, skipped, refused }: `position` is the highest of
 * this member's ids the controller now holds for the stream, which is what
 * the member moves its cursor to.
 */
router.post('/:stream', async (req, res) => {
  const stream = streamNamed(req.params.stream);
  if (!stream) {
    return res.status(404).json({ error: 'No such stream.', code: 'unknown_stream' });
  }
  const { epoch, rows } = req.body || {};
  if (!isEpoch(epoch) || !Array.isArray(rows)) {
    return res.status(400).json({ error: 'A batch is { epoch, rows }.', code: 'invalid_request' });
  }
  if (rows.length > MAX_BATCH_ROWS) {
    return res.status(413).json({
      error: `A batch holds at most ${MAX_BATCH_ROWS} rows.`,
      code: 'batch_too_large',
    });
  }
  try {
    const { position, taken, skipped, refused } = await stream.store(
      getDb(),
      req.member.instance_id,
      epoch,
      (at) => acceptBatch(stream, rows, at),
    );
    if (refused > 0) {
      console.warn(
        `[sync] refused ${refused} ${stream.name} row(s) from ${req.member.name}: not rows this controller stores`,
      );
    }
    res.json({ position, taken, skipped, refused });
  } catch (err) {
    console.error(
      `[sync] could not store ${stream.name} rows from ${req.member.name}:`,
      err.message,
    );
    res.status(500).json({ error: 'The rows could not be stored.', code: 'store_failed' });
  }
});

export default router;
