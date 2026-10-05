-- Address history outlives the address row. ip_events lost its cascade to
-- ip_addresses: deleting or deallocating a network removes the rows, and the
-- history of what happened to each address is what an operator wants then.
-- History is read by the address itself (and its interface, for a
-- link-local IPv6 address), so it also follows an address into a new
-- network. Events name the user who caused them where there was one.
--
-- Per-probe 'scanned' events are gone: liveness changes are recorded as
-- online and offline, and when an address was last scanned is the
-- address's own last_scanned_at.

CREATE TABLE ip_events_new (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ip_address_id INTEGER,
  subnet_id INTEGER,
  ip_address TEXT NOT NULL,
  interface_id TEXT,
  event_type TEXT NOT NULL,
  old_value TEXT,
  new_value TEXT,
  source TEXT,
  actor TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

INSERT INTO ip_events_new (
  id, ip_address_id, subnet_id, ip_address, interface_id, event_type,
  old_value, new_value, source, created_at
)
SELECT
  event.id, event.ip_address_id, event.subnet_id, event.ip_address, ip.interface_id,
  event.event_type, event.old_value, event.new_value, event.source, event.created_at
FROM ip_events event
LEFT JOIN ip_addresses ip ON ip.id = event.ip_address_id
WHERE event.event_type != 'scanned';

DROP TABLE ip_events;
ALTER TABLE ip_events_new RENAME TO ip_events;

CREATE INDEX idx_ip_events_address ON ip_events(ip_address, interface_id, created_at);
CREATE INDEX idx_ip_events_subnet_time ON ip_events(subnet_id, created_at);
CREATE INDEX idx_ip_events_type ON ip_events(event_type, created_at);

-- A Network Range Type assigned to, or taken off, a run of addresses. One
-- row per run rather than per address, so a /16 or an IPv6 /64 costs one
-- row; an address's history picks up the runs that cover it. The keys are
-- utils/address.js sortKey values, which carry the family, so a range of
-- one family never matches an address of the other.
CREATE TABLE ip_range_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  subnet_id INTEGER,
  range_id INTEGER,
  range_type TEXT NOT NULL,
  start_ip TEXT NOT NULL,
  end_ip TEXT NOT NULL,
  start_key TEXT NOT NULL,
  end_key TEXT NOT NULL,
  event_type TEXT NOT NULL CHECK(event_type IN ('range_assigned', 'range_unassigned')),
  actor TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX idx_ip_range_events_keys ON ip_range_events(start_key, end_key);
CREATE INDEX idx_ip_range_events_time ON ip_range_events(created_at);
