-- The AdGuard preset named unfiltered.dns.adguard-dns.com, which does not
-- resolve and which AdGuard's servers refuse during the TLS handshake. Every
-- encrypted query to an upstream saved from that preset failed. The working
-- name is unfiltered.adguard-dns.com, on the same addresses.
--
-- The saved upstreams are one JSON list; the old name appears in both the
-- hostname and the doh_url and nowhere else.
UPDATE settings
SET value = replace(value, 'unfiltered.dns.adguard-dns.com', 'unfiltered.adguard-dns.com')
WHERE key = 'forwarder_encrypted_upstreams'
  AND value LIKE '%unfiltered.dns.adguard-dns.com%';
