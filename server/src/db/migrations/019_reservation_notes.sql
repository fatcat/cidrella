-- Add reservation_note column to ip_addresses for tracking why an IP was reserved
ALTER TABLE ip_addresses ADD COLUMN reservation_note TEXT;
