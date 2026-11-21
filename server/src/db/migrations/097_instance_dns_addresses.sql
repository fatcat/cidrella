-- The addresses an instance answers DNS on, both families, as a JSON list.
-- Data of record: whichever instance serves DHCP hands clients every
-- instance's address (docs/REDUNDANCY-PLAN.md, section 6).
ALTER TABLE sync_instances ADD COLUMN dns_addresses TEXT NOT NULL DEFAULT '[]';
