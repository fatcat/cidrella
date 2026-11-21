-- Instances: every CIDRella that shares this data of record
-- (docs/REDUNDANCY-PLAN.md). One row each, the controller's own included. The
-- row is data of record, so a member that is promoted knows the others; what
-- the controller last heard from an instance stays on the controller (the
-- host columns in sync/registry.js).
CREATE TABLE sync_instances (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  instance_id TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  -- How other instances reach it: a host name or an address, either family.
  address TEXT NOT NULL DEFAULT '',
  port INTEGER NOT NULL DEFAULT 443,
  -- SHA-256 of its sync identity certificate, which is what others pin.
  fingerprint TEXT NOT NULL,
  -- The credential it presents, hashed. NULL on the row of the instance that
  -- issues credentials.
  credential_hash TEXT,
  is_controller INTEGER NOT NULL DEFAULT 0,
  serves_dns INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  last_contact_at TEXT,
  cursor INTEGER,
  version TEXT,
  schema_version INTEGER
);

-- Join tokens the controller has handed out: one use, short lived, hashed.
CREATE TABLE sync_join_tokens (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  token_hash TEXT NOT NULL UNIQUE,
  created_by TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  expires_at TEXT NOT NULL,
  used_at TEXT
);

-- What a member has to tell the controller and has not yet: audit rows today.
CREATE TABLE sync_outbox (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  kind TEXT NOT NULL,
  payload TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
