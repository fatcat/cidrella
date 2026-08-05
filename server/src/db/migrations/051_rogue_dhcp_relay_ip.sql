-- Record the DHCP relay agent (giaddr) that forwarded a rogue offer, if any.
--
-- Zero/NULL means the offer arrived straight from a server on our own segment.
-- A value means a relay was in the path, which is what tells "a second DHCP
-- server is running here" apart from "our own offer came back through a relay
-- that rewrote the server-identifier to itself". Without it those two look
-- identical in the events table.

ALTER TABLE rogue_dhcp_events ADD COLUMN relay_ip TEXT;
