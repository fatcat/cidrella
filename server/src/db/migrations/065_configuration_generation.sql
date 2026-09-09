CREATE TABLE configuration_generations (
  hook_name TEXT PRIMARY KEY CHECK(hook_name IN (
    'regenerate_dns', 'regenerate_dhcp', 'regenerate_dnsmasq_conf'
  )),
  desired_generation INTEGER NOT NULL DEFAULT 0,
  applied_generation INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'applied'
    CHECK(status IN ('pending', 'applying', 'applied', 'failed')),
  last_error TEXT,
  requested_at TEXT,
  applied_at TEXT,
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

INSERT INTO configuration_generations (hook_name) VALUES
  ('regenerate_dns'),
  ('regenerate_dhcp'),
  ('regenerate_dnsmasq_conf');
