-- Add NTP servers and domain search options to DHCP scopes
ALTER TABLE dhcp_scopes ADD COLUMN ntp_servers TEXT;
ALTER TABLE dhcp_scopes ADD COLUMN domain_search TEXT;
