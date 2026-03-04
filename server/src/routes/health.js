import { Router } from 'express';
import { getDb } from '../db/init.js';

const router = Router();

// GET /api/health
router.get('/', (req, res) => {
  try {
    const db = getDb();
    db.prepare('SELECT 1').get();
    res.json({ status: 'ok', timestamp: new Date().toISOString() });
  } catch {
    res.status(503).json({ status: 'error', message: 'Database unavailable' });
  }
});

export default router;
