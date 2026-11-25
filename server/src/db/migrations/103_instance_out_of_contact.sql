-- A member the controller has not heard from for its contact window
-- (CURRENT_MS): DHCP clients are not given it as a DNS server until it is
-- back (dnsInstances). Data of record, unlike last_contact_at: whichever
-- instance serves DHCP builds that list from its own copy, and only the
-- controller knows who is in contact. Only the controller writes it.
ALTER TABLE sync_instances ADD COLUMN out_of_contact INTEGER NOT NULL DEFAULT 0;
