-- The change log of the data of record (docs/REDUNDANCY-PLAN.md, section 2).
-- One row per (table, key): the newest change to that row, an upsert ('u') or
-- a delete ('d'), so the log holds current state plus tombstones and never
-- grows past that. `seq` only ever rises (AUTOINCREMENT), which is what a
-- copy's cursor counts in. The triggers that fill it are generated from
-- sync/registry.js at boot (sync/log.js), not written here.
CREATE TABLE sync_log (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  tbl TEXT NOT NULL,
  pk NOT NULL,
  op TEXT NOT NULL CHECK (op IN ('u', 'd')),
  UNIQUE (tbl, pk)
);

-- What this box knows about its own copy: the dataset it holds, the epoch,
-- the lowest cursor the log can still serve (floor).
CREATE TABLE sync_state (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
