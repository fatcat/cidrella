import { DATA_DIR } from '../config/defaults.js';
import { readLifecycleMigrationReport } from '../db/ip-lifecycle-upgrade.js';
import { findEnabledScopeForIp } from '../models/dhcp-scope.js';
import { ADDRESS_TYPE, computeIpView } from '../models/ip-view.js';
import { getLastRetirementDiagnostics } from '../services/ip-lifecycle-service.js';

const ALLOCATION_STATES = [
  'unassigned',
  'reserved',
  'static_dns',
  'dynamic_dhcp',
  'static_dhcp',
  'slaac',
  'system',
  'gateway',
  'quarantined',
];

export function getIpLifecycleDiagnostics(db, { dataDir = DATA_DIR } = {}) {
  const allocationCounts = Object.fromEntries(ALLOCATION_STATES.map((state) => [state, 0]));
  for (const row of db
    .prepare(
      `
    SELECT allocation_state, COUNT(*) AS count
    FROM ip_addresses
    GROUP BY allocation_state
  `,
    )
    .all()) {
    allocationCounts[row.allocation_state] = row.count;
  }

  let scopeConflicts = 0;
  const scopeCandidates = db
    .prepare(
      `
    SELECT subnet_id, ip_address, allocation_state, dhcp_version
    FROM ip_addresses
    WHERE allocation_state IN ('static_dns', 'dynamic_dhcp')
      AND address_family = 4
  `,
    )
    .all();
  for (const row of scopeCandidates) {
    const inScope = Boolean(findEnabledScopeForIp(db, row.subnet_id, row.ip_address));
    if (row.allocation_state === 'static_dns' && inScope) scopeConflicts++;
    if (row.allocation_state === 'dynamic_dhcp' && row.dhcp_version === 4 && !inScope) {
      scopeConflicts++;
    }
  }

  const migration = readLifecycleMigrationReport(dataDir);
  const migrationOutcome = migration?.outcome || 'not_required';
  const migrationConflicts = Number(migration?.summary?.blocking_conflicts) || 0;
  const retirementEvents = db
    .prepare(
      `
    SELECT COUNT(*) AS total,
           SUM(CASE WHEN created_at >= datetime('now', '-24 hours') THEN 1 ELSE 0 END) AS last_24h
    FROM ip_events
    WHERE event_type = 'retired'
  `,
    )
    .get();

  // Rogue is whatever the address tables call rogue, so ip-view decides it
  // rather than a second rule in SQL. Only unassigned rows can be rogue.
  const rogueCounts = new Map();
  for (const row of db
    .prepare(
      `
    SELECT ip.allocation_state, ip.is_online, ip.is_rogue, s.id AS subnet_id, s.cidr, s.name
    FROM ip_addresses ip
    JOIN subnets s ON s.id = ip.subnet_id
    WHERE COALESCE(ip.allocation_state, 'unassigned') = 'unassigned'
  `,
    )
    .iterate()) {
    if (computeIpView(row).address_type !== ADDRESS_TYPE.ROGUE) continue;
    const network = rogueCounts.get(row.subnet_id);
    if (network) network.count++;
    else
      rogueCounts.set(row.subnet_id, {
        subnet_id: row.subnet_id,
        cidr: row.cidr,
        name: row.name,
        count: 1,
      });
  }
  const rogueByNetwork = [...rogueCounts.values()].sort(
    (a, b) => b.count - a.count || a.cidr.localeCompare(b.cidr),
  );

  return {
    allocations: allocationCounts,
    scope_conflicts: scopeConflicts,
    rogue_hosts: rogueByNetwork.reduce((sum, row) => sum + row.count, 0),
    // Rogue hosts can only be listed inside a network, so the dashboard links
    // each network that has them rather than an all-networks view.
    rogue_hosts_by_network: rogueByNetwork,
    retirement: {
      total: retirementEvents.total,
      last_24h: retirementEvents.last_24h || 0,
      last_run: getLastRetirementDiagnostics(),
    },
    reconciliation: {
      outcome: migrationOutcome,
      blocking_conflicts: migrationConflicts,
      failures: ['blocked', 'reconciliation_pending', 'invalid'].includes(migrationOutcome) ? 1 : 0,
      generated_at: migration?.generated_at || null,
    },
  };
}
