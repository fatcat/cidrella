-- Empty PTR rows were previously pre-created for every usable IP when a
-- reverse zone was created. They are not served by dnsmasq and do not
-- represent real DNS data; PTR rows are now created only when needed.
DELETE FROM dns_records
WHERE type = 'PTR'
  AND trim(COALESCE(value, '')) = '';
